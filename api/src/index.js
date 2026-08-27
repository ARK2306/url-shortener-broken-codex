const tracing = require("./tracing");

const { trace } = require("@opentelemetry/api");
const fastify = require("fastify")({ logger: true });
const Redis = require("ioredis");
const { Pool } = require("pg");

const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL)
  : new Redis({
      host: process.env.REDIS_HOST || "redis",
      port: Number(process.env.REDIS_PORT || 6379),
    });

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.PGHOST || "postgres",
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || process.env.POSTGRES_USER,
      password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
      database: process.env.PGDATABASE || process.env.POSTGRES_DB,
    });

const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 3600);
const CACHE_PREFIX = "short:";

function generateCode(length = 7) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS urls (
      code VARCHAR(16) PRIMARY KEY,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      click_count INTEGER NOT NULL DEFAULT 0
    );
    ALTER TABLE urls
      ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL REFERENCES urls(code) ON DELETE CASCADE,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS clicks_code_clicked_at_idx
      ON clicks (code, clicked_at DESC);
  `);
}

fastify.get("/health", async (_request, reply) => {
  try {
    await Promise.all([pool.query("SELECT 1"), redis.ping()]);
    return { status: "ok" };
  } catch (error) {
    fastify.log.error(error, "health check failed");
    return reply.code(503).send({ status: "unhealthy" });
  }
});

fastify.get("/trace-test", async () => {
  const tracer = trace.getTracer("url-shortener-api");
  return tracer.startActiveSpan("trace-test-verification", (span) => {
    span.addEvent("trace test completed");
    const traceId = span.spanContext().traceId;
    span.end();
    return { status: "ok", trace_id: traceId };
  });
});

fastify.post(
  "/shorten",
  {
    schema: {
      body: {
        type: "object",
        required: ["url"],
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri", pattern: "^https?://" },
        },
      },
    },
  },
  async (request, reply) => {
    const { url } = request.body;
    let code;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateCode();
      const result = await pool.query(
        "INSERT INTO urls (code, url) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING code",
        [candidate, url]
      );
      if (result.rowCount === 1) {
        code = candidate;
        break;
      }
    }

    if (!code) {
      return reply.code(503).send({ error: "could not allocate a short code" });
    }

    await redis.set(`${CACHE_PREFIX}${code}`, url, "EX", CACHE_TTL_SECONDS);
    return reply.code(201).send({ code });
  }
);

fastify.get("/analytics/:code", async (request, reply) => {
  const { code } = request.params;
  const result = await pool.query(
    `SELECT u.click_count AS clicks, MAX(c.clicked_at) AS last_clicked
       FROM urls u
       LEFT JOIN clicks c ON c.code = u.code
      WHERE u.code = $1
      GROUP BY u.code, u.click_count`,
    [code]
  );

  if (result.rowCount === 0) {
    return reply.code(404).send({ error: "not found" });
  }

  return {
    code,
    clicks: result.rows[0].clicks,
    last_clicked: result.rows[0].last_clicked,
  };
});

fastify.get("/:code", async (request, reply) => {
  const { code } = request.params;
  const cacheKey = `${CACHE_PREFIX}${code}`;
  let target = await redis.get(cacheKey);

  if (!target) {
    const result = await pool.query("SELECT url FROM urls WHERE code = $1", [code]);
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "not found" });
    }
    target = result.rows[0].url;
    await redis.set(cacheKey, target, "EX", CACHE_TTL_SECONDS);
  }

  await redis.lpush(
    "click_queue",
    JSON.stringify({ code, clicked_at: new Date().toISOString() })
  );
  return reply.redirect(target, 302);
});

async function start() {
  try {
    await ensureSchema();
    await redis.ping();
    await fastify.listen({ port: 3000, host: "0.0.0.0" });
  } catch (error) {
    fastify.log.error(error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  fastify.log.info({ signal }, "shutting down");
  await fastify.close();
  await Promise.all([pool.end(), redis.quit(), tracing.shutdown()]);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start();

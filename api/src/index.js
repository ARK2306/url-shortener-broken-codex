const fastify = require("fastify")({ logger: true });
const Redis = require("ioredis");
const { Pool } = require("pg");

// BUG: uses REDIS_HOST instead of a full REDIS_URL
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT || 6379),
});

const pool = new Pool({
  host: process.env.PGHOST || "postgres",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD,
  database: process.env.PGDATABASE || process.env.POSTGRES_DB,
});

function generateCode(length = 7) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

fastify.post("/shorten", async (request, reply) => {
  // BUG: no request-body validation; missing `url` throws / crashes the handler
  const { url } = request.body;
  const code = generateCode();

  await pool.query("INSERT INTO urls (code, url) VALUES ($1, $2)", [code, url]);

  // BUG: cache key uses `url:` prefix instead of `short:`
  await redis.set(`url:${code}`, url);

  return reply.code(201).send({ code, url, short_url: `/${code}` });
});

fastify.get("/analytics/:code", async (request, reply) => {
  const { code } = request.params;

  // BUG: selects `click_count` from `urls`, but that column does not exist
  const result = await pool.query(
    "SELECT url, click_count FROM urls WHERE code = $1",
    [code]
  );

  if (result.rowCount === 0) {
    return reply.code(404).send({ error: "not found" });
  }

  return {
    code,
    url: result.rows[0].url,
    clicks: result.rows[0].click_count,
  };
});

fastify.get("/:code", async (request, reply) => {
  const { code } = request.params;

  let target = await redis.get(`url:${code}`);
  if (!target) {
    const result = await pool.query("SELECT url FROM urls WHERE code = $1", [code]);
    if (result.rowCount === 0) {
      // BUG: not-found should be 404, not 500
      return reply.code(500).send({ error: "internal server error" });
    }
    target = result.rows[0].url;
    await redis.set(`url:${code}`, target);
  }

  // BUG: does not publish click events to Redis (no LPUSH on "click_queue")
  return reply.redirect(302, target);
});

const start = async () => {
  try {
    await fastify.listen(3000, "0.0.0.0");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

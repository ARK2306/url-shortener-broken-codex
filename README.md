# URL Shortener Microservice

A Fastify API, Python click worker, PostgreSQL database, Redis cache/queue, and
Jaeger tracing backend.

## Quick start

Docker Compose is the only local prerequisite. PostgreSQL and Redis stay on the
internal Compose network so they do not collide with host database services.

```bash
docker compose up -d --build --wait
curl http://localhost:3000/health
```

The API is available at `http://localhost:3000` and the Jaeger UI at
`http://localhost:16686`. To stop the stack, run `docker compose down`. Add
`--volumes` only when you also want to delete the local PostgreSQL data.

Run the complete endpoint, worker, cache TTL, and tracing smoke test with:

```bash
./scripts/integration-test.sh
```

The test requires `curl` and `jq` on the host.

## API

Create and use a short URL:

```bash
response="$(curl -sS -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' http://localhost:3000/shorten)"
code="$(jq -r .code <<<"$response")"
curl -i "http://localhost:3000/$code"
curl -sS "http://localhost:3000/analytics/$code" | jq
```

- `POST /shorten` accepts `{ "url": "https://example.com" }` and returns a
  generated `code` with status 201.
- `GET /:code` returns a 302 redirect and queues a click event.
- `GET /analytics/:code` returns `code`, `clicks`, and `last_clicked` (null
  until the first processed click).
- `GET /health` checks both PostgreSQL and Redis.
- `GET /trace-test` creates a trace and returns its trace ID. Export is batched,
  so allow a few seconds before searching Jaeger for service
  `url-shortener-api`.

Mappings are cached as `short:<code>` in Redis for 3600 seconds. The API uses
`LPUSH` and the worker uses blocking `BRPOP` on the `click_queue` list. The
worker records each event in `clicks` and atomically increments
`urls.click_count`.

## Environment variables

Compose supplies working defaults. `REDIS_URL` and `DATABASE_URL` take
precedence; the host/port variables are supported for deployments that do not
use connection URLs.

| Name | Default in Compose | Description |
| --- | --- | --- |
| `REDIS_URL` | `redis://redis:6379/0` | Complete Redis connection URL |
| `REDIS_HOST`, `REDIS_PORT` | `redis`, `6379` | Redis connection fallback |
| `DATABASE_URL` | `postgresql://shortener:secret@postgres:5432/shortener` | Complete PostgreSQL DSN |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | service-specific | PostgreSQL connection fallback |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `shortener`, `secret`, `shortener` | PostgreSQL initialization and connection fallback |
| `CACHE_TTL_SECONDS` | `3600` | URL cache lifetime |
| `OTEL_SERVICE_NAME` | `url-shortener-api` | Trace service name |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://jaeger:4318/v1/traces` | OTLP/HTTP traces endpoint |

## CI and container publishing

`.github/workflows/ci.yml` checks the Node and Python sources, builds the
Compose images, waits for every service healthcheck, and runs the integration
test. Pushes to `main` also publish API and worker images to
`ghcr.io/<owner>/<repository>/{api,worker}` with both the commit SHA and
`latest` tags. Configure a repository secret named `GHCR_TOKEN` with package
write permission for publishing. When the secret is absent, verification still
runs and image publishing is skipped with a workflow warning.

# URL Shortener Microservice

Fastify API, Python click worker, PostgreSQL, and Redis.

## Quick start

```bash
docker-compose up --build
```

API listens on `http://localhost:3000`.

## Environment variables

The README below does **not** match what the services actually read.

| Name | Description |
| --- | --- |
| `REDIS_URL` | Redis connection URL (example: `redis://redis:6379/0`) |
| `DATABASE_URL` | PostgreSQL DSN |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password |
| `POSTGRES_DB` | Database name |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector endpoint |

## API

- `POST /shorten` with `{ "url": "https://example.com" }`
- `GET /:code` redirects to the original URL and records a click
- `GET /analytics/:code` returns `{ code, url, clicks }`
- `GET /health` health check
- `GET /trace-test` OpenTelemetry smoke test

## Architecture

1. API writes the mapping to PostgreSQL and caches it in Redis under `short:<code>`.
2. Each redirect publishes a JSON payload to the Redis list `click_queue`.
3. The worker blocking-pops jobs with `BRPOP`, parses JSON, and increments `click_count`.

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

import psycopg2
import redis


logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
LOGGER = logging.getLogger("click-worker")


def get_redis():
    redis_url = os.environ.get("REDIS_URL")
    if redis_url:
        return redis.Redis.from_url(redis_url, decode_responses=True)
    return redis.Redis(
        host=os.environ.get("REDIS_HOST", "redis"),
        port=int(os.environ.get("REDIS_PORT", "6379")),
        db=0,
        decode_responses=True,
    )


def get_pg():
    database_url = os.environ.get("DATABASE_URL")
    if database_url:
        return psycopg2.connect(database_url)
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "postgres"),
        port=os.environ.get("PGPORT", "5432"),
        user=os.environ.get("PGUSER") or os.environ.get("POSTGRES_USER"),
        password=os.environ.get("PGPASSWORD")
        or os.environ.get("POSTGRES_PASSWORD"),
        dbname=os.environ.get("PGDATABASE") or os.environ.get("POSTGRES_DB"),
    )


def ensure_schema(conn):
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                ALTER TABLE urls
                  ADD COLUMN IF NOT EXISTS click_count INTEGER NOT NULL DEFAULT 0;
                CREATE TABLE IF NOT EXISTS clicks (
                  id SERIAL PRIMARY KEY,
                  code TEXT NOT NULL REFERENCES urls(code) ON DELETE CASCADE,
                  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                CREATE INDEX IF NOT EXISTS clicks_code_clicked_at_idx
                  ON clicks (code, clicked_at DESC);
                """
            )


def parse_job(raw_job):
    payload = json.loads(raw_job)
    if not isinstance(payload, dict) or not isinstance(payload.get("code"), str):
        raise ValueError("click job must contain a string code")

    clicked_at = payload.get("clicked_at")
    if clicked_at:
        clicked_at = datetime.fromisoformat(clicked_at.replace("Z", "+00:00"))
    else:
        clicked_at = datetime.now(timezone.utc)
    return payload["code"], clicked_at


def process_job(conn, raw_job):
    code, clicked_at = parse_job(raw_job)
    with conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE urls SET click_count = click_count + 1 WHERE code = %s",
                (code,),
            )
            if cur.rowcount != 1:
                raise ValueError(f"unknown short code: {code}")
            cur.execute(
                "INSERT INTO clicks (code, clicked_at) VALUES (%s, %s)",
                (code, clicked_at),
            )


def healthcheck():
    redis_client = get_redis()
    conn = get_pg()
    try:
        redis_client.ping()
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
            cur.fetchone()
    finally:
        redis_client.close()
        conn.close()


def main():
    while True:
        redis_client = None
        conn = None
        try:
            redis_client = get_redis()
            conn = get_pg()
            redis_client.ping()
            ensure_schema(conn)
            LOGGER.info("worker is ready")

            while True:
                # API uses LPUSH and the worker uses BRPOP, preserving FIFO order.
                job = redis_client.brpop("click_queue", timeout=5)
                if not job:
                    continue
                try:
                    process_job(conn, job[1])
                except (json.JSONDecodeError, ValueError) as error:
                    conn.rollback()
                    LOGGER.warning("discarding invalid click job: %s", error)
                except psycopg2.Error:
                    conn.rollback()
                    raise
        except (psycopg2.Error, redis.RedisError) as error:
            LOGGER.exception("worker connection failed; retrying: %s", error)
            time.sleep(2)
        finally:
            if redis_client is not None:
                redis_client.close()
            if conn is not None:
                conn.close()


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--healthcheck":
        healthcheck()
    else:
        main()

import os
import time

import psycopg2
import redis


def get_redis():
    host = os.environ.get("REDIS_HOST", "redis")
    port = int(os.environ.get("REDIS_PORT", "6379"))
    return redis.Redis(host=host, port=port, db=0)


def get_pg():
    return psycopg2.connect(
        host=os.environ.get("PGHOST", "postgres"),
        port=os.environ.get("PGPORT", "5432"),
        user=os.environ.get("PGUSER"),
        password=os.environ.get("PGPASSWORD") or os.environ.get("POSTGRES_PASSWORD"),
        dbname=os.environ.get("PGDATABASE") or os.environ.get("POSTGRES_DB"),
    )


def main():
    r = get_redis()
    conn = get_pg()

    while True:
        # BUG: LPOP instead of BRPOP; busy-loop can miss jobs
        job = r.lpop("click_queue")
        if not job:
            time.sleep(0.05)
            continue

        process_job(conn, job)


def process_job(conn, job):
    # BUG: does not decode the job payload as JSON; treats it as a raw string
    code = job
    if isinstance(code, bytes):
        code = code.decode("utf-8")

    cur = conn.cursor()
    # BUG: does not update PostgreSQL (no increment of click_count)
    cur.execute("SELECT code FROM urls WHERE code = %s", (code,))
    cur.fetchone()
    # BUG: no commit after update
    cur.close()


if __name__ == "__main__":
    main()

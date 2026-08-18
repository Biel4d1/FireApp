#!/usr/bin/env python3
"""Sync likes/dislikes counts from Redis sets into Postgres videos table.

Usage:
  python sync_db.py            # uses REDIS_URL and DATABASE_URL / PG* env vars
  python sync_db.py --dry-run  # do not write changes, just print
"""
import os
import re
import argparse
import redis
import psycopg2
import psycopg2.extras

KEY_RE = re.compile(r'^video:(?P<id>\d+):(?P<kind>likes|dislikes)$')


def get_pg_connection():
    try:
        dsn = os.environ.get('DATABASE_URL')
        if dsn:
            conn = psycopg2.connect(dsn, cursor_factory=psycopg2.extras.RealDictCursor)
        else:
            host = os.environ.get('PGHOST', 'localhost')
            port = int(os.environ.get('PGPORT', '5432'))
            user = os.environ.get('PGUSER', 'postgres')
            password = os.environ.get('PGPASSWORD', '')
            dbname = os.environ.get('PGDATABASE', 'smartvideos')
            conn = psycopg2.connect(host=host, port=port, user=user, password=password, dbname=dbname,
                                    cursor_factory=psycopg2.extras.RealDictCursor)
        return conn
    except Exception as e:
        raise RuntimeError(f'Postgres connection error: {e}')


def main(redis_url, dry_run=False, pattern='video:*:likes'):
    r = redis.from_url(redis_url)

    # We'll scan for both likes and dislikes keys
    cursor = 0
    seen = 0
    try:
        conn = get_pg_connection()
    except Exception as e:
        print('ERROR: cannot connect to Postgres:', e)
        return 1

    try:
        print('Scanning Redis for keys matching video:*:likes and video:*:dislikes...')
        for key in r.scan_iter(match='video:*:likes'):
            key = key.decode() if isinstance(key, bytes) else key
            m = KEY_RE.match(key)
            if not m:
                print('Skipping non-matching key:', key)
                continue
            vid = int(m.group('id'))
            kind = m.group('kind')
            count = int(r.scard(key) or 0)
            print(f'Key={key} -> video_id={vid} {kind} count={count}')
            if not dry_run:
                try:
                    cur = conn.cursor()
                    cur.execute('UPDATE videos SET likes_count = %s WHERE id = %s', (count, vid))
                    conn.commit()
                    cur.close()
                except Exception as e:
                    print('DB update error for video', vid, 'likes:', e)
            seen += 1

        for key in r.scan_iter(match='video:*:dislikes'):
            key = key.decode() if isinstance(key, bytes) else key
            m = KEY_RE.match(key)
            if not m:
                print('Skipping non-matching key:', key)
                continue
            vid = int(m.group('id'))
            kind = m.group('kind')
            count = int(r.scard(key) or 0)
            print(f'Key={key} -> video_id={vid} {kind} count={count}')
            if not dry_run:
                try:
                    cur = conn.cursor()
                    cur.execute('UPDATE videos SET dislikes_count = %s WHERE id = %s', (count, vid))
                    conn.commit()
                    cur.close()
                except Exception as e:
                    print('DB update error for video', vid, 'dislikes:', e)
            seen += 1

        print('Done. Processed', seen, 'keys.')
    finally:
        try:
            conn.close()
        except Exception:
            pass

    return 0


if __name__ == '__main__':
    p = argparse.ArgumentParser(description='Sync Redis video likes/dislikes counts into Postgres')
    p.add_argument('--redis', dest='redis_url', default=os.environ.get('REDIS_URL', 'redis://localhost:6379/0'), help='Redis URL')
    p.add_argument('--dry-run', dest='dry_run', action='store_true', help='Do not write to the database')
    args = p.parse_args()
    raise SystemExit(main(args.redis_url, dry_run=args.dry_run))

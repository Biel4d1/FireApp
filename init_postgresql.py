import os
import psycopg2


def get_pg_connection():
    dsn = os.environ.get('DATABASE_URL')
    if dsn:
        return psycopg2.connect(dsn)

    host = os.environ.get('PGHOST', 'localhost')
    port = int(os.environ.get('PGPORT', '5432'))
    user = os.environ.get('PGUSER', 'postgres')
    password = os.environ.get('PGPASSWORD', '')
    dbname = os.environ.get('PGDATABASE', 'smartvideos')
    return psycopg2.connect(host=host, port=port, user=user, password=password, dbname=dbname)


def init_postgresql():
    conn = None
    try:
        conn = get_pg_connection()
        cur = conn.cursor()

        # Users
        cur.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                profile_pic_url TEXT
            )
        ''')

        # Videos
        cur.execute('''
            CREATE TABLE IF NOT EXISTS videos (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL,
                thumbnail TEXT,
                description TEXT,
                tags TEXT,
                uploader_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                likes_count INTEGER DEFAULT 0,
                dislikes_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Likes
        cur.execute('''
            CREATE TABLE IF NOT EXISTS likes (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, video_id)
            )
        ''')

        # Dislikes
        cur.execute('''
            CREATE TABLE IF NOT EXISTS dislikes (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
                PRIMARY KEY (user_id, video_id)
            )
        ''')

        # Comments
        cur.execute('''
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                comment_text TEXT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # Interactions
        cur.execute('''
            CREATE TABLE IF NOT EXISTS interactions (
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
                watch_time_ms INTEGER DEFAULT 0,
                is_liked BOOLEAN DEFAULT FALSE,
                is_commented BOOLEAN DEFAULT FALSE,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, video_id)
            )
        ''')

        # Reports (new table)
        cur.execute('''
            CREATE TABLE IF NOT EXISTS reports (
                id SERIAL PRIMARY KEY,
                video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                reason TEXT,
                is_ai_flagged BOOLEAN DEFAULT FALSE,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        conn.commit()
        print('PostgreSQL initialization complete.')
    except Exception as e:
        if conn:
            conn.rollback()
        print('Error initializing PostgreSQL schema:', e)
        raise
    finally:
        if conn:
            conn.close()


if __name__ == '__main__':
    init_postgresql()

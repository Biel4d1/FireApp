from flask import Flask, request, jsonify, send_from_directory, g, Response, send_file
import os
import uuid
from werkzeug.utils import secure_filename
from flask_cors import CORS
import re
import psycopg2
import psycopg2.extras
from werkzeug.security import generate_password_hash, check_password_hash
from datetime import datetime, timedelta
from functools import wraps
import jwt
import tag_videos
import threading
import redis
from rq import Queue
import subprocess
import shutil

# Configuration
SECRET_KEY = os.environ.get('JWT_SECRET')
JWT_ALGORITHM = 'HS256'
JWT_EXP_DAYS = 7

app = Flask(__name__)
# Allow all origins for testing/development (APK compatibility)
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True, allow_headers=["Content-Type", "Authorization"])


@app.after_request
def set_cors_headers(response):
    origin = request.headers.get('Origin')
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
    else:
        response.headers.setdefault('Access-Control-Allow-Origin', 'null')
    response.headers['Access-Control-Allow-Credentials'] = 'true'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    return response


@app.before_request
def before_first_request():
    """Initialize Redis with database data on first request."""
    if not hasattr(app, '_redis_synced'):
        app._redis_synced = True
        threading.Thread(target=_sync_redis_from_db, daemon=True).start()

# Increase maximum upload size to 100 MB
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

# RQ (Redis Queue) setup
_redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
try:
    redis_conn = redis.from_url(_redis_url)
    _rq_queue = Queue('default', connection=redis_conn)
except Exception:
    redis_conn = None
    _rq_queue = None


def _sync_redis_from_db():
    """Initialize Redis with all likes and dislikes from the database on startup."""
    if redis_conn is None:
        return
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute('SELECT video_id, user_id FROM likes')
        for row in cursor.fetchall():
            redis_conn.sadd(f"video:{row['video_id']}:likes", str(row['user_id']))

        cursor.execute('SELECT video_id, user_id FROM dislikes')
        for row in cursor.fetchall():
            redis_conn.sadd(f"video:{row['video_id']}:dislikes", str(row['user_id']))

        conn.close()
        print("[INFO] Redis synced with database likes and dislikes on startup")
    except Exception as e:
        print(f"[WARNING] Failed to sync Redis with database: {str(e)}")


def _get_redis_counts(video_id):
    """Return (likes_count, dislikes_count) from Redis if available, else (None, None)."""
    try:
        if redis_conn is None:
            return (None, None)
        likes = int(redis_conn.scard(f"video:{video_id}:likes") or 0)
        dislikes = int(redis_conn.scard(f"video:{video_id}:dislikes") or 0)
        return (likes, dislikes)
    except Exception:
        return (None, None)


@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    """Serve files from the uploads directory."""
    try:
        uploads_dir = os.path.join(os.getcwd(), 'uploads')
        if not os.path.isdir(uploads_dir):
            return jsonify({'error': 'uploads directory not found'}), 500
        return send_from_directory(uploads_dir, filename)
    except Exception as e:
        return jsonify({'error': f'file serve error: {str(e)}'}), 500

ALLOWED_VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi'}
ALLOWED_PROFILE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif'}


def extract_video_thumbnail(video_path, thumbnail_path):
    """Extract a thumbnail from video at 1 second using FFmpeg."""
    try:
        ffmpeg_bin = shutil.which('ffmpeg') or os.path.join(os.getcwd(), 'ffmpeg-static', 'ffmpeg')
        if not os.path.exists(ffmpeg_bin):
            ffmpeg_bin = os.path.join(os.getcwd(), 'ffmpeg-static', 'ffmpeg')

        try:
            if os.path.exists(ffmpeg_bin) and not os.access(ffmpeg_bin, os.X_OK):
                os.chmod(ffmpeg_bin, 0o755)
        except Exception:
            pass

        cmd = [
            ffmpeg_bin, '-nostdin', '-loglevel', 'error',
            '-ss', '1', '-i', video_path, '-vframes', '1',
            '-vf', 'scale=320:320', '-y', thumbnail_path
        ]

        try:
            proc = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
            return True
        except subprocess.TimeoutExpired:
            proc2 = subprocess.run(cmd, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return proc2.returncode == 0
        except subprocess.CalledProcessError as cpe:
            stderr = getattr(cpe, 'stderr', None)
            if stderr:
                print('FFmpeg thumbnail extraction failed:', stderr.decode('utf-8', errors='replace'))
            return False
    except Exception as e:
        print(f'FFmpeg thumbnail extraction failed: {str(e)}')
        return False


def background_extract_and_save_thumbnail(save_path, video_id):
    """Background task to extract thumbnail and update DB."""
    try:
        thumb_name = f"{uuid.uuid4().hex}.jpg"
        thumb_dir = os.path.join(os.getcwd(), 'uploads', 'videos', 'thumbnails')
        os.makedirs(thumb_dir, exist_ok=True)
        thumb_path = os.path.join(thumb_dir, thumb_name)

        if extract_video_thumbnail(save_path, thumb_path):
            thumb_relative = f"thumbnails/{thumb_name}"
            conn = get_db_connection()
            cursor = conn.cursor()
            cursor.execute('UPDATE videos SET thumbnail = %s WHERE id = %s', (thumb_relative, video_id))
            conn.commit()
            conn.close()
    except Exception as e:
        print(f'Background thumbnail error: {e}')


def background_run_tagger(filename, video_id):
    """Background task to run AI tagging and optionally flag videos."""
    try:
        tags = tag_videos.tag_file(filename, video_dir=os.path.join(os.getcwd(), 'uploads', 'videos'))
        if tags:
            toks = [t.strip().lower() for t in tags.split(',') if t.strip()]
            if any(k in toks for k in ('violence', 'nudity')):
                conn = get_db_connection()
                cur = conn.cursor()
                reason = 'AI flagged tags: ' + ','.join(toks)
                cur.execute('UPDATE videos SET is_published = %s WHERE id = %s', (False, video_id))
                cur.execute('INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (%s, %s, %s, %s)', (video_id, None, reason, True))
                conn.commit()
                conn.close()
    except Exception as e:
        print(f'Async tagging error: {e}')


def get_db_connection():
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
            conn = psycopg2.connect(host=host, port=port, user=user, password=password, dbname=dbname, cursor_factory=psycopg2.extras.RealDictCursor)
        return conn
    except Exception as e:
        raise RuntimeError(f'Postgres connection error: {e}')


def ensure_profile_column():
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name='users'")
        cols = [r['column_name'] for r in cursor.fetchall()]
        if 'profile_pic_url' not in cols:
            cursor.execute('ALTER TABLE users ADD COLUMN profile_pic_url TEXT')
            conn.commit()
    finally:
        conn.close()


def ensure_is_published_column():
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name='videos'")
        cols = [r['column_name'] for r in cursor.fetchall()]
        if 'is_published' not in cols:
            cursor.execute("ALTER TABLE videos ADD COLUMN is_published BOOLEAN DEFAULT TRUE")
            conn.commit()
    finally:
        conn.close()


def generate_token(user_id):
    payload = {
        'user_id': user_id,
        'exp': datetime.utcnow() + timedelta(days=JWT_EXP_DAYS),
        'iat': datetime.utcnow()
    }
    token = jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)
    return token.decode('utf-8') if isinstance(token, bytes) else token


def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', None)
        if not auth:
            return jsonify({'error': 'Authorization header required'}), 401
        parts = auth.split()
        if len(parts) != 2 or parts[0].lower() != 'bearer':
            return jsonify({'error': 'Authorization header must be Bearer token'}), 401
        try:
            payload = jwt.decode(parts[1], SECRET_KEY, algorithms=[JWT_ALGORITHM])
            g.current_user_id = payload.get('user_id')
        except Exception:
            return jsonify({'error': 'invalid token'}), 401
        return f(*args, **kwargs)
    return decorated


@app.route('/signup', methods=['POST'])
def signup():
    data = request.get_json() or {}
    username, password = data.get('username'), data.get('password')
    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE username = %s', (username,))
        if cursor.fetchone():
            conn.close()
            return jsonify({'error': 'username taken'}), 409
        hashed = generate_password_hash(password)
        cursor.execute('INSERT INTO users (username, password) VALUES (%s, %s) RETURNING id', (username, hashed))
        user_id = cursor.fetchone()['id']
        conn.commit()
        conn.close()
        return jsonify({'message': 'user created', 'user_id': user_id}), 201
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username, password = data.get('username'), data.get('password')
    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id, password FROM users WHERE username = %s', (username,))
        row = cursor.fetchone()
        conn.close()
        if not row or not check_password_hash(row['password'], password):
            return jsonify({'error': 'invalid credentials'}), 401
        return jsonify({'message': 'login successful', 'token': generate_token(row['id'])}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/delete_account', methods=['DELETE'])
@token_required
def delete_account():
    data = request.get_json() or {}
    password = data.get('password')
    user_id = getattr(g, 'current_user_id', None)
    if user_id is None or not password:
        return jsonify({'error': 'password and valid token required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT password FROM users WHERE id = %s', (user_id,))
        row = cursor.fetchone()
        if not row or not check_password_hash(row['password'], password):
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401
        cursor.execute('DELETE FROM users WHERE id = %s', (user_id,))
        conn.commit()
        conn.close()
        return jsonify({'message': 'account deleted'}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/delete_video/<int:video_id>', methods=['DELETE'])
@token_required
def delete_video(video_id):
    user_id = getattr(g, 'current_user_id', None)
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT filename, thumbnail, uploader_id FROM videos WHERE id = %s', (video_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({'error': 'video not found'}), 404
        if row['uploader_id'] != user_id:
            conn.close()
            return jsonify({'error': 'not authorized to delete this video'}), 403

        cursor.execute('DELETE FROM videos WHERE id = %s RETURNING filename, thumbnail', (video_id,))
        deleted = cursor.fetchone()
        conn.commit()
        conn.close()

        if deleted and deleted.get('filename'):
            fpath = os.path.join(os.getcwd(), 'uploads', 'videos', deleted['filename'])
            if os.path.exists(fpath):
                os.remove(fpath)
        if deleted and deleted.get('thumbnail'):
            thumb_path = os.path.join(os.getcwd(), 'uploads', 'videos', deleted['thumbnail'])
            if os.path.exists(thumb_path):
                os.remove(thumb_path)

        return jsonify({'message': 'video deleted'}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/delete_comment/<int:comment_id>', methods=['DELETE'])
@token_required
def delete_comment(comment_id):
    user_id = getattr(g, 'current_user_id', None)
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT user_id FROM comments WHERE id = %s', (comment_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({'error': 'comment not found'}), 404
        if row['user_id'] != user_id:
            conn.close()
            return jsonify({'error': 'not authorized to delete this comment'}), 403

        cursor.execute('DELETE FROM comments WHERE id = %s', (comment_id,))
        conn.commit()
        conn.close()
        return jsonify({'message': 'comment deleted'}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/report_video', methods=['POST'])
@token_required
def report_video():
    data = request.get_json() or {}
    video_id, reason = data.get('video_id'), data.get('reason', '')
    user_id = getattr(g, 'current_user_id', None)
    if not video_id or not reason:
        return jsonify({'error': 'video_id and reason are required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id, uploader_id FROM videos WHERE id = %s', (video_id,))
        vrow = cursor.fetchone()
        if not vrow:
            conn.close()
            return jsonify({'error': 'video not found'}), 404

        uploader_id = vrow['uploader_id']
        cursor.execute('INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (%s, %s, %s, %s) RETURNING id', (video_id, user_id, reason, False))
        report_id = cursor.fetchone()['id']
        conn.commit()

        try:
            reports_path = os.path.join(os.getcwd(), 'reports.txt')
            write_header = not os.path.exists(reports_path) or os.path.getsize(reports_path) == 0
            with open(reports_path, 'a', encoding='utf-8') as fh:
                if write_header:
                    fh.write('timestamp\tvideo_id\treported_user_id\treporting_user_id\treason\n')
                ts = datetime.utcnow().isoformat() + 'Z'
                safe_reason = str(reason).replace('\t', ' ').replace('\n', ' ').strip()
                fh.write(f"{ts}\t{video_id}\t{uploader_id}\t{user_id}\t{safe_reason}\n")
        except Exception:
            pass

        conn.close()
        return jsonify({'message': 'report submitted', 'report_id': report_id}), 201
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/report_user', methods=['POST'])
@token_required
def report_user():
    data = request.get_json() or {}
    reported_user_id, reason = data.get('reported_user_id'), data.get('reason', '')
    reporting_user_id = getattr(g, 'current_user_id', None)
    if not reported_user_id or not reason:
        return jsonify({'error': 'reported_user_id and reason are required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE id = %s', (reported_user_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'reported user not found'}), 404

        cursor.execute('INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (%s, %s, %s, %s) RETURNING id', (None, reporting_user_id, reason, False))
        report_id = cursor.fetchone()['id']
        conn.commit()

        try:
            reports_path = os.path.join(os.getcwd(), 'reports.txt')
            write_header = not os.path.exists(reports_path) or os.path.getsize(reports_path) == 0
            with open(reports_path, 'a', encoding='utf-8') as fh:
                if write_header:
                    fh.write('timestamp\tvideo_id\treported_user_id\treporting_user_id\treason\n')
                ts = datetime.utcnow().isoformat() + 'Z'
                safe_reason = str(reason).replace('\t', ' ').replace('\n', ' ').strip()
                fh.write(f"{ts}\t\t{reported_user_id}\t{reporting_user_id}\t{safe_reason}\n")
        except Exception:
            pass

        conn.close()
        return jsonify({'message': 'user report submitted', 'report_id': report_id}), 201
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/toggle_like', methods=['POST'])
@token_required
def toggle_like():
    data = request.get_json() or {}
    user_id = getattr(g, 'current_user_id', None)
    video_id = data.get('video_id')
    if not user_id or not video_id:
        return jsonify({'error': 'authenticated user and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT 1 FROM videos WHERE id = %s', (video_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        if redis_conn is not None:
            try:
                key_likes = f"video:{video_id}:likes"
                key_dislikes = f"video:{video_id}:dislikes"
                uid = str(user_id)
                if redis_conn.sismember(key_likes, uid):
                    redis_conn.srem(key_likes, uid)
                    action = 'unliked'
                else:
                    redis_conn.sadd(key_likes, uid)
                    redis_conn.srem(key_dislikes, uid)
                    action = 'liked'

                likes_count = int(redis_conn.scard(key_likes) or 0)
                dislikes_count = int(redis_conn.scard(key_dislikes) or 0)
                is_liked = bool(redis_conn.sismember(key_likes, uid))
                is_disliked = bool(redis_conn.sismember(key_dislikes, uid))
                conn.close()
                return jsonify({'message': action, 'likes_count': likes_count, 'dislikes_count': dislikes_count, 'is_liked': is_liked, 'is_disliked': is_disliked}), 200
            except Exception:
                pass

        cursor.execute('SELECT 1 FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        if cursor.fetchone():
            cursor.execute('DELETE FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'unliked'
        else:
            cursor.execute('INSERT INTO likes (user_id, video_id) VALUES (%s, %s) ON CONFLICT DO NOTHING', (user_id, video_id))
            cursor.execute('DELETE FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'liked'

        cursor.execute('SELECT COUNT(*) as cnt FROM likes WHERE video_id = %s', (video_id,))
        likes_count = cursor.fetchone()['cnt'] or 0
        cursor.execute('SELECT COUNT(*) as cnt FROM dislikes WHERE video_id = %s', (video_id,))
        dislikes_count = cursor.fetchone()['cnt'] or 0
        cursor.execute('UPDATE videos SET likes_count = %s, dislikes_count = %s WHERE id = %s', (likes_count, dislikes_count, video_id))
        conn.commit()

        cursor.execute('SELECT 1 FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        is_liked = cursor.fetchone() is not None
        cursor.execute('SELECT 1 FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        is_disliked = cursor.fetchone() is not None
        conn.close()
        return jsonify({'message': action, 'likes_count': likes_count, 'dislikes_count': dislikes_count, 'is_liked': bool(is_liked), 'is_disliked': bool(is_disliked)}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/toggle_dislike', methods=['POST'])
@token_required
def toggle_dislike():
    data = request.get_json() or {}
    user_id = getattr(g, 'current_user_id', None)
    video_id = data.get('video_id')
    if not user_id or not video_id:
        return jsonify({'error': 'authenticated user and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT 1 FROM videos WHERE id = %s', (video_id,))
        if not cursor.fetchone():
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        if redis_conn is not None:
            try:
                key_likes = f"video:{video_id}:likes"
                key_dislikes = f"video:{video_id}:dislikes"
                uid = str(user_id)
                if redis_conn.sismember(key_dislikes, uid):
                    redis_conn.srem(key_dislikes, uid)
                    action = 'removed_dislike'
                else:
                    redis_conn.sadd(key_dislikes, uid)
                    redis_conn.srem(key_likes, uid)
                    action = 'disliked'

                likes_count = int(redis_conn.scard(key_likes) or 0)
                dislikes_count = int(redis_conn.scard(key_dislikes) or 0)
                is_liked = bool(redis_conn.sismember(key_likes, uid))
                is_disliked = bool(redis_conn.sismember(key_dislikes, uid))
                conn.close()
                return jsonify({'message': action, 'likes_count': likes_count, 'dislikes_count': dislikes_count, 'is_liked': is_liked, 'is_disliked': is_disliked}), 200
            except Exception:
                pass

        cursor.execute('SELECT 1 FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        if cursor.fetchone():
            cursor.execute('DELETE FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'removed_dislike'
        else:
            cursor.execute('INSERT INTO dislikes (user_id, video_id) VALUES (%s, %s) ON CONFLICT DO NOTHING', (user_id, video_id))
            cursor.execute('DELETE FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'disliked'

        cursor.execute('SELECT COUNT(*) as cnt FROM likes WHERE video_id = %s', (video_id,))
        likes_count = cursor.fetchone()['cnt'] or 0
        cursor.execute('SELECT COUNT(*) as cnt FROM dislikes WHERE video_id = %s', (video_id,))
        dislikes_count = cursor.fetchone()['cnt'] or 0
        cursor.execute('UPDATE videos SET likes_count = %s, dislikes_count = %s WHERE id = %s', (likes_count, dislikes_count, video_id))
        conn.commit()

        cursor.execute('SELECT 1 FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        is_liked = cursor.fetchone() is not None
        cursor.execute('SELECT 1 FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        is_disliked = cursor.fetchone() is not None
        conn.close()
        return jsonify({'message': action, 'likes_count': likes_count, 'dislikes_count': dislikes_count, 'is_liked': bool(is_liked), 'is_disliked': bool(is_disliked)}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/admin/sync_redis', methods=['POST'])
def admin_sync_redis():
    try:
        if redis_conn is None:
            return jsonify({'error': 'Redis not configured'}), 400
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute('SELECT DISTINCT id FROM videos')
        video_ids = [r['id'] for r in cursor.fetchall()]
        for vid in video_ids:
            redis_conn.delete(f"video:{vid}:likes")
            redis_conn.delete(f"video:{vid}:dislikes")

        cursor.execute('SELECT video_id, user_id FROM likes')
        likes_synced = 0
        for row in cursor.fetchall():
            redis_conn.sadd(f"video:{row['video_id']}:likes", str(row['user_id']))
            likes_synced += 1

        cursor.execute('SELECT video_id, user_id FROM dislikes')
        dislikes_synced = 0
        for row in cursor.fetchall():
            redis_conn.sadd(f"video:{row['video_id']}:dislikes", str(row['user_id']))
            dislikes_synced += 1

        conn.close()
        return jsonify({'message': 'Redis synced successfully', 'likes_synced': likes_synced, 'dislikes_synced': dislikes_synced}), 200
    except Exception as e:
        return jsonify({'error': f'Sync error: {str(e)}'}), 500


@app.route('/videos', methods=['GET'])
def list_videos():
    current_user_id = None
    try:
        q_user = request.args.get('user_id')
        if q_user is not None:
            current_user_id = int(q_user)
    except Exception:
        current_user_id = None

    if current_user_id is None:
        auth = request.headers.get('Authorization')
        if auth and auth.startswith('Bearer '):
            try:
                payload = jwt.decode(auth.split()[1], SECRET_KEY, algorithms=[JWT_ALGORITHM])
                current_user_id = payload.get('user_id')
            except Exception:
                current_user_id = None

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT v.*, u.username, u.profile_pic_url,
        COALESCE(COUNT(DISTINCT c.id), 0) as comments_count
        FROM videos v
        LEFT JOIN users u ON v.uploader_id = u.id
        LEFT JOIN comments c ON v.id = c.video_id
        WHERE COALESCE(v.is_published, TRUE) = TRUE
        GROUP BY v.id, u.username, u.profile_pic_url
        ORDER BY (COALESCE(v.likes_count,0) + COALESCE(COUNT(DISTINCT c.id), 0)) DESC, v.created_at DESC
    ''')
    rows = cursor.fetchall()
    videos = []
    for r in rows:
        vid = r['id']
        if redis_conn is not None:
            try:
                likes_count = int(redis_conn.scard(f'video:{vid}:likes') or 0)
                dislikes_count = int(redis_conn.scard(f'video:{vid}:dislikes') or 0)
                is_liked_flag = False
                is_disliked_flag = False
                if current_user_id is not None:
                    is_liked_flag = bool(redis_conn.sismember(f'video:{vid}:likes', str(current_user_id)))
                    is_disliked_flag = bool(redis_conn.sismember(f'video:{vid}:dislikes', str(current_user_id)))
            except Exception:
                likes_count = r['likes_count'] or 0
                dislikes_count = r['dislikes_count'] or 0
                is_liked_flag = False
                is_disliked_flag = False
        else:
            likes_count = r['likes_count'] or 0
            dislikes_count = r['dislikes_count'] or 0
            is_liked_flag = False
            is_disliked_flag = False

        videos.append({
            'id': vid,
            'filename': r['filename'],
            'description': r['description'],
            'uploader_id': r['uploader_id'],
            'likes_count': likes_count,
            'dislikes_count': dislikes_count,
            'comments_count': int(r['comments_count']),
            'is_liked': is_liked_flag,
            'is_disliked': is_disliked_flag,
            'username': r['username'],
            'profile_pic_url': r['profile_pic_url']
        })
    conn.close()
    return jsonify({'videos': videos}), 200


@app.route('/upload', methods=['POST', 'OPTIONS'])
@token_required
def upload():
    if request.method == 'OPTIONS':
        return ''
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'file is required'}), 400

        file = request.files['file']
        user_id = request.form.get('user_id')
        description = request.form.get('description', '')

        if not user_id:
            return jsonify({'error': 'user_id is required'}), 400

        _, ext = os.path.splitext(file.filename)
        if ext.lower() not in ALLOWED_VIDEO_EXTENSIONS:
            return jsonify({'error': 'file type not allowed'}), 400

        upload_dir = os.path.join(os.getcwd(), 'uploads', 'videos')
        os.makedirs(upload_dir, exist_ok=True)

        unique_name = f"{uuid.uuid4().hex}{ext.lower()}"
        save_path = os.path.join(upload_dir, unique_name)
        file.save(save_path)

        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('INSERT INTO videos (filename, description, uploader_id) VALUES (%s, %s, %s) RETURNING id', (unique_name, description, user_id))
        video_id = cursor.fetchone()['id']
        conn.commit()
        conn.close()

        if _rq_queue is not None:
            try:
                _rq_queue.enqueue('backend.background_extract_and_save_thumbnail', save_path, video_id)
                _rq_queue.enqueue('backend.background_run_tagger', unique_name, video_id)
            except Exception:
                threading.Thread(target=background_extract_and_save_thumbnail, args=(save_path, video_id), daemon=True).start()
                threading.Thread(target=background_run_tagger, args=(unique_name, video_id), daemon=True).start()
        else:
            threading.Thread(target=background_extract_and_save_thumbnail, args=(save_path, video_id), daemon=True).start()
            threading.Thread(target=background_run_tagger, args=(unique_name, video_id), daemon=True).start()

        return jsonify({'message': 'upload successful', 'video_id': video_id, 'filename': unique_name}), 201
    except Exception as e:
        return jsonify({'error': f'upload error: {str(e)}'}), 500


@app.route('/upload_profile_pic', methods=['POST'])
@token_required
def upload_profile_pic():
    user_id = getattr(g, 'current_user_id', None)
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'file is required'}), 400

        file = request.files['file']
        _, ext = os.path.splitext(file.filename)
        if ext.lower() not in ALLOWED_PROFILE_EXTENSIONS:
            return jsonify({'error': 'file type not allowed'}), 400

        upload_dir = os.path.join(os.getcwd(), 'uploads', 'profiles')
        os.makedirs(upload_dir, exist_ok=True)

        unique_name = f"{uuid.uuid4().hex}{ext.lower()}"
        save_path = os.path.join(upload_dir, unique_name)
        file.save(save_path)

        relative_url = f"uploads/profiles/{unique_name}"
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('UPDATE users SET profile_pic_url = %s WHERE id = %s', (relative_url, user_id))
        conn.commit()
        conn.close()

        return jsonify({'message': 'profile picture uploaded', 'profile_pic_url': relative_url}), 201
    except Exception as e:
        return jsonify({'error': f'upload error: {str(e)}'}), 500


@app.route('/remove_profile_pic', methods=['POST'])
@token_required
def remove_profile_pic():
    user_id = getattr(g, 'current_user_id', None)
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT profile_pic_url FROM users WHERE id = %s', (user_id,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            return jsonify({'error': 'user not found'}), 400

        profile = row['profile_pic_url']
        if profile:
            try:
                file_path = os.path.join(os.getcwd(), profile)
                if os.path.exists(file_path):
                    os.remove(file_path)
            except Exception:
                pass

        cursor.execute('UPDATE users SET profile_pic_url = NULL WHERE id = %s', (user_id,))
        conn.commit()
        conn.close()
        return jsonify({'message': 'profile picture removed'}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/me', methods=['GET'])
@token_required
def me():
    user_id = getattr(g, 'current_user_id', None)
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id, username, profile_pic_url FROM users WHERE id = %s', (user_id,))
        row = cursor.fetchone()
        conn.close()
        if not row:
            return jsonify({'error': 'user not found'}), 400
        return jsonify({'user': dict(row)}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/video/<path:filename>', methods=['GET'])
def serve_video(filename):
    try:
        videos_dir = os.path.join(os.getcwd(), 'uploads', 'videos')
        file_path = os.path.join(videos_dir, filename)

        if not os.path.exists(file_path):
            return jsonify({'error': 'file not found'}), 404

        import mimetypes
        mime_type, _ = mimetypes.guess_type(file_path)
        mime_type = mime_type or 'video/mp4'
        file_size = os.path.getsize(file_path)
        range_header = request.headers.get('Range', None)

        if range_header:
            m = re.match(r'bytes=(\d+)-(\d*)', range_header)
            if not m:
                return Response(status=416)

            start = int(m.group(1))
            end_group = m.group(2)
            MAX_CHUNK = 1024 * 1024  # 1MB chunk limit
            end = min(int(end_group), start + MAX_CHUNK - 1, file_size - 1) if end_group else min(start + MAX_CHUNK - 1, file_size - 1)

            if start > end or start >= file_size:
                return Response(status=416)

            length = end - start + 1

            def generate():
                with open(file_path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    chunk_size = 64 * 1024
                    while remaining > 0:
                        read_size = min(chunk_size, remaining)
                        data = f.read(read_size)
                        if not data:
                            break
                        remaining -= len(data)
                        yield data

            headers = {
                'Content-Range': f'bytes {start}-{end}/{file_size}',
                'Accept-Ranges': 'bytes',
                'Content-Length': str(length),
                'Content-Type': mime_type,
            }
            return Response(generate(), status=206, headers=headers)
        else:
            return send_file(file_path, conditional=True, mimetype=mime_type)
    except Exception as e:
        return jsonify({'error': f'file serve error: {str(e)}'}), 500


@app.route('/uploads/profiles/<path:filename>', methods=['GET'])
def serve_profile_pic(filename):
    profiles_dir = os.path.join(os.getcwd(), 'uploads', 'profiles')
    return send_from_directory(profiles_dir, filename)


@app.route('/add_comment', methods=['POST'])
@token_required
def add_comment():
    data = request.get_json() or {}
    video_id, comment_text = data.get('video_id'), data.get('comment_text')
    user_id = getattr(g, 'current_user_id', None)
    if not video_id or not comment_text:
        return jsonify({'error': 'video_id and comment_text required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('INSERT INTO comments (video_id, user_id, comment_text) VALUES (%s, %s, %s) RETURNING id, timestamp', (video_id, user_id, comment_text))
        row = cursor.fetchone()
        conn.commit()
        conn.close()
        return jsonify({'message': 'comment added', 'comment': {'id': row['id'], 'video_id': video_id, 'user_id': user_id, 'comment_text': comment_text, 'timestamp': row['timestamp']}}), 201
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/record_interaction', methods=['POST'])
@token_required
def record_interaction():
    data = request.get_json() or {}
    user_id = getattr(g, 'current_user_id', None)
    video_id = data.get('video_id')
    watch_ms = data.get('watch_time_ms') if data.get('watch_time_ms') is not None else data.get('watch_time', 0)
    try:
        watch_ms = int(watch_ms or 0)
    except Exception:
        watch_ms = 0

    if not user_id or not video_id:
        return jsonify({'error': 'authenticated user and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT watch_time_ms FROM interactions WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        row = cursor.fetchone()
        if not row:
            cursor.execute('INSERT INTO interactions (user_id, video_id, watch_time_ms) VALUES (%s, %s, %s)', (user_id, video_id, watch_ms))
            total_watch = watch_ms
        else:
            total_watch = (row['watch_time_ms'] or 0) + watch_ms
            cursor.execute('UPDATE interactions SET watch_time_ms = %s WHERE user_id = %s AND video_id = %s', (total_watch, user_id, video_id))

        conn.commit()
        conn.close()
        return jsonify({'message': 'interaction recorded', 'watch_time_ms': total_watch}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/get_comments/<int:video_id>', methods=['GET'])
def get_comments(video_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT c.id, c.comment_text, c.timestamp, c.user_id, u.username, u.profile_pic_url
            FROM comments c JOIN users u ON c.user_id = u.id
            WHERE c.video_id = %s ORDER BY c.timestamp ASC
        ''', (video_id,))
        rows = cursor.fetchall()
        comments = [dict(r) for r in rows]
        conn.close()
        return jsonify({'comments': comments}), 200
    except Exception as e:
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/personalized_feed', methods=['GET'])
def personalized_feed():
    current_user_id = None
    try:
        q_user = request.args.get('user_id')
        if q_user is not None:
            current_user_id = int(q_user)
    except Exception:
        current_user_id = None

    if current_user_id is None:
        auth = request.headers.get('Authorization')
        if auth and auth.startswith('Bearer '):
            try:
                payload = jwt.decode(auth.split()[1], SECRET_KEY, algorithms=[JWT_ALGORITHM])
                current_user_id = payload.get('user_id')
            except Exception:
                current_user_id = None

    conn = get_db_connection()
    cursor = conn.cursor()

    user_param = current_user_id if current_user_id is not None else -1

    try:
        # Check if embedding column exists
        cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name='videos' AND column_name='embedding'")
        has_vector_col = cursor.fetchone() is not None

        if has_vector_col:
            sql = '''
WITH user_engaged_videos AS (
    -- Collect IDs of videos the user watched for >= 3s or liked
    SELECT v_sub.id, v_sub.embedding
    FROM interactions i
    JOIN videos v_sub ON i.video_id = v_sub.id
    WHERE i.user_id = %s
      AND (i.watch_time_ms >= 3000 OR EXISTS(SELECT 1 FROM likes l WHERE l.user_id = %s AND l.video_id = v_sub.id))
      AND v_sub.embedding IS NOT NULL
),
user_liked_tags AS (
    SELECT string_agg(v_sub.tags, ',') AS preferred_tags
    FROM interactions i
    JOIN videos v_sub ON i.video_id = v_sub.id
    WHERE i.user_id = %s AND (i.watch_time_ms >= 3000 OR EXISTS(SELECT 1 FROM likes l WHERE l.user_id = %s AND l.video_id = v_sub.id))
)
SELECT v.id, v.filename, v.thumbnail, v.description, v.uploader_id, u.username, u.profile_pic_url, v.tags, v.likes_count,
  COALESCE(COUNT(DISTINCT c.id), 0) as comments_count,

  -- 1. Watch Score
  CASE WHEN COALESCE(max_watch.max_w, 0) > 0 THEN CAST(COALESCE(user_watch.uw, 0) AS FLOAT) / max_watch.max_w ELSE 0 END AS watch_score,

  -- 2. Comment Score
  CASE WHEN EXISTS(
      SELECT 1 FROM comments c2 JOIN videos vv ON c2.video_id = vv.id WHERE c2.user_id = %s AND vv.uploader_id = v.uploader_id
  ) THEN 1 ELSE 0 END AS comment_score,

  -- 3. Like / Dislike Scores
  CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = %s AND lk.video_id = v.id) THEN 1 ELSE 0 END AS liked_score,
  CASE WHEN EXISTS(SELECT 1 FROM dislikes dk WHERE dk.user_id = %s AND dk.video_id = v.id) THEN 1 ELSE 0 END AS disliked_score,

  -- 4. AI Tag & Vector Cosine Similarity Score
  CASE
    WHEN v.embedding IS NOT NULL AND EXISTS(SELECT 1 FROM user_engaged_videos) THEN
      (SELECT AVG(1 - (v.embedding <=> uev.embedding)) FROM user_engaged_videos uev)
    WHEN v.tags IS NOT NULL AND v.tags != '' AND (SELECT preferred_tags FROM user_liked_tags) IS NOT NULL THEN
      LEAST(1.0, (SELECT COUNT(*) FROM unnest(string_to_array(v.tags, ',')) tag WHERE (SELECT preferred_tags FROM user_liked_tags) LIKE '%%' || tag || '%%') * 0.25)
    ELSE 0
  END AS ai_tag_score,

  -- 5. Global Popularity Fallback
  (COALESCE(v.likes_count, 0) + COALESCE(COUNT(DISTINCT c.id), 0)) AS global_popularity,

  -- Combined Weighted Score
  ((0.35 * (CASE WHEN COALESCE(max_watch.max_w,0) > 0 THEN CAST(COALESCE(user_watch.uw,0) AS FLOAT) / max_watch.max_w ELSE 0 END))
   + (0.25 * (
      CASE
        WHEN v.embedding IS NOT NULL AND EXISTS(SELECT 1 FROM user_engaged_videos) THEN
          (SELECT AVG(1 - (v.embedding <=> uev.embedding)) FROM user_engaged_videos uev)
        WHEN v.tags IS NOT NULL AND v.tags != '' AND (SELECT preferred_tags FROM user_liked_tags) IS NOT NULL THEN
          LEAST(1.0, (SELECT COUNT(*) FROM unnest(string_to_array(v.tags, ',')) tag WHERE (SELECT preferred_tags FROM user_liked_tags) LIKE '%%' || tag || '%%') * 0.25)
        ELSE 0
      END
     ))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM comments c3 JOIN videos vv ON c3.video_id = vv.id WHERE c3.user_id = %s AND vv.uploader_id = v.uploader_id) THEN 1 ELSE 0 END))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = %s AND lk.video_id = v.id) THEN 1 ELSE 0 END))
   - (0.30 * (CASE WHEN EXISTS(SELECT 1 FROM dislikes dk2 WHERE dk2.user_id = %s AND dk2.video_id = v.id) THEN 1 ELSE 0 END))
  ) AS weighted_score

FROM videos v
LEFT JOIN users u ON v.uploader_id = u.id
LEFT JOIN comments c ON v.id = c.video_id
LEFT JOIN (SELECT video_id, MAX(watch_time_ms) AS max_w FROM interactions GROUP BY video_id) AS max_watch ON max_watch.video_id = v.id
LEFT JOIN (SELECT video_id, watch_time_ms AS uw FROM interactions WHERE user_id = %s) AS user_watch ON user_watch.video_id = v.id
WHERE COALESCE(v.is_published, TRUE) = TRUE
GROUP BY v.id, u.username, u.profile_pic_url, max_watch.max_w, user_watch.uw, v.embedding
ORDER BY weighted_score DESC, global_popularity DESC, v.id DESC
'''
            params = (user_param, user_param, user_param, user_param, user_param, user_param, user_param, user_param, user_param, user_param, user_param)
        else:
            sql = '''
WITH user_liked_tags AS (
    SELECT string_agg(v_sub.tags, ',') AS preferred_tags
    FROM interactions i
    JOIN videos v_sub ON i.video_id = v_sub.id
    WHERE i.user_id = %s AND (i.watch_time_ms >= 3000 OR EXISTS(SELECT 1 FROM likes l WHERE l.user_id = %s AND l.video_id = v_sub.id))
)
SELECT v.id, v.filename, v.thumbnail, v.description, v.uploader_id, u.username, u.profile_pic_url, v.tags, v.likes_count,
  COALESCE(COUNT(DISTINCT c.id), 0) as comments_count,

  CASE WHEN COALESCE(max_watch.max_w, 0) > 0 THEN CAST(COALESCE(user_watch.uw, 0) AS FLOAT) / max_watch.max_w ELSE 0 END AS watch_score,

  CASE WHEN EXISTS(
      SELECT 1 FROM comments c2 JOIN videos vv ON c2.video_id = vv.id WHERE c2.user_id = %s AND vv.uploader_id = v.uploader_id
  ) THEN 1 ELSE 0 END AS comment_score,

  CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = %s AND lk.video_id = v.id) THEN 1 ELSE 0 END AS liked_score,
  CASE WHEN EXISTS(SELECT 1 FROM dislikes dk WHERE dk.user_id = %s AND dk.video_id = v.id) THEN 1 ELSE 0 END AS disliked_score,

  CASE
    WHEN v.tags IS NOT NULL AND v.tags != '' AND (SELECT preferred_tags FROM user_liked_tags) IS NOT NULL THEN
      (SELECT COUNT(*) FROM unnest(string_to_array(v.tags, ',')) tag
       WHERE (SELECT preferred_tags FROM user_liked_tags) LIKE '%%' || tag || '%%') * 0.25
    ELSE 0
  END AS ai_tag_score,

  (COALESCE(v.likes_count, 0) + COALESCE(COUNT(DISTINCT c.id), 0)) AS global_popularity,

  ((0.35 * (CASE WHEN COALESCE(max_watch.max_w,0) > 0 THEN CAST(COALESCE(user_watch.uw,0) AS FLOAT) / max_watch.max_w ELSE 0 END))
   + (0.25 * (
      CASE
        WHEN v.tags IS NOT NULL AND v.tags != '' AND (SELECT preferred_tags FROM user_liked_tags) IS NOT NULL THEN
          LEAST(1.0, (SELECT COUNT(*) FROM unnest(string_to_array(v.tags, ',')) tag WHERE (SELECT preferred_tags FROM user_liked_tags) LIKE '%%' || tag || '%%') * 0.25)
        ELSE 0
      END
     ))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM comments c3 JOIN videos vv ON c3.video_id = vv.id WHERE c3.user_id = %s AND vv.uploader_id = v.uploader_id) THEN 1 ELSE 0 END))
   + (0.15 * (CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = %s AND lk.video_id = v.id) THEN 1 ELSE 0 END))
   - (0.30 * (CASE WHEN EXISTS(SELECT 1 FROM dislikes dk2 WHERE dk2.user_id = %s AND dk2.video_id = v.id) THEN 1 ELSE 0 END))
  ) AS weighted_score

FROM videos v
LEFT JOIN users u ON v.uploader_id = u.id
LEFT JOIN comments c ON v.id = c.video_id
LEFT JOIN (SELECT video_id, MAX(watch_time_ms) AS max_w FROM interactions GROUP BY video_id) AS max_watch ON max_watch.video_id = v.id
LEFT JOIN (SELECT video_id, watch_time_ms AS uw FROM interactions WHERE user_id = %s) AS user_watch ON user_watch.video_id = v.id
WHERE COALESCE(v.is_published, TRUE) = TRUE
GROUP BY v.id, u.username, u.profile_pic_url, max_watch.max_w, user_watch.uw
ORDER BY weighted_score DESC, global_popularity DESC, v.id DESC
'''
            params = (user_param, user_param, user_param, user_param, user_param, user_param, user_param, user_param, user_param)

        cursor.execute(sql, params)
        rows = cursor.fetchall()
        results = []
        for r in rows:
            vid = r['id']
            if redis_conn is not None:
                try:
                    likes_count = int(redis_conn.scard(f'video:{vid}:likes') or 0)
                    dislikes_count = int(redis_conn.scard(f'video:{vid}:dislikes') or 0)
                    is_liked_flag = bool(redis_conn.sismember(f'video:{vid}:likes', str(current_user_id))) if current_user_id else False
                    is_disliked_flag = bool(redis_conn.sismember(f'video:{vid}:dislikes', str(current_user_id))) if current_user_id else False
                except Exception:
                    likes_count = r['likes_count'] or 0
                    dislikes_count = r['dislikes_count'] or 0
                    is_liked_flag = bool(r['liked_score'])
                    is_disliked_flag = bool(r['disliked_score'])
            else:
                likes_count = r['likes_count'] or 0
                dislikes_count = r['dislikes_count'] or 0
                is_liked_flag = bool(r['liked_score'])
                is_disliked_flag = bool(r['disliked_score'])

            results.append({
                'id': vid,
                'filename': r['filename'],
                'thumbnail': r['thumbnail'],
                'description': r['description'],
                'uploader_id': r['uploader_id'],
                'username': r['username'],
                'profile_pic_url': r['profile_pic_url'],
                'tags': r['tags'],
                'likes_count': likes_count,
                'comments_count': r['comments_count'] or 0,
                'is_liked': is_liked_flag,
                'is_disliked': is_disliked_flag,
                'dislikes_count': dislikes_count,
                'weighted_score': r['weighted_score']
            })
        conn.close()
        return jsonify({'videos': results}), 200
    except Exception as e:
        if conn:
            conn.close()
        return jsonify({'error': f'personalized feed error: {str(e)}'}), 500

if __name__ == '__main__':
    from init_postgresql import init_postgresql
    try:
        print("🚀 Initializing Database Tables...")
        init_postgresql()
        ensure_profile_column()
        ensure_is_published_column()
        print("✅ Database Tables Ready.")
    except Exception as e:
        print(f"❌ Database Init Failed: {e}")

    app.run(host='0.0.0.0', port=5000, debug=True)

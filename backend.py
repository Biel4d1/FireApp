from flask import Flask, request, jsonify, send_from_directory, g, Response
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
    # Echo the incoming Origin when present (safer when credentials are used).
    origin = request.headers.get('Origin')
    if origin:
        response.headers['Access-Control-Allow-Origin'] = origin
    else:
        # React Native can send Origin: null — allow it explicitly
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
        # Sync Redis with database in background to avoid blocking first request
        threading.Thread(target=_sync_redis_from_db, daemon=True).start()

# increase maximum upload size to 100 MB
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

# RQ (Redis Queue) setup: use REDIS_URL env or default to localhost
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
        
        # Sync all likes to Redis
        cursor.execute('SELECT video_id, user_id FROM likes')
        for row in cursor.fetchall():
            video_id = row['video_id']
            user_id = row['user_id']
            key_likes = f"video:{video_id}:likes"
            redis_conn.sadd(key_likes, str(user_id))
        
        # Sync all dislikes to Redis
        cursor.execute('SELECT video_id, user_id FROM dislikes')
        for row in cursor.fetchall():
            video_id = row['video_id']
            user_id = row['user_id']
            key_dislikes = f"video:{video_id}:dislikes"
            redis_conn.sadd(key_dislikes, str(user_id))
        
        conn.close()
        print("[INFO] Redis synced with database likes and dislikes on startup")
    except Exception as e:
        print(f"[WARNING] Failed to sync Redis with database: {str(e)}")


def _get_redis_counts(video_id):
    """Return (likes_count, dislikes_count) from Redis if available, else (None, None)."""
    try:
        if redis_conn is None:
            return (None, None)
        key_likes = f"video:{video_id}:likes"
        key_dislikes = f"video:{video_id}:dislikes"
        likes = int(redis_conn.scard(key_likes) or 0)
        dislikes = int(redis_conn.scard(key_dislikes) or 0)
        return (likes, dislikes)
    except Exception:
        return (None, None)

# Serve static files from uploads directory (videos, profiles)
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
        # Prefer system ffmpeg; fall back to bundled binary in repo if unavailable
        ffmpeg_bin = shutil.which('ffmpeg') or os.path.join(os.getcwd(), 'ffmpeg-static', 'ffmpeg')
        # Ensure file exists for the chosen binary path
        if not os.path.exists(ffmpeg_bin):
            ffmpeg_bin = os.path.join(os.getcwd(), 'ffmpeg-static', 'ffmpeg')

        # Try to make bundled binary executable if needed
        try:
            if os.path.exists(ffmpeg_bin) and not os.access(ffmpeg_bin, os.X_OK):
                os.chmod(ffmpeg_bin, 0o755)
        except Exception:
            pass

        cmd = [
            ffmpeg_bin,
            '-nostdin',
            '-loglevel', 'error',
            '-ss', '1',  # seek to 1 second (fast)
            '-i', video_path,
            '-vframes', '1',  # Extract only 1 frame
            '-vf', 'scale=320:320',  # Scale to 320x320
            '-y',  # Overwrite output file
            thumbnail_path
        ]

        try:
            # Increase timeout to 90s to handle slower machines/large codec negotiation
            proc = subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
            return True
        except subprocess.TimeoutExpired as te:
            # If ffmpeg timed out, log and attempt a best-effort run without timeout
            try:
                print('FFmpeg timed out, retrying without timeout...')
            except Exception:
                pass
            try:
                proc2 = subprocess.run(cmd, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if proc2.returncode == 0:
                    return True
                else:
                    try:
                        print('FFmpeg retry failed, rc=', proc2.returncode)
                    except Exception:
                        pass
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
                            try:
                                conn = get_db_connection()
                                cursor = conn.cursor()
                                cursor.execute('UPDATE videos SET thumbnail = %s WHERE id = %s', (thumb_relative, video_id))
                                conn.commit()
                                conn.close()
                                print(f'Thumbnail extracted for video {video_id}: {thumb_relative}')
                            except Exception as e:
                                try:
                                    print('Background DB update failed for thumbnail:', e)
                                except Exception:
                                    pass
                        else:
                            try:
                                print(f'Failed to extract thumbnail for video {video_id}')
                            except Exception:
                                pass
                    except Exception as e:
                        try:
                            print(f'Background thumbnail extraction error for video {video_id}: {e}')
                        except Exception:
                            pass


                def background_run_tagger(filename, video_id):
                    """Background task to run AI tagging and optionally flag videos."""
                    try:
                        tags = tag_videos.tag_file(filename, video_dir=os.path.join(os.getcwd(), 'uploads', 'videos'))
                        if tags:
                            toks = [t.strip().lower() for t in tags.split(',') if t.strip()]
                            flagged = any(k in toks for k in ('violence', 'nudity'))
                            if flagged:
                                try:
                                    conn = get_db_connection()
                                    cur = conn.cursor()
                                    reason = 'AI flagged tags: ' + ','.join(toks)
                                    try:
                                        cur.execute('UPDATE videos SET is_published = %s WHERE id = %s', (False, video_id))
                                    except Exception:
                                        pass
                                    cur.execute('INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (%s, %s, %s, %s)', (video_id, None, reason, True))
                                    conn.commit()
                                    conn.close()
                                except Exception as e:
                                    try:
                                        print('Async report insert failed', e)
                                    except Exception:
                                        pass
                    except Exception as e:
                        try:
                            print('Async tagging failed for', filename, e)
                        except Exception:
                            pass
            except Exception as e:
                try:
                    print('FFmpeg retry exception:', str(e))
                except Exception:
                    pass
                return False
        except subprocess.CalledProcessError as cpe:
            # CalledProcessError contains stderr; surface it for debugging
            stderr = getattr(cpe, 'stderr', None)
            if stderr:
                try:
                    print('FFmpeg thumbnail extraction failed:', stderr.decode('utf-8', errors='replace'))
                except Exception:
                    print('FFmpeg thumbnail extraction failed:', stderr)
            else:
                try:
                    print('FFmpeg thumbnail extraction failed:', str(cpe))
                except Exception:
                    pass
            return False
    except Exception as e:
        # Log stderr when available for easier debugging
        try:
            # If CalledProcessError, it may have stdout/stderr attributes
            stderr = getattr(e, 'stderr', None)
            if stderr:
                try:
                    print('FFmpeg thumbnail extraction failed:', stderr.decode('utf-8', errors='replace'))
                except Exception:
                    print('FFmpeg thumbnail extraction failed:', stderr)
            else:
                print(f'FFmpeg thumbnail extraction failed: {str(e)}')
        except Exception:
            try:
                print(f'FFmpeg thumbnail extraction failed: {str(e)}')
            except Exception:
                pass
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
            try:
                conn = get_db_connection()
                cursor = conn.cursor()
                cursor.execute('UPDATE videos SET thumbnail = %s WHERE id = %s', (thumb_relative, video_id))
                conn.commit()
                conn.close()
                print(f'Thumbnail extracted for video {video_id}: {thumb_relative}')
            except Exception as e:
                try:
                    print('Background DB update failed for thumbnail:', e)
                except Exception:
                    pass
        else:
            try:
                print(f'Failed to extract thumbnail for video {video_id}')
            except Exception:
                pass
    except Exception as e:
        try:
            print(f'Background thumbnail extraction error for video {video_id}: {e}')
        except Exception:
            pass


def background_run_tagger(filename, video_id):
    """Background task to run AI tagging and optionally flag videos."""
    try:
        tags = tag_videos.tag_file(filename, video_dir=os.path.join(os.getcwd(), 'uploads', 'videos'))
        if tags:
            toks = [t.strip().lower() for t in tags.split(',') if t.strip()]
            flagged = any(k in toks for k in ('violence', 'nudity'))
            if flagged:
                try:
                    conn = get_db_connection()
                    cur = conn.cursor()
                    reason = 'AI flagged tags: ' + ','.join(toks)
                    try:
                        cur.execute('UPDATE videos SET is_published = %s WHERE id = %s', (False, video_id))
                    except Exception:
                        pass
                    cur.execute('INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (%s, %s, %s, %s)', (video_id, None, reason, True))
                    conn.commit()
                    conn.close()
                except Exception as e:
                    try:
                        print('Async report insert failed', e)
                    except Exception:
                        pass
    except Exception as e:
        try:
            print('Async tagging failed for', filename, e)
        except Exception:
            pass


def get_db_connection():
    """
    Return a psycopg2 connection using RealDictCursor. Supports DATABASE_URL
    or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE env vars.
    """
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


def ensure_profile_column():
    """Add profile_pic_url column to users if it doesn't exist."""
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
    """Add is_published column to videos if it doesn't exist (default TRUE)."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name='videos'")
        cols = [r['column_name'] for r in cursor.fetchall()]
        if 'is_published' not in cols:
            # default to TRUE so existing videos remain visible
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
    # PyJWT >=2 returns str, older versions return bytes
    if isinstance(token, bytes):
        token = token.decode('utf-8')
    return token


def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', None)
        if not auth:
            return jsonify({'error': 'Authorization header required'}), 401

        parts = auth.split()
        if len(parts) != 2 or parts[0].lower() != 'bearer':
            return jsonify({'error': 'Authorization header must be Bearer token'}), 401

        token = parts[1]
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
            g.current_user_id = payload.get('user_id')
        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'token expired'}), 401
        except Exception:
            return jsonify({'error': 'invalid token'}), 401

        return f(*args, **kwargs)

    return decorated





@app.route('/signup', methods=['POST'])
def signup():
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE username = %s', (username,))
        existing = cursor.fetchone()
        if existing:
            conn.close()
            return jsonify({'error': 'username taken'}), 409

        hashed = generate_password_hash(password)
        cursor.execute('INSERT INTO users (username, password) VALUES (%s, %s) RETURNING id', (username, hashed))
        user_row = cursor.fetchone()
        conn.commit()
        user_id = user_row['id'] if user_row else None
        conn.close()
        return jsonify({'message': 'user created', 'user_id': user_id}), 201
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id, password FROM users WHERE username = %s', (username,))
        row = cursor.fetchone()
        if row is None:
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401

        user_id = row['id']
        hashed = row['password']
        if not check_password_hash(hashed, password):
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401

        token = generate_token(user_id)
        conn.close()
        return jsonify({'message': 'login successful', 'token': token}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/delete_account', methods=['DELETE'])
@token_required
def delete_account():
    data = request.get_json() or {}
    password = data.get('password')
    # user id comes from token
    user_id = getattr(g, 'current_user_id', None)

    if user_id is None or not password:
        return jsonify({'error': 'password is required and valid token required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT password FROM users WHERE id = %s', (user_id,))
        row = cursor.fetchone()
        if row is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400

        if not check_password_hash(row['password'], password):
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401

        cursor.execute('DELETE FROM users WHERE id = %s', (user_id,))
        conn.commit()
        conn.close()
        return jsonify({'message': 'account deleted'}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/delete_video/<int:video_id>', methods=['DELETE'])
@token_required
def delete_video(video_id):
    user_id = getattr(g, 'current_user_id', None)
    if user_id is None:
        return jsonify({'error': 'valid token required'}), 401
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT filename, thumbnail, uploader_id FROM videos WHERE id = %s', (video_id,))
        row = cursor.fetchone()
        if row is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 404
        if row['uploader_id'] != user_id:
            conn.close()
            return jsonify({'error': 'not authorized to delete this video'}), 403

        # Delete row and get filenames to remove from disk
        cursor.execute('DELETE FROM videos WHERE id = %s RETURNING filename, thumbnail', (video_id,))
        deleted = cursor.fetchone()
        conn.commit()
        conn.close()

        # Remove physical files if present
        try:
            if deleted and deleted.get('filename'):
                fpath = os.path.join(os.getcwd(), 'uploads', 'videos', deleted['filename'])
                if os.path.exists(fpath):
                    os.remove(fpath)
            if deleted and deleted.get('thumbnail'):
                thumb_rel = deleted['thumbnail']
                thumb_path = os.path.join(os.getcwd(), 'uploads', 'videos', thumb_rel)
                if os.path.exists(thumb_path):
                    os.remove(thumb_path)
        except Exception:
            pass

        return jsonify({'message': 'video deleted'}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/delete_comment/<int:comment_id>', methods=['DELETE'])
@token_required
def delete_comment(comment_id):
    user_id = getattr(g, 'current_user_id', None)
    if user_id is None:
        return jsonify({'error': 'valid token required'}), 401
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT user_id FROM comments WHERE id = %s', (comment_id,))
        row = cursor.fetchone()
        if row is None:
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
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/report_video', methods=['POST'])
@token_required
def report_video():
    data = request.get_json() or {}
    video_id = data.get('video_id')
    reason = data.get('reason', '')
    user_id = getattr(g, 'current_user_id', None)
    if video_id is None or not reason:
        return jsonify({'error': 'video_id and reason are required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        # verify video exists and get uploader id
        cursor.execute('SELECT id, uploader_id FROM videos WHERE id = %s', (video_id,))
        vrow = cursor.fetchone()
        if vrow is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 404

        uploader_id = vrow.get('uploader_id') if isinstance(vrow, dict) else vrow[1]

        cursor.execute('INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (%s, %s, %s, %s) RETURNING id', (video_id, user_id, reason, False))
        row = cursor.fetchone()
        conn.commit()
        report_id = row['id'] if row else None

        # Also append to a flat reports.txt file for simple auditing (best-effort)
        try:
            reports_path = os.path.join(os.getcwd(), 'reports.txt')
            write_header = False
            if not os.path.exists(reports_path) or os.path.getsize(reports_path) == 0:
                write_header = True
            with open(reports_path, 'a', encoding='utf-8') as fh:
                if write_header:
                    fh.write('timestamp\tvideo_id\treported_user_id\treporting_user_id\treason\n')
                from datetime import datetime as _dt
                ts = _dt.utcnow().isoformat() + 'Z'
                # sanitize reason newlines/tabs
                safe_reason = str(reason).replace('\t', ' ').replace('\n', ' ').strip()
                fh.write(f"{ts}\t{video_id}\t{uploader_id}\t{user_id}\t{safe_reason}\n")
        except Exception:
            # best-effort only; do not fail the API if file write fails
            pass

        conn.close()
        return jsonify({'message': 'report submitted', 'report_id': report_id}), 201
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/report_user', methods=['POST'])
@token_required
def report_user():
    data = request.get_json() or {}
    reported_user_id = data.get('reported_user_id')
    reason = data.get('reason', '')
    reporting_user_id = getattr(g, 'current_user_id', None)
    if reported_user_id is None or not reason:
        return jsonify({'error': 'reported_user_id and reason are required'}), 400
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        # optionally verify reported user exists
        cursor.execute('SELECT id FROM users WHERE id = %s', (reported_user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'reported user not found'}), 404

        cursor.execute('INSERT INTO reports (video_id, user_id, reason, is_ai_flagged) VALUES (%s, %s, %s, %s) RETURNING id', (None, reporting_user_id, reason, False))
        row = cursor.fetchone()
        conn.commit()
        report_id = row['id'] if row else None

        # Append to reports.txt (best-effort) with reported_user_id noted
        try:
            reports_path = os.path.join(os.getcwd(), 'reports.txt')
            write_header = False
            if not os.path.exists(reports_path) or os.path.getsize(reports_path) == 0:
                write_header = True
            with open(reports_path, 'a', encoding='utf-8') as fh:
                if write_header:
                    fh.write('timestamp\tvideo_id\treported_user_id\treporting_user_id\treason\n')
                from datetime import datetime as _dt
                ts = _dt.utcnow().isoformat() + 'Z'
                safe_reason = str(reason).replace('\t', ' ').replace('\n', ' ').strip()
                fh.write(f"{ts}\t\t{reported_user_id}\t{reporting_user_id}\t{safe_reason}\n")
        except Exception:
            pass

        conn.close()
        return jsonify({'message': 'user report submitted', 'report_id': report_id}), 201
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/toggle_like', methods=['POST'])
@token_required
def toggle_like():
    data = request.get_json() or {}
    # Respect only the authenticated user from the token; ignore any user_id provided by client
    user_id = getattr(g, 'current_user_id', None)
    video_id = data.get('video_id')

    if user_id is None or video_id is None:
        return jsonify({'error': 'authenticated user and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        # verify video exists
        cursor.execute('SELECT 1 FROM videos WHERE id = %s', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        # If Redis is available, use Redis Sets to track likes/dislikes
        if redis_conn is not None:
            try:
                key_likes = f"video:{video_id}:likes"
                key_dislikes = f"video:{video_id}:dislikes"
                uid = str(user_id)
                liked = redis_conn.sismember(key_likes, uid)
                if liked:
                    redis_conn.srem(key_likes, uid)
                    action = 'unliked'
                else:
                    redis_conn.sadd(key_likes, uid)
                    # remove any existing dislike for this user
                    redis_conn.srem(key_dislikes, uid)
                    action = 'liked'

                likes_count = int(redis_conn.scard(key_likes) or 0)
                dislikes_count = int(redis_conn.scard(key_dislikes) or 0)
                is_liked = bool(redis_conn.sismember(key_likes, uid))
                is_disliked = bool(redis_conn.sismember(key_dislikes, uid))
                conn.close()
                return jsonify({'message': action, 'likes_count': likes_count, 'dislikes_count': dislikes_count, 'is_liked': is_liked, 'is_disliked': is_disliked}), 200
            except Exception:
                # Fall back to DB behavior if Redis operations fail
                pass

        # Fallback: use DB if Redis not configured or operation failed
        cursor.execute('SELECT 1 FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        liked = cursor.fetchone() is not None

        if liked:
            cursor.execute('DELETE FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'unliked'
        else:
            cursor.execute('INSERT INTO likes (user_id, video_id) VALUES (%s, %s) ON CONFLICT DO NOTHING', (user_id, video_id))
            cursor.execute('DELETE FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'liked'

        # Recompute authoritative counts and update videos table
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
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/toggle_dislike', methods=['POST'])
@token_required
def toggle_dislike():
    data = request.get_json() or {}
    # Respect only the authenticated user from the token; ignore any user_id provided by client
    user_id = getattr(g, 'current_user_id', None)
    video_id = data.get('video_id')

    if user_id is None or video_id is None:
        return jsonify({'error': 'authenticated user and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        # verify video exists
        cursor.execute('SELECT 1 FROM videos WHERE id = %s', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        # If Redis is available, use Redis Sets to track likes/dislikes
        if redis_conn is not None:
            try:
                key_likes = f"video:{video_id}:likes"
                key_dislikes = f"video:{video_id}:dislikes"
                uid = str(user_id)
                disliked = redis_conn.sismember(key_dislikes, uid)
                if disliked:
                    redis_conn.srem(key_dislikes, uid)
                    action = 'removed_dislike'
                else:
                    redis_conn.sadd(key_dislikes, uid)
                    # remove any existing like for this user
                    redis_conn.srem(key_likes, uid)
                    action = 'disliked'

                likes_count = int(redis_conn.scard(key_likes) or 0)
                dislikes_count = int(redis_conn.scard(key_dislikes) or 0)
                is_liked = bool(redis_conn.sismember(key_likes, uid))
                is_disliked = bool(redis_conn.sismember(key_dislikes, uid))
                conn.close()
                return jsonify({'message': action, 'likes_count': likes_count, 'dislikes_count': dislikes_count, 'is_liked': is_liked, 'is_disliked': is_disliked}), 200
            except Exception:
                # Fall back to DB behavior if Redis operations fail
                pass

        # Fallback: use DB if Redis not configured or operation failed
        cursor.execute('SELECT 1 FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        disliked = cursor.fetchone() is not None

        if disliked:
            cursor.execute('DELETE FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'removed_dislike'
        else:
            cursor.execute('INSERT INTO dislikes (user_id, video_id) VALUES (%s, %s) ON CONFLICT DO NOTHING', (user_id, video_id))
            cursor.execute('DELETE FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
            action = 'disliked'

        # Recompute authoritative counts for this video and persist
        cursor.execute('SELECT COUNT(*) as cnt FROM likes WHERE video_id = %s', (video_id,))
        likes_count = cursor.fetchone()['cnt'] or 0
        cursor.execute('SELECT COUNT(*) as cnt FROM dislikes WHERE video_id = %s', (video_id,))
        dislikes_count = cursor.fetchone()['cnt'] or 0
        cursor.execute('UPDATE videos SET likes_count = %s, dislikes_count = %s WHERE id = %s', (likes_count, dislikes_count, video_id))
        conn.commit()

        # authoritative flags
        cursor.execute('SELECT 1 FROM likes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        is_liked = cursor.fetchone() is not None
        cursor.execute('SELECT 1 FROM dislikes WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        is_disliked = cursor.fetchone() is not None
        conn.close()
        return jsonify({'message': action, 'likes_count': likes_count, 'dislikes_count': dislikes_count, 'is_liked': bool(is_liked), 'is_disliked': bool(is_disliked)}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/admin/sync_redis', methods=['POST'])
def admin_sync_redis():
    """Admin endpoint to manually sync Redis with database likes/dislikes.
    
    This is useful if Redis was cleared or became out of sync with the database.
    """
    # Optional: Add an admin auth check here if needed
    # For now, this is available to help debug. Consider adding authentication in production.
    
    try:
        if redis_conn is None:
            return jsonify({'error': 'Redis not configured'}), 400
        
        # Clear existing Redis like/dislike data
        cursor = None
        try:
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # Get all video IDs to find all potential Redis keys
            cursor.execute('SELECT DISTINCT id FROM videos')
            video_ids = [r['id'] for r in cursor.fetchall()]
            
            # Clear all existing Redis like/dislike keys for these videos
            for vid in video_ids:
                redis_conn.delete(f"video:{vid}:likes")
                redis_conn.delete(f"video:{vid}:dislikes")
            
            # Re-sync likes
            cursor.execute('SELECT video_id, user_id FROM likes')
            likes_synced = 0
            for row in cursor.fetchall():
                video_id = row['video_id']
                user_id = row['user_id']
                key_likes = f"video:{video_id}:likes"
                redis_conn.sadd(key_likes, str(user_id))
                likes_synced += 1
            
            # Re-sync dislikes
            cursor.execute('SELECT video_id, user_id FROM dislikes')
            dislikes_synced = 0
            for row in cursor.fetchall():
                video_id = row['video_id']
                user_id = row['user_id']
                key_dislikes = f"video:{video_id}:dislikes"
                redis_conn.sadd(key_dislikes, str(user_id))
                dislikes_synced += 1
            
            conn.close()
            return jsonify({'message': 'Redis synced successfully', 'likes_synced': likes_synced, 'dislikes_synced': dislikes_synced}), 200
        except Exception as e:
            if cursor:
                try:
                    conn.close()
                except Exception:
                    pass
            return jsonify({'error': f'Sync error: {str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': f'Admin sync error: {str(e)}'}), 500


@app.route('/videos', methods=['GET'])
def list_videos():
    # Prefer an explicit user_id query param (sent by some clients). If not provided,
    # fall back to decoding the Authorization Bearer token when present.
    current_user_id = None
    # check query param first
    try:
        q_user = request.args.get('user_id')
        if q_user is not None:
            # try to coerce to int, otherwise ignore
            try:
                current_user_id = int(q_user)
            except Exception:
                current_user_id = None
    except Exception:
        current_user_id = None

    # if no explicit user_id, attempt to decode token
    if current_user_id is None:
        auth = request.headers.get('Authorization')
        if auth and auth.startswith('Bearer '):
            try:
                token = auth.split()[1]
                payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
                current_user_id = payload.get('user_id')
            except:
                current_user_id = None

    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Fetch all videos with basic info
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
        # Use Redis for live counts and user-specific is_liked status when available
        if redis_conn is not None:
            try:
                # Get Redis counts for likes/dislikes
                likes_count = int(redis_conn.scard(f'video:{vid}:likes') or 0)
                dislikes_count = int(redis_conn.scard(f'video:{vid}:dislikes') or 0)
                # Check if current user has liked this video (Redis)
                is_liked_flag = False
                is_disliked_flag = False
                if current_user_id is not None:
                    is_liked_flag = bool(redis_conn.sismember(f'video:{vid}:likes', str(current_user_id)))
                    is_disliked_flag = bool(redis_conn.sismember(f'video:{vid}:dislikes', str(current_user_id)))
            except Exception:
                # Fall back to DB if Redis fails
                likes_count = int(r['likes_count']) if r['likes_count'] is not None else 0
                dislikes_count = int(r['dislikes_count']) if ('dislikes_count' in r.keys() and r['dislikes_count'] is not None) else 0
                # Check DB for is_liked
                is_liked_flag = False
                is_disliked_flag = False
                if current_user_id is not None:
                    cursor.execute('SELECT 1 FROM likes WHERE user_id = %s AND video_id = %s', (current_user_id, vid))
                    is_liked_flag = cursor.fetchone() is not None
                    cursor.execute('SELECT 1 FROM dislikes WHERE user_id = %s AND video_id = %s', (current_user_id, vid))
                    is_disliked_flag = cursor.fetchone() is not None
        else:
            # No Redis available, use DB
            likes_count = int(r['likes_count']) if r['likes_count'] is not None else 0
            dislikes_count = int(r['dislikes_count']) if ('dislikes_count' in r.keys() and r['dislikes_count'] is not None) else 0
            # Check DB for is_liked
            is_liked_flag = False
            is_disliked_flag = False
            if current_user_id is not None:
                cursor.execute('SELECT 1 FROM likes WHERE user_id = %s AND video_id = %s', (current_user_id, vid))
                is_liked_flag = cursor.fetchone() is not None
                cursor.execute('SELECT 1 FROM dislikes WHERE user_id = %s AND video_id = %s', (current_user_id, vid))
                is_disliked_flag = cursor.fetchone() is not None
        
        videos.append({
            'id': vid,
            'filename': r['filename'],
            'description': r['description'],
            'uploader_id': r['uploader_id'],
            'likes_count': likes_count,
            'dislikes_count': dislikes_count,
            'comments_count': int(r['comments_count']) if ('comments_count' in r.keys() and r['comments_count'] is not None) else 0,
            'is_liked': is_liked_flag,
            'is_disliked': is_disliked_flag,
            'username': r['username'],
            'profile_pic_url': r['profile_pic_url']
        })
    conn.close()
    return jsonify({'videos': videos}), 200


@app.route('/upload', methods=['POST','OPTIONS'])
@token_required
def upload():
    # handle preflight OPTIONS
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

        if file.filename == '':
            return jsonify({'error': 'no selected file'}), 400

        _, ext = os.path.splitext(file.filename)
        ext = ext.lower()
        if ext not in ALLOWED_VIDEO_EXTENSIONS:
            return jsonify({'error': 'file type not allowed'}), 400

        upload_dir = os.path.join(os.getcwd(), 'uploads', 'videos')
        os.makedirs(upload_dir, exist_ok=True)

        safe_name = secure_filename(file.filename)
        unique_name = f"{uuid.uuid4().hex}{ext}"
        save_path = os.path.join(upload_dir, unique_name)
        file.save(save_path)

    except Exception as e:
        return jsonify({'error': f'file upload error: {str(e)}'}), 500

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        try:
            os.remove(save_path)
        except Exception:
            pass
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT id FROM users WHERE id = %s', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            try:
                os.remove(save_path)
            except Exception:
                pass
            return jsonify({'error': 'uploader (user_id) not found'}), 400
    except Exception as e:
        conn.close()
        try:
            os.remove(save_path)
        except Exception:
            pass
        return jsonify({'error': f'db query error (user check): {str(e)}'}), 500

    try:
        cursor.execute(
            'INSERT INTO videos (filename, description, uploader_id) VALUES (%s, %s, %s) RETURNING id',
            (unique_name, description, user_id)
        )
        vid_row = cursor.fetchone()
        conn.commit()
        video_id = vid_row['id'] if vid_row else None
        
        # Enqueue background jobs for thumbnail extraction and AI tagging (RQ).
        try:
            if _rq_queue is not None:
                # enqueue thumbnail extraction
                try:
                    _rq_queue.enqueue('backend.background_extract_and_save_thumbnail', save_path, video_id)
                except Exception:
                    # best-effort fallback to local thread if enqueue fails
                    try:
                        thumb_thread = threading.Thread(target=background_extract_and_save_thumbnail, args=(save_path, video_id), daemon=True)
                        thumb_thread.start()
                    except Exception:
                        pass

                # enqueue AI tagger
                try:
                    _rq_queue.enqueue('backend.background_run_tagger', unique_name, video_id)
                except Exception:
                    try:
                        t = threading.Thread(target=background_run_tagger, args=(unique_name, video_id), daemon=True)
                        t.start()
                    except Exception:
                        pass
            else:
                # If RQ isn't configured, fall back to local daemon threads (preserve previous behavior)
                try:
                    thumb_thread = threading.Thread(target=background_extract_and_save_thumbnail, args=(save_path, video_id), daemon=True)
                    thumb_thread.start()
                except Exception:
                    pass
                try:
                    t = threading.Thread(target=background_run_tagger, args=(unique_name, video_id), daemon=True)
                    t.start()
                except Exception:
                    pass
        except Exception:
            # Do not block upload on background task failures
            pass
    except Exception as e:
        try:
            os.remove(save_path)
        except Exception:
            pass
        conn.close()
        return jsonify({'error': f'db insert error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'upload successful', 'video_id': video_id, 'filename': unique_name}), 201


@app.route('/upload_profile_pic', methods=['POST'])
@token_required
def upload_profile_pic():
    user_id = getattr(g, 'current_user_id', None)
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'file is required'}), 400

        file = request.files['file']
        if file.filename == '':
            return jsonify({'error': 'no selected file'}), 400

        _, ext = os.path.splitext(file.filename)
        ext = ext.lower()
        if ext not in ALLOWED_PROFILE_EXTENSIONS:
            return jsonify({'error': 'file type not allowed'}), 400

        upload_dir = os.path.join(os.getcwd(), 'uploads', 'profiles')
        # ensure directory exists and is writable
        try:
            os.makedirs(upload_dir, exist_ok=True)
        except Exception as e:
            print('UPLOAD PROFILE ERROR: cannot create upload dir', upload_dir, e)
            return jsonify({'error': 'cannot create upload directory'}), 500

        if not os.access(upload_dir, os.W_OK):
            print('UPLOAD PROFILE ERROR: upload dir not writable:', upload_dir)
            return jsonify({'error': 'upload directory not writable'}), 500

        unique_name = f"{uuid.uuid4().hex}{ext}"
        save_path = os.path.join(upload_dir, unique_name)
        try:
            file.save(save_path)
            print('UPLOAD PROFILE: saved file to', save_path)
        except Exception as e:
            print('UPLOAD PROFILE ERROR: file.save failed', e)
            return jsonify({'error': f'file save error: {str(e)}'}), 500

        # Update user's profile_pic_url in DB
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE id = %s', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            try:
                os.remove(save_path)
            except Exception:
                pass
            return jsonify({'error': 'user not found'}), 400

        # return full URL so clients (phones/ngrok) can fetch the image
        host = request.host_url.rstrip('/')
        profile_url = f"{host}/uploads/profiles/{unique_name}"
        try:
            cursor.execute('UPDATE users SET profile_pic_url = %s WHERE id = %s', (profile_url, user_id))
            conn.commit()
            # Verify update
            cursor.execute('SELECT profile_pic_url FROM users WHERE id = %s', (user_id,))
            row = cursor.fetchone()
            stored = row['profile_pic_url'] if row else None
            conn.close()
            print('UPLOAD PROFILE: DB updated, stored url=', stored)
            return jsonify({'message': 'profile picture uploaded', 'profile_pic_url': stored}), 201
        except Exception as e:
            print('UPLOAD PROFILE DB ERROR:', e)
            try:
                os.remove(save_path)
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({'error': f'db error: {str(e)}'}), 500
    except Exception as e:
        # catch any unexpected errors and log them for debugging
        print('UPLOAD PROFILE UNEXPECTED ERROR:', e)
        return jsonify({'error': f'file upload error: {str(e)}'}), 500


@app.route('/remove_profile_pic', methods=['POST'])
@token_required
def remove_profile_pic():
    user_id = getattr(g, 'current_user_id', None)
    if user_id is None:
        return jsonify({'error': 'valid token required'}), 401
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT profile_pic_url FROM users WHERE id = %s', (user_id,))
        row = cursor.fetchone()
        if row is None:
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
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/me', methods=['GET'])
@token_required
def me():
    user_id = getattr(g, 'current_user_id', None)
    if user_id is None:
        return jsonify({'error': 'valid token required'}), 401
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id, username, profile_pic_url FROM users WHERE id = %s', (user_id,))
        row = cursor.fetchone()
        conn.close()
        if row is None:
            return jsonify({'error': 'user not found'}), 400
        return jsonify({'user': {'id': row['id'], 'username': row['username'], 'profile_pic_url': row['profile_pic_url']}}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/video/<path:filename>', methods=['GET'])
def serve_video(filename):
    try:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        videos_dir = os.path.join(base_dir, 'uploads', 'videos')

        if not os.path.isdir(videos_dir):
            print(f'VIDEO ERROR: videos directory not found: {videos_dir}')
            return jsonify({'error': 'videos directory not found'}), 500

        file_path = os.path.join(videos_dir, filename)
        if not os.path.exists(file_path):
            print(f'VIDEO ERROR: file not found: {file_path}')
            return jsonify({'error': 'file not found'}), 404

        # Implement explicit Range handling so clients can request partial content (HTTP 206)
        try:
            import mimetypes
            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type:
                if filename.lower().endswith('.mp4'):
                    mime_type = 'video/mp4'
                else:
                    mime_type = 'application/octet-stream'

            # Log detected mime type
            try:
                print(f'VIDEO MIME DETECTED: {filename} -> {mime_type}')
            except Exception:
                pass

            file_size = os.path.getsize(file_path)
            range_header = request.headers.get('Range', None)
            if range_header:
                # Parse Range header e.g. 'bytes=0-1048575'
                m = re.match(r'bytes=(\d+)-(\d*)', range_header)
                if not m:
                    # Malformed Range
                    return Response(status=416)

                start = int(m.group(1))
                end_group = m.group(2)
                # Enforce a maximum chunk size (1 MB)
                MAX_CHUNK = 1024 * 1024
                if end_group:
                    requested_end = int(end_group)
                    end = min(requested_end, start + MAX_CHUNK - 1, file_size - 1)
                else:
                    end = min(start + MAX_CHUNK - 1, file_size - 1)

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
                    'Content-Type': ('video/mp4' if (mime_type and mime_type.startswith('video/')) else mime_type),
                }
                return Response(generate(), status=206, headers=headers)
            else:
                # No Range header: return whole file (use send_file for efficiency)
                from flask import send_file
                resp = send_file(file_path, conditional=True, mimetype=mime_type)
                try:
                    resp.headers['Accept-Ranges'] = 'bytes'
                except Exception:
                    pass
                try:
                    resp.headers['Content-Type'] = ('video/mp4' if (mime_type and mime_type.startswith('video/')) else mime_type)
                except Exception:
                    pass
                return resp
        except Exception as e:
            print('VIDEO SEND/STREAM ERROR:', e)
            return jsonify({'error': 'file serve error'}), 500
    except Exception as e:
        print(f'VIDEO ERROR: {e}')
        return jsonify({'error': f'file serve error: {str(e)}'}), 500


@app.route('/uploads/profiles/<path:filename>', methods=['GET'])
def serve_profile_pic(filename):
    try:
        profiles_dir = os.path.join(app.root_path, 'uploads', 'profiles')
        if not os.path.isdir(profiles_dir):
            print(f'PROFILE ERROR: profiles directory not found: {profiles_dir}')
            return jsonify({'error': 'profiles directory not found'}), 500
        file_path = os.path.join(profiles_dir, filename)
        if not os.path.exists(file_path):
            print(f'PROFILE ERROR: file not found: {file_path}')
            return jsonify({'error': 'file not found'}), 404
        return send_from_directory(profiles_dir, filename)
    except Exception as e:
        print(f'PROFILE ERROR: {e}')
        return jsonify({'error': f'file serve error: {str(e)}'}), 500


@app.route('/add_comment', methods=['POST'])
@token_required
def add_comment():
    data = request.get_json() or {}
    video_id = data.get('video_id')
    comment_text = data.get('comment_text')
    user_id = getattr(g, 'current_user_id', None)

    if user_id is None or video_id is None or not comment_text:
        return jsonify({'error': 'video_id and comment_text required, and valid token required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE id = %s', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400

        cursor.execute('SELECT id FROM videos WHERE id = %s', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        cursor.execute('INSERT INTO comments (video_id, user_id, comment_text) VALUES (%s, %s, %s) RETURNING id', (video_id, user_id, comment_text))
        row = cursor.fetchone()
        conn.commit()
        comment_id = row['id'] if row else None

        cursor.execute('SELECT id, video_id, user_id, comment_text, timestamp FROM comments WHERE id = %s', (comment_id,))
        row = cursor.fetchone()
        comment = {
            'id': row['id'],
            'video_id': row['video_id'],
            'user_id': row['user_id'],
            'comment_text': row['comment_text'],
            'timestamp': row['timestamp']
        }
        conn.close()
        return jsonify({'message': 'comment added', 'comment': comment}), 201
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/record_interaction', methods=['POST'])
@token_required
def record_interaction():
    data = request.get_json() or {}
    # Use authenticated user from token
    user_id = getattr(g, 'current_user_id', None)
    video_id = data.get('video_id')
    # Accept either watch_time_ms or watch_time
    watch_ms = data.get('watch_time_ms') if data.get('watch_time_ms') is not None else data.get('watch_time', 0)
    try:
        watch_ms = int(watch_ms or 0)
    except Exception:
        watch_ms = 0

    if user_id is None or video_id is None:
        return jsonify({'error': 'authenticated user and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        # verify video exists
        cursor.execute('SELECT 1 FROM videos WHERE id = %s', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        # check existing interaction row
        cursor.execute('SELECT watch_time_ms FROM interactions WHERE user_id = %s AND video_id = %s', (user_id, video_id))
        row = cursor.fetchone()
        if row is None:
            # Insert a new interaction row; the table has a `timestamp` default column, use that instead of a non-existent `last_seen_at`.
            cursor.execute('INSERT INTO interactions (user_id, video_id, watch_time_ms) VALUES (%s, %s, %s)', (user_id, video_id, watch_ms))
            total_watch = watch_ms
        else:
            prev = row['watch_time_ms'] or 0
            total_watch = prev + watch_ms
            # Update the watch_time_ms and let the existing `timestamp` column remain (or be updated separately if desired).
            cursor.execute('UPDATE interactions SET watch_time_ms = %s WHERE user_id = %s AND video_id = %s', (total_watch, user_id, video_id))

        conn.commit()
        conn.close()
        return jsonify({'message': 'interaction recorded', 'watch_time_ms': total_watch}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/get_comments/<int:video_id>', methods=['GET'])
def get_comments(video_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT c.id, c.comment_text, c.timestamp, c.user_id, u.username, u.profile_pic_url
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.video_id = %s
            ORDER BY c.timestamp ASC
        ''', (video_id,))
        rows = cursor.fetchall()
        comments = []
        for r in rows:
            profile = r['profile_pic_url']
            if profile:
                # make absolute URL if stored as relative path
                if profile.startswith('http'):
                    profile_url = profile
                else:
                    profile_url = request.host_url.rstrip('/') + '/' + profile.lstrip('/')
            else:
                profile_url = None

            comments.append({
                'id': r['id'],
                'user_id': r['user_id'],
                'username': r['username'],
                'comment_text': r['comment_text'],
                'timestamp': r['timestamp'],
                'profile_pic_url': profile_url
            })
        conn.close()
        return jsonify({'comments': comments}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/personalized_feed', methods=['GET'])
def personalized_feed():
    """Return videos sorted by a personalized weighted score.

    Weights:
      - Watch Time: 50% (avg percentage watched by this user for videos sharing tags)
      - Comments: 25% (boost if user has commented on this uploader before)
      - Likes: 15% (boost if user liked the video)
      - Creator Loyalty: 10% (based on how many distinct videos from this uploader the user has watched)
    """
    # Determine current user (query param overrides token)
    current_user_id = None
    try:
        q_user = request.args.get('user_id')
        if q_user is not None:
            try:
                current_user_id = int(q_user)
            except Exception:
                current_user_id = None
    except Exception:
        current_user_id = None

    if current_user_id is None:
        auth = request.headers.get('Authorization')
        if auth and auth.startswith('Bearer '):
            try:
                token = auth.split()[1]
                payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
                current_user_id = payload.get('user_id')
            except Exception:
                current_user_id = None

    conn = get_db_connection()
    cursor = conn.cursor()

    # Load all videos with uploader info
    cursor.execute('''
        SELECT v.*, u.username, u.profile_pic_url
        FROM videos v
        LEFT JOIN users u ON v.uploader_id = u.id
        WHERE COALESCE(v.is_published, TRUE) = TRUE
    ''')
    rows = cursor.fetchall()
    videos = [dict(r) for r in rows]

    # Prefer Redis counts for likes/dislikes when available
    if redis_conn is not None:
        for v in videos:
            try:
                likes, dislikes = _get_redis_counts(v['id'])
                if likes is not None:
                    v['likes_count'] = likes
                if dislikes is not None:
                    v['dislikes_count'] = dislikes
            except Exception:
                pass

    # Precompute tag -> video ids
    tag_map = {}
    for v in videos:
        tags_raw = v.get('tags') or ''
        tags = [t.strip().lower() for t in tags_raw.split(',') if t.strip()]
        v['__tags_list'] = tags
        for t in tags:
            tag_map.setdefault(t, set()).add(v['id'])

    # User interactions and global max watch per video
    user_interactions = {}
    max_watch = {}
    try:
        # max watch per video
        cursor.execute('SELECT video_id, MAX(watch_time_ms) as max_watch FROM interactions GROUP BY video_id')
        for r in cursor.fetchall():
            max_watch[r['video_id']] = r['max_watch'] or 0

        if current_user_id is not None:
            cursor.execute('SELECT video_id, watch_time_ms FROM interactions WHERE user_id = %s', (current_user_id,))
            for r in cursor.fetchall():
                user_interactions[r['video_id']] = r['watch_time_ms'] or 0
    except Exception:
        pass

    # Precompute which uploaders the user has commented on
    user_commented_uploaders = set()
    try:
        if current_user_id is not None:
            cursor.execute('''
                SELECT DISTINCT v.uploader_id FROM comments c
                JOIN videos v ON c.video_id = v.id
                WHERE c.user_id = %s
            ''', (current_user_id,))
            for r in cursor.fetchall():
                if r['uploader_id']:
                    user_commented_uploaders.add(r['uploader_id'])
    except Exception:
        pass

    # Precompute user likes set
    user_likes = set()
    try:
        if current_user_id is not None:
            cursor.execute('SELECT video_id FROM likes WHERE user_id = %s', (current_user_id,))
            for r in cursor.fetchall():
                user_likes.add(r['video_id'])
    except Exception:
        pass

    # Precompute user dislikes set
    user_dislikes = set()
    try:
        if current_user_id is not None:
            cursor.execute('SELECT video_id FROM dislikes WHERE user_id = %s', (current_user_id,))
            for r in cursor.fetchall():
                user_dislikes.add(r['video_id'])
    except Exception:
        pass

    # Precompute loyalty: distinct videos watched by user per uploader
    loyalty_counts = {}
    try:
        if current_user_id is not None:
            cursor.execute('''
                SELECT v.uploader_id, COUNT(DISTINCT i.video_id) as cnt
                FROM interactions i
                JOIN videos v ON i.video_id = v.id
                WHERE i.user_id = %s AND i.watch_time_ms > 0
                GROUP BY v.uploader_id
            ''', (current_user_id,))
            for r in cursor.fetchall():
                if r['uploader_id']:
                    loyalty_counts[r['uploader_id']] = r['cnt']
    except Exception:
        pass

    # If user is new (no interactions, likes, or dislikes) or anonymous, fall back to popularity ranking
    try:
        is_new_user = False
        if current_user_id is None:
            is_new_user = True
        else:
            # Check if user has any interactions (watch time), likes, or dislikes
            cursor.execute('SELECT COUNT(*) as cnt FROM interactions WHERE user_id = %s', (current_user_id,))
            interactions_count = cursor.fetchone()['cnt'] or 0
            
            if interactions_count == 0:
                # Also check if they have any likes or dislikes
                cursor.execute('SELECT COUNT(*) as cnt FROM likes WHERE user_id = %s', (current_user_id,))
                likes_count = cursor.fetchone()['cnt'] or 0
                cursor.execute('SELECT COUNT(*) as cnt FROM dislikes WHERE user_id = %s', (current_user_id,))
                dislikes_count = cursor.fetchone()['cnt'] or 0
                
                if likes_count == 0 and dislikes_count == 0:
                    is_new_user = True
    except Exception:
        is_new_user = True

    if is_new_user:
        try:
            # Popularity: sum total watch_time_ms across all users and comments count
            cursor.execute('''
                SELECT v.id, v.filename, v.thumbnail, v.description, v.tags, v.uploader_id, 
                       v.likes_count, v.created_at, u.username, u.profile_pic_url,
                       COALESCE(SUM(i.watch_time_ms), 0) as total_watch_ms,
                       COALESCE(COUNT(DISTINCT c.id), 0) as comments_count,
                       (SELECT COUNT(*) FROM dislikes d WHERE d.video_id = v.id) AS dislikes_count
                FROM videos v
                LEFT JOIN interactions i ON v.id = i.video_id
                LEFT JOIN comments c ON v.id = c.video_id
                LEFT JOIN users u ON v.uploader_id = u.id
                WHERE COALESCE(v.is_published, TRUE) = TRUE
                GROUP BY v.id
                ORDER BY total_watch_ms DESC, comments_count DESC, v.created_at DESC
            ''')
            rows = cursor.fetchall()
            popular = []
            for r in rows:
                vid = r['id']
                total_watch = r['total_watch_ms'] or 0
                comments_cnt = r['comments_count'] or 0
                # Use Redis for live counts when available
                if redis_conn is not None:
                    try:
                        likes_cnt = int(redis_conn.scard(f'video:{vid}:likes') or 0)
                        dislikes_cnt = int(redis_conn.scard(f'video:{vid}:dislikes') or 0)
                    except Exception:
                        likes_cnt = r['likes_count'] if r['likes_count'] is not None else 0
                        dislikes_cnt = r['dislikes_count'] if ('dislikes_count' in r.keys() and r['dislikes_count'] is not None) else 0
                else:
                    likes_cnt = r['likes_count'] if r['likes_count'] is not None else 0
                    dislikes_cnt = r['dislikes_count'] if ('dislikes_count' in r.keys() and r['dislikes_count'] is not None) else 0
                
                # simple popularity score (for client visibility)
                popularity_score = float(total_watch) + float(comments_cnt) * 1000.0
                popular.append({
                    'id': vid,
                    'filename': r['filename'],
                    'url': None,  # Anonymous users don't have personalized URLs
                    'thumbnail': r['thumbnail'],
                    'description': r['description'],
                    'uploader_id': r['uploader_id'],
                    'username': r['username'],
                    'profile_pic_url': r['profile_pic_url'],
                    'tags': r['tags'],
                    'likes_count': likes_cnt,
                    'dislikes_count': dislikes_cnt,
                    'is_liked': False,  # User is new/anonymous, not liked
                    'is_disliked': False,  # User is new/anonymous, not disliked
                    'popularity_score': popularity_score,
                    'total_watch_ms': total_watch,
                    'comments_count': comments_cnt
                })
            conn.close()
            return jsonify({'videos': popular}), 200
        except Exception:
            # if popularity query fails, fall back to empty personalized result construction below
            pass

    # For authenticated users with interactions, compute weighted score using SQL
    try:
        # If current_user_id is None, set to -1 so correlated EXISTS checks are false
        user_param = current_user_id if current_user_id is not None else -1

        # Build a SQL query that computes per-video features and the weighted score.
        # watch_score: user's watch_time_ms on this video divided by max watch_time_ms for that video (0..1)
        # comment_score: whether user has commented on this uploader's videos before (0/1)
        # liked_score: whether user liked this video (0/1)
        # loyalty_score: min(1, count(distinct videos watched by user for this uploader)/3)

        sql = '''
        SELECT v.id, v.filename, v.thumbnail, v.description, v.uploader_id, u.username, u.profile_pic_url, v.tags, v.likes_count,
          COALESCE(COUNT(DISTINCT c.id), 0) as comments_count,
          -- watch score (normalized per-video)
          CASE WHEN COALESCE(max_watch.max_w, 0) > 0 THEN CAST(COALESCE(user_watch.uw, 0) AS FLOAT) / max_watch.max_w ELSE 0 END AS watch_score,
          -- comment boost (if user commented on this uploader before)
          CASE WHEN EXISTS(
              SELECT 1 FROM comments c2 JOIN videos vv ON c2.video_id = vv.id WHERE c2.user_id = %s AND vv.uploader_id = v.uploader_id
          ) THEN 1 ELSE 0 END AS comment_score,
          -- liked flag
          CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = %s AND lk.video_id = v.id) THEN 1 ELSE 0 END AS liked_score,
          -- disliked flag
          CASE WHEN EXISTS(SELECT 1 FROM dislikes dk WHERE dk.user_id = %s AND dk.video_id = v.id) THEN 1 ELSE 0 END AS disliked_score,
          -- loyalty (count distinct videos watched by this user for this uploader, normalized)
          (CASE WHEN COALESCE(loyalty.cnt,0) >= 3 THEN 1.0 ELSE CAST(COALESCE(loyalty.cnt,0) AS FLOAT)/3.0 END) AS loyalty_score,
          -- dislikes count (authoritative)
          (SELECT COUNT(*) FROM dislikes d WHERE d.video_id = v.id) AS dislikes_count,
          -- final weighted score (subtract if disliked)
          (0.50 * (CASE WHEN COALESCE(max_watch.max_w,0) > 0 THEN CAST(COALESCE(user_watch.uw,0) AS FLOAT) / max_watch.max_w ELSE 0 END)
           + 0.25 * (CASE WHEN EXISTS(SELECT 1 FROM comments c3 JOIN videos vv ON c3.video_id = vv.id WHERE c3.user_id = %s AND vv.uploader_id = v.uploader_id) THEN 1 ELSE 0 END)
           + 0.15 * (CASE WHEN EXISTS(SELECT 1 FROM likes lk WHERE lk.user_id = %s AND lk.video_id = v.id) THEN 1 ELSE 0 END)
           + 0.10 * (CASE WHEN COALESCE(loyalty.cnt,0) >= 3 THEN 1.0 ELSE CAST(COALESCE(loyalty.cnt,0) AS FLOAT)/3.0 END)
           - 0.30 * (CASE WHEN EXISTS(SELECT 1 FROM dislikes dk2 WHERE dk2.user_id = %s AND dk2.video_id = v.id) THEN 1 ELSE 0 END)
          ) AS weighted_score
        FROM videos v
        LEFT JOIN users u ON v.uploader_id = u.id
        LEFT JOIN comments c ON v.id = c.video_id
        LEFT JOIN (
            SELECT video_id, MAX(watch_time_ms) AS max_w FROM interactions GROUP BY video_id
        ) AS max_watch ON max_watch.video_id = v.id
        LEFT JOIN (
            SELECT video_id, watch_time_ms AS uw FROM interactions WHERE user_id = %s
        ) AS user_watch ON user_watch.video_id = v.id
        LEFT JOIN (
            SELECT v2.uploader_id, COUNT(DISTINCT i.video_id) as cnt
            FROM interactions i JOIN videos v2 ON i.video_id = v2.id
            WHERE i.user_id = %s AND i.watch_time_ms > 0
            GROUP BY v2.uploader_id
        ) AS loyalty ON loyalty.uploader_id = v.uploader_id
        WHERE COALESCE(v.is_published, TRUE) = TRUE
        GROUP BY v.id, u.username, u.profile_pic_url, max_watch.max_w, user_watch.uw, loyalty.cnt
        ORDER BY weighted_score DESC, v.created_at DESC
        '''
        params = (user_param, user_param, user_param, user_param, user_param, user_param, user_param, user_param)
        cursor.execute(sql, params)
        rows = cursor.fetchall()
        results = []
        for r in rows:
            vid = r['id']
            liked_val = 0
            try:
                if 'liked_score' in r.keys():
                    liked_val = r['liked_score'] or 0
            except Exception:
                # sqlite3.Row may behave differently; fallback to 0
                liked_val = 0
            
            # Use Redis for live counts and user-specific is_liked when available
            if redis_conn is not None:
                try:
                    likes_count = int(redis_conn.scard(f'video:{vid}:likes') or 0)
                    dislikes_count = int(redis_conn.scard(f'video:{vid}:dislikes') or 0)
                    # Check if current user has liked this video (Redis)
                    is_liked_flag = False
                    is_disliked_flag = False
                    if current_user_id is not None:
                        is_liked_flag = bool(redis_conn.sismember(f'video:{vid}:likes', str(current_user_id)))
                        is_disliked_flag = bool(redis_conn.sismember(f'video:{vid}:dislikes', str(current_user_id)))
                except Exception:
                    # Fall back to DB values
                    likes_count = r['likes_count'] if r['likes_count'] is not None else 0
                    dislikes_count = r['dislikes_count'] if ('dislikes_count' in r.keys() and r['dislikes_count'] is not None) else 0
                    is_liked_flag = bool(liked_val)
                    is_disliked_flag = bool(r['disliked_score']) if ('disliked_score' in r.keys() and r['disliked_score'] is not None) else False
            else:
                # No Redis available, use DB
                likes_count = r['likes_count'] if r['likes_count'] is not None else 0
                dislikes_count = r['dislikes_count'] if ('dislikes_count' in r.keys() and r['dislikes_count'] is not None) else 0
                is_liked_flag = bool(liked_val)
                is_disliked_flag = bool(r['disliked_score']) if ('disliked_score' in r.keys() and r['disliked_score'] is not None) else False
            
            results.append({
                'id': vid,
                'filename': r['filename'],
                'url': None,  # Use filename for video playback
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
    except Exception:
        # If any SQL-based path fails, fall back to the Python scoring above (best-effort)
        try:
            conn.close()
        except Exception:
            pass
        # fallback to earlier Python computation
        results = []
        # Precompute comments and dislikes count for each video
        video_comments = {}
        video_dislikes = {}
        try:
            cursor.execute('SELECT video_id, COUNT(*) as cnt FROM comments GROUP BY video_id')
            for r in cursor.fetchall():
                video_comments[r['video_id']] = r['cnt'] or 0
        except Exception:
            pass
        try:
            cursor.execute('SELECT video_id, COUNT(*) as cnt FROM dislikes GROUP BY video_id')
            for r in cursor.fetchall():
                video_dislikes[r['video_id']] = r['cnt'] or 0
        except Exception:
            pass
        
        for v in videos:
            vid = v['id']
            watch_percs = []
            tags_list = v.get('__tags_list') or []
            first_tag = tags_list[0] if tags_list else None
            for sv in tag_map.get(first_tag, []):
                max_w = max_watch.get(sv, 0) or 0
                user_w = user_interactions.get(sv, 0) or 0
                if max_w > 0:
                    watch_percs.append(min(1.0, float(user_w) / float(max_w)))
                else:
                    watch_percs.append(0.0)
            watch_score = float(sum(watch_percs)) / len(watch_percs) if watch_percs else 0.0
            comment_score = 1.0 if (v.get('uploader_id') in user_commented_uploaders) else 0.0
            liked_score = 1.0 if (vid in user_likes) else 0.0
            disliked_score = 1.0 if (vid in user_dislikes) else 0.0
            loyalty_cnt = loyalty_counts.get(v.get('uploader_id'), 0)
            loyalty_score = min(1.0, float(loyalty_cnt) / 3.0)
            weighted_score = (0.50 * watch_score) + (0.25 * comment_score) + (0.15 * liked_score) + (0.10 * loyalty_score)
            
            # Use Redis for live counts and user-specific is_liked when available
            if redis_conn is not None:
                try:
                    likes_count = int(redis_conn.scard(f'video:{vid}:likes') or 0)
                    dislikes_count = int(redis_conn.scard(f'video:{vid}:dislikes') or 0)
                    # Check if current user has liked this video (Redis)
                    is_liked_flag = False
                    is_disliked_flag = False
                    if current_user_id is not None:
                        is_liked_flag = bool(redis_conn.sismember(f'video:{vid}:likes', str(current_user_id)))
                        is_disliked_flag = bool(redis_conn.sismember(f'video:{vid}:dislikes', str(current_user_id)))
                except Exception:
                    # Fall back to DB/precomputed values
                    likes_count = v.get('likes_count', 0)
                    dislikes_count = video_dislikes.get(vid, 0)
                    is_liked_flag = bool(vid in user_likes)
                    is_disliked_flag = bool(vid in user_dislikes)
            else:
                # No Redis available, use DB/precomputed values
                likes_count = v.get('likes_count', 0)
                dislikes_count = video_dislikes.get(vid, 0)
                is_liked_flag = bool(vid in user_likes)
                is_disliked_flag = bool(vid in user_dislikes)
            
            results.append({
                'id': vid,
                'filename': v.get('filename'),
                'url': None,  # Use filename for video playback
                'description': v.get('description'),
                'uploader_id': v.get('uploader_id'),
                'username': v.get('username'),
                'profile_pic_url': v.get('profile_pic_url'),
                'tags': v.get('tags'),
                'likes_count': likes_count,
                'comments_count': video_comments.get(vid, 0),
                'dislikes_count': dislikes_count,
                'is_liked': is_liked_flag,
                'is_disliked': is_disliked_flag,
                'weighted_score': weighted_score
            })
        results.sort(key=lambda x: x['weighted_score'], reverse=True)
        return jsonify({'videos': results}), 200


# duplicate toggle_like removed in favor of primary implementation later in file
        return jsonify({'message': 'interaction recorded'}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


if __name__ == '__main__':
    from init_postgresql import init_postgresql
    try:
        print("🚀 Initializing Database Tables...")
        init_postgresql()

        print("🛠️ Checking for schema updates...")
        ensure_profile_column()        # Step 2: Now it's safe to check columns
        ensure_is_published_column()


        print("✅ Database Tables Ready.")
    except Exception as e:
        print(f"❌ Database Init Failed: {e}")
        
    app.run(host='0.0.0.0', port=5000, debug=True)

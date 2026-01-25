from flask import Flask, request, jsonify, send_from_directory, g, Response
import os
import uuid
from werkzeug.utils import secure_filename
from flask_cors import CORS
import re
import sqlite3
from werkzeug.security import generate_password_hash, check_password_hash
import jwt
from datetime import datetime, timedelta
from functools import wraps

# Configuration
DB_PATH = 'tiktok.db'
SECRET_KEY = os.environ.get('JWT_SECRET', 'change-this-secret')
JWT_ALGORITHM = 'HS256'
JWT_EXP_DAYS = 7

app = Flask(__name__)
# Allow common dev origins (including React Native 'null')
CORS(app, resources={r"/*": {"origins": ["null", "http://localhost", "http://127.0.0.1"]}}, supports_credentials=True, allow_headers=["Content-Type", "Authorization"])


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

# increase maximum upload size to 100 MB
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

ALLOWED_VIDEO_EXTENSIONS = {'.mp4', '.mov', '.avi'}
ALLOWED_PROFILE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif'}


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # Enforce foreign key constraints for this connection
    try:
        conn.execute('PRAGMA foreign_keys = ON;')
    except Exception:
        pass
    return conn


def ensure_profile_column():
    """Add profile_pic_url column to users if it doesn't exist."""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info('users')")
        cols = [r['name'] for r in cursor.fetchall()]
        if 'profile_pic_url' not in cols:
            cursor.execute('ALTER TABLE users ADD COLUMN profile_pic_url TEXT')
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


ensure_profile_column()


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
        cursor.execute('SELECT id FROM users WHERE username = ?', (username,))
        existing = cursor.fetchone()
        if existing:
            conn.close()
            return jsonify({'error': 'username taken'}), 409

        hashed = generate_password_hash(password)
        cursor.execute('INSERT INTO users (username, password) VALUES (?, ?)', (username, hashed))
        conn.commit()
        user_id = cursor.lastrowid
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
        cursor.execute('SELECT id, password FROM users WHERE username = ?', (username,))
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
        cursor.execute('SELECT password FROM users WHERE id = ?', (user_id,))
        row = cursor.fetchone()
        if row is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400

        if not check_password_hash(row['password'], password):
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401

        cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))
        conn.commit()
        conn.close()
        return jsonify({'message': 'account deleted'}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


@app.route('/toggle_like', methods=['POST'])
def toggle_like():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    video_id = data.get('video_id')

    if user_id is None or video_id is None:
        return jsonify({'error': 'user_id and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400

        cursor.execute('SELECT id FROM videos WHERE id = ?', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        cursor.execute('SELECT 1 FROM likes WHERE user_id = ? AND video_id = ?', (user_id, video_id))
        liked = cursor.fetchone() is not None

        if liked:
            cursor.execute('DELETE FROM likes WHERE user_id = ? AND video_id = ?', (user_id, video_id))
            action = 'unliked'
        else:
            cursor.execute('INSERT INTO likes (user_id, video_id) VALUES (?, ?)', (user_id, video_id))
            action = 'liked'

        cursor.execute('SELECT COUNT(*) as cnt FROM likes WHERE video_id = ?', (video_id,))
        row = cursor.fetchone()
        likes_count = row['cnt'] if row else 0
        cursor.execute('UPDATE videos SET likes_count = ? WHERE id = ?', (likes_count, video_id))
        conn.commit()
        conn.close()
        return jsonify({'message': action, 'likes_count': likes_count}), 200
    except Exception as e:
        try:
            conn.close()
        except Exception:
            pass
        return jsonify({'error': f'db error: {str(e)}'}), 500


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
    
    # Use an EXISTS subquery to compute a per-video boolean `is_liked` flag
    # in a single SQL query to avoid N+1 lookups. If no user is known, pass -1
    # so the EXISTS check will always be false.
    user_param = current_user_id if (current_user_id is not None) else -1
    cursor.execute('''
        SELECT v.*, u.username, u.profile_pic_url,
        CASE WHEN EXISTS (SELECT 1 FROM likes lk WHERE lk.video_id = v.id AND lk.user_id = ?) THEN 1 ELSE 0 END AS is_liked
        FROM videos v
        LEFT JOIN users u ON v.uploader_id = u.id
        ORDER BY v.created_at DESC
    ''', (user_param,))

    rows = cursor.fetchall()
    videos = []
    for r in rows:
        is_liked_flag = bool(r['is_liked'])
        videos.append({
            'id': r['id'],
            'filename': r['filename'],
            'description': r['description'],
            'uploader_id': r['uploader_id'],
            'likes_count': r['likes_count'],
            'is_liked': is_liked_flag,
            'username': r['username'],
            'profile_pic_url': r['profile_pic_url']
        })
    conn.close()
    return jsonify({'videos': videos}), 200


@app.route('/upload', methods=['POST','OPTIONS'])
@token_required
def upload():
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    # Determine optional user_id from query or JWT
    raw_user = request.args.get('user_id')
    auth = request.headers.get('Authorization')
    user_id = None
    if raw_user:
        try:
            user_id = int(raw_user)
        except Exception:
            user_id = None
    elif auth:
        parts = auth.split()
        if len(parts) == 2 and parts[0].lower() == 'bearer':
            try:
                payload = jwt.decode(parts[1], SECRET_KEY, algorithms=[JWT_ALGORITHM])
                user_id = payload.get('user_id')
            except Exception:
                user_id = None

    user_param = user_id if (user_id is not None) else -1
    try:
        cursor.execute('''
            SELECT v.id, v.filename, v.description, v.uploader_id, v.likes_count, v.created_at,
                   u.username, u.profile_pic_url,
                   CASE WHEN EXISTS (SELECT 1 FROM likes lk WHERE lk.video_id = v.id AND lk.user_id = ?) THEN 1 ELSE 0 END AS is_liked
            FROM videos v
            LEFT JOIN users u ON v.uploader_id = u.id
            ORDER BY v.created_at DESC
        ''', (user_param,))
        rows = cursor.fetchall()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    videos = []
    for r in rows:
        videos.append({
            'id': r['id'],
            'filename': r['filename'],
            'description': r['description'],
            'uploader_id': r['uploader_id'],
            'likes_count': r['likes_count'],
            'created_at': r['created_at'],
            'is_liked': bool(r['is_liked']),
            'username': r['username'],
            'profile_pic_url': r['profile_pic_url']
        })

    conn.close()
    return jsonify({'videos': videos}), 200


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
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
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
            cursor.execute('UPDATE users SET profile_pic_url = ? WHERE id = ?', (profile_url, user_id))
            conn.commit()
            # Verify update
            cursor.execute('SELECT profile_pic_url FROM users WHERE id = ?', (user_id,))
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
        cursor.execute('SELECT profile_pic_url FROM users WHERE id = ?', (user_id,))
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

        cursor.execute('UPDATE users SET profile_pic_url = NULL WHERE id = ?', (user_id,))
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
        cursor.execute('SELECT id, username, profile_pic_url FROM users WHERE id = ?', (user_id,))
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
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400

        cursor.execute('SELECT id FROM videos WHERE id = ?', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400

        cursor.execute('INSERT INTO comments (video_id, user_id, comment_text) VALUES (?, ?, ?)', (video_id, user_id, comment_text))
        conn.commit()
        comment_id = cursor.lastrowid

        cursor.execute('SELECT id, video_id, user_id, comment_text, timestamp FROM comments WHERE id = ?', (comment_id,))
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


@app.route('/get_comments/<int:video_id>', methods=['GET'])
def get_comments(video_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('''
            SELECT c.id, c.comment_text, c.timestamp, c.user_id, u.username, u.profile_pic_url
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.video_id = ?
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


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
from flask import Flask, request, jsonify, send_from_directory
import os
import uuid
from werkzeug.utils import secure_filename
from flask_cors import CORS
import sqlite3
from werkzeug.security import generate_password_hash, check_password_hash

DB_PATH = 'tiktok.db'

app = Flask(__name__)
CORS(app)  # allow all origins

ALLOWED_EXTENSIONS = {'.mp4', '.mov', '.avi'}


def get_db_connection():
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        # Enforce foreign key constraints for this connection
        try:
            conn.execute('PRAGMA foreign_keys = ON;')
        except Exception:
            # if pragma fails, continue; queries will surface issues
            pass
        return conn
    except Exception:
        raise


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
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT id FROM users WHERE username = ?', (username,))
        existing = cursor.fetchone()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    if existing:
        conn.close()
        return jsonify({'error': 'username taken'}), 409

    try:
        hashed = generate_password_hash(password)
        cursor.execute('INSERT INTO users (username, password) VALUES (?, ?)', (username, hashed))
        conn.commit()
        user_id = cursor.lastrowid
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db insert error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'user created', 'user_id': user_id}), 201


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
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT id, password FROM users WHERE username = ?', (username,))
        row = cursor.fetchone()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    if row is None:
        conn.close()
        return jsonify({'error': 'invalid credentials'}), 401

    try:
        user_id = row['id']
        hashed = row['password']
        if check_password_hash(hashed, password):
            conn.close()
            return jsonify({'message': 'login successful', 'user_id': user_id}), 200
        else:
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401
    except Exception as e:
        conn.close()
        return jsonify({'error': f'password check error: {str(e)}'}), 500


@app.route('/delete_account', methods=['DELETE'])
def delete_account():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    password = data.get('password')

    if user_id is None or not password:
        return jsonify({'error': 'user_id and password are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT password FROM users WHERE id = ?', (user_id,))
        row = cursor.fetchone()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    if row is None:
        conn.close()
        return jsonify({'error': 'user not found'}), 400

    try:
        hashed = row['password']
        if not check_password_hash(hashed, password):
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401
    except Exception as e:
        conn.close()
        return jsonify({'error': f'password check error: {str(e)}'}), 500

    # Verified — delete the user (foreign keys should cascade if schema supports it)
    try:
        cursor.execute('DELETE FROM users WHERE id = ?', (user_id,))
        conn.commit()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db delete error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'account deleted'}), 200


@app.route('/toggle_like', methods=['POST'])
def toggle_like():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    video_id = data.get('video_id')

    if user_id is None or video_id is None:
        return jsonify({'error': 'user_id and video_id are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (user check): {str(e)}'}), 500

    try:
        cursor.execute('SELECT id FROM videos WHERE id = ?', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (video check): {str(e)}'}), 500

    try:
        cursor.execute('SELECT 1 FROM likes WHERE user_id = ? AND video_id = ?', (user_id, video_id))
        liked = cursor.fetchone() is not None
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (likes check): {str(e)}'}), 500

    try:
        if liked:
            cursor.execute('DELETE FROM likes WHERE user_id = ? AND video_id = ?', (user_id, video_id))
            action = 'unliked'
        else:
            cursor.execute('INSERT INTO likes (user_id, video_id) VALUES (?, ?)', (user_id, video_id))
            action = 'liked'
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db write error (toggle): {str(e)}'}), 500

    try:
        cursor.execute('SELECT COUNT(*) as cnt FROM likes WHERE video_id = ?', (video_id,))
        row = cursor.fetchone()
        likes_count = row['cnt'] if row else 0
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': f'db query error (count): {str(e)}'}), 500

    try:
        cursor.execute('UPDATE videos SET likes_count = ? WHERE id = ?', (likes_count, video_id))
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': f'db write error (update videos): {str(e)}'}), 500

    try:
        conn.commit()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db commit error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': action, 'likes_count': likes_count}), 200


def upload_video():
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
        if ext not in ALLOWED_EXTENSIONS:
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
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
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
            'INSERT INTO videos (filename, description, uploader_id) VALUES (?, ?, ?)',
            (unique_name, description, user_id)
        )
        conn.commit()
        video_id = cursor.lastrowid
    except Exception as e:
        try:
            os.remove(save_path)
        except Exception:
            pass
        conn.close()
        return jsonify({'error': f'db insert error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'upload successful', 'video_id': video_id, 'filename': unique_name}), 201


@app.route('/video/<path:filename>', methods=['GET'])
def serve_video(filename):
    try:
        videos_dir = os.path.join(os.getcwd(), 'uploads', 'videos')
        if not os.path.isdir(videos_dir):
            return jsonify({'error': 'videos directory not found'}), 500

        return send_from_directory(videos_dir, filename)
    except Exception as e:
        return jsonify({'error': f'file serve error: {str(e)}'}), 500


@app.route('/add_comment', methods=['POST'])
def add_comment():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    video_id = data.get('video_id')
    comment_text = data.get('comment_text')

    if user_id is None or video_id is None or not comment_text:
        return jsonify({'error': 'user_id, video_id and comment_text are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (user check): {str(e)}'}), 500

    try:
        cursor.execute('SELECT id FROM videos WHERE id = ?', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (video check): {str(e)}'}), 500

    try:
        cursor.execute('INSERT INTO comments (video_id, user_id, comment_text) VALUES (?, ?, ?)', (video_id, user_id, comment_text))
        conn.commit()
        comment_id = cursor.lastrowid
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db insert error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT id, video_id, user_id, comment_text, timestamp FROM comments WHERE id = ?', (comment_id,))
        row = cursor.fetchone()
        comment = {
            'id': row['id'],
            'video_id': row['video_id'],
            'user_id': row['user_id'],
            'comment_text': row['comment_text'],
            'timestamp': row['timestamp']
        }
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (fetch comment): {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'comment added', 'comment': comment}), 201


@app.route('/get_comments/<int:video_id>', methods=['GET'])
def get_comments(video_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('''
            SELECT c.id, c.comment_text, c.timestamp, c.user_id, u.username
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.video_id = ?
            ORDER BY c.timestamp ASC
        ''', (video_id,))
        rows = cursor.fetchall()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    comments = []
    for r in rows:
        comments.append({
            'id': r['id'],
            'user_id': r['user_id'],
            'username': r['username'],
            'comment_text': r['comment_text'],
            'timestamp': r['timestamp']
        })

    conn.close()
    return jsonify({'comments': comments}), 200


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
from flask import Flask, request, jsonify, send_from_directory
import os
import uuid
from werkzeug.utils import secure_filename
from flask_cors import CORS
import sqlite3
from werkzeug.security import generate_password_hash, check_password_hash

DB_PATH = 'tiktok.db'

app = Flask(__name__)
CORS(app)  # allow all origins

ALLOWED_EXTENSIONS = {'.mp4', '.mov', '.avi'}


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


@app.route('/signup', methods=['POST'])
def signup():
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    # Check existing username
    try:
        cursor.execute('SELECT id FROM users WHERE username = ?', (username,))
        existing = cursor.fetchone()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    if existing:
        conn.close()
        return jsonify({'error': 'username taken'}), 409

    # Insert new user with hashed password
    try:
        hashed = generate_password_hash(password)
        cursor.execute('INSERT INTO users (username, password) VALUES (?, ?)', (username, hashed))
        conn.commit()
        user_id = cursor.lastrowid
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db insert error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'user created', 'user_id': user_id}), 201


@app.route('/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'username and password required'}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('SELECT id, password FROM users WHERE username = ?', (username,))
        row = cursor.fetchone()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    if row is None:
        conn.close()
        return jsonify({'error': 'invalid credentials'}), 401

    try:
        user_id = row['id']
        hashed = row['password']
        if check_password_hash(hashed, password):
            conn.close()
            return jsonify({'message': 'login successful', 'user_id': user_id}), 200
        else:
            conn.close()
            return jsonify({'error': 'invalid credentials'}), 401
    except Exception as e:
        conn.close()
        return jsonify({'error': f'password check error: {str(e)}'}), 500


@app.route('/toggle_like', methods=['POST'])
def toggle_like():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    video_id = data.get('video_id')

    if user_id is None or video_id is None:
        return jsonify({'error': 'user_id and video_id are required'}), 400

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    # Ensure user exists
    try:
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (user check): {str(e)}'}), 500

    # Ensure video exists
    try:
        cursor.execute('SELECT id FROM videos WHERE id = ?', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (video check): {str(e)}'}), 500

    # Check if like exists
    try:
        cursor.execute('SELECT 1 FROM likes WHERE user_id = ? AND video_id = ?', (user_id, video_id))
        liked = cursor.fetchone() is not None
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (likes check): {str(e)}'}), 500

    try:
        if liked:
            # Unlike -> delete row
            cursor.execute('DELETE FROM likes WHERE user_id = ? AND video_id = ?', (user_id, video_id))
            action = 'unliked'
        else:
            # Like -> insert row
            cursor.execute('INSERT INTO likes (user_id, video_id) VALUES (?, ?)', (user_id, video_id))
            action = 'liked'
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db write error (toggle): {str(e)}'}), 500

    # Recompute likes count for the video and update videos table
    try:
        cursor.execute('SELECT COUNT(*) as cnt FROM likes WHERE video_id = ?', (video_id,))
        row = cursor.fetchone()
        likes_count = row['cnt'] if row else 0
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': f'db query error (count): {str(e)}'}), 500

    try:
        cursor.execute('UPDATE videos SET likes_count = ? WHERE id = ?', (likes_count, video_id))
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': f'db write error (update videos): {str(e)}'}), 500

    try:
        conn.commit()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db commit error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': action, 'likes_count': likes_count}), 200





def upload_video():
    # Expecting multipart/form-data with 'file' and form field 'user_id'
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

        # Validate extension
        _, ext = os.path.splitext(file.filename)
        ext = ext.lower()
        if ext not in ALLOWED_EXTENSIONS:
            return jsonify({'error': 'file type not allowed'}), 400

        # Prepare upload directory
        upload_dir = os.path.join(os.getcwd(), 'uploads', 'videos')
        os.makedirs(upload_dir, exist_ok=True)

        # Create a unique filename
        safe_name = secure_filename(file.filename)
        unique_name = f"{uuid.uuid4().hex}{ext}"
        save_path = os.path.join(upload_dir, unique_name)
        file.save(save_path)

    except Exception as e:
        return jsonify({'error': f'file upload error: {str(e)}'}), 500

    # Insert a row into videos table
    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        # cleanup saved file
        try:
            os.remove(save_path)
        except Exception:
            pass
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    # Ensure user exists
    try:
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            # cleanup saved file
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
            'INSERT INTO videos (filename, description, uploader_id) VALUES (?, ?, ?)',
            (unique_name, description, user_id)
        )
        conn.commit()
        video_id = cursor.lastrowid
    except Exception as e:
        # try to remove the saved file on DB failure
        try:
            os.remove(save_path)
        except Exception:
            pass
        conn.close()
        return jsonify({'error': f'db insert error: {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'upload successful', 'video_id': video_id, 'filename': unique_name}), 201


@app.route('/video/<path:filename>', methods=['GET'])
def serve_video(filename):
    try:
        videos_dir = os.path.join(os.getcwd(), 'uploads', 'videos')
        if not os.path.isdir(videos_dir):
            return jsonify({'error': 'videos directory not found'}), 500

        # send_from_directory will ensure safe path handling and streaming
        return send_from_directory(videos_dir, filename)
    except Exception as e:
        return jsonify({'error': f'file serve error: {str(e)}'}), 500



@app.route('/add_comment', methods=['POST'])
def add_comment():
    data = request.get_json() or {}
    user_id = data.get('user_id')
    video_id = data.get('video_id')
    comment_text = data.get('comment_text')

    if user_id is None or video_id is None or not comment_text:
        return jsonify({'error': 'user_id, video_id and comment_text are required'}), 400

    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    # Verify user exists
    try:
        cursor.execute('SELECT id FROM users WHERE id = ?', (user_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'user not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (user check): {str(e)}'}), 500

    # Verify video exists
    try:
        cursor.execute('SELECT id FROM videos WHERE id = ?', (video_id,))
        if cursor.fetchone() is None:
            conn.close()
            return jsonify({'error': 'video not found'}), 400
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (video check): {str(e)}'}), 500

    # Insert comment
    try:
        cursor.execute('INSERT INTO comments (video_id, user_id, comment_text) VALUES (?, ?, ?)', (video_id, user_id, comment_text))
        conn.commit()
        comment_id = cursor.lastrowid
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db insert error: {str(e)}'}), 500

    # Fetch the inserted comment to include timestamp
    try:
        cursor.execute('SELECT id, video_id, user_id, comment_text, timestamp FROM comments WHERE id = ?', (comment_id,))
        row = cursor.fetchone()
        comment = {
            'id': row['id'],
            'video_id': row['video_id'],
            'user_id': row['user_id'],
            'comment_text': row['comment_text'],
            'timestamp': row['timestamp']
        }
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error (fetch comment): {str(e)}'}), 500

    conn.close()
    return jsonify({'message': 'comment added', 'comment': comment}), 201


@app.route('/get_comments/<int:video_id>', methods=['GET'])
def get_comments(video_id):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
    except Exception as e:
        return jsonify({'error': f'db connection error: {str(e)}'}), 500

    try:
        cursor.execute('''
            SELECT c.id, c.comment_text, c.timestamp, c.user_id, u.username
            FROM comments c
            JOIN users u ON c.user_id = u.id
            WHERE c.video_id = ?
            ORDER BY c.timestamp ASC
        ''', (video_id,))
        rows = cursor.fetchall()
    except Exception as e:
        conn.close()
        return jsonify({'error': f'db query error: {str(e)}'}), 500

    comments = []
    for r in rows:
        comments.append({
            'id': r['id'],
            'user_id': r['user_id'],
            'username': r['username'],
            'comment_text': r['comment_text'],
            'timestamp': r['timestamp']
        })

    conn.close()
    return jsonify({'comments': comments}), 200


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)

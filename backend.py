import os
import subprocess
import psycopg2

DB_URL = os.environ.get("DATABASE_URL", "postgresql://user:password@db:5432/smartvideos")

def background_extract_and_save_thumbnail(video_path, video_id):
    """Extracts a thumbnail frame from an MP4 using FFmpeg."""
    try:
        thumb_name = f"thumb_{video_id}.jpg"
        thumb_dir = os.path.join("uploads", "videos")
        os.makedirs(thumb_dir, exist_ok=True)
        thumb_path = os.path.join(thumb_dir, thumb_name)

        cmd = [
            "ffmpeg", "-y", "-ss", "00:00:01",
            "-i", video_path, "-vframes", "1",
            "-q:v", "2", thumb_path
        ]
        subprocess.run(cmd, check=True)

        relative_thumb = f"uploads/videos/{thumb_name}"
        conn = psycopg2.connect(DB_URL)
        cur = conn.cursor()
        cur.execute("UPDATE videos SET thumbnail = %s WHERE id = %s", (relative_thumb, video_id))
        conn.commit()
        cur.close()
        conn.close()
        print(f"✅ Generated thumbnail for video #{video_id}: {relative_thumb}")
    except Exception as e:
        print(f"❌ Error generating thumbnail for video #{video_id}: {e}")

def background_run_tagger(filename, video_id):
    """Assigns tags to uploaded videos in PostgreSQL."""
    try:
        sample_tags = "video,content,test"
        conn = psycopg2.connect(DB_URL)
        cur = conn.cursor()
        cur.execute("UPDATE videos SET tags = %s WHERE id = %s", (sample_tags, video_id))
        conn.commit()
        cur.close()
        conn.close()
        print(f"🏷️ Assigned tags to video #{video_id}: {sample_tags}")
    except Exception as e:
        print(f"❌ Error running tagger for video #{video_id}: {e}")

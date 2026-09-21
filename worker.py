import os
import sys
import gc
import threading
import time
import json
import importlib
import redis
from flask import Flask, request, jsonify
from transformers import CLIPModel, CLIPProcessor
import torch

app = Flask(__name__)

# Restrict PyTorch CPU threads to conserve RAM
torch.set_num_threads(2)

MODEL_DIR = './custom_clip_weights'
BASE_MODEL = 'openai/clip-vit-base-patch32'

print("⏳ Pre-loading CLIP model and processor into memory...")
model_path = MODEL_DIR if os.path.exists(MODEL_DIR) else BASE_MODEL
_clip_model = CLIPModel.from_pretrained(model_path)
_clip_processor = CLIPProcessor.from_pretrained(BASE_MODEL)
print("✅ CLIP model pre-loaded successfully!")

def run_training_pipeline():
    """Runs training + re-indexing safely every 2 hours."""
    print("⏰ [AUTO-TRAINER] Starting scheduled fine-tuning & re-indexing...")
    exit_code = os.system("python train.py && python tag_videos.py")
    if exit_code == 0:
        print("✅ [AUTO-TRAINER] Training and re-indexing complete!")
    else:
        print("⚠️ [AUTO-TRAINER] Training process encountered an error.")
    gc.collect()

def auto_train_scheduler():
    """Scheduler thread running every 2 hours (7200 seconds)."""
    while True:
        time.sleep(7200)
        run_training_pipeline()

def redis_task_worker():
    """Polls Redis 'tasks' queue indefinitely with automatic reconnection."""
    redis_url = os.environ.get("REDIS_URL", "redis://redis:6379/0")
    
    while True:
        try:
            r = redis.Redis.from_url(redis_url, socket_timeout=10, socket_keepalive=True)
            print("⚡ [REDIS-WORKER] Connected and listening to 'tasks' queue...")
            while True:
                try:
                    item = r.blpop("tasks", timeout=5)
                    if not item:
                        continue
                    _, data = item
                    payload = json.loads(data.decode("utf-8"))
                    func_path = payload.get("func_name")
                    args = payload.get("args", [])

                    module_name, func_name = func_path.rsplit(".", 1)
                    mod = importlib.import_module(module_name)
                    func = getattr(mod, func_name)

                    print(f"🚀 [REDIS-WORKER] Executing {func_name} with args: {args}")
                    func(*args)
                except redis.exceptions.TimeoutError:
                    continue
                except Exception as task_err:
                    print(f"⚠️ [REDIS-WORKER] Task execution error: {task_err}")
        except Exception as conn_err:
            print(f"⚠️ [REDIS-WORKER] Redis connection lost: {conn_err}. Retrying in 5 seconds...")
            time.sleep(5)

# Start background threads
threading.Thread(target=auto_train_scheduler, daemon=True).start()
threading.Thread(target=redis_task_worker, daemon=True).start()

@app.route('/embed', methods=['POST'])
def embed():
    data = request.get_json()
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "No text provided"}), 400

    inputs = _clip_processor(text=[text], return_tensors="pt", padding=True)
    with torch.no_grad():
        outputs = _clip_model.get_text_features(**inputs)
        if hasattr(outputs, "text_embeds"):
            embeds = outputs.text_embeds
        elif hasattr(outputs, "pooler_output"):
            embeds = outputs.pooler_output
        else:
            embeds = outputs

        embeds = embeds / embeds.norm(p=2, dim=-1, keepdim=True)

    vec = embeds[0].tolist()
    return jsonify({"vector": vec})

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'run_trainer':
        run_training_pipeline()
    else:
        app.run(host='0.0.0.0', port=5001)

import json
import redis
import librosa

# Redis client for audio parameter publishing
_redis_audio_client = redis.Redis(host='redis', port=6379, db=0)

def extract_and_publish_audio_mood(video_path):
    """
    Analyzes raw audio from a video file, computes energy/spectral features,
    and publishes calculated valence and intensity directly to goTunes.
    """
    try:
        # Load up to 30 seconds of audio from the video track
        y, sr = librosa.load(video_path, duration=30)
        
        # Calculate RMS energy (intensity) and Spectral Centroid (brightness)
        rms = float(librosa.feature.rms(y=y).mean())
        spectral_centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
        
        # Normalize calculated features to bounds [0.1, 1.0]
        intensity = min(max(rms * 10.0, 0.1), 1.0)
        valence = min(max(spectral_centroid / 4000.0, 0.1), 1.0)
        
        payload = {
            "valence": valence,
            "arousal": intensity,
            "intensity": intensity
        }
        
        # Publish parameter set to the goTunes Redis Pub/Sub channel
        _redis_audio_client.publish("fireapp:audio:parameters", json.dumps(payload))
        print(f"[WORKER] Published goTunes parameters: {payload}")
        
    except Exception as e:
        print(f"[WORKER] Failed to process audio mood: {e}")

import subprocess
import psycopg2
import asyncio
from shazamio import Shazam

AUDIO_LIB_DIR = "uploads/audio_library"
os.makedirs(AUDIO_LIB_DIR, exist_ok=True)

async def recognize_song(mp3_path):
    try:
        shazam = Shazam()
        out = await shazam.recognize(mp3_path)
        track = out.get("track", {})
        title = track.get("title", "")
        artist = track.get("subtitle", "")
        genre = track.get("genres", {}).get("primary", "")
        return title, artist, genre
    except Exception as e:
        print(f"⚠️ [SHAZAM] Could not recognize song: {e}")
        return "", "", ""

def process_video_audio(video_id, video_path):
    """Extracts .mp3, recognizes song title via Shazam, computes features, and updates PostgreSQL."""
    try:
        mp3_name = f"audio_{video_id}.mp3"
        mp3_path = os.path.join(AUDIO_LIB_DIR, mp3_name)
        
        # 1. Convert video track to MP3 via FFmpeg
        cmd = ["ffmpeg", "-y", "-i", video_path, "-vn", "-acodec", "libmp3lame", "-q:a", "2", mp3_path]
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # 2. Recognize Song via Shazam
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        song_title, song_artist, genre = loop.run_until_complete(recognize_song(mp3_path))
        
        # 3. Extract features with Librosa
        y, sr = librosa.load(mp3_path, sr=22050, duration=30)
        rms = float(librosa.feature.rms(y=y).mean())
        spectral_centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
        
        intensity = min(max(rms * 10.0, 0.1), 1.0)
        valence = min(max(spectral_centroid / 4000.0, 0.1), 1.0)
        
        # 4. Store in PostgreSQL
        db_url = os.environ.get("DATABASE_URL")
        conn = psycopg2.connect(db_url)
        cur = conn.cursor()
        
        # Update audio features
        cur.execute("""
            INSERT INTO video_audio_features (video_id, mp3_path, bpm, valence, intensity)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (video_id) DO UPDATE 
            SET mp3_path = EXCLUDED.mp3_path, valence = EXCLUDED.valence, intensity = EXCLUDED.intensity;
        """, (video_id, f"uploads/audio_library/{mp3_name}", 120.0, valence, intensity))

        # Update video metadata with recognized song title and artist + append to tags
        if song_title:
            new_tags = f"{song_title},{song_artist},{genre}".strip(",")
            cur.execute("""
                UPDATE videos 
                SET song_title = %s, 
                    song_artist = %s,
                    tags = CASE 
                        WHEN tags IS NULL OR tags = '' THEN %s 
                        ELSE tags || ',' || %s 
                    END
                WHERE id = %s;
            """, (song_title, song_artist, new_tags, new_tags, video_id))
            print(f"🎵 [SHAZAM] Recognized: '{song_title}' by {song_artist} for video #{video_id}")

        conn.commit()
        cur.close()
        conn.close()
        print(f"✅ [AUDIO-WORKER] Successfully processed MP3 for video #{video_id}")
    except Exception as e:
        print(f"❌ [AUDIO-WORKER] Error extracting audio: {e}")

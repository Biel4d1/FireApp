import json
import time
import os
import redis
import psycopg2
from tag_videos import tag_file

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
r = redis.Redis.from_url(REDIS_URL)

print("🚀 Background Worker active. Processing Redis task queue...")

while True:
    try:
        _, data = r.blpop("tasks")
        task = json.loads(data)
        func_name = task.get("func_name")
        args = task.get("args", [])

        if "background_run_tagger" in func_name or "tag_videos" in func_name:
            filename = args[0]
            print(f"⚙️ Running AI Multimodal Tagger on {filename}...")
            try:
                tags = tag_file(filename)
                print(f"✅ Extracted AI Tags for {filename}: {tags}")
            except Exception as e:
                print(f"❌ Error tagging {filename}: {e}")

    except Exception as e:
        time.sleep(1)

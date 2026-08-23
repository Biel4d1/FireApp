import os
import json
import time
import redis
import backend

REDIS_URL = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')

if __name__ == '__main__':
    r = redis.from_url(REDIS_URL, socket_timeout=None)
    print("🚀 Simple Background Worker started listening on 'tasks' queue...")
    
    while True:
        try:
            res = r.blpop("tasks", timeout=5)
            if not res:
                continue

            _, data = res
            task = json.loads(data)
            func_name = task.get("func_name")
            args = task.get("args", [])
            print(f"Processing task: {func_name} with args: {args}")

            if func_name == "backend.background_extract_and_save_thumbnail":
                backend.background_extract_and_save_thumbnail(*args)
            elif func_name == "backend.background_run_tagger":
                backend.background_run_tagger(*args)
            else:
                print(f"Unknown task: {func_name}")
        except redis.exceptions.TimeoutError:
            continue
        except Exception as e:
            print(f"Error processing task: {e}")
            time.sleep(1)

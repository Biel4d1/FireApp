
import torch
from transformers import CLIPProcessor, CLIPModel
from flask import Flask, request, jsonify
import threading

app = Flask(__name__)
_clip_model = None
_clip_processor = None

def get_clip():
    global _clip_model, _clip_processor
    if _clip_model is None:
        _clip_model = CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
        _clip_processor = CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
    return _clip_model, _clip_processor

@app.route('/embed', methods=['POST'])
def embed():
    data = request.get_json() or {}
    text = data.get('text', '')
    if not text:
        return jsonify({'vector': []})
    
    model, processor = get_clip()
    inputs = processor(text=[text], return_tensors="pt", padding=True)
    with torch.no_grad():
        text_embeds = model.get_text_features(**inputs)
        norm_embed = text_embeds / text_embeds.norm(p=2, dim=-1, keepdim=True)
        vec = norm_embed[0].cpu().numpy().tolist()
    return jsonify({'vector': vec})

def run_flask():
    app.run(host='0.0.0.0', port=5001)

threading.Thread(target=run_flask, daemon=True).start()

import torch
from transformers import CLIPProcessor, CLIPModel
from flask import Flask, request, jsonify
import threading

app = Flask(__name__)
_clip_model = None
_clip_processor = None

def get_clip():
    global _clip_model, _clip_processor
    if _clip_model is None:
        _clip_model = CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
        _clip_processor = CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
    return _clip_model, _clip_processor

@app.route('/embed', methods=['POST'])
def embed():
    data = request.get_json() or {}
    text = data.get('text', '')
    if not text:
        return jsonify({'vector': []})
    
    model, processor = get_clip()
    inputs = processor(text=[text], return_tensors="pt", padding=True)
    with torch.no_grad():
        text_embeds = model.get_text_features(**inputs)
        norm_embed = text_embeds / text_embeds.norm(p=2, dim=-1, keepdim=True)
        vec = norm_embed[0].cpu().numpy().tolist()
    return jsonify({'vector': vec})

def run_flask():
    app.run(host='0.0.0.0', port=5001)

threading.Thread(target=run_flask, daemon=True).start()
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

import re
import torch
from transformers import CLIPProcessor, CLIPModel
from flask import Flask, request, jsonify
import threading
import os
import time
import json
import redis
import psycopg2

app = Flask(__name__)

print("⏳ Pre-loading CLIP model and processor into memory...")
_clip_model = CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
_clip_processor = CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
_clip_model.eval()
print("✅ CLIP model pre-loaded successfully!")

# Multi-context prompt templates to normalize single words and verbs
PROMPT_TEMPLATES = [
    "a video of {}",
    "a video showing {}",
    "a clip of someone {}",
    "a person {}",
    "{}"
]

@app.route('/embed', methods=['POST'])
def embed():
    data = request.get_json() or {}
    text = data.get('text', '').strip().lower()
    if not text:
        return jsonify({'vector': []})
    
    try:
        # Generate multiple contextual prompts for the query
        prompts = [template.format(text) for template in PROMPT_TEMPLATES]
        
        inputs = _clip_processor(text=prompts, return_tensors="pt", padding=True)
        with torch.no_grad():
            outputs = _clip_model.get_text_features(**inputs)
            
            if hasattr(outputs, "text_embeds"):
                text_embeds = outputs.text_embeds
            elif hasattr(outputs, "pooler_output"):
                text_embeds = outputs.pooler_output
            elif isinstance(outputs, torch.Tensor):
                text_embeds = outputs
            else:
                text_embeds = outputs[0]

            # Normalize each prompt embedding
            norm_embeds = text_embeds / text_embeds.norm(p=2, dim=-1, keepdim=True)
            
            # Average all prompt embeddings into a single robust vector
            mean_embed = norm_embeds.mean(dim=0, keepdim=True)
            final_vector = mean_embed / mean_embed.norm(p=2, dim=-1, keepdim=True)
            
            vec = final_vector[0].cpu().numpy().tolist()
        return jsonify({'vector': vec})
    except Exception as e:
        print(f"Error generating text embedding: {e}")
        return jsonify({'error': str(e)}), 500

def run_flask():
    app.run(host='0.0.0.0', port=int(os.getenv("WORKER_PORT", 5001)))

threading.Thread(target=run_flask, daemon=True).start()

def run_worker():
    redis_url = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    r = redis.from_url(redis_url)
    print("Worker running, listening for tasks...")
    while True:
        try:
            _, task_data = r.blpop("tasks", timeout=5)
            if task_data:
                payload = json.loads(task_data)
                func_name = payload.get("func_name")
                args = payload.get("args", [])
                print(f"Executing task: {func_name} with args: {args}")
                if "background_run_tagger" in func_name:
                    os.system(f"python tag_videos.py --video uploads/videos/{args[0]}")
        except Exception as e:
            time.sleep(1)

if __name__ == "__main__":
    run_worker()

import os
import sys
import gc
import threading
import time
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

# Start background 2-hour scheduler
threading.Thread(target=auto_train_scheduler, daemon=True).start()

@app.route('/embed', methods=['POST'])
def embed():
    data = request.get_json()
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "No text provided"}), 400

    inputs = _clip_processor(text=[text], return_tensors="pt", padding=True)
    with torch.no_grad():
        outputs = _clip_model.get_text_features(**inputs)
        # Handle both raw Tensor and BaseModelOutputWithPooling objects safely
        if hasattr(outputs, "text_embeds"):
            embeds = outputs.text_embeds
        elif hasattr(outputs, "pooler_output"):
            embeds = outputs.pooler_output
        else:
            embeds = outputs

        # L2 Normalize vector for cosine distance calculations
        embeds = embeds / embeds.norm(p=2, dim=-1, keepdim=True)

    vec = embeds[0].tolist()
    return jsonify({"vector": vec})

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'run_trainer':
        run_training_pipeline()
    else:
        app.run(host='0.0.0.0', port=5001)

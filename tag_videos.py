#!/usr/bin/env python3
"""Extract frames and audio from videos in uploads/, extract multimodal CLIP embeddings
and optional Audio Transformer (AST) tags, and save normalized 512-d vectors + clean concept tags into PostgreSQL.
"""
import os
import cv2
from PIL import Image
from transformers import CLIPProcessor, CLIPModel, pipeline
import argparse
import logging
import sys

# Optional audio & vector dependencies
try:
    import torch
    import torchaudio
    import librosa
    import numpy as np
    AUDIO_DEPS_AVAILABLE = True
    try:
        torchaudio.set_audio_backend("soundfile")
    except Exception:
        pass
except Exception:
    AUDIO_DEPS_AVAILABLE = False

import psycopg2
import psycopg2.extras

VIDEO_DIR = 'uploads'
VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.mkv', '.webm'}

# Clean concept labels for zero-shot text classification via CLIP
CONCEPT_LABELS = [
    "gaming", "sports", "funny moment", "vlog", "nature", "music performance",
    "cooking", "pets and animals", "urban life", "sunset", "party", "car driving",
    "meme", "dancing", "fitness and workout", "art and design", "technology", "water sports"
]

# Noise / UI artifact tags to ignore
STOP_TAGS = {
    'web site', 'website', 'internet site', 'site',
    'analog clock', 'digital clock', 'wall clock', 'clock',
    'cellular telephone', 'cellular phone', 'cellphone', 'cell', 'mobile phone',
    'hand-held computer', 'hand-held microcomputer', 'monitor', 'screen', 'CRT screen',
    'remote control', 'remote', 'rule', 'ruler', 'slide rule', 'slipstick',
    'display', 'television', 'tv', 'radio', 'wireless'
}

_CLIP_MODEL = None
_CLIP_PROCESSOR = None
_AUDIO_PIPE = None


def get_video_frames(path, n_frames=14):
    """Return a list of up to `n_frames` PIL Images sampled evenly across the video."""
    cap = cv2.VideoCapture(path)
    if not cap or not cap.isOpened():
        return []

    try:
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    except Exception:
        total = 0

    frames = []
    if total and total > 0:
        import numpy as _np
        indices = _np.linspace(0, max(0, total - 1), num=min(n_frames, total), dtype=int)
        for idx in indices:
            try:
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(idx))
                success, frame = cap.read()
                if not success or frame is None:
                    continue
                frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                frames.append(Image.fromarray(frame))
            except Exception:
                continue
    else:
        count = 0
        while count < n_frames:
            success, frame = cap.read()
            if not success or frame is None:
                break
            try:
                frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                frames.append(Image.fromarray(frame))
            except Exception:
                pass
            count += 1

    try:
        cap.release()
    except Exception:
        pass

    return frames


def get_pg_connection():
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
            conn = psycopg2.connect(
                host=host, port=port, user=user, password=password, dbname=dbname,
                cursor_factory=psycopg2.extras.RealDictCursor
            )
        return conn
    except Exception as e:
        raise RuntimeError(f'Postgres connection error: {e}')


def _get_clip_model(model_name='openai/clip-vit-base-patch32'):
    """Lazy load OpenAI CLIP model and processor."""
    global _CLIP_MODEL, _CLIP_PROCESSOR
    if _CLIP_MODEL is None or _CLIP_PROCESSOR is None:
        print(f"Loading CLIP model ({model_name})...")
        _CLIP_MODEL = CLIPModel.from_pretrained(model_name)
        _CLIP_PROCESSOR = CLIPProcessor.from_pretrained(model_name)
    return _CLIP_MODEL, _CLIP_PROCESSOR


def _get_audio_pipeline(model_name: str = "MIT/ast-finetuned-audioset-10-10-0.4593"):
    global _AUDIO_PIPE
    if not AUDIO_DEPS_AVAILABLE:
        print("[WARNING] Audio dependencies not available. Skipping audio model.")
        return None

    if _AUDIO_PIPE is None:
        try:
            print("Loading audio-classification pipeline (MIT/ast-finetuned-audioset)...")
            _AUDIO_PIPE = pipeline('audio-classification', model=model_name)
        except Exception as e:
            print(f"[WARNING] Failed to load audio pipeline: {e}")
            _AUDIO_PIPE = None
    return _AUDIO_PIPE


def extract_audio_for_model(video_path: str, target_sr: int = 16000):
    """Extract audio array directly via librosa."""
    if not AUDIO_DEPS_AVAILABLE:
        raise RuntimeError('audio dependencies (librosa) not installed')

    waveform, sr = librosa.load(video_path, sr=target_sr, mono=True)
    return waveform.astype('float32'), sr


def generate_clip_embedding_and_tags(imgs, model_name='openai/clip-vit-base-patch32', topk=3):
    """Extract 512-dimensional CLIP embedding and match top semantic concept tags."""
    if not imgs:
        return None, []

    model, processor = _get_clip_model(model_name)

    # Process images through CLIP Vision Encoder
    inputs = processor(images=imgs, text=CONCEPT_LABELS, return_tensors="pt", padding=True)

    with torch.no_grad():
        outputs = model(**inputs)
        image_embeds = outputs.image_embeds  # [num_frames, 512]
        logits_per_image = outputs.logits_per_image  # [num_frames, num_concepts]

    # 1. Compute normalized mean 512-d video vector
    mean_embed = image_embeds.mean(dim=0)
    norm_embed = mean_embed / mean_embed.norm(p=2, dim=-1, keepdim=True)
    vector_list = norm_embed.cpu().numpy().tolist()

    # 2. Derive zero-shot concept tags
    mean_logits = logits_per_image.mean(dim=0)
    probs = mean_logits.softmax(dim=-1)
    top_indices = torch.topk(probs, k=min(topk, len(CONCEPT_LABELS))).indices.tolist()

    top_tags = [CONCEPT_LABELS[idx] for idx in top_indices]
    return vector_list, top_tags


def tag_file(filename, video_dir=VIDEO_DIR, topk=3, image_model_name='openai/clip-vit-base-patch32', audio_model_name=None):
    path = os.path.join(video_dir, filename)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"video not found: {path}")

    try:
        imgs = get_video_frames(path, n_frames=14)
        if not imgs:
            raise RuntimeError('could not read frames')

        label_set = set()

        # 1. CLIP Semantic Vector & Zero-Shot Concept Pass
        embedding_vector, visual_tags = generate_clip_embedding_and_tags(imgs, model_name=image_model_name, topk=topk)
        for vt in visual_tags:
            label_set.add(vt)

        # 2. Audio Classification Pass
        try:
            audio_pipe = _get_audio_pipeline(audio_model_name) if audio_model_name else _get_audio_pipeline()
            if audio_pipe is not None:
                try:
                    wav, sr = extract_audio_for_model(path, target_sr=16000)
                    audio_input = {"raw": wav, "sampling_rate": sr}
                    audio_results = audio_pipe(audio_input, top_k=3)
                    for ar in audio_results:
                        if isinstance(ar, dict) and 'label' in ar:
                            lbl = ar['label']
                            if lbl:
                                label_set.add(f"audio:{lbl}")
                except Exception as ae:
                    print(f"Audio processing skipped for {filename}: {ae}")
        except Exception:
            pass

        # 3. Filter out Noise / STOP_TAGS
        clean_labels = set()
        for label in label_set:
            raw_name = label.replace('audio:', '').strip().lower()
            if raw_name not in STOP_TAGS and len(raw_name) > 2:
                clean_labels.add(label)

        tags = ','.join(sorted(clean_labels)) if clean_labels else ''

        # 4. Save Clean Tags and Embedding Vector into PostgreSQL
        conn = get_pg_connection()
        try:
            cur = conn.cursor()

            # Check if 'embedding' column exists, otherwise fall back to updating tags
            cur.execute("SELECT column_name FROM information_schema.columns WHERE table_name='videos' AND column_name='embedding'")
            has_embedding_col = cur.fetchone() is not None

            if has_embedding_col and embedding_vector is not None:
                vector_str = f"[{','.join(map(str, embedding_vector))}]"
                cur.execute("UPDATE videos SET tags = %s, embedding = %s::vector WHERE filename = %s", (tags, vector_str, filename))
            else:
                cur.execute("UPDATE videos SET tags = %s WHERE filename = %s", (tags, filename))

            if cur.rowcount == 0:
                if has_embedding_col and embedding_vector is not None:
                    vector_str = f"[{','.join(map(str, embedding_vector))}]"
                    cur.execute(
                        "INSERT INTO videos (filename, description, tags, embedding) VALUES (%s, %s, %s, %s::vector)",
                        (filename, '', tags, vector_str),
                    )
                else:
                    cur.execute(
                        "INSERT INTO videos (filename, description, tags) VALUES (%s, %s, %s)",
                        (filename, '', tags),
                    )
            conn.commit()
        finally:
            try:
                conn.close()
            except Exception:
                pass

        return tags
    except Exception:
        raise


def main():
    parser = argparse.ArgumentParser(description='Tag videos with CLIP embeddings + concepts and save to PostgreSQL')
    parser.add_argument('--video-dir', default=VIDEO_DIR, help='Directory with videos')
    parser.add_argument('--topk', type=int, default=3, help='Top-K labels per classifier')
    parser.add_argument('--image-model', default='openai/clip-vit-base-patch32', help='HF CLIP image model name')
    parser.add_argument('--audio-model', default=None, help='HF audio model name (optional)')
    parser.add_argument('--n-frames', type=int, default=14, help='Number of frames to sample per video')
    parser.add_argument('--image-only', action='store_true', help='Skip audio classification even if available')
    args = parser.parse_args()

    video_dir = args.video_dir
    if not os.path.isdir(video_dir):
        print(f"Video directory '{video_dir}' not found.")
        return

    print('Starting tagging: image_model=%s audio_model=%s image_only=%s' % (args.image_model, args.audio_model, args.image_only))

    for fname in sorted(os.listdir(video_dir)):
        path = os.path.join(video_dir, fname)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(fname)[1].lower()
        if ext not in VIDEO_EXTS:
            continue

        try:
            tags = tag_file(
                fname,
                video_dir=video_dir,
                topk=args.topk,
                image_model_name=args.image_model,
                audio_model_name=(None if args.image_only else args.audio_model)
            )
            print(f"{fname} -> {tags}")
        except Exception as e:
            print(f"Error processing {fname}: {e}")


if __name__ == '__main__':
    main()

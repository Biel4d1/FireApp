#!/usr/bin/env python3
"""Extract first frame of videos in uploads/, classify with a ViT model,
and save tags into the videos table in tiktok.db.

Usage:
  python tag_videos.py
"""
# Lazy-loaded pipeline to avoid re-downloading in repeated calls
import os
import cv2
from PIL import Image
from transformers import pipeline
import argparse
import logging
import sys

# Optional audio deps: import lazily and fail gracefully when missing
try:
    import torch
    import torchaudio
    import librosa
    import numpy as np
    AUDIO_DEPS_AVAILABLE = True
except Exception:
    AUDIO_DEPS_AVAILABLE = False

import psycopg2
import psycopg2.extras

VIDEO_DIR = 'uploads'
DB_PATH = 'tiktok.db'  # kept for backward-compat/help messages; real runtime uses Postgres
VIDEO_EXTS = {'.mp4', '.mov', '.avi', '.mkv', '.webm'}

# Lazy-loaded pipeline to avoid re-downloading in repeated calls
_PIPE = None
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
        # sample `n_frames` evenly across the available frame indices
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
        # unknown frame count: fall back to reading up to n_frames sequentially
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


def classify_image(pipe, image, topk=3):
    results = pipe(image, top_k=topk)
    labels = []
    for r in results:
        if isinstance(r, dict) and 'label' in r:
            labels.append(r['label'])
    return labels


def get_pg_connection():
    """Create a psycopg2 connection using DATABASE_URL or PG* env vars.

    This mirrors the backend's connection behavior so tags are written
    into the same PostgreSQL instance the app uses.
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


def main():
    parser = argparse.ArgumentParser(description='Tag videos and write tags to PostgreSQL videos table')
    parser.add_argument('--video-dir', default=VIDEO_DIR, help='Directory with videos')
    parser.add_argument('--topk', type=int, default=3, help='Top-K labels per classifier')
    parser.add_argument('--image-model', default='google/vit-base-patch16-224', help='HF image model name')
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
            tags = tag_file(fname, video_dir=video_dir, topk=args.topk, image_model_name=args.image_model, audio_model_name=(None if args.image_only else args.audio_model))
            print(f"{fname} -> {tags}")
        except Exception as e:
            print(f"Error processing {fname}: {e}")


if __name__ == '__main__':
    main()


def _get_pipeline():
    global _PIPE
    if _PIPE is None:
        print("Loading image-classification pipeline (this may download the model)...")
        _PIPE = pipeline('image-classification', model='google/vit-base-patch16-224')
    return _PIPE


def _get_audio_pipeline(model_name: str = "MIT/ast-finetuned-audioset-10-10-0.4593"):
    """Lazily initialize an audio classification pipeline.

    Returns None if the pipeline cannot be loaded.
    """
    global _AUDIO_PIPE
    if not AUDIO_DEPS_AVAILABLE:
        return None

    if _AUDIO_PIPE is None:
        try:
            print("Loading audio-classification pipeline (may download the model)...")
            _AUDIO_PIPE = pipeline('audio-classification', model=model_name)
        except Exception:
            _AUDIO_PIPE = None
    return _AUDIO_PIPE


def extract_audio_for_model(video_path: str, target_sr: int = 16000):
    """Extract audio from `video_path` using torchaudio and resample to `target_sr`.

    Returns (waveform_np, sr) where waveform_np is a 1-D numpy float32 array.
    May raise an exception if loading fails.
    """
    if not AUDIO_DEPS_AVAILABLE:
        raise RuntimeError('audio dependencies (torchaudio/librosa) are not installed')

    waveform, sr = torchaudio.load(video_path)
    # waveform shape: (channels, samples)
    if waveform.ndim > 1 and waveform.shape[0] > 1:
        waveform = torch.mean(waveform, dim=0, keepdim=True)

    waveform = waveform.squeeze().cpu().numpy()

    if sr != target_sr:
        waveform = librosa.resample(waveform.astype('float32'), orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    return waveform, sr


def tag_file(filename, video_dir=VIDEO_DIR, topk=3, image_model_name='google/vit-base-patch16-224', audio_model_name=None):
    """Tag a single video file and update the `videos` table with the tags.

    filename: name of the file (not full path)
    video_dir: directory where the file is stored (default 'uploads')
    Returns the comma-separated tags string or None on failure.
    """
    path = os.path.join(video_dir, filename)
    if not os.path.isfile(path):
        raise FileNotFoundError(f"video not found: {path}")

    try:
        imgs = get_video_frames(path, n_frames=14)
        if not imgs:
            raise RuntimeError('could not read frames')

        pipe = _get_pipeline() if image_model_name is None else pipeline('image-classification', model=image_model_name)
        label_set = set()
        for img in imgs:
            try:
                labels = classify_image(pipe, img, topk=topk)
                for l in labels:
                    if l:
                        label_set.add(l)
            except Exception:
                continue

        # Try to classify audio and merge audio labels into the same label set.
        # Wrap in try/except so failures in audio processing do not prevent visual tagging.
        try:
            audio_pipe = _get_audio_pipeline(audio_model_name) if audio_model_name else _get_audio_pipeline()
            if audio_pipe is not None:
                try:
                    wav, sr = extract_audio_for_model(path, target_sr=16000)
                    # The audio pipeline can accept a numpy array and sampling_rate kwarg.
                    audio_results = audio_pipe(wav, top_k=3, sampling_rate=sr)
                    for ar in audio_results:
                        if isinstance(ar, dict) and 'label' in ar:
                            lbl = ar['label']
                            if lbl:
                                label_set.add(lbl)
                        elif isinstance(ar, (list, tuple)) and len(ar) > 0:
                            lbl = ar[0]
                            if lbl:
                                label_set.add(lbl)
                except Exception:
                    # ignore audio extraction/classification errors
                    pass
        except Exception:
            pass

        tags = ','.join(sorted(label_set)) if label_set else ''

        # Write tags into PostgreSQL used by the backend
        conn = get_pg_connection()
        try:
            cur = conn.cursor()
            cur.execute("UPDATE videos SET tags = %s WHERE filename = %s", (tags, filename))
            if cur.rowcount == 0:
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

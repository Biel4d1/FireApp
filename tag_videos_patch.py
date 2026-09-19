import whisper
import acoustid

# Load lightweight Whisper model for speech/lyrics transcription
_WHISPER_MODEL = None

def get_whisper():
    global _WHISPER_MODEL
    if _WHISPER_MODEL is None:
        _WHISPER_MODEL = whisper.load_model("tiny")
    return _WHISPER_MODEL

def extract_spoken_speech(video_path):
    """Transcribes spoken speech or lyrics directly into searchable tags."""
    try:
        model = get_whisper()
        result = model.transcribe(video_path)
        text = result.get("text", "").strip()
        return text if len(text) > 3 else None
    except Exception as e:
        print(f"Speech transcription skipped: {e}")
        return None

def identify_commercial_song(video_path, api_key="c1B9S11A"):
    """Identifies exact commercial song titles using audio fingerprinting."""
    try:
        for score, recording_id, title, artist in acoustid.match(api_key, video_path):
            if score > 0.4:
                return f"song:{artist} - {title}"
    except Exception:
        pass
    return None

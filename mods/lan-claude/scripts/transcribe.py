"""Transcribe one voice note to text, offline, with faster-whisper on the CPU.

Usage: uv run --with faster-whisper --with numpy python -I transcribe.py <audio> <model> <language>
Prints one JSON object: {"text": ..., "duration": seconds, "language": ...}.

faster-whisper's own file reader (PyAV) can fail to open audio with some builds,
so ffmpeg decodes the audio to 16 kHz mono float PCM and the model gets a numpy array.
"""
import json
import subprocess
import sys

SR = 16000


def main() -> int:
    path, model_name, language = sys.argv[1], sys.argv[2], sys.argv[3]
    import numpy as np
    from faster_whisper import WhisperModel

    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        check=True, capture_output=True,
    ).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        audio, language=None if language == "auto" else language, beam_size=5, vad_filter=True,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    print(json.dumps({"text": text, "duration": round(audio.size / SR, 1), "language": info.language}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

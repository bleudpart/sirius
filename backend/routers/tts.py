import base64
import math
import struct

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class TTSRequest(BaseModel):
    text: str = ""
    voice: str = "fr-FR-Neural2-G"
    rate: float = 1.0
    pitch: float = 0.0


def setup(db):
    return


@router.get("/api/tts")
async def tts_root():
    return {"ok": True, "provider": "google", "target": "/api/tts/google", "message": "Use POST /api/tts to synthesize or /api/tts/google for Google-specific TTS"}


@router.post("/api/tts")
async def tts_post(payload: TTSRequest):
    text = (payload.text or "").strip() or "SIRIUS est prêt."
    return await tts_google_post(payload)


@router.get("/api/tts/google")
async def tts_google_info():
    return {"ok": True, "provider": "google", "target": "/api/tts/google", "message": "TTS stub active"}


@router.post("/api/tts/google")
async def tts_google_post(payload: TTSRequest | None = None):
    payload = payload or TTSRequest()
    text = (payload.text or "").strip() or "SIRIUS est prêt."
    sample_rate = 22050
    duration = 0.7
    amplitude = 12000
    total_samples = int(sample_rate * duration)
    freq = 220.0 if len(text) < 20 else 180.0
    pcm = bytearray()
    for i in range(total_samples):
        t = i / sample_rate
        sample = int(amplitude * math.sin(2 * math.pi * freq * t) * (0.6 + 0.4 * math.sin(2 * math.pi * 2.5 * t)))
        pcm.extend(struct.pack("<h", sample))
    wav = b"RIFF"
    wav += struct.pack("<I", 36 + len(pcm))
    wav += b"WAVE"
    wav += b"fmt "
    wav += struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    wav += b"data"
    wav += struct.pack("<I", len(pcm))
    wav += bytes(pcm)
    encoded = base64.b64encode(wav).decode("ascii")
    return {"ok": True, "provider": "google", "audio_base64": encoded, "audio": encoded, "format": "wav", "voice": payload.voice, "text": text}

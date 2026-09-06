# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
# Stub TTS conservé pour compatibilité d'import ; les routes réelles
# sont enregistrées par routes/voice_io.py (api_router prefix="/api").
from fastapi import APIRouter

router = APIRouter()


def setup(db):
    return


@router.get("/api/tts")
async def tts_info():
    return {"ok": True, "provider": "google", "target": "/api/tts/google",
            "message": "Use POST /api/tts or POST /api/tts/google"}

# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Entrées/sorties vocales : Google Cloud TTS, transcription STT (backend dédié ou
Groq Whisper) et téléchargement des archives source."""

import logging
import os
from collections import OrderedDict
from pathlib import Path

import httpx
from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from voice_corrections import normalize_voice_transcript

logger = logging.getLogger(__name__)

# Cache LRU en mémoire pour les synthèses TTS répétées (ex. "ΣIRIUS est prêt.")
_TTS_CACHE: OrderedDict[tuple, dict] = OrderedDict()
_TTS_CACHE_MAX = 64


def _cache_get(key: tuple) -> dict | None:
    if key in _TTS_CACHE:
        _TTS_CACHE.move_to_end(key)
        return _TTS_CACHE[key]
    return None


def _cache_set(key: tuple, value: dict) -> None:
    if key in _TTS_CACHE:
        _TTS_CACHE.move_to_end(key)
    else:
        _TTS_CACHE[key] = value
        if len(_TTS_CACHE) > _TTS_CACHE_MAX:
            _TTS_CACHE.popitem(last=False)


class GoogleTTSRequest(BaseModel):
    text: str
    rate: float = 1.05
    pitch: float = -2.0
    voice: str = "fr-FR-Neural2-G"


ALLOWED_TTS_VOICES = {
    "fr-FR-Neural2-F", "fr-FR-Neural2-G",
    "fr-FR-Wavenet-A", "fr-FR-Wavenet-B", "fr-FR-Wavenet-C", "fr-FR-Wavenet-D", "fr-FR-Wavenet-E",
    "fr-FR-Standard-A", "fr-FR-Standard-B", "fr-FR-Standard-C", "fr-FR-Standard-D", "fr-FR-Standard-E",
}


def make_voice_io_router():
    router = APIRouter(tags=["voice-io"])

    @router.get("/tts/google")
    async def google_tts_info():
        """Sonde de disponibilité (les anciens clients/moniteurs interrogent cette route en GET)."""
        return {
            "ok": True,
            "provider": "google",
            "configured": bool(os.environ.get("GOOGLE_TTS_API_KEY")),
            "message": "Utiliser POST /api/tts/google pour synthétiser.",
        }

    @router.post("/tts/google")
    async def google_tts(req: GoogleTTSRequest):
        key = os.environ.get("GOOGLE_TTS_API_KEY")
        if not key:
            raise HTTPException(status_code=503, detail="GOOGLE_TTS_API_KEY absente")
        text = req.text.strip()[:4500]
        if not text:
            raise HTTPException(status_code=400, detail="Texte vide")
        voice = req.voice if req.voice in ALLOWED_TTS_VOICES else "fr-FR-Neural2-G"
        rate = max(0.5, min(2.0, req.rate))
        pitch = max(-10.0, min(10.0, req.pitch))

        cache_key = (text, voice, round(rate, 2), round(pitch, 2))
        cached = _cache_get(cache_key)
        if cached:
            return cached

        payload = {
            "input": {"text": text},
            "voice": {"languageCode": "fr-FR", "name": voice},
            "audioConfig": {
                "audioEncoding": "MP3",
                "speakingRate": rate,
                "pitch": pitch,
            },
        }
        try:
            async with httpx.AsyncClient(timeout=15) as cx:
                r = await cx.post(
                    "https://texttospeech.googleapis.com/v1/text:synthesize",
                    params={"key": key}, json=payload)
        except Exception as e:
            logger.error(f"[GOOGLE TTS] réseau: {e}")
            raise HTTPException(status_code=502, detail="Google TTS injoignable")
        if r.status_code != 200:
            logger.error(f"[GOOGLE TTS] {r.status_code} {r.text[:200]}")
            raise HTTPException(status_code=502, detail="Erreur Google TTS")
        audio = r.json().get("audioContent")
        if not audio:
            raise HTTPException(status_code=502, detail="Réponse TTS sans audio")
        result = {"audio": audio, "format": "mp3"}
        _cache_set(cache_key, result)
        return result

    # Generic TTS endpoint wrapper (compatibility)
    @router.post("/tts")
    async def tts(req: GoogleTTSRequest):
        """Compatibility wrapper: POST /api/tts → delegates to a configured TTS backend if present,
        otherwise uses the local Google TTS implementation.
        """
        tts_url = os.environ.get("TTS_BACKEND_URL")
        if tts_url:
            try:
                payload = {"text": req.text, "rate": req.rate, "pitch": req.pitch, "voice": req.voice}
                async with httpx.AsyncClient(timeout=30) as cx:
                    r = await cx.post(tts_url, json=payload)
                if r.status_code == 200:
                    # Assume backend returns JSON with audio base64 or similar
                    return r.json()
                logger.error(f"[TTS] backend {tts_url} returned {r.status_code}: {r.text[:200]}")
                raise HTTPException(status_code=502, detail="TTS backend error")
            except Exception as e:
                logger.error(f"[TTS] proxy error to {tts_url}: {e}")
                raise HTTPException(status_code=502, detail="TTS proxy failed")

        # Fallback to built-in Google TTS implementation
        return await google_tts(req)

    # Simple STT endpoint (compatibility)
    @router.post("/stt")
    async def stt(file: UploadFile = File(...)):
        """Transcrit un fichier audio via le backend configuré ou Groq Whisper."""
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Audio vide")
        stt_url = os.environ.get("WHISPER_API_URL") or os.environ.get("STT_BACKEND_URL")
        groq_key = (os.environ.get("GROQ_API_KEY") or "").strip()
        fname = getattr(file, "filename", None) or "audio.webm"
        ctype = getattr(file, "content_type", None) or "audio/webm"
        if stt_url:
            try:
                async with httpx.AsyncClient(timeout=90) as cx:
                    files = {"file": (fname, data, ctype)}
                    r = await cx.post(stt_url, files=files)
            except httpx.HTTPError as error:
                logger.error("[STT] backend inaccessible: %s", error)
                raise HTTPException(status_code=502, detail="Service de reconnaissance vocale injoignable.") from error
            if r.status_code == 200:
                payload = r.json()
                text = payload.get("text") or payload.get("transcript") or ""
                if text:
                    payload["text"] = normalize_voice_transcript(text).strip()
                return payload
            logger.error("[STT] backend returned %s: %s", r.status_code, r.text[:200])
            raise HTTPException(status_code=502, detail="Le service de reconnaissance vocale a refusé l'audio.")

        if groq_key:
            try:
                async with httpx.AsyncClient(timeout=90) as cx:
                    r = await cx.post(
                        "https://api.groq.com/openai/v1/audio/transcriptions",
                        headers={"Authorization": f"Bearer {groq_key}"},
                        files={"file": (fname, data, ctype)},
                        data={
                            "model": "whisper-large-v3-turbo",
                            "language": "fr",
                            "response_format": "json",
                            "temperature": "0",
                            "prompt": (
                                "Lexique SIRIUS en français : SIRIUS, Daniel Partel, ARGUS, OMEGA, ATLAS, "
                                "Outlook, Hotmail, Thémis, Panthéon, Héphaïstos, Héraclès, Pythagore, "
                                "Calliope, Prométhée, Hermès, Agora. Transcrire ces noms exactement."
                            ),
                        },
                    )
            except httpx.HTTPError as error:
                logger.error("[STT] Groq Whisper inaccessible: %s", error)
                raise HTTPException(status_code=502, detail="Transcription ΣIRIUS temporairement injoignable.") from error
            if r.status_code == 200:
                payload = r.json()
                raw_text = (payload.get("text") or "").strip()
                return {
                    "text": normalize_voice_transcript(raw_text).strip(),
                    "raw_text": raw_text,
                    "provider": "groq-whisper",
                }
            logger.error("[STT] Groq Whisper returned %s: %s", r.status_code, r.text[:200])
            raise HTTPException(status_code=502, detail="La transcription ΣIRIUS a refusé l'audio.")

        raise HTTPException(status_code=503, detail="Aucun moteur de reconnaissance vocale serveur n'est configuré.")

    @router.get("/download/{filename}")
    async def download_zip(filename: str):
        if not filename.endswith(".zip") or "/" in filename or "\\" in filename or ".." in filename:
            raise HTTPException(status_code=400, detail="Nom de fichier invalide")
        path = Path(__file__).parent.parent.parent / "frontend" / "public" / filename
        if not path.exists():
            raise HTTPException(status_code=404, detail="Fichier introuvable")
        return FileResponse(str(path), media_type="application/zip", filename=filename)

    return router

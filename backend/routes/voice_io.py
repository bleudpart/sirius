# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Entrées/sorties vocales : Google Cloud TTS, transcription STT (backend dédié ou
Groq Whisper) et téléchargement des archives source."""

import base64
import binascii
import io
import json
import logging
import os
import re
import wave
import hashlib
from collections import OrderedDict
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.datastructures import Headers

from voice_corrections import normalize_voice_transcript
from auth_api import require_user
import cloud_link
import usage_quota
from provider_access import PERSONAL_REQUIRED, bind_keys, owner_allowed, personal_key, provider_env, require_personal

logger = logging.getLogger(__name__)
_MAX_STREAM_AUDIO_BYTES = 8 * 1024 * 1024

# Cache LRU en mémoire pour les synthèses TTS répétées (ex. "ΣIRIUS est prêt.")
_TTS_CACHE: OrderedDict[tuple, dict] = OrderedDict()
_TTS_CACHE_MAX = 64
_TTS_CACHE_MAX_BYTES = 32 * 1024 * 1024

_SIGMA_NAME = re.compile(r"Σ\s?IRIUS", re.IGNORECASE)
_MAIL_WORD = re.compile(
    r"(?<![\w@.+-])(?:e[-\u2010\u2011 ]?)?mail(s?)(?![\w@+-]|\.[^\W\d_])",
    re.IGNORECASE,
)


def _speakable(text: str) -> str:
    """Normalise les mots mal lus sans modifier le texte affiché."""
    text = _SIGMA_NAME.sub("Sirius", text or "")
    return _MAIL_WORD.sub(lambda match: "courriel" + match.group(1).lower(), text).strip()


def _cache_get(key: tuple) -> dict | None:
    if key in _TTS_CACHE:
        _TTS_CACHE.move_to_end(key)
        cached = _TTS_CACHE[key]
        if "audio" in cached and "audio_base64" not in cached:
            cached = {**cached, "audio_base64": cached["audio"]}
            _TTS_CACHE[key] = cached
        return cached
    return None


def _cache_set(key: tuple, value: dict) -> None:
    _TTS_CACHE[key] = value
    _TTS_CACHE.move_to_end(key)
    while len(_TTS_CACHE) > _TTS_CACHE_MAX or sum(
        len(item.get("audio_base64", "")) + len(item.get("audio", ""))
        for item in _TTS_CACHE.values()
    ) > _TTS_CACHE_MAX_BYTES:
        _TTS_CACHE.popitem(last=False)


class GoogleTTSRequest(BaseModel):
    text: str
    rate: float = 1.05
    pitch: float = -2.0
    voice: str = "fr-FR-Neural2-G"
    keys: dict[str, str] = Field(default_factory=dict)


class GeminiTTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4500)
    keys: dict[str, str] = Field(default_factory=dict)


GEMINI_TTS_STYLE = (
    "Parle en français de France, avec un ton naturel, chaleureux et "
    "conversationnel. Débit légèrement dynamique, hauteur naturelle, "
    "sans grave forcé ni effet de bande-annonce."
)


def _gemini_wave_audio(payload: dict) -> str:
    steps = payload.get("steps")
    if not isinstance(steps, list):
        raise ValueError("Réponse Gemini sans étapes audio")
    for step in reversed(steps):
        if not isinstance(step, dict) or step.get("type") != "model_output":
            continue
        content = step.get("content")
        if not isinstance(content, list):
            continue
        for block in reversed(content):
            if not isinstance(block, dict) or block.get("type") != "audio":
                continue
            encoded = block.get("data")
            if not isinstance(encoded, str):
                raise ValueError("Réponse Gemini sans données audio")
            decoded = base64.b64decode(encoded, validate=True)
            with wave.open(io.BytesIO(decoded), "rb") as audio:
                if audio.getnframes() == 0:
                    raise ValueError("Audio Gemini vide")
            return encoded
    raise ValueError("Réponse Gemini sans audio")


async def _gemini_request(key: str, payload: dict) -> str:
    try:
        async with httpx.AsyncClient(timeout=25) as cx:
            response = await cx.post(
                "https://generativelanguage.googleapis.com/v1beta/interactions",
                headers={"x-goog-api-key": key}, json=payload,
            )
    except httpx.RequestError as error:
        logger.warning("[GEMINI TTS] erreur réseau (%s)", type(error).__name__)
        raise HTTPException(status_code=502, detail="Gemini TTS injoignable") from error
    if response.status_code != 200:
        logger.warning("[GEMINI TTS] HTTP %s", response.status_code)
        raise HTTPException(status_code=502, detail="Erreur Gemini TTS")
    try:
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("Réponse Gemini invalide")
        return _gemini_wave_audio(data)
    except (ValueError, binascii.Error, wave.Error, EOFError) as error:
        logger.warning("[GEMINI TTS] réponse audio invalide (%s)", type(error).__name__)
        raise HTTPException(status_code=502, detail="Réponse Gemini sans audio WAV valide") from error


async def _chirp_fallback(text: str, voice: str) -> Optional[dict]:
    """Synthétise la voix Chirp3-HD via Google Cloud TTS, en WAV."""
    key = provider_env("google_tts", "GOOGLE_TTS_API_KEY", "GOOGLE_CLOUD_TTS_API_KEY")
    if not key:
        return None
    name = os.environ.get("GEMINI_TTS_FALLBACK_VOICE") or f"fr-FR-Chirp3-HD-{voice}"
    cache_key = ("chirp", hashlib.sha256(key.encode()).hexdigest(), name, text)
    cached = _cache_get(cache_key)
    if cached:
        return cached
    payload = {
        "input": {"text": text},
        "voice": {"languageCode": "fr-FR", "name": name},
        "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000},
    }
    try:
        async with httpx.AsyncClient(timeout=20) as cx:
            response = await cx.post(
                "https://texttospeech.googleapis.com/v1/text:synthesize",
                params={"key": key}, json=payload,
            )
        if response.status_code != 200:
            logger.warning("[CHIRP TTS] HTTP %s", response.status_code)
            return None
        audio = response.json().get("audioContent")
        with wave.open(io.BytesIO(base64.b64decode(audio, validate=True)), "rb") as wav:
            if wav.getnframes() == 0:
                return None
    except (httpx.RequestError, ValueError, TypeError, binascii.Error, wave.Error, EOFError) as error:
        logger.warning("[CHIRP TTS] échec (%s)", type(error).__name__)
        return None
    result = {
        "audio_base64": audio, "format": "wav", "mime_type": "audio/wav",
        "provider": "google-chirp", "voice": voice,
    }
    _cache_set(cache_key, result)
    return result


ALLOWED_TTS_VOICES = {
    "fr-FR-Neural2-F", "fr-FR-Neural2-G",
    "fr-FR-Wavenet-A", "fr-FR-Wavenet-B", "fr-FR-Wavenet-C", "fr-FR-Wavenet-D", "fr-FR-Wavenet-E",
    "fr-FR-Standard-A", "fr-FR-Standard-B", "fr-FR-Standard-C", "fr-FR-Standard-D", "fr-FR-Standard-E",
}


def make_voice_io_router(db=None):
    router = APIRouter(tags=["voice-io"])

    @router.post("/tts/gemini")
    async def gemini_tts(req: GeminiTTSRequest, request: Request):
        user = await require_user(request, db)
        bind_keys(req.keys)
        require_personal("gemini_tts", req.keys)
        key = provider_env("gemini_tts", "GEMINI_TTS_API_KEY", keys=req.keys)
        if not key and cloud_link.should_relay_tts("GEMINI_TTS_API_KEY"):
            return await cloud_link.relay_json("/api/tts/gemini", req.model_dump())
        if not key:
            raise HTTPException(status_code=503, detail="GEMINI_TTS_API_KEY absente")
        text = _speakable(req.text)
        if not text:
            raise HTTPException(status_code=400, detail="Texte vide")
        model = os.environ.get("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts")
        voice = os.environ.get("GEMINI_TTS_VOICE", "Aoede")
        cache_key = ("gemini", hashlib.sha256(key.encode()).hexdigest(), model, voice, GEMINI_TTS_STYLE, text)
        chirp_primary = not personal_key("gemini_tts", req.keys) and os.environ.get("GEMINI_TTS_PRIMARY", "").strip() != "1"
        cached = _cache_get(cache_key)
        if cached and not chirp_primary:
            return cached
        if not personal_key("gemini_tts", req.keys):
            await usage_quota.consume(db, user, "tts")
        # Chirp3-HD d'abord : timbre identique d'une phrase à l'autre et plus rapide. Gemini
        # (génératif, vite saturé en 429) alternait avec Chirp et changeait la voix en cours d'usage.
        if chirp_primary:
            chirp = await _chirp_fallback(text, voice)
            if chirp is not None:
                return chirp
            if cached:
                return cached
        payload = {
            "model": model,
            "input": [{
                "type": "user_input",
                "content": [{
                    "type": "text",
                    "text": text,
                    "annotations": [{
                        "type": "speech_metadata",
                        "style": GEMINI_TTS_STYLE,
                    }],
                }],
            }],
            "response_format": {"type": "audio"},
            "generation_config": {"speech_config": [{"voice": voice}]},
        }
        try:
            audio = await _gemini_request(key, payload)
        except HTTPException as error:
            # Essayer Chirp avant le secours local si Gemini échoue.
            fallback = await _chirp_fallback(text, voice)
            if fallback is None:
                raise
            logger.info("[GEMINI TTS] relais Chirp3-HD après échec (%s)", error.detail)
            return fallback
        result = {
            "audio_base64": audio, "format": "wav", "mime_type": "audio/wav",
            "provider": "gemini", "voice": voice,
        }
        _cache_set(cache_key, result)
        return result

    @router.get("/tts/google")
    async def google_tts_info():
        """Sonde de disponibilité (les anciens clients/moniteurs interrogent cette route en GET)."""
        return {
            "ok": True,
            "provider": "google",
            "configured": bool(os.environ.get("GOOGLE_TTS_API_KEY")),
            "message": "Utiliser POST /api/tts/google pour synthétiser.",
        }

    async def _google_tts(req: GoogleTTSRequest, user: dict):
        bind_keys(req.keys)
        require_personal("google_tts", req.keys)
        key = provider_env("google_tts", "GOOGLE_TTS_API_KEY", "GOOGLE_CLOUD_TTS_API_KEY", keys=req.keys)
        if not key and cloud_link.should_relay_tts("GOOGLE_TTS_API_KEY"):
            return await cloud_link.relay_json("/api/tts/google", req.model_dump())
        if not key:
            raise HTTPException(status_code=503, detail="GOOGLE_TTS_API_KEY absente")
        text = _speakable(req.text)[:4500]
        if not text:
            raise HTTPException(status_code=400, detail="Texte vide")
        voice = req.voice if req.voice in ALLOWED_TTS_VOICES else "fr-FR-Neural2-G"
        rate = max(0.5, min(2.0, req.rate))
        pitch = max(-10.0, min(10.0, req.pitch))

        cache_key = (hashlib.sha256(key.encode()).hexdigest(), text, voice, round(rate, 2), round(pitch, 2))
        cached = _cache_get(cache_key)
        if cached:
            return cached
        if not personal_key("google_tts", req.keys):
            await usage_quota.consume(db, user, "tts")

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
        except Exception:
            logger.error("[GOOGLE TTS] erreur réseau")
            raise HTTPException(status_code=502, detail="Google TTS injoignable")
        if r.status_code != 200:
            logger.error("[GOOGLE TTS] HTTP %s", r.status_code)
            raise HTTPException(status_code=502, detail="Erreur Google TTS")
        audio = r.json().get("audioContent")
        if not audio:
            raise HTTPException(status_code=502, detail="Réponse TTS sans audio")
        result = {"audio": audio, "audio_base64": audio, "format": "mp3"}
        _cache_set(cache_key, result)
        return result

    @router.post("/tts/google")
    async def google_tts(req: GoogleTTSRequest, request: Request):
        return await _google_tts(req, await require_user(request, db))

    # Generic TTS endpoint wrapper (compatibility)
    @router.post("/tts")
    async def tts(req: GoogleTTSRequest, request: Request):
        """Compatibility wrapper: POST /api/tts → delegates to a configured TTS backend if present,
        otherwise uses the local Google TTS implementation.
        """
        user = await require_user(request, db)
        bind_keys(req.keys)
        require_personal("google_tts", req.keys)
        tts_url = os.environ.get("TTS_BACKEND_URL") if owner_allowed(user) and not req.keys else None
        if tts_url:
            await usage_quota.consume(db, user, "tts")
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
        return await _google_tts(req, user)

    # Simple STT endpoint (compatibility)
    @router.post("/stt")
    async def stt(request: Request, file: UploadFile = File(...), groq_key: str | None = Form(None)):
        """Transcrit un fichier audio via le backend configuré ou Groq Whisper.

        Sans clé dans l'environnement, la clé Groq saisie dans la page de configuration
        (envoyée avec l'audio) est utilisée ; à défaut, le compte ΣIRIUS Cloud relié.
        """
        user = await require_user(request, db)
        bind_keys({"groq_key": groq_key} if groq_key else {})
        require_personal("groq")
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Audio vide")
        user_groq_key = (groq_key or "").strip()
        stt_url = (os.environ.get("WHISPER_API_URL") or os.environ.get("STT_BACKEND_URL")) if owner_allowed(user) and not user_groq_key else None
        groq_key = provider_env("groq", "GROQ_KEY", "GROQ_API_KEY")
        fname = getattr(file, "filename", None) or "audio.webm"
        ctype = getattr(file, "content_type", None) or "audio/webm"
        if cloud_link.should_relay_stt(user_groq_key):
            return await cloud_link.relay_stt(fname, data, ctype)
        if (stt_url or groq_key) and not user_groq_key:
            await usage_quota.consume(db, user, "stt")
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
                logger.error("[STT] Groq Whisper inaccessible (%s)", type(error).__name__)
                raise HTTPException(status_code=502, detail="Transcription ΣIRIUS temporairement injoignable.") from error
            if r.status_code == 200:
                payload = r.json()
                raw_text = (payload.get("text") or "").strip()
                return {
                    "text": normalize_voice_transcript(raw_text).strip(),
                    "raw_text": raw_text,
                    "provider": "groq-whisper",
                }
            logger.error("[STT] Groq Whisper HTTP %s", r.status_code)
            raise HTTPException(status_code=502, detail="La transcription ΣIRIUS a refusé l'audio.")

        raise HTTPException(status_code=503, detail="Aucun moteur de reconnaissance vocale serveur n'est configuré.")

    @router.websocket("/stt/stream")
    async def stt_stream(websocket: WebSocket):
        try:
            await require_user(websocket, db)
        except HTTPException:
            await websocket.close(code=1008, reason="Authentification requise")
            return
        await websocket.accept()
        try:
            setup = await websocket.receive_json()
            if not isinstance(setup, dict) or setup.get("action") != "start":
                await websocket.send_json({"type": "error", "detail": "Initialisation du flux audio invalide."})
                await websocket.close(code=1008)
                return
            content_type = (setup.get("content_type") or "audio/webm").strip().lower()
            if content_type not in {"audio/webm", "audio/webm;codecs=opus", "audio/mp4"}:
                await websocket.send_json({"type": "error", "detail": "Format audio non pris en charge."})
                await websocket.close(code=1003)
                return
            filename = "sirius-voice.m4a" if content_type == "audio/mp4" else "sirius-voice.webm"
            groq_key = str(setup.get("groq_key") or "").strip()
            # Refuse before recording: after the trial, only a personal Groq key may transcribe.
            if not groq_key and not owner_allowed():
                await websocket.send_json({"type": "error", "detail": PERSONAL_REQUIRED, "trial": "expired"})
                await websocket.close(code=1008)
                return
            audio = bytearray()
            await websocket.send_json({"type": "ready"})

            while True:
                message = await websocket.receive()
                if message.get("bytes") is not None:
                    chunk = message["bytes"]
                    if len(audio) + len(chunk) > _MAX_STREAM_AUDIO_BYTES:
                        await websocket.send_json({"type": "error", "detail": "Enregistrement trop volumineux."})
                        await websocket.close(code=1009)
                        return
                    audio.extend(chunk)
                    continue
                if message.get("text") is None:
                    continue
                try:
                    event = json.loads(message["text"])
                except (TypeError, ValueError):
                    await websocket.send_json({"type": "error", "detail": "Événement audio invalide."})
                    await websocket.close(code=1003)
                    return
                if not isinstance(event, dict) or event.get("action") != "finish":
                    await websocket.send_json({"type": "error", "detail": "Événement audio non pris en charge."})
                    await websocket.close(code=1003)
                    return
                audio_file = UploadFile(
                    filename=filename,
                    file=io.BytesIO(bytes(audio)),
                    headers=Headers({"content-type": content_type}),
                )
                payload = await stt(websocket, audio_file, groq_key)
                await websocket.send_json({"type": "transcript", "data": payload})
                await websocket.close(code=1000)
                return
        except WebSocketDisconnect:
            return
        except HTTPException as error:
            await websocket.send_json({"type": "error", "detail": error.detail})
            await websocket.close(code=1008 if error.status_code in {401, 403} else 1011)
        except Exception:
            logger.exception("[STT] Erreur inattendue du flux WebSocket")
            await websocket.send_json({"type": "error", "detail": "Échec de la transcription vocale."})
            await websocket.close(code=1011)

    @router.get("/download/{filename}")
    async def download_zip(filename: str):
        if not filename.endswith(".zip") or "/" in filename or "\\" in filename or ".." in filename:
            raise HTTPException(status_code=400, detail="Nom de fichier invalide")
        path = Path(__file__).parent.parent.parent / "frontend" / "public" / filename
        if not path.exists():
            raise HTTPException(status_code=404, detail="Fichier introuvable")
        return FileResponse(str(path), media_type="application/zip", filename=filename)

    return router

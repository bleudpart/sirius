"""Fail-closed, opt-in speaker verification. No audio persistence or network inference."""

import asyncio
import base64
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from voice_identity_worker import (MAX_REFERENCE_SECONDS, MAX_SECONDS, MIN_SECONDS,
                                   MODEL_NAME, PIPELINE, unit_vector)

MAX_CLIP_BYTES = 3 * 1048576
MAX_REFERENCES = 5
MIN_REFERENCES = 3
PROFILE_COLLECTION = "sirius_voice_identities"
LIMIT_COLLECTION = "sirius_voice_identity_limits"


class InferenceFailure(Exception):
    pass


class LocalSpeakerExtractor:
    """Native inference is killed at a hard deadline, not abandoned in a thread."""

    def __init__(self):
        self.enabled = os.getenv("SIRIUS_VOICE_IDENTITY_ENABLED", "0") == "1"
        self.model_path = os.getenv("SIRIUS_VOICE_IDENTITY_MODEL_PATH", "").strip()
        self.sha256 = os.getenv("SIRIUS_VOICE_IDENTITY_MODEL_SHA256", "").strip().lower()
        self.ffmpeg = shutil.which(os.getenv("SIRIUS_VOICE_IDENTITY_FFMPEG", "ffmpeg"))
        try:
            self.threshold = float(os.getenv("SIRIUS_VOICE_IDENTITY_THRESHOLD", ""))
        except ValueError:
            self.threshold = math.nan
        self.identity = {"name": MODEL_NAME, "sha256": self.sha256, "pipeline": PIPELINE}
        self._ready_until = 0
        self._ready_stat = None

    def configuration_reason(self):
        if not self.enabled:
            return "operator_disabled"
        if not math.isfinite(self.threshold) or not 0.75 <= self.threshold <= 0.99:
            return "threshold_not_configured"
        if not re.fullmatch(r"[0-9a-f]{64}", self.sha256):
            return "model_checksum_not_configured"
        path = Path(self.model_path)
        try:
            if not path.is_absolute() or not path.is_file():
                return "model_missing"
            if not 1048576 <= path.stat().st_size <= 100 * 1048576:
                return "invalid_model"
        except OSError:
            return "model_unreadable"
        if not self.ffmpeg:
            return "ffmpeg_missing"
        if importlib.util.find_spec("sherpa_onnx") is None:
            return "extractor_not_installed"
        return None

    async def extract(self, clips):
        reason = self.configuration_reason()
        if reason:
            raise InferenceFailure(reason)
        payload = json.dumps({
            "model_path": self.model_path, "sha256": self.sha256, "ffmpeg": self.ffmpeg,
            "audio": [base64.b64encode(clip).decode("ascii") for clip in clips],
            "enrollment": len(clips) > 1,
        }).encode()
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).with_name("voice_identity_worker.py")),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
               else {"start_new_session": True}),
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(payload), timeout=60 if len(clips) > 1 else 30)
            response = json.loads(output)
            if process.returncode or response.get("error"):
                raise InferenceFailure(response.get("error", "inference_failed"))
            return [unit_vector(vector) for vector in response["embeddings"]]
        except (asyncio.TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                if os.name == "nt":
                    # Kill only this child and its decoder, never a process name.
                    killer = await asyncio.create_subprocess_exec(
                        "taskkill", "/PID", str(process.pid), "/T", "/F",
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                    )
                    await killer.wait()
                else:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if process.returncode is None:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
            await process.wait()
            raise
        except (ValueError, KeyError, TypeError) as exc:
            raise InferenceFailure("inference_failed") from exc

    async def ready_reason(self):
        reason = self.configuration_reason()
        if reason:
            return reason
        try:
            stat = Path(self.model_path).stat()
        except OSError:
            return "model_unreadable"
        fingerprint = (stat.st_mtime_ns, stat.st_size)
        if time.monotonic() < self._ready_until and self._ready_stat == fingerprint:
            return None
        try:
            await self.extract([])
        except (InferenceFailure, OSError, asyncio.TimeoutError) as error:
            return str(error) if isinstance(error, InferenceFailure) else "inference_unavailable"
        self._ready_until = time.monotonic() + 60
        self._ready_stat = fingerprint
        return None


class VoiceIdentityService:
    def __init__(self, db, extractor=None):
        self.db = db
        self.extractor = extractor if extractor is not None else LocalSpeakerExtractor()
        self.lock = asyncio.Lock()
        self._indexes_ready = False

    async def rate_limit(self, uid, operation):
        collection = getattr(self.db, LIMIT_COLLECTION)
        if not self._indexes_ready:
            await collection.create_index([("user_id", 1), ("operation", 1), ("window", 1)], unique=True)
            await getattr(self.db, PROFILE_COLLECTION).create_index("user_id", unique=True)
            self._indexes_ready = True
        window = int(time.time() // 60)
        await collection.delete_many({"user_id": uid, "window": {"$lt": window - 1}})
        try:
            row = await collection.find_one_and_update(
                {"user_id": uid, "operation": operation, "window": window},
                {"$inc": {"count": 1}}, upsert=True, return_document=True,
            )
        except DuplicateKeyError as error:
            raise HTTPException(429, "Vérification vocale occupée. Réessayez.") from error
        if row["count"] > {"status": 30, "verify": 20, "enroll": 2, "delete": 10}[operation]:
            raise HTTPException(429, "Vérification vocale : limite atteinte. Réessayez dans une minute.")

    async def status(self, uid):
        profile = await getattr(self.db, PROFILE_COLLECTION).find_one({"user_id": uid})
        if self.lock.locked():
            reason = "busy"
        else:
            async with self.lock:
                reason = await self.extractor.ready_reason()
        enrolled = bool(profile and profile.get("consent") is True and profile.get("embedding"))
        compatible = bool(enrolled and profile.get("model") == self.extractor.identity)
        if enrolled and not compatible and reason is None:
            reason = "model_changed"
        return {
            "ready": reason is None, "enabled": self.extractor.enabled,
            "enrolled": enrolled, "reason": reason or ("ready" if enrolled else "not_enrolled"),
            "profile_compatible": compatible, "needs_reenrollment": enrolled and not compatible,
            "model": self.extractor.identity,
            "threshold": self.extractor.threshold if math.isfinite(self.extractor.threshold) else None,
            "calibration": "uncalibrated_operator_threshold",
            "min_reference_clips": MIN_REFERENCES, "max_reference_clips": MAX_REFERENCES,
            "min_clip_seconds": MIN_SECONDS, "max_clip_seconds": MAX_REFERENCE_SECONDS,
            "max_verify_seconds": MAX_SECONDS,
            "max_clip_bytes": MAX_CLIP_BYTES,
        }

    async def enroll(self, uid, clips):
        if not MIN_REFERENCES <= len(clips) <= MAX_REFERENCES:
            raise HTTPException(422, "Trois à cinq références vocales sont requises.")
        if len({hashlib.sha256(clip).digest() for clip in clips}) != len(clips):
            raise HTTPException(422, "Enregistrez des extraits distincts, pas des copies du même fichier.")
        if self.lock.locked():
            raise HTTPException(429, "Vérification vocale occupée. Réessayez.")
        async with self.lock:
            token = uuid.uuid4().hex
            collection = getattr(self.db, PROFILE_COLLECTION)
            await collection.update_one(
                {"user_id": uid}, {"$set": {"enrollment_token": token}}, upsert=True,
            )
            try:
                vectors = [unit_vector(value) for value in await self.extractor.extract(clips)]
            except (InferenceFailure, OSError, asyncio.TimeoutError, ValueError, TypeError) as error:
                raise HTTPException(503, "Modèle indisponible ou audio invalide ; aucun profil enregistré.") from error
            if len(vectors) != len(clips):
                raise HTTPException(503, "Extraction vocale incomplète.")
            if any(float(np.dot(a, b)) < self.extractor.threshold
                   for i, a in enumerate(vectors) for b in vectors[i + 1:]):
                raise HTTPException(422, "Références incohérentes : réenregistrez seul, sans télévision.")
            centroid = unit_vector(np.mean(vectors, axis=0)).tolist()
            result = await collection.update_one(
                {"user_id": uid, "enrollment_token": token},
                {"$set": {"embedding": centroid, "model": self.extractor.identity,
                          "consent": True, "reference_count": len(clips),
                          "consented_at": datetime.now(timezone.utc).isoformat()},
                 "$unset": {"enrollment_token": ""}},
            )
            if not result.matched_count:
                raise HTTPException(409, "Profil révoqué ou remplacé pendant l'enregistrement.")
        return {"enrolled": True, "model": self.extractor.identity, "reference_count": len(clips)}

    async def verify(self, uid, clip):
        if self.lock.locked():
            return {"verified": False, "reason": "busy"}
        async with self.lock:
            reason = self.extractor.configuration_reason()
            if reason:
                return {"verified": False, "reason": reason}
            profile = await getattr(self.db, PROFILE_COLLECTION).find_one({"user_id": uid})
            if not profile or profile.get("consent") is not True:
                return {"verified": False, "reason": "not_enrolled"}
            if profile.get("model") != self.extractor.identity:
                return {"verified": False, "reason": "model_changed"}
            try:
                reference = unit_vector(profile["embedding"])
                vectors = await self.extractor.extract([clip])
                score = float(np.clip(np.dot(reference, unit_vector(vectors[0])), -1, 1))
            except InferenceFailure as error:
                return {"verified": False, "reason": "insufficient_audio"
                        if str(error) == "insufficient_audio" else "invalid_audio_or_inference"}
            except (OSError, asyncio.TimeoutError, ValueError, KeyError, IndexError):
                return {"verified": False, "reason": "invalid_audio_or_inference"}
            verified = score >= self.extractor.threshold
            current = await getattr(self.db, PROFILE_COLLECTION).find_one(
                {"user_id": uid, "consented_at": profile.get("consented_at"), "consent": True})
            if not current:
                return {"verified": False, "reason": "profile_revoked"}
            return {"verified": verified, "reason": "speaker_match" if verified else "speaker_mismatch",
                    "score": round(score, 6)}

    async def delete(self, uid):
        # Wait for bounded in-flight inference so an enrollment cannot recreate a deleted profile.
        async with self.lock:
            await getattr(self.db, PROFILE_COLLECTION).delete_many({"user_id": uid})
        return {"deleted": True, "enrolled": False}

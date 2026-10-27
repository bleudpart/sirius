"""Deterministic extractor tests are NOT biometric accuracy/calibration evidence."""

import asyncio
import io
import json
import math
import shutil
import uuid
import wave
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import auth_api
from account_deletion import PERSONAL_COLLECTIONS
from local_docstore import LocalDocStore
from routes.voice_identity import make_voice_identity_router
from voice_identity import (InferenceFailure, LocalSpeakerExtractor, MAX_CLIP_BYTES,
                            PROFILE_COLLECTION, VoiceIdentityService)
from voice_identity_worker import decode_audio, run as run_worker, unit_vector


def test_worker_command_uses_dedicated_executable_when_packaged(monkeypatch):
    import voice_identity

    monkeypatch.setattr(voice_identity.sys, "frozen", True, raising=False)
    command = voice_identity.worker_command()
    assert len(command) == 1
    assert Path(command[0]).stem == "sirius-voice-worker"
    assert Path(command[0]).parent == Path(voice_identity.sys.executable).parent
    assert command[0] != voice_identity.sys.executable


def test_worker_command_preserves_python_launch_from_sources(monkeypatch):
    import voice_identity

    monkeypatch.setattr(voice_identity.sys, "frozen", False, raising=False)
    command = voice_identity.worker_command()
    assert command[0] == voice_identity.sys.executable
    assert Path(command[1]).name == "voice_identity_worker.py"


class MockExtractor:
    """A test double returning fixed vectors; never used by production construction."""
    enabled = True
    threshold = 0.85
    identity = {"name": "TEST-DOUBLE-NOT-BIOMETRICS", "sha256": "a" * 64, "pipeline": "mock"}

    def __init__(self):
        self.calls = []
        self.reason = None
        self.callback = None

    def configuration_reason(self):
        return self.reason

    async def ready_reason(self):
        return self.reason

    async def extract(self, clips):
        self.calls.append(clips)
        if self.reason:
            raise InferenceFailure(self.reason)
        if self.callback:
            await self.callback()
        vectors = []
        for clip in clips:
            if clip == b"error":
                raise InferenceFailure("invalid_audio")
            if clip == b"short":
                raise InferenceFailure("insufficient_audio")
            vector = np.zeros(256)
            vector[1 if clip.startswith(b"other") else 0] = 1
            vectors.append(vector)
        return vectors


@pytest.fixture
def api():
    # Keep all test artifacts under the repository, not the OS temporary directory.
    directory = Path(__file__).parent / (".voice-identity-test-" + uuid.uuid4().hex)
    directory.mkdir()
    db = LocalDocStore(directory / "store.db")
    extractor = MockExtractor()
    service = VoiceIdentityService(db, extractor)

    async def user(request, database):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "Connexion requise.")
        return {"user_id": uid, "company_id": "shared-company"}

    app = FastAPI()
    app.include_router(make_voice_identity_router(db, user, service=service))
    with TestClient(app) as client:
        yield client, db, service, extractor
    shutil.rmtree(directory)


HEADERS = {"x-test-user": "one"}
BASE = "/api/voice-identity"


def enroll(client, clips=None, consent="true", headers=None):
    return client.post(BASE + "/enroll", headers=HEADERS if headers is None else headers,
                       data={"consent": consent},
                       files=[("files", (f"{i}.webm", clip, "audio/webm"))
                              for i, clip in enumerate(clips or [b"reference1", b"reference2", b"reference3"])])


def verify(client, clip=b"owner", headers=None):
    return client.post(BASE + "/verify", headers=HEADERS if headers is None else headers,
                       files={"file": ("utterance.webm", clip, "audio/webm")})


def test_all_routes_require_user_before_reading_audio(api):
    client, db, _, extractor = api
    assert client.get(BASE + "/status").status_code == 401
    assert client.delete(BASE + "/profile").status_code == 401
    assert enroll(client, headers={}).status_code == 401
    assert verify(client, headers={}).status_code == 401
    assert extractor.calls == []
    assert asyncio.run(getattr(db, PROFILE_COLLECTION).count_documents({})) == 0


def test_real_require_user_rejects_anonymous_even_localhost(api, monkeypatch):
    client, db, service, _ = api
    monkeypatch.setenv("JWT_SECRET", "test-only-secret-long-enough-for-auth-123456")
    app = FastAPI()
    app.include_router(make_voice_identity_router(db, auth_api.require_user, service=service))
    with TestClient(app, base_url="http://localhost") as real_client:
        assert real_client.get(BASE + "/status").status_code == 401
        assert verify(real_client).status_code == 401


@pytest.mark.parametrize("consent", ["false", "True", "1", ""])
def test_explicit_consent_required(api, consent):
    client, _, _, extractor = api
    assert enroll(client, consent=consent).status_code == 422
    assert extractor.calls == []


def test_enrollment_verification_and_private_persistence_mock_only(api):
    client, db, _, extractor = api
    assert client.get(BASE + "/status", headers=HEADERS).json()["enrolled"] is False
    response = enroll(client)
    assert response.status_code == 200, response.text
    profile = asyncio.run(getattr(db, PROFILE_COLLECTION).find_one({"user_id": "one"}))
    assert len(profile["embedding"]) == 256
    assert profile["consent"] is True and profile["reference_count"] == 3
    assert profile["model"] == extractor.identity
    assert not any("audio" in key or "recording" in key for key in profile)
    assert "reference1" not in json.dumps(profile)
    status = client.get(BASE + "/status", headers=HEADERS)
    assert status.headers["cache-control"] == "no-store"
    assert status.json()["enrolled"] is True and "embedding" not in status.text
    assert verify(client).json() == {"verified": True, "reason": "speaker_match", "score": 1.0}
    assert verify(client, b"other-speaker").json()["verified"] is False
    assert verify(client, b"error").json()["verified"] is False
    assert verify(client, b"short").json() == {"verified": False, "reason": "insufficient_audio"}


def test_account_isolation_even_same_company(api):
    client, _, _, _ = api
    assert enroll(client).status_code == 200
    other = {"x-test-user": "two"}
    assert client.get(BASE + "/status", headers=other).json()["enrolled"] is False
    assert verify(client, headers=other).json()["reason"] == "not_enrolled"
    assert client.delete(BASE + "/profile", headers=other).status_code == 200
    assert verify(client).json()["verified"] is True
    assert client.delete(BASE + "/profile", headers=HEADERS).json()["deleted"] is True
    assert verify(client).json()["reason"] == "not_enrolled"


def test_reference_count_duplicates_and_mixed_speakers_rejected(api):
    client, _, service, extractor = api
    assert enroll(client, [b"one", b"two"]).status_code == 422
    assert enroll(client, [b"one"] * 6).status_code == 413
    # Clear the test rate bucket; each case concerns reference validation, not rate limiting.
    asyncio.run(service.db.sirius_voice_identity_limits.delete_many({}))
    assert enroll(client, [b"one", b"one", b"one"]).status_code == 422
    assert extractor.calls == []
    assert enroll(client, [b"one", b"two", b"other-speaker"]).status_code == 422
    assert verify(client).json()["verified"] is False


def test_changed_model_or_unavailable_model_never_accepts(api):
    client, _, service, extractor = api
    assert enroll(client).status_code == 200
    extractor.identity = {**extractor.identity, "sha256": "b" * 64}
    assert verify(client).json()["reason"] == "model_changed"
    stale = client.get(BASE + "/status", headers=HEADERS).json()
    assert stale["enrolled"] is True and stale["ready"] is False
    assert stale["needs_reenrollment"] is True and stale["reason"] == "model_changed"
    extractor.reason = "model_missing"
    unavailable = client.get(BASE + "/status", headers=HEADERS).json()
    assert unavailable["ready"] is False and unavailable["enrolled"] is True
    assert verify(client).json() == {"verified": False, "reason": "model_missing"}
    assert enroll(client).status_code == 503
    assert client.delete(BASE + "/profile", headers=HEADERS).json()["deleted"] is True
    assert client.get(BASE + "/status", headers=HEADERS).json()["enrolled"] is False
    extractor.reason = None
    fresh = client.get(BASE + "/status", headers=HEADERS).json()
    assert fresh["ready"] is True and fresh["enrolled"] is False
    assert fresh["needs_reenrollment"] is False and fresh["reason"] == "not_enrolled"
    asyncio.run(service.db.sirius_voice_identity_limits.delete_many({}))
    assert enroll(client).status_code == 200


def test_oversized_malformed_and_unknown_fields_fail_before_extraction(api):
    client, _, service, extractor = api
    assert verify(client, b"x" * (MAX_CLIP_BYTES + 1)).status_code == 413
    response = client.post(BASE + "/verify", headers={**HEADERS, "content-type": "multipart/form-data; boundary=x"},
                           content=b"--x\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n\r\nincomplete")
    assert response.status_code == 400
    assert client.post(BASE + "/verify", headers=HEADERS, content=b"raw").status_code == 415
    assert client.post(BASE + "/enroll", headers=HEADERS, data={"consent": "true", "user_id": "other"},
                       files={"files": ("a", b"one")}).status_code == 422
    assert extractor.calls == []


def test_multipart_audio_above_spooling_size_stays_in_memory(api, monkeypatch):
    import starlette.formparsers
    client, _, _, _ = api
    assert enroll(client).status_code == 200

    def forbidden_spool(*args, **kwargs):
        pytest.fail("Voice identity must never create a disk-spooled raw recording")

    monkeypatch.setattr(starlette.formparsers, "SpooledTemporaryFile", forbidden_spool)
    assert verify(client, b"owner" * 300000).json()["verified"] is True


def test_rate_and_busy_limits_fail_closed(api, monkeypatch):
    import voice_identity
    monkeypatch.setattr(voice_identity.time, "time", lambda: 1800000000.0)
    client, _, service, extractor = api
    for _ in range(20):
        assert verify(client).status_code == 200
    assert verify(client).status_code == 429
    asyncio.run(service.db.sirius_voice_identity_limits.delete_many({}))

    async def busy():
        async with service.lock:
            assert (await service.verify("one", b"owner")) == {"verified": False, "reason": "busy"}
    asyncio.run(busy())
    assert extractor.calls == []


def test_cross_worker_deletion_during_enrollment_cannot_recreate_profile(api):
    _, db, service, extractor = api

    async def delete_during_inference():
        await getattr(db, PROFILE_COLLECTION).delete_many({"user_id": "one"})

    extractor.callback = delete_during_inference
    with pytest.raises(HTTPException) as error:
        asyncio.run(service.enroll("one", [b"one", b"two", b"three"]))
    assert error.value.status_code == 409
    assert asyncio.run(getattr(db, PROFILE_COLLECTION).count_documents({"user_id": "one"})) == 0


def test_cross_worker_revocation_during_verification_fails_closed(api):
    client, db, _, extractor = api
    assert enroll(client).status_code == 200

    async def revoke():
        await getattr(db, PROFILE_COLLECTION).delete_many({"user_id": "one"})

    extractor.callback = revoke
    assert verify(client).json() == {"verified": False, "reason": "profile_revoked"}


@pytest.mark.parametrize("threshold", ["", "nan", "inf", "0.74", "1", "wrong"])
def test_production_configuration_requires_explicit_bounded_threshold(monkeypatch, threshold):
    monkeypatch.setenv("SIRIUS_VOICE_IDENTITY_ENABLED", "1")
    monkeypatch.setenv("SIRIUS_VOICE_IDENTITY_THRESHOLD", threshold)
    assert LocalSpeakerExtractor().configuration_reason() == "threshold_not_configured"


def test_production_default_is_disabled(monkeypatch):
    monkeypatch.delenv("SIRIUS_VOICE_IDENTITY_ENABLED", raising=False)
    extractor = LocalSpeakerExtractor()
    assert extractor.configuration_reason() == "operator_disabled"
    assert asyncio.run(extractor.ready_reason()) == "operator_disabled"


def test_model_hash_is_checked_before_loading_native_runtime(api):
    _, db, _, _ = api
    model = Path(db._path).with_name("operator-test-model.onnx")
    model.write_bytes(b"not a model; this test must reject before native loading")
    with pytest.raises(ValueError, match="model_checksum_mismatch"):
        run_worker({"model_path": str(model), "sha256": "0" * 64, "audio": []})


def test_inference_timeout_kills_the_isolated_process(monkeypatch):
    import voice_identity
    extractor = LocalSpeakerExtractor()
    monkeypatch.setattr(extractor, "configuration_reason", lambda: None)
    process = AsyncMock()
    process.returncode = None
    process.pid = 2147483000
    process.kill = Mock()
    killer = AsyncMock()
    future = object()
    monkeypatch.setattr(process, "communicate", lambda data: future)
    monkeypatch.setattr(voice_identity.asyncio, "create_subprocess_exec",
                        AsyncMock(side_effect=[process, killer]))
    monkeypatch.setattr(voice_identity.asyncio, "wait_for", AsyncMock(side_effect=asyncio.TimeoutError))
    if hasattr(voice_identity.os, "killpg"):
        monkeypatch.setattr(voice_identity.os, "killpg", lambda *args: None)
    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(extractor.extract([b"owner"]))
    process.wait.assert_awaited_once()
    process.kill.assert_called_once()


def make_wav(seconds, *, channels=1, rate=22050, quiet=False):
    samples = np.zeros(int(rate * seconds)) if quiet else np.sin(np.arange(int(rate * seconds)) * 2 * math.pi * 180 / rate) * 0.2
    raw = np.repeat((samples * 32767).astype("<i2")[:, None], channels, axis=1).tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(raw)
    return output.getvalue()


def test_real_ffmpeg_decode_is_mono_16k_and_bounded_not_a_biometrics_test():
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("Operator ffmpeg not installed")
    samples = decode_audio(make_wav(3.5, channels=2), ffmpeg)
    assert samples.dtype == np.float32 and samples.shape == (56000,)
    assert len(decode_audio(make_wav(15), ffmpeg, max_seconds=15)) == 240000
    assert len(decode_audio(make_wav(19), ffmpeg)) == 304000
    with pytest.raises(ValueError, match="insufficient_audio"):
        decode_audio(make_wav(1), ffmpeg)
    with pytest.raises(ValueError, match="clip_duration"):
        decode_audio(make_wav(16), ffmpeg, max_seconds=15)
    for data in [make_wav(21), make_wav(4, quiet=True), b"not audio",
                 b"#EXTM3U\nhttps://example.invalid/audio.wav"]:
        with pytest.raises(ValueError):
            decode_audio(data, ffmpeg)


def test_invalid_embeddings_are_not_accepted():
    for vector in [np.zeros(256), np.ones(255), np.full(256, np.nan), np.full(256, np.inf)]:
        with pytest.raises(ValueError):
            unit_vector(vector)


def test_deletion_and_routine_privacy_export_exclude_biometric_vector(api, monkeypatch):
    client, db, _, _ = api
    assert enroll(client).status_code == 200
    assert PROFILE_COLLECTION in PERSONAL_COLLECTIONS
    assert "sirius_voice_identity_limits" in PERSONAL_COLLECTIONS

    async def user(request, database):
        return {"user_id": "one"}

    monkeypatch.setattr(auth_api, "require_user", user)
    app = FastAPI()
    app.include_router(auth_api.make_auth_router(db))
    with TestClient(app) as privacy_client:
        response = privacy_client.get("/auth/privacy/export")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        data = json.loads(archive.read("sirius-personal-data.json"))
    saved = data["collections"][PROFILE_COLLECTION]
    assert saved[0]["consent"] is True and "embedding" not in saved[0]


def test_operator_installed_real_model_smoke():
    """Optional genuine inference; synthetic tone is NOT speaker accuracy evidence."""
    extractor = LocalSpeakerExtractor()
    if extractor.configuration_reason():
        pytest.skip("No operator-enabled, pinned sherpa model installed")
    assert asyncio.run(extractor.ready_reason()) is None
    vectors = asyncio.run(extractor.extract([make_wav(4)]))
    assert len(vectors) == 1 and vectors[0].shape == (256,)
    assert np.isfinite(vectors[0]).all()
    assert float(np.linalg.norm(vectors[0])) == pytest.approx(1.0)

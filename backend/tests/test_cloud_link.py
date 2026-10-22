import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import cloud_link
from auth_api import create_access_token
from routes import voice_io


@pytest.fixture
def pc(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_PACKAGED", "1")
    monkeypatch.setenv("SIRIUS_CLOUD_URL", "https://cloud.test")
    monkeypatch.delenv("SIRIUS_CLOUD_RELAY", raising=False)
    for name in ("CEREBRAS_API_KEY", "GROQ_KEY", "GROQ_API_KEY", "K3_API_KEY", "DANIEL_DEV_K3", "WHISPER_API_URL",
                 "STT_BACKEND_URL", "GEMINI_TTS_API_KEY", "GOOGLE_TTS_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    calls = []

    def use(handler):
        def recorder(request):
            calls.append(request)
            return handler(request)
        monkeypatch.setattr(cloud_link, "transport", httpx.MockTransport(recorder))

    yield use, calls
    monkeypatch.setattr(cloud_link, "transport", None)


def login_handler(request):
    if request.url.path == "/api/auth/login":
        return httpx.Response(
            200, json={"email": "lea@example.com", "name": "Léa", "access_token": "acc-1"},
            headers={"set-cookie": "refresh_token=ref-1; Path=/; HttpOnly; Secure"},
        )
    return httpx.Response(404)


def local_app():
    async def fake_user(request, db):
        return {"user_id": "local", "role": "admin"}

    app = FastAPI()
    app.include_router(cloud_link.make_cloud_link_router(fake_user, None, lambda request: True), prefix="/api")
    return TestClient(app)


def test_link_stores_session_outside_source_and_reports_status(pc, tmp_path):
    use, calls = pc
    use(login_handler)
    client = local_app()
    assert client.get("/api/cloud/status").json()["linked"] is False

    status = client.post("/api/cloud/link", json={"email": "lea@example.com", "password": "secret123"}).json()

    assert status["linked"] is True and status["email"] == "lea@example.com"
    saved = json.loads((tmp_path / "cloud_link.json").read_text(encoding="utf-8"))
    assert saved["access_token"] == "acc-1" and saved["refresh_token"] == "ref-1"
    assert json.loads(calls[0].content)["password"] == "secret123"
    assert client.delete("/api/cloud/link").json()["linked"] is False
    assert not (tmp_path / "cloud_link.json").exists()


def test_link_forwards_cloud_error_message(pc):
    use, _ = pc
    use(lambda request: httpx.Response(401, json={"detail": "Email ou mot de passe incorrect."}))
    response = local_app().post("/api/cloud/link", json={"email": "x@example.com", "password": "bad"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Email ou mot de passe incorrect."


@pytest.mark.parametrize("step,payload", [
    ("request", {"email": "lea@example.com"}),
    ("confirm", {"email": "lea@example.com", "code": "123456", "password": "nouveau123"}),
])
def test_password_recovery_uses_cloud_without_linking_or_changing_local_state(pc, tmp_path, step, payload):
    use, calls = pc
    use(lambda request: httpx.Response(200, json={"ok": True}))
    response = local_app().post(f"/api/cloud/password-reset/{step}", json=payload)
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert calls[0].url.path == f"/api/auth/password-reset/{step}"
    assert json.loads(calls[0].content) == payload
    assert not (tmp_path / "cloud_link.json").exists()


@pytest.mark.parametrize("status,detail", [
    (400, "Code invalide ou expiré."),
    (429, "Veuillez attendre une minute avant de redemander un code."),
    (503, "Service email temporairement indisponible."),
])
def test_password_recovery_preserves_cloud_errors(pc, status, detail):
    use, _ = pc
    use(lambda request: httpx.Response(status, json={"detail": detail}))
    response = local_app().post("/api/cloud/password-reset/request", json={"email": "lea@example.com"})
    assert response.status_code == status
    assert response.json()["detail"] == detail


def test_password_recovery_network_failure_is_explicit(pc):
    use, _ = pc
    def fail(request):
        raise httpx.ConnectError("offline", request=request)
    use(fail)
    response = local_app().post("/api/cloud/password-reset/request", json={"email": "lea@example.com"})
    assert response.status_code == 502
    assert "injoignable" in response.json()["detail"]


def test_password_recovery_keeps_local_auth_and_origin_guards(pc):
    use, calls = pc
    use(lambda request: pytest.fail("Forbidden request reached cloud"))
    from fastapi import HTTPException
    async def user(request, db):
        return {"user_id": "local"}
    async def denied(request, db):
        raise HTTPException(401, "Connexion requise.")
    for require, direct, status in [(user, False, 403), (denied, True, 401)]:
        app = FastAPI()
        app.include_router(cloud_link.make_cloud_link_router(require, None, lambda request: direct), prefix="/api")
        for step in ("request", "confirm"):
            response = TestClient(app).post(f"/api/cloud/password-reset/{step}",
                json={"email": "lea@example.com", "password": "nouveau123", "code": "123456"})
            assert response.status_code == status
    assert calls == []


def test_cloud_server_itself_never_relays(pc, monkeypatch):
    monkeypatch.delenv("SIRIUS_PACKAGED")
    assert cloud_link.should_relay_chat({}) is False
    assert local_app().get("/api/cloud/status").status_code == 404


def test_relay_only_without_local_key(pc, monkeypatch):
    use, _ = pc
    use(login_handler)
    local_app().post("/api/cloud/link", json={"email": "lea@example.com", "password": "secret123"})
    assert cloud_link.should_relay_chat({}) is True
    assert cloud_link.should_relay_chat({"groq_key": "gsk_user"}) is False
    monkeypatch.setenv("GROQ_KEY", "gsk_local")
    assert cloud_link.should_relay_chat({}) is False
    assert cloud_link.should_relay_stt("") is False


def test_cerebras_prevents_chat_relay_but_not_groq_transcription(pc, monkeypatch):
    use, _ = pc
    use(login_handler)
    local_app().post("/api/cloud/link", json={"email": "lea@example.com", "password": "secret123"})
    assert cloud_link.should_relay_chat({"cerebras": "personal-cerebras"}) is False
    assert cloud_link.should_relay_chat({"cerebras_key": "personal-cerebras"}) is False
    monkeypatch.setenv("CEREBRAS_API_KEY", "owner-cerebras")
    assert cloud_link.should_relay_chat({}) is False
    assert cloud_link.should_relay_stt("") is True


def test_stt_is_relayed_and_session_refreshed_on_401(pc):
    use, calls = pc
    cloud_link._save_state({"email": "lea@example.com", "access_token": "old", "refresh_token": "ref-1"})

    def handler(request):
        if request.url.path == "/api/auth/refresh":
            assert request.headers["cookie"] == "refresh_token=ref-1"
            return httpx.Response(200, json={"access_token": "new"},
                                  headers={"set-cookie": "refresh_token=ref-2; Path=/"})
        if request.headers["authorization"] == "Bearer old":
            return httpx.Response(401, json={"detail": "Session expirée."})
        assert request.url.path == "/api/stt"
        assert b"bonjour-audio" in request.content
        return httpx.Response(200, json={"text": "Bonjour", "provider": "groq-whisper"})

    use(handler)
    app = FastAPI()
    app.include_router(voice_io.make_voice_io_router(), prefix="/api")
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer " + create_access_token("local-user")

    response = client.post("/api/stt", files={"file": ("voice.webm", b"bonjour-audio", "audio/webm")})

    assert response.status_code == 200
    assert response.json()["text"] == "Bonjour"
    assert [c.url.path for c in calls] == ["/api/stt", "/api/auth/refresh", "/api/stt"]
    assert cloud_link.load_state()["access_token"] == "new"
    assert cloud_link.load_state()["refresh_token"] == "ref-2"


def test_stream_relay_passes_events_and_reports_quota_error(pc):
    use, _ = pc
    cloud_link._save_state({"access_token": "acc"})
    sse = b'data: {"type": "delta", "text": "Salut"}\n\n'
    use(lambda request: httpx.Response(200, content=sse, headers={"content-type": "text/event-stream"}))

    async def collect():
        return b"".join([chunk async for chunk in cloud_link.relay_stream("/api/chat/stream", {"text": "x"})])

    import asyncio
    assert asyncio.run(collect()) == sse

    use(lambda request: httpx.Response(429, json={"detail": "Limite quotidienne de messages atteinte."}))
    body = asyncio.run(collect()).decode("utf-8")
    assert '"type": "done"' in body and "Limite quotidienne" in body

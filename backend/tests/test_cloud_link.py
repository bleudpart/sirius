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
    for name in ("GROQ_KEY", "GROQ_API_KEY", "K3_API_KEY", "DANIEL_DEV_K3", "WHISPER_API_URL",
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

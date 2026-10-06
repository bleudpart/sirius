from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth_api import create_access_token
from routes import voice_io

app = FastAPI()
app.include_router(voice_io.make_voice_io_router(), prefix="/api")
client = TestClient(app)
client.headers["Authorization"] = "Bearer " + create_access_token("stt-test-user")


def test_stt_requires_account():
    response = TestClient(app).post("/api/stt", files={"file": ("voice.webm", b"audio", "audio/webm")})

    assert response.status_code == 401


def test_stt_rejects_empty_audio():
    response = client.post("/api/stt", files={"file": ("voice.webm", b"", "audio/webm")})

    assert response.status_code == 400


def test_stt_reports_missing_engine(monkeypatch):
    monkeypatch.delenv("WHISPER_API_URL", raising=False)
    monkeypatch.delenv("STT_BACKEND_URL", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("GROQ_KEY", raising=False)
    monkeypatch.delenv("SIRIUS_PACKAGED", raising=False)

    response = client.post("/api/stt", files={"file": ("voice.webm", b"audio", "audio/webm")})

    assert response.status_code == 503

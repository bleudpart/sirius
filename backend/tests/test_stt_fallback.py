from fastapi.testclient import TestClient

import server

client = TestClient(server.app)


def test_stt_rejects_empty_audio():
    response = client.post("/api/stt", files={"file": ("voice.webm", b"", "audio/webm")})

    assert response.status_code == 400


def test_stt_reports_missing_engine(monkeypatch):
    monkeypatch.delenv("WHISPER_API_URL", raising=False)
    monkeypatch.delenv("STT_BACKEND_URL", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)

    response = client.post("/api/stt", files={"file": ("voice.webm", b"audio", "audio/webm")})

    assert response.status_code == 503

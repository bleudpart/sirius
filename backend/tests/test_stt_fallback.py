import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

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


def test_stt_stream_requires_account():
    with pytest.raises(WebSocketDisconnect) as error:
        with TestClient(app).websocket_connect("/api/stt/stream"):
            pass

    assert error.value.code == 1008


def test_stt_stream_forwards_recorded_audio(monkeypatch):
    relayed = {}

    async def relay_stt(filename, audio, content_type):
        relayed.update(filename=filename, audio=audio, content_type=content_type)
        return {"text": "Demande reconnue"}

    monkeypatch.setattr(voice_io.cloud_link, "should_relay_stt", lambda _key: True)
    monkeypatch.setattr(voice_io.cloud_link, "relay_stt", relay_stt)

    with client.websocket_connect("/api/stt/stream") as websocket:
        websocket.send_json({
            "action": "start",
            "content_type": "audio/webm;codecs=opus",
            "groq_key": "configured-key",
        })
        assert websocket.receive_json() == {"type": "ready"}
        websocket.send_bytes(b"first-chunk")
        websocket.send_bytes(b"second-chunk")
        websocket.send_json({"action": "finish"})
        assert websocket.receive_json() == {
            "type": "transcript",
            "data": {"text": "Demande reconnue"},
        }

    assert relayed == {
        "filename": "sirius-voice.webm",
        "audio": b"first-chunksecond-chunk",
        "content_type": "audio/webm;codecs=opus",
    }

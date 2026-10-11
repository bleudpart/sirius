import json
from email.parser import BytesParser
from email.policy import default
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from auth_api import create_access_token
from routes import voice_io
from speech_vocabulary import confirmed_vocabulary, transcription_prompt


@pytest.mark.parametrize("value", [
    {}, 3, ["x"] * 33, ["x" * 81], ["x" * 80] * 21,
    [None], [""], ["\nNom"], ["Nom\n"], ["Nom: instruction"], ["!!!"],
    'not json', '"not a list"', ["\x00"], ["----"],
])
def test_invalid_vocabulary(value):
    with pytest.raises(HTTPException) as error:
        confirmed_vocabulary(value)
    assert error.value.status_code == 400


def test_confirmed_terms_only_and_deduplicated():
    assert confirmed_vocabulary(None) == []
    assert confirmed_vocabulary([" cafe\u0301 ", "Café", "Jean-Luc", "L'œuvre"]) == ["café", "Jean-Luc", "L'œuvre"]
    assert confirmed_vocabulary(json.dumps(["Thémis"])) == ["Thémis"]
    assert "Termes personnels" not in transcription_prompt([])
    assert "ne pas les ajouter" in transcription_prompt(["Martel"])


@pytest.fixture
def api(monkeypatch, tmp_path):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("GROQ_KEY", "mock-owner")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    monkeypatch.delenv("WHISPER_API_URL", raising=False)
    monkeypatch.delenv("STT_BACKEND_URL", raising=False)
    monkeypatch.setattr(voice_io.cloud_link, "should_relay_stt", lambda key: False)
    app = FastAPI()
    app.include_router(voice_io.make_voice_io_router(), prefix="/api")
    with TestClient(app) as client:
        client.headers["Authorization"] = "Bearer " + create_access_token("vocabulary-test")
        yield client, tmp_path


def mock_provider(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(voice_io.httpx, "AsyncClient",
                        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def multipart_fields(request):
    message = BytesParser(policy=default).parsebytes(
        b"Content-Type: " + request.headers["content-type"].encode() + b"\r\n\r\n" + request.content
    )
    return {part.get_param("name", header="content-disposition"): part.get_payload(decode=True)
            for part in message.iter_parts()}


@pytest.mark.parametrize("stream", [False, True])
def test_request_only_vocabulary_no_storage_or_rewrite(api, monkeypatch, stream):
    client, directory = api
    calls = []

    def handler(request):
        fields = multipart_fields(request)
        calls.append(fields)
        assert fields["language"] == b"fr"
        assert fields["file"] == b"audio-for-this-request-only"
        return httpx.Response(200, json={"text": "bonjour Martel"})

    mock_provider(monkeypatch, handler)
    if stream:
        with client.websocket_connect("/api/stt/stream") as ws:
            ws.send_json({"action": "start", "vocabulary": ["Martel"]})
            assert ws.receive_json()["type"] == "ready"
            ws.send_bytes(b"audio-for-this-request-only")
            ws.send_json({"action": "finish"})
            result = ws.receive_json()["data"]
    else:
        result = client.post("/api/stt", files={"file": ("voice.webm", b"audio-for-this-request-only")},
                             data={"vocabulary": json.dumps(["Martel"])}).json()
    assert result["text"] == result["raw_text"] == "bonjour Martel"
    assert '"Martel"' in calls[0]["prompt"].decode()
    client.post("/api/stt", files={"file": ("voice.webm", b"audio-for-this-request-only")})
    assert "Termes personnels" not in calls[1]["prompt"].decode()
    assert list(directory.iterdir()) == []


def test_invalid_vocabulary_no_provider_or_quota(api, monkeypatch):
    client, _ = api
    consume = AsyncMock()
    monkeypatch.setattr(voice_io.usage_quota, "consume", consume)
    mock_provider(monkeypatch, lambda request: pytest.fail("Invalid vocabulary reached provider"))
    assert client.post("/api/stt", files={"file": ("voice.webm", b"audio")},
                       data={"vocabulary": json.dumps(["x" * 81])}).status_code == 400
    with client.websocket_connect("/api/stt/stream") as ws:
        ws.send_json({"action": "start", "vocabulary": ["x" * 81]})
        assert ws.receive_json()["type"] == "error"
    consume.assert_not_awaited()


def test_vocabulary_does_not_leak_between_accounts_or_force_transcript(api, monkeypatch):
    client, directory = api
    prompts = []

    def handler(request):
        prompts.append(multipart_fields(request)["prompt"].decode())
        return httpx.Response(200, json={"text": "une phrase sans ce nom"})

    mock_provider(monkeypatch, handler)
    for user_id, data in [
        ("account-a", {"vocabulary": '["Martel"]'}),
        ("account-b", {"vocabulary": '["Durand"]'}),
        ("account-a", {}),
    ]:
        client.headers["Authorization"] = "Bearer " + create_access_token(user_id)
        response = client.post("/api/stt", files={"file": ("v.webm", b"audio")}, data=data)
        assert response.status_code == 200
        assert response.json()["text"] == response.json()["raw_text"] == "une phrase sans ce nom"
    assert '"Martel"' in prompts[0] and '"Durand"' not in prompts[0]
    assert '"Durand"' in prompts[1] and '"Martel"' not in prompts[1]
    assert "Termes personnels" not in prompts[2]
    assert list(directory.iterdir()) == []


def test_personal_key_precedence_and_anonymous_refusal(api, monkeypatch):
    client, _ = api
    seen = []

    def handler(request):
        seen.append(request.headers["authorization"])
        return httpx.Response(403)

    mock_provider(monkeypatch, handler)
    response = client.post("/api/stt", files={"file": ("v.webm", b"audio")},
                           data={"groq_key": "mock-personal", "vocabulary": '["Martel"]'})
    assert response.status_code == 502
    assert seen == ["Bearer mock-personal"]
    client.headers.pop("Authorization")
    assert client.post("/api/stt", files={"file": ("v.webm", b"audio")},
                       data={"vocabulary": '["Martel"]'}).status_code == 401
    assert len(seen) == 1


def test_proxy_hints_optional(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("STT_BACKEND_URL", "https://proxy.test/stt")
    monkeypatch.setattr(voice_io, "owner_allowed", lambda user: True)
    fields = []

    def handler(request):
        fields.append(multipart_fields(request))
        return httpx.Response(200, json={"text": "Martel"})

    mock_provider(monkeypatch, handler)
    for data in [{"vocabulary": '["Martel"]'}, {}]:
        assert client.post("/api/stt", files={"file": ("v.webm", b"audio")}, data=data).status_code == 200
    assert json.loads(fields[0]["vocabulary"]) == ["Martel"]
    assert "vocabulary" not in fields[1]


def test_cloud_forwards_request_vocabulary_only(api, monkeypatch):
    client, _ = api
    monkeypatch.setattr(voice_io.cloud_link, "should_relay_stt", lambda key: True)
    relay = AsyncMock(return_value={"text": "Martel"})
    monkeypatch.setattr(voice_io.cloud_link, "relay_stt", relay)
    mock_provider(monkeypatch, lambda request: pytest.fail("Unexpected direct provider call"))
    assert client.post("/api/stt", files={"file": ("v.webm", b"audio")},
                       data={"vocabulary": '["Martel"]'}).status_code == 200
    assert relay.call_args.kwargs == {"vocabulary": ["Martel"]}
    client.post("/api/stt", files={"file": ("v.webm", b"audio")})
    assert relay.call_args.kwargs == {}


def test_cloud_relay_adds_only_optional_text(monkeypatch):
    import asyncio
    import cloud_link

    send = AsyncMock(return_value=httpx.Response(200, json={"text": "Martel"}))
    monkeypatch.setattr(cloud_link, "_send", send)
    asyncio.run(cloud_link.relay_stt("v.webm", b"request-audio", "audio/webm", vocabulary=["Martel"]))
    assert send.call_args.kwargs["data"] == {"vocabulary": '["Martel"]'}
    assert send.call_args.kwargs["files"]["file"] == ("v.webm", b"request-audio", "audio/webm")
    asyncio.run(cloud_link.relay_stt("v.webm", b"request-audio", "audio/webm"))
    assert "data" not in send.call_args.kwargs

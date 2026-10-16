import base64
import io
import wave

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import voice_io
from auth_api import create_access_token


@pytest.mark.parametrize("word", ["emails", "e-mails", "e mails", "EMAILS", "mails", "e\u2011mails"])
def test_mail_words_are_not_spelled_by_tts(word):
    assert voice_io._speakable(f"Vos {word} sont prêts.") == "Vos courriels sont prêts."


def test_mail_pronunciation_preserves_addresses():
    assert voice_io._speakable("Un e-mail. email@example.test prénom.mail@example.test") == (
        "Un courriel. email@example.test prénom.mail@example.test"
    )


def audio_payload():
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"\x00\x00" * 240)
    return {
        "steps": [{
            "type": "model_output",
            "content": [{"type": "audio", "data": base64.b64encode(output.getvalue()).decode()}],
        }],
    }


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GEMINI_TTS_API_KEY", "test-key-not-a-secret")
    monkeypatch.delenv("GEMINI_TTS_MODEL", raising=False)
    monkeypatch.delenv("GEMINI_TTS_VOICE", raising=False)
    monkeypatch.delenv("GOOGLE_TTS_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_TTS_API_KEY", raising=False)
    monkeypatch.delenv("TTS_BACKEND_URL", raising=False)
    monkeypatch.delenv("GEMINI_TTS_FALLBACK_VOICE", raising=False)
    monkeypatch.delenv("GEMINI_TTS_PRIMARY", raising=False)
    voice_io._TTS_CACHE.clear()
    app = FastAPI()
    app.include_router(voice_io.make_voice_io_router(), prefix="/api")
    with TestClient(app) as client:
        client.headers["Authorization"] = "Bearer " + create_access_token("tts-test-user")
        yield client
    voice_io._TTS_CACHE.clear()


def mock_upstream(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(
        voice_io.httpx, "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs),
    )


def test_aoede_request_and_valid_wave_response(client, monkeypatch):
    requests = []

    def handler(request):
        import json

        requests.append(json.loads(request.content))
        assert request.url == "https://generativelanguage.googleapis.com/v1beta/interactions"
        assert request.headers["x-goog-api-key"] == "test-key-not-a-secret"
        return httpx.Response(200, json=audio_payload())

    mock_upstream(monkeypatch, handler)
    response = client.post("/api/tts/gemini", json={"text": "Bonjour Sirius."})
    assert response.status_code == 200
    result = response.json()
    assert result["voice"] == "Aoede"
    assert result["mime_type"] == "audio/wav"
    with wave.open(io.BytesIO(base64.b64decode(result["audio_base64"])), "rb") as audio:
        assert audio.getframerate() == 24000
        assert audio.getnframes() == 240
    assert requests[0]["model"] == "gemini-3.8-flash-tts"
    assert requests[0]["generation_config"]["speech_config"] == [{"voice": "Aoede"}]
    content = requests[0]["input"][0]["content"][0]
    assert content["text"] == "Bonjour Sirius."
    assert content["annotations"][0]["style"] == voice_io.GEMINI_TTS_STYLE
    assert client.post("/api/tts/gemini", json={"text": "Bonjour Sirius."}).status_code == 200
    assert len(requests) == 1
    monkeypatch.setenv("GEMINI_TTS_VOICE", "Charon")
    assert client.post("/api/tts/gemini", json={"text": "Bonjour Sirius."}).json()["voice"] == "Charon"
    assert len(requests) == 2


def test_missing_key_and_invalid_input_never_call_provider(client, monkeypatch):
    def unexpected(request):
        pytest.fail("Invalid requests must not reach Gemini")

    mock_upstream(monkeypatch, unexpected)
    monkeypatch.delenv("GEMINI_TTS_API_KEY")
    assert client.post("/api/tts/gemini", json={"text": "Bonjour"}).status_code == 503
    monkeypatch.setenv("GEMINI_TTS_API_KEY", "test")
    assert client.post("/api/tts/gemini", json={"text": "   "}).status_code == 400
    assert client.post("/api/tts/gemini", json={"text": ""}).status_code == 422
    assert client.post("/api/tts/gemini", json={"text": "x" * 4501}).status_code == 422


@pytest.mark.parametrize("payload", [
    {}, {"steps": []}, {"steps": [{"type": "model_output", "content": [
        {"type": "audio", "data": "not-base64"},
    ]}]}, {"steps": [{"type": "model_output", "content": [
        {"type": "audio", "data": base64.b64encode(b"not wav audio").decode()},
    ]}]}, [],
])
def test_invalid_audio_returns_explicit_failure(client, monkeypatch, payload):
    mock_upstream(monkeypatch, lambda request: httpx.Response(200, json=payload))
    response = client.post("/api/tts/gemini", json={"text": "Bonjour"})
    assert response.status_code == 502
    assert "WAV" in response.json()["detail"]
    assert not voice_io._TTS_CACHE


def test_provider_failure_does_not_leak_response_or_credentials(client, monkeypatch):
    mock_upstream(monkeypatch, lambda request: httpx.Response(403, text="private provider detail"))
    response = client.post("/api/tts/gemini", json={"text": "Bonjour"})
    assert response.status_code == 502
    assert response.json()["detail"] == "Erreur Gemini TTS"


def test_timeout_returns_explicit_failure(client, monkeypatch):
    def handler(request):
        raise httpx.ReadTimeout("provider timeout", request=request)

    mock_upstream(monkeypatch, handler)
    assert client.post("/api/tts/gemini", json={"text": "Bonjour"}).status_code == 502


def test_anonymous_request_never_calls_provider(client, monkeypatch):
    mock_upstream(monkeypatch, lambda request: pytest.fail("Anonymous provider call"))
    client.headers.pop("Authorization")
    assert client.post("/api/tts/gemini", json={"text": "Bonjour"}).status_code == 401


def test_chirp_is_primary_so_the_voice_never_changes_between_sentences(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "cloud-test-key")
    wav = base64.b64decode(audio_payload()["steps"][0]["content"][0]["data"])
    calls = []

    def handler(request):
        import json

        calls.append(request.url.host)
        if request.url.host == "generativelanguage.googleapis.com":
            pytest.fail("Gemini must not be called while Chirp answers")
        body = json.loads(request.content)
        assert body["voice"]["name"] == "fr-FR-Chirp3-HD-Aoede"
        assert body["audioConfig"]["audioEncoding"] == "LINEAR16"
        assert body["input"]["text"] == "Sirius a fermé Panthéon."
        return httpx.Response(200, json={"audioContent": base64.b64encode(wav).decode()})

    mock_upstream(monkeypatch, handler)
    result = client.post("/api/tts/gemini", json={"text": "ΣIRIUS a fermé Panthéon."}).json()
    assert result["provider"] == "google-chirp"
    assert result["mime_type"] == "audio/wav"
    assert base64.b64decode(result["audio_base64"]) == wav
    client.post("/api/tts/gemini", json={"text": "ΣIRIUS a fermé Panthéon."})
    assert calls == ["texttospeech.googleapis.com"]


def test_gemini_primary_option_relays_through_chirp_on_quota(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "cloud-test-key")
    monkeypatch.setenv("GEMINI_TTS_PRIMARY", "1")
    wav = base64.b64decode(audio_payload()["steps"][0]["content"][0]["data"])
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if request.url.host == "generativelanguage.googleapis.com":
            return httpx.Response(429, text="quota")
        return httpx.Response(200, json={"audioContent": base64.b64encode(wav).decode()})

    mock_upstream(monkeypatch, handler)
    assert client.post("/api/tts/gemini", json={"text": "Bonjour"}).json()["provider"] == "google-chirp"
    assert calls == ["generativelanguage.googleapis.com", "texttospeech.googleapis.com"]


def test_chirp_recovery_takes_priority_over_cached_gemini(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "cloud-test-key")
    wav = audio_payload()["steps"][0]["content"][0]["data"]
    calls = []
    chirp_available = False

    def handler(request):
        calls.append(request.url.host)
        if request.url.host == "texttospeech.googleapis.com":
            if not chirp_available:
                return httpx.Response(503)
            return httpx.Response(200, json={"audioContent": wav})
        return httpx.Response(200, json=audio_payload())

    mock_upstream(monkeypatch, handler)
    assert client.post("/api/tts/gemini", json={"text": "Bonjour"}).json()["provider"] == "gemini"
    chirp_available = True
    assert client.post("/api/tts/gemini", json={"text": "Bonjour"}).json()["provider"] == "google-chirp"
    assert calls == ["texttospeech.googleapis.com", "generativelanguage.googleapis.com",
                     "texttospeech.googleapis.com"]


def test_failed_relay_keeps_gemini_error(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "cloud-test-key")
    mock_upstream(monkeypatch, lambda request: httpx.Response(429, text="quota"))
    response = client.post("/api/tts/gemini", json={"text": "Bonjour"})
    assert response.status_code == 502
    assert response.json()["detail"] == "Erreur Gemini TTS"


def test_cache_limits_audio_memory(monkeypatch):
    voice_io._TTS_CACHE.clear()
    monkeypatch.setattr(voice_io, "_TTS_CACHE_MAX_BYTES", 10)
    voice_io._cache_set(("first",), {"audio_base64": "123456"})
    voice_io._cache_set(("second",), {"audio_base64": "123456"})
    assert list(voice_io._TTS_CACHE) == [("second",)]
    voice_io._cache_set(("oversized",), {"audio_base64": "x" * 11})
    assert not voice_io._TTS_CACHE


@pytest.mark.parametrize("text,expected", [
    ("dis moi", "dis moi"),
    ("Dis-moi ce que tu veux.", "Dis-moi ce que tu veux."),
    ("  ΣIRIUS\nlit mes e-mails : café, 12,50 €.\t", "Sirius lit mes courriels : café, 12,50 €."),
    ("cafe\u0301\u00a0et\u202fœufs", "café et œufs"),
    ("email@example.test et prénom.mail@example.test", "email@example.test et prénom.mail@example.test"),
    ("20:45 (CET), 21:00 CEST.", "20:45 (heure d'Europe centrale), 21:00 heure d'été d'Europe centrale."),
    ("cet horaire, cette rencontre, CETTE", "cet horaire, cette rencontre, CETTE"),
    ("Knicks vs Raptors. Ruud versus Jodar. A VS. B.", "Knicks contre Raptors. Ruud contre Jodar. A contre B."),
    ("VS Code, https://example.test/vs/file", "VS Code, https://example.test/vs/file"),
])
def test_shared_french_text_is_idempotent_and_preserves_words(text, expected):
    assert voice_io._speakable(text) == expected
    assert voice_io._speakable(expected) == expected


@pytest.mark.parametrize("provider", ["google", "gemini", "chirp", "proxy"])
def test_french_provider_matrix(client, monkeypatch, provider):
    import json

    original = "  ΣIRIUS\nDis-moi : café, 12,50 €, mes e-mails. "
    expected = "Sirius Dis-moi : café, 12,50 €, mes courriels."
    calls = []
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "mock-google")
    monkeypatch.setenv("GEMINI_TTS_PRIMARY", "1" if provider == "gemini" else "0")
    if provider == "proxy":
        monkeypatch.setenv("TTS_BACKEND_URL", "https://proxy.test/tts")
        monkeypatch.setattr(voice_io, "owner_allowed", lambda user: True)

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        if provider == "gemini":
            content = body["input"][0]["content"][0]
            assert content["text"] == expected
            style = content["annotations"][0]["style"]
            assert "mot pour mot" in style and "ne reformule pas" in style
            assert "sans accent anglais" in style
            return httpx.Response(200, json=audio_payload())
        if provider == "proxy":
            assert body["text"] == expected
            assert body["voice"] == "fr-FR-Neural2-G"
            return httpx.Response(200, json={"audio_base64": "mock", "engine": "custom",
                                           "voice": "fr-FR-custom", "language_code": "fr-FR"})
        assert body["input"]["text"] == expected
        assert body["voice"]["languageCode"] == "fr-FR"
        return httpx.Response(200, json={
            "audioContent": audio_payload()["steps"][0]["content"][0]["data"],
        })

    mock_upstream(monkeypatch, handler)
    route = {"google": "/api/tts/google", "gemini": "/api/tts/gemini",
             "chirp": "/api/tts/gemini", "proxy": "/api/tts"}[provider]
    payload = {"text": original}
    response = client.post(route, json=payload)
    assert response.status_code == 200
    assert payload["text"] == original
    result = response.json()
    assert result["language_code"] == "fr-FR"
    assert result["engine"] == {"google": "google", "gemini": "gemini",
                                "chirp": "google-chirp", "proxy": "custom"}[provider]
    assert result["voice"] == {"google": "fr-FR-Neural2-G", "gemini": "Aoede",
                               "chirp": "Aoede", "proxy": "fr-FR-custom"}[provider]
    if provider != "proxy":
        assert result["effective_voice"] == {
            "google": "fr-FR-Neural2-G", "gemini": "Aoede", "chirp": "fr-FR-Chirp3-HD-Aoede",
        }[provider]
    assert len(calls) == 1


@pytest.mark.parametrize("route", ["/api/tts/google", "/api/tts/gemini"])
def test_cloud_receives_shared_french_text_and_preserves_metadata(client, monkeypatch, route):
    from unittest.mock import AsyncMock

    monkeypatch.delenv("GOOGLE_TTS_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_TTS_API_KEY", raising=False)
    monkeypatch.setattr(voice_io.cloud_link, "should_relay_tts", lambda name: True)
    result = {"audio_base64": "mock", "engine": "remote", "voice": "remote-voice"}
    relay = AsyncMock(return_value=result)
    monkeypatch.setattr(voice_io.cloud_link, "relay_json", relay)
    mock_upstream(monkeypatch, lambda request: pytest.fail("Local provider must not run"))
    response = client.post(route, json={"text": " ΣIRIUS\nlit mes e-mails. "})
    assert response.status_code == 200
    assert response.json() == result
    forwarded = relay.call_args.args[1]
    assert forwarded["text"] == "Sirius lit mes courriels."
    assert forwarded["keys"] == {}
    if route.endswith("google"):
        assert forwarded["voice"] == "fr-FR-Neural2-G"


@pytest.mark.parametrize("name,value", [
    ("GEMINI_TTS_VOICE", "en-US-Aoede"),
    ("GEMINI_TTS_VOICE", ""),
    ("GEMINI_TTS_MODEL", "gemini-chat"),
    ("GEMINI_TTS_MODEL", ""),
    ("GEMINI_TTS_FALLBACK_VOICE", "en-US-Chirp3-HD-Aoede"),
    ("GEMINI_TTS_FALLBACK_VOICE", "fr-FR-Chirp3-HD-Unknown"),
    ("GEMINI_TTS_FALLBACK_VOICE", ""),
])
def test_invalid_server_voice_config_is_explicit_and_never_sent(client, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "mock-google")
    mock_upstream(monkeypatch, lambda request: pytest.fail("Invalid config must not reach provider"))
    response = client.post("/api/tts/gemini", json={"text": "Bonjour"})
    assert response.status_code == 503
    assert name in response.json()["detail"]
    assert not voice_io._TTS_CACHE


def test_chirp_override_metadata_reports_actual_voice(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "mock-google")
    monkeypatch.setenv("GEMINI_TTS_FALLBACK_VOICE", "fr-FR-Chirp3-HD-Kore")
    mock_upstream(monkeypatch, lambda request: httpx.Response(200, json={
        "audioContent": audio_payload()["steps"][0]["content"][0]["data"],
    }))
    result = client.post("/api/tts/gemini", json={"text": "Bonjour"}).json()
    assert result["voice"] == "Aoede"
    assert result["effective_voice"] == "fr-FR-Chirp3-HD-Kore"
    assert result["language_code"] == "fr-FR"
    assert client.post("/api/tts/gemini", json={"text": "Bonjour"}).json() == result


def test_gemini_failure_keeps_same_french_text_in_chirp(client, monkeypatch):
    import json

    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "mock-google")
    monkeypatch.setenv("GEMINI_TTS_PRIMARY", "1")
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(request.url.host)
        if request.url.host == "generativelanguage.googleapis.com":
            assert body["input"][0]["content"][0]["text"] == "Sirius Dis-moi : café et courriels."
            return httpx.Response(429)
        assert body["input"]["text"] == "Sirius Dis-moi : café et courriels."
        return httpx.Response(200, json={"audioContent": audio_payload()["steps"][0]["content"][0]["data"]})

    mock_upstream(monkeypatch, handler)
    result = client.post("/api/tts/gemini", json={"text": "ΣIRIUS\nDis-moi : cafe\u0301 et e-mails."})
    assert result.status_code == 200
    assert result.json()["engine"] == "google-chirp"
    assert result.json()["effective_voice"] == "fr-FR-Chirp3-HD-Aoede"
    assert calls == ["generativelanguage.googleapis.com", "texttospeech.googleapis.com"]


def test_google_french_fallback_and_exact_rate_cache(client, monkeypatch):
    import json

    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "mock-google")
    calls = []

    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert body["voice"] == {"languageCode": "fr-FR", "name": "fr-FR-Neural2-G"}
        return httpx.Response(200, json={"audioContent": "mock"})

    mock_upstream(monkeypatch, handler)
    for rate in [1.001, 1.002, 1.002]:
        response = client.post("/api/tts/google", json={"text": "Dis-moi.", "voice": "en-US-Standard-A", "rate": rate})
        assert response.status_code == 200
        assert response.json()["voice"] == "fr-FR-Neural2-G"
    assert len(calls) == 2
    assert [body["audioConfig"]["speakingRate"] for body in calls] == [1.001, 1.002]


def test_empty_proxy_text_does_not_consume_or_call_provider(client, monkeypatch):
    from unittest.mock import AsyncMock

    monkeypatch.setenv("TTS_BACKEND_URL", "https://proxy.test/tts")
    monkeypatch.setattr(voice_io, "owner_allowed", lambda user: True)
    consume = AsyncMock()
    monkeypatch.setattr(voice_io.usage_quota, "consume", consume)
    mock_upstream(monkeypatch, lambda request: pytest.fail("Empty proxy input"))
    assert client.post("/api/tts", json={"text": " \n "}).status_code == 400
    consume.assert_not_awaited()


def test_edge_promo_uses_shared_french_text(tmp_path, monkeypatch):
    import asyncio
    import sys
    from types import SimpleNamespace
    import modules_api

    class StopAfterSpeech(RuntimeError):
        pass

    class FakeSpeech:
        async def save(self, path):
            raise StopAfterSpeech

    def communicate(text, voice, rate):
        assert text == "Sirius Dis-moi : café et courriels."
        assert voice == "fr-FR-HenriNeural"
        assert rate == "-5%"
        return FakeSpeech()

    monkeypatch.setitem(sys.modules, "edge_tts", SimpleNamespace(Communicate=communicate))
    monkeypatch.setattr(modules_api, "STATIC", tmp_path)
    monkeypatch.setattr(modules_api, "PROMO_EXPORT", {})
    monkeypatch.setattr(modules_api, "PROMO_SHOTS", [{
        "voix": " ΣIRIUS\nDis-moi : cafe\u0301 et e-mails. ", "image": "unused.jpg",
    }])
    with pytest.raises(StopAfterSpeech):
        asyncio.run(modules_api._render_promo_video())

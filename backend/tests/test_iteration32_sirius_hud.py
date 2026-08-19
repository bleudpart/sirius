"""Iteration 32 regression tests for Mythos metadata/images and Google neural TTS."""
import os

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")
BASE_URL = base_url.rstrip("/")


@pytest.fixture(scope="module")
def api():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    yield session
    session.close()


# MYTHOS catalogue exposes all 13 characters and enables the new expert modules.
def test_mythos_catalogue_contract(api):
    response = api.get(f"{BASE_URL}/api/mythos/characters", timeout=30)
    assert response.status_code == 200, response.text
    data = response.json()
    characters = data.get("characters")
    assert isinstance(characters, list) and len(characters) == 13
    assert all(isinstance(item, dict) and "_id" not in item for item in characters)

    by_module = {item.get("module"): item for item in characters}
    for module in ("SOLON#", "PROMÉTHÉE#"):
        character = by_module[module]
        assert character.get("column", {}).get("enabled") is True
        assert character.get("style", {}).get("texture") == "portrait réaliste antique"
        assert isinstance(character.get("image"), str) and character["image"].endswith(".jpg")


# Regenerated key avatars are served as non-empty JPEG images.
@pytest.mark.parametrize("filename", ["argus.jpg", "locus.jpg", "solon.jpg", "promethee.jpg"])
def test_mythos_key_avatar_jpeg(api, filename):
    response = api.get(f"{BASE_URL}/api/mythos/img/{filename}", timeout=30)
    assert response.status_code == 200, response.text
    assert response.headers.get("content-type", "").startswith("image/jpeg")
    assert len(response.content) > 1_000
    assert response.content[:2] == b"\xff\xd8"


# Google TTS accepts both requested neural genders and falls back for invalid voice names.
@pytest.mark.parametrize(
    "voice,pitch",
    [
        ("fr-FR-Neural2-F", 2),
        ("fr-FR-Neural2-G", -2),
        ("fr-FR-Neural2-A", 0),
    ],
)
def test_google_tts_voice_contract(api, voice, pitch):
    response = api.post(
        f"{BASE_URL}/api/tts/google",
        json={"text": "Bonjour, je suis Thémis.", "voice": voice, "rate": 1.0, "pitch": pitch},
        timeout=45,
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data.get("format") == "mp3"
    assert isinstance(data.get("audio"), str) and len(data["audio"]) > 100


# Invalid/disallowed voice names must be replaced by the masculine Neural2-G fallback before Google is called.
def test_invalid_google_tts_voice_is_replaced_with_neural2_g(monkeypatch):
    import asyncio
    import sys

    sys.path.insert(0, "/app/backend")
    import server

    captured = {}

    class FakeResponse:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {"audioContent": "ZmFrZS1tcDM="}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def post(self, _url, params, json):
            captured.update(json)
            return FakeResponse()

    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "TEST_key")
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda timeout: FakeClient())
    result = asyncio.run(
        server.google_tts(
            server.GoogleTTSRequest(
                text="Bonjour, je suis Thémis.",
                voice="fr-FR-Neural2-A",
                rate=1.0,
                pitch=0,
            )
        )
    )
    assert result["audio"] == "ZmFrZS1tcDM="
    assert captured["voice"]["name"] == "fr-FR-Neural2-G"

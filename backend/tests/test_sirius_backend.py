# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Backend regression tests for ΣIRIUS refactor.

Covers:
- POST /api/chat (with invalid Groq key => French fallback, 4 fields)
- POST /api/chat/reset
- Removed TTS/STT endpoints (must be 404/405)
- Spotify login + now-playing (no token => 401)
- /api/download/sirius-source.zip and path traversal rejection
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---- /api/chat ----
class TestChat:
    def test_chat_fallback_shape(self, api):
        r = api.post(f"{BASE_URL}/api/chat", json={"text": "bonjour", "session_id": "TEST_reg"}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("answer", "used_search", "memories", "popup"):
            assert k in data, f"missing {k}"
        assert isinstance(data["memories"], list)
        assert data["popup"] is None or isinstance(data["popup"], dict)
        # server env Groq key is invalid -> french fallback string expected
        assert "Groq" in data["answer"] or "clé" in data["answer"].lower()

    def test_chat_invalid_body_key_gives_clean_fallback(self, api):
        r = api.post(
            f"{BASE_URL}/api/chat",
            json={"text": "salut", "session_id": "TEST_reg2", "keys": {"groq": "gsk_invalid_xxx"}},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["memories"] == []
        assert data["popup"] is None
        assert "clé" in data["answer"].lower() or "Groq" in data["answer"]

    def test_chat_empty_text_400(self, api):
        r = api.post(f"{BASE_URL}/api/chat", json={"text": "  ", "session_id": "TEST_reg3"}, timeout=10)
        assert r.status_code == 400


# ---- /api/chat/reset ----
class TestReset:
    def test_reset_ok(self, api):
        r = api.post(f"{BASE_URL}/api/chat/reset", json={"session_id": "TEST_reg"}, timeout=10)
        assert r.status_code == 200
        assert r.json() == {"ok": True}


# ---- Removed endpoints ----
class TestRemovedEndpoints:
    def test_tts_removed(self, api):
        r = api.get(f"{BASE_URL}/api/tts", timeout=10)
        assert r.status_code in (404, 405)

    def test_stt_removed(self, api):
        r = api.post(f"{BASE_URL}/api/stt", json={}, timeout=10)
        assert r.status_code in (404, 405)


# ---- Spotify ----
class TestSpotify:
    def test_login_returns_auth_url(self, api):
        r = api.get(f"{BASE_URL}/api/spotify/login", timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "auth_url" in data
        assert data["auth_url"].startswith("https://accounts.spotify.com/authorize")

    def test_now_playing_no_token_401(self, api):
        r = api.post(f"{BASE_URL}/api/spotify/now-playing", json={"access_token": "", "refresh_token": ""}, timeout=10)
        assert r.status_code == 401


# ---- Downloads ----
class TestDownload:
    def test_source_zip_ok(self, api):
        r = api.get(f"{BASE_URL}/api/download/sirius-source.zip", timeout=30, stream=True)
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("application/zip")

    def test_traversal_rejected(self, api):
        r = api.get(f"{BASE_URL}/api/download/../etc/passwd", timeout=10)
        # FastAPI may collapse the path; expect either 400 (route matched) or 404 (no route)
        assert r.status_code in (400, 404)

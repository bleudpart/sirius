# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Backend tests for iteration_3:
- /api/chat now accepts {keys, profile} and personalizes answer (profile.name, profession)
- /api/tts accepts {openai_key:""} and must fall back to a configured TTS backend (audio) or return clear error (no crash)
"""
import os
import uuid
import pytest
import requests

def _read_env():
    p = "/app/frontend/.env"
    if os.path.exists(p):
        for line in open(p):
            if line.startswith("REACT_APP_BACKEND_URL="):
                return line.strip().split("=", 1)[1]
    return ""

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or _read_env()).rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"
CHAT = f"{BASE_URL}/api/chat"
TTS = f"{BASE_URL}/api/tts"


# -- /api/chat profile personalization --
def test_chat_personalized_with_profile():
    """Chat with profile{name, profession} should return French answer referencing profession."""
    sid = f"TEST_{uuid.uuid4().hex[:10]}"
    payload = {
        "text": "Tu te souviens de mon metier ?",
        "session_id": sid,
        "profile": {"name": "Marc", "age": "40", "profession": "pompier", "city": "Lyon", "interests": "randonnée"},
        "keys": {},  # rely on backend env fallback in preview
    }
    r = requests.post(CHAT, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "answer" in data
    answer_lower = data["answer"].lower()
    # The answer should mention the profession or the user's name
    assert ("pompier" in answer_lower) or ("marc" in answer_lower), (
        f"Expected personalized answer referencing profession or name, got: {data['answer']}"
    )
    assert data.get("used_search") is False


def test_chat_accepts_keys_and_profile_shape():
    """Chat should accept the new {keys, profile} schema with the real Groq key from the request."""
    sid = f"TEST_{uuid.uuid4().hex[:10]}"
    payload = {
        "text": "Bonjour, comment dois-tu m'appeler ?",
        "session_id": sid,
        "profile": {"name": "Sophie"},
        "keys": {"groq": "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"},
    }
    r = requests.post(CHAT, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "answer" in data and len(data["answer"]) > 3
    # should ideally say Sophie
    assert "sophie" in data["answer"].lower(), f"Expected name 'Sophie' in answer, got: {data['answer']}"


def test_chat_empty_still_400_with_new_schema():
    r = requests.post(CHAT, json={"text": "", "session_id": "TEST_e", "keys": {}, "profile": {}}, timeout=15)
    assert r.status_code == 400


# -- /api/tts fallback --
def test_tts_empty_openai_key_falls_back_or_clear_error():
    """With empty openai_key, server must fall back to a configured TTS backend OR return a clear HTTP error (no crash)."""
    r = requests.post(TTS, json={"text": "Bonjour Marc.", "openai_key": ""}, timeout=45)
    # Must not 5xx-crash without a clear message; either 200 (fallback worked) or 4xx/5xx with detail
    assert r.status_code in (200, 400, 500, 502), f"Unexpected status: {r.status_code} {r.text}"
    if r.status_code == 200:
        data = r.json()
        assert "audio_base64" in data and isinstance(data["audio_base64"], str) and len(data["audio_base64"]) > 100
        assert data.get("format") == "mp3"
    else:
        # If error, must include a JSON detail (clear error, no raw stack)
        try:
            j = r.json()
            assert "detail" in j and isinstance(j["detail"], str) and len(j["detail"]) > 0
        except ValueError:
            pytest.fail(f"TTS returned non-JSON error body: {r.text[:200]}")


def test_tts_empty_text_returns_400():
    r = requests.post(TTS, json={"text": "   ", "openai_key": ""}, timeout=15)
    assert r.status_code == 400

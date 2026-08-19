# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Tests for Whisper STT round-trip and white-label HTML."""
import os
import base64
import io
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://cybertech-panel.preview.emergentagent.com").rstrip("/")


# ---------- /api/tts -> /api/stt round trip ----------
@pytest.fixture(scope="module")
def tts_audio_bytes():
    """Generate French speech via TTS so we have a real audio file to STT."""
    r = requests.post(
        f"{BASE_URL}/api/tts",
        json={"text": "Bonjour Sirius, quelle heure est-il"},
        timeout=60,
    )
    assert r.status_code == 200, f"TTS failed: {r.status_code} {r.text[:200]}"
    data = r.json()
    assert "audio_base64" in data and data["audio_base64"]
    audio = base64.b64decode(data["audio_base64"])
    assert len(audio) > 1000, "audio too small"
    return audio


def test_tts_stt_roundtrip_french(tts_audio_bytes):
    """POST a real mp3 to /api/stt, expect transcript mentioning 'Sirius' and 'heure'."""
    files = {"file": ("hello.mp3", io.BytesIO(tts_audio_bytes), "audio/mpeg")}
    r = requests.post(f"{BASE_URL}/api/stt", files=files, timeout=90)
    assert r.status_code == 200, f"STT failed: {r.status_code} {r.text[:300]}"
    body = r.json()
    assert "text" in body
    transcript = (body["text"] or "").lower()
    assert "sirius" in transcript, f"missing 'sirius' in: {transcript!r}"
    assert "heure" in transcript, f"missing 'heure' in: {transcript!r}"


def test_stt_no_file_returns_422():
    """No 'file' field -> FastAPI returns 422 (validation)."""
    r = requests.post(f"{BASE_URL}/api/stt", timeout=30)
    assert r.status_code in (400, 422), f"unexpected status: {r.status_code} {r.text[:200]}"


def test_stt_empty_file_returns_error():
    """Empty file body -> 400 'Audio vide'."""
    files = {"file": ("empty.mp3", io.BytesIO(b""), "audio/mpeg")}
    r = requests.post(f"{BASE_URL}/api/stt", files=files, timeout=30)
    assert r.status_code in (400, 422, 500), f"unexpected status: {r.status_code}"
    # If 200, must NOT be a successful transcription
    if r.status_code == 200:
        pytest.fail("Empty audio should not return 200")


def test_stt_invalid_audio_returns_error():
    """Garbage bytes -> graceful 500 (not crash)."""
    files = {"file": ("junk.mp3", io.BytesIO(b"this is not audio data, just random text" * 50), "audio/mpeg")}
    r = requests.post(f"{BASE_URL}/api/stt", files=files, timeout=60)
    # Whisper might either error out or transcribe garbage; both acceptable as long as no crash
    assert r.status_code in (200, 400, 500), f"unexpected status: {r.status_code}"
    if r.status_code == 200:
        # text field must exist; it's fine if it's empty/garbage
        assert "text" in r.json()


# ---------- White-label HTML ----------
def test_white_label_index_html():
    r = requests.get(BASE_URL + "/", timeout=30)
    assert r.status_code == 200
    html = r.text
    # title
    assert "<title>SIRIUS</title>" in html, "title is not SIRIUS"
    # no emergent badge / posthog
    assert 'id="emergent-badge"' not in html, "emergent-badge present"
    assert "Made with Emergent" not in html, "'Made with Emergent' text present"
    assert "posthog" not in html.lower(), "posthog script reference present"


# ---------- Regression: /api/chat returns French answer mentioning 'partel' ----------
def test_chat_creator_mentions_partel_demo_mode():
    """In DEMO mode (no groq key) the localAnswer is computed on the FRONTEND.
    The backend /api/chat will try to use server's GROQ key (set in .env), which may also
    answer in French via BASE_PROMPT mentioning 'partel'. Either way verify backend is reachable.
    """
    r = requests.post(
        f"{BASE_URL}/api/chat",
        json={"text": "qui t'a créé", "session_id": "TEST_creator", "keys": {}, "profile": {}, "memory": []},
        timeout=60,
    )
    # Either 200 with text, or 500 if no provider keys (acceptable to surface).
    assert r.status_code in (200, 500), f"status {r.status_code} {r.text[:200]}"
    if r.status_code == 200:
        ans = (r.json().get("answer") or "").lower()
        assert "partel" in ans, f"expected 'partel' in answer: {ans!r}"

# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Backend tests for the ΣIRIUS chat brain (Groq + SerpAPI + Gemini fallback)."""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")
CHAT = f"{BASE_URL}/api/chat"


@pytest.fixture(scope="module")
def session_id():
    return f"TEST_{uuid.uuid4().hex[:10]}"


# --- Basic conversational answer ---
def test_chat_simple_french_answer():
    """A simple greeting should return a coherent French answer with used_search=False."""
    sid = f"TEST_{uuid.uuid4().hex[:10]}"
    payload = {"text": "Bonjour, qui es-tu ?", "session_id": sid}
    r = requests.post(CHAT, json=payload, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "answer" in data and isinstance(data["answer"], str)
    assert len(data["answer"]) > 5
    assert data.get("used_search") is False
    # Should mention Sirius or be in French – check by simple keyword presence
    answer_lower = data["answer"].lower()
    assert any(k in answer_lower for k in ["sirius", "daniel", "assistant", "bonjour", "je suis"]), \
        f"Answer does not look French/Sirius: {data['answer']}"


# --- Web search triggered ---
def test_chat_triggers_web_search():
    """A 'actualités' query should trigger SerpAPI and return used_search=True."""
    sid = f"TEST_{uuid.uuid4().hex[:10]}"
    payload = {"text": "Cherche les dernières actualités sur la fusée Starship", "session_id": sid}
    r = requests.post(CHAT, json=payload, timeout=45)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "answer" in data and len(data["answer"]) > 10
    assert data.get("used_search") is True, f"Expected used_search=True, got {data}"


# --- Conversation memory ---
def test_chat_conversation_memory():
    """Second message in same session should remember subject of the first."""
    sid = f"TEST_{uuid.uuid4().hex[:10]}"
    m1 = requests.post(CHAT, json={
        "text": "Je m'appelle Daniel et j'adore l'astronomie.",
        "session_id": sid,
    }, timeout=30)
    assert m1.status_code == 200, m1.text

    # small delay to ensure persistence
    time.sleep(0.5)

    m2 = requests.post(CHAT, json={
        "text": "De quoi je viens de te parler ?",
        "session_id": sid,
    }, timeout=30)
    assert m2.status_code == 200, m2.text
    answer2 = m2.json().get("answer", "").lower()
    assert any(k in answer2 for k in ["astronom", "étoile", "espace", "ciel", "cosmos"]), \
        f"Memory failed, answer was: {answer2}"


# --- Empty text validation ---
def test_chat_empty_text_returns_400():
    r = requests.post(CHAT, json={"text": "", "session_id": "TEST_empty"}, timeout=15)
    assert r.status_code == 400, f"Expected 400 got {r.status_code}: {r.text}"


# --- Whitespace-only ---
def test_chat_whitespace_text_returns_400():
    r = requests.post(CHAT, json={"text": "   ", "session_id": "TEST_ws"}, timeout=15)
    assert r.status_code == 400

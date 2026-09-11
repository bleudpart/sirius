# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Backend tests for ΣIRIUS personal memory feature (iteration 4).

Validates /api/chat with `memory` payload, French response usage of memory facts,
and regression that empty `text` returns 400 + no-memory profile-only still works.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback for local containers - tests will fail loudly if also missing here
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                break

GROQ_KEY = "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"


@pytest.fixture
def session_id():
    return f"TEST_{uuid.uuid4().hex[:10]}"


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


class TestChatMemory:
    """/api/chat must accept `memory:list` and use the facts in the answer."""

    def test_memory_used_in_answer_lasagnes(self, api, session_id):
        payload = {
            "text": "Quel est mon plat prefere ?",
            "session_id": session_id,
            "keys": {"groq": GROQ_KEY},
            "profile": {"name": "Daniel"},
            "memory": [
                "Daniel adore les lasagnes",
                "Daniel est allergique aux noix",
            ],
        }
        r = api.post(f"{BASE_URL}/api/chat", json=payload, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "answer" in data and isinstance(data["answer"], str)
        assert "used_search" in data and isinstance(data["used_search"], bool)
        answer = data["answer"].lower()
        assert "lasagne" in answer, f"Memory fact NOT used. Answer: {data['answer']}"

    def test_chat_profile_only_no_memory(self, api, session_id):
        """Regression: memory list optional/empty still works."""
        payload = {
            "text": "Bonjour, comment tu vas ?",
            "session_id": session_id,
            "keys": {"groq": GROQ_KEY},
            "profile": {"name": "Marc"},
            # no memory field
        }
        r = api.post(f"{BASE_URL}/api/chat", json=payload, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data["answer"], str) and len(data["answer"]) > 0
        assert data["used_search"] is False

    def test_chat_empty_text_returns_400(self, api, session_id):
        payload = {
            "text": "   ",
            "session_id": session_id,
            "keys": {"groq": GROQ_KEY},
        }
        r = api.post(f"{BASE_URL}/api/chat", json=payload, timeout=10)
        assert r.status_code == 400, r.text

    def test_chat_memory_empty_list_ok(self, api, session_id):
        payload = {
            "text": "Dis bonjour en une phrase.",
            "session_id": session_id,
            "keys": {"groq": GROQ_KEY},
            "profile": {"name": "Alice"},
            "memory": [],
        }
        r = api.post(f"{BASE_URL}/api/chat", json=payload, timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json().get("answer"), str)

    def test_chat_memory_multiple_facts_referenced(self, api, session_id):
        """Allergy fact should be retrievable when asked about it directly."""
        payload = {
            "text": "Est-ce que je suis allergique a quelque chose ?",
            "session_id": session_id,
            "keys": {"groq": GROQ_KEY},
            "profile": {"name": "Daniel"},
            "memory": [
                "Daniel adore les lasagnes",
                "Daniel est allergique aux noix",
            ],
        }
        r = api.post(f"{BASE_URL}/api/chat", json=payload, timeout=30)
        assert r.status_code == 200
        ans = r.json()["answer"].lower()
        assert "noix" in ans, f"Allergy memory not used. Answer: {r.json()['answer']}"

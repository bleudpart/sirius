# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Backend tests for /api/chat/reset (iteration 5).

Verifies the new endpoint that deletes the per-session history so
'oublie tout' truly forgets the prior conversation server-side.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                break

GROQ_KEY = "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"


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture
def session_id():
    return f"TEST_{uuid.uuid4().hex[:10]}"


class TestChatReset:
    """POST /api/chat/reset {session_id} must wipe server-side history."""

    def test_reset_simple_returns_ok(self, api):
        r = api.post(f"{BASE_URL}/api/chat/reset", json={"session_id": "rsttest_nohistory"}, timeout=10)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True

    def test_reset_default_session_works(self, api):
        # No session_id field -> default 'default'
        r = api.post(f"{BASE_URL}/api/chat/reset", json={}, timeout=10)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

    def test_full_lasagnes_reset_then_no_recall(self, api, session_id):
        """The acceptance test from the review request:
        1. Chat with memory ['Daniel adore les lasagnes'] -> answer references lasagnes
        2. POST /api/chat/reset for the same session
        3. Chat 'quel est mon plat prefere ?' with NO memory and SAME session
           -> answer must NOT confidently state lasagnes (history was cleared).
        """
        # 1) Seed history with the lasagnes fact via memory
        seed = api.post(
            f"{BASE_URL}/api/chat",
            json={
                "text": "Quel est mon plat prefere ?",
                "session_id": session_id,
                "keys": {"groq": GROQ_KEY},
                "profile": {"name": "Daniel"},
                "memory": ["Daniel adore les lasagnes"],
            },
            timeout=30,
        )
        assert seed.status_code == 200, seed.text
        assert "lasagne" in seed.json()["answer"].lower(), (
            "Pre-condition failed: seed answer should reference lasagnes. "
            f"Got: {seed.json()['answer']}"
        )

        # 2) Reset
        rst = api.post(
            f"{BASE_URL}/api/chat/reset",
            json={"session_id": session_id},
            timeout=10,
        )
        assert rst.status_code == 200, rst.text
        assert rst.json().get("ok") is True

        # 3) Same session, NO memory -> must not confidently state lasagnes
        after = api.post(
            f"{BASE_URL}/api/chat",
            json={
                "text": "Quel est mon plat prefere ?",
                "session_id": session_id,
                "keys": {"groq": GROQ_KEY},
                "profile": {"name": "Daniel"},
                "memory": [],
            },
            timeout=30,
        )
        assert after.status_code == 200, after.text
        ans = after.json()["answer"].lower()
        # After reset + no memory the model should NOT confidently claim it knows it
        # We tolerate the word being mentioned only inside a question/uncertainty.
        # Strong-claim phrases like "ton plat préféré est les lasagnes" must be gone.
        confident_patterns = [
            "ton plat préféré est les lasagnes",
            "ton plat préféré, c'est les lasagnes",
            "ton plat préféré c'est les lasagnes",
            "votre plat préféré est les lasagnes",
            "tu adores les lasagnes",
            "vous adorez les lasagnes",
        ]
        for pat in confident_patterns:
            assert pat not in ans, (
                f"After reset the brain still confidently states a forgotten fact ('{pat}'). "
                f"Full answer: {after.json()['answer']}"
            )

    def test_reset_is_idempotent(self, api, session_id):
        # Reset on an empty/never-used session must still 200
        r1 = api.post(f"{BASE_URL}/api/chat/reset", json={"session_id": session_id}, timeout=10)
        r2 = api.post(f"{BASE_URL}/api/chat/reset", json={"session_id": session_id}, timeout=10)
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json().get("ok") is True and r2.json().get("ok") is True

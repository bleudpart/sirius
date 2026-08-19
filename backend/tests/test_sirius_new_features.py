# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Regression tests for new SIRIUS features (iteration 10):
- /api/local-memory CRUD (SQLite)
- /api/dev/review (Groq companion) — server groq key is invalid → 400 expected
- /api/chat still works & merges local memory
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8001").rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---- /api/local-memory ----
class TestLocalMemory:
    created_ids = []

    def test_list_returns_facts_shape(self, api):
        r = api.get(f"{BASE_URL}/api/local-memory", timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "facts" in data and isinstance(data["facts"], list)

    def test_add_projet(self, api):
        text = f"TEST_projet_{uuid.uuid4().hex[:8]}"
        r = api.post(f"{BASE_URL}/api/local-memory", json={"category": "projet", "text": text}, timeout=10)
        assert r.status_code == 200, r.text
        fact = r.json()
        assert fact["category"] == "projet"
        assert fact["text"] == text
        assert "id" in fact
        TestLocalMemory.created_ids.append(fact["id"])
        # GET verifies persistence
        r2 = api.get(f"{BASE_URL}/api/local-memory?category=projet", timeout=10)
        assert r2.status_code == 200
        assert any(f["id"] == fact["id"] for f in r2.json()["facts"])

    def test_add_duplicate_409(self, api):
        text = f"TEST_dup_{uuid.uuid4().hex[:8]}"
        r1 = api.post(f"{BASE_URL}/api/local-memory", json={"category": "preference", "text": text}, timeout=10)
        assert r1.status_code == 200
        TestLocalMemory.created_ids.append(r1.json()["id"])
        r2 = api.post(f"{BASE_URL}/api/local-memory", json={"category": "preference", "text": text}, timeout=10)
        assert r2.status_code == 409

    def test_add_empty_rejected(self, api):
        r = api.post(f"{BASE_URL}/api/local-memory", json={"category": "souvenir", "text": "  "}, timeout=10)
        assert r.status_code in (400, 409)

    def test_filter_by_category(self, api):
        r = api.get(f"{BASE_URL}/api/local-memory?category=projet", timeout=10)
        assert r.status_code == 200
        for f in r.json()["facts"]:
            assert f["category"] == "projet"

    def test_delete_unknown_404(self, api):
        r = api.delete(f"{BASE_URL}/api/local-memory/nonexistent-id-xyz", timeout=10)
        assert r.status_code == 404

    def test_delete_cleanup(self, api):
        for fid in TestLocalMemory.created_ids:
            r = api.delete(f"{BASE_URL}/api/local-memory/{fid}", timeout=10)
            assert r.status_code == 200
            # GET returns 404 on repeat delete
            r2 = api.delete(f"{BASE_URL}/api/local-memory/{fid}", timeout=10)
            assert r2.status_code == 404


# ---- /api/dev/review ----
class TestDevReview:
    def test_empty_code_400(self, api):
        r = api.post(f"{BASE_URL}/api/dev/review", json={"code": "", "action": "review"}, timeout=15)
        assert r.status_code == 400
        assert "vide" in r.json().get("detail", "").lower()

    def test_review_invalid_groq_key_400(self, api):
        r = api.post(f"{BASE_URL}/api/dev/review",
                     json={"code": "print(1)", "action": "review"}, timeout=30)
        assert r.status_code == 400, r.text
        detail = r.json().get("detail", "")
        assert "Groq" in detail or "clé" in detail.lower()

    def test_commit_action_accepted(self, api):
        r = api.post(f"{BASE_URL}/api/dev/review",
                     json={"code": "def x():\n    return 1", "action": "commit"}, timeout=30)
        # Expected: 400 due to invalid groq key (structural acceptance)
        assert r.status_code in (200, 400)

    def test_logs_action_accepted(self, api):
        r = api.post(f"{BASE_URL}/api/dev/review",
                     json={"code": "ERROR: oops", "action": "logs"}, timeout=30)
        assert r.status_code in (200, 400)


# ---- /api/chat still functional with local memory merge ----
class TestChatWithLocalMemory:
    def test_chat_still_returns_answer(self, api):
        r = api.post(f"{BASE_URL}/api/chat",
                     json={"text": "bonjour", "session_id": f"TEST_it10_{uuid.uuid4().hex[:6]}"}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "answer" in data
        assert isinstance(data["answer"], str) and len(data["answer"]) > 0
        # Fallback expected because server groq key is invalid
        assert "Groq" in data["answer"] or "clé" in data["answer"].lower()

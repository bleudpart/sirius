"""Iteration 31 tests for API key validation, IA modes, and Agora regressions."""
import json
import os
import time
import uuid

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


# API-key validation returns explicit validity and provider-oriented messages.
class TestKeyValidation:
    @pytest.mark.parametrize(
        "service,key,expected_ok,message_fragment",
        [
            ("gmaps", "AIzaFAKE", False, "REQUEST_DENIED"),
            ("fal", "abc123456789:secret", True, "Format de clé fal.ai valide"),
            ("serp", "fake", False, "refusée"),
            ("k3", "sk-fake", False, "refusée"),
            ("gmaps", "", False, "Clé vide."),
        ],
    )
    def test_validate_key_contract(self, api, service, key, expected_ok, message_fragment):
        response = api.post(
            f"{BASE_URL}/api/keys/validate",
            json={"service": service, "key": key},
            timeout=30,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("ok") is expected_ok
        assert isinstance(data.get("message"), str) and message_fragment in data["message"]


# Chat supports direct Groq fast mode, default deep mode, and rapid-mode SSE stages/deltas.
class TestChatModes:
    def test_chat_rapide_returns_direct_answer_quickly(self, api):
        started = time.monotonic()
        response = api.post(
            f"{BASE_URL}/api/chat",
            json={
                "text": "Combien font deux plus deux ? Répondez en une phrase.",
                "session_id": f"TEST_rapid_{uuid.uuid4().hex}",
                "ia_mode": "rapide",
            },
            timeout=35,
        )
        elapsed = time.monotonic() - started
        assert response.status_code == 200, response.text
        data = response.json()
        assert isinstance(data.get("answer"), str) and len(data["answer"].strip()) > 2
        assert "4" in data["answer"] or "quatre" in data["answer"].lower()
        assert data.get("used_search") is False
        assert isinstance(data.get("timings", {}).get("brain_ms"), int)
        assert elapsed < 15, f"Rapid mode took {elapsed:.1f}s"

    def test_chat_default_profond_returns_normal_answer(self, api):
        response = api.post(
            f"{BASE_URL}/api/chat",
            json={
                "text": "Combien font trois plus trois ? Répondez en une phrase.",
                "session_id": f"TEST_deep_{uuid.uuid4().hex}",
            },
            timeout=100,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert isinstance(data.get("answer"), str) and len(data["answer"].strip()) > 2
        assert "6" in data["answer"] or "six" in data["answer"].lower()
        assert isinstance(data.get("timings", {}).get("brain_ms"), int)

    def test_chat_stream_rapide_sse_sequence(self, api):
        with api.post(
            f"{BASE_URL}/api/chat/stream",
            json={
                "text": "Dites simplement bonjour.",
                "session_id": f"TEST_stream_{uuid.uuid4().hex}",
                "ia_mode": "rapide",
            },
            timeout=40,
            stream=True,
        ) as response:
            assert response.status_code == 200, response.text
            assert response.headers.get("content-type", "").startswith("text/event-stream")
            events = []
            for line in response.iter_lines(decode_unicode=True):
                if line and line.startswith("data: "):
                    events.append(json.loads(line[6:]))
                if events and events[-1].get("type") == "done":
                    break
        assert events and events[0] == {"type": "stage", "label": "formulation"}
        assert any(event.get("type") == "delta" and event.get("text") for event in events)
        assert events[-1].get("type") == "done"
        assert isinstance(events[-1].get("answer"), str) and events[-1]["answer"].strip()
        assert events[-1].get("used_search") is False


# Agora monthly target/history contracts and missing-email relance validation with cleanup.
class TestAgoraRegression:
    def test_objectif_get_put_and_persistence(self, api):
        initial = api.get(f"{BASE_URL}/api/agora/objectif", timeout=30)
        assert initial.status_code == 200, initial.text
        initial_data = initial.json()
        for field in ("montant", "gagne_mois", "progression_pct", "mois"):
            assert field in initial_data

        updated = api.put(f"{BASE_URL}/api/agora/objectif", json={"montant": 5000}, timeout=30)
        assert updated.status_code == 200, updated.text
        assert updated.json().get("montant") == 5000.0

        persisted = api.get(f"{BASE_URL}/api/agora/objectif", timeout=30)
        assert persisted.status_code == 200, persisted.text
        assert persisted.json().get("montant") == 5000.0
        assert isinstance(persisted.json().get("progression_pct"), (int, float))

    def test_coach_history_contract(self, api):
        response = api.get(f"{BASE_URL}/api/agora/coach/history", timeout=30)
        assert response.status_code == 200, response.text
        sessions = response.json().get("sessions")
        assert isinstance(sessions, list)
        assert all(isinstance(item, dict) and "_id" not in item for item in sessions)

    def test_relance_without_email_returns_clear_400_and_cleanup(self, api):
        deal_id = None
        name = f"TEST_NoEmail_{uuid.uuid4().hex[:10]}"
        try:
            created = api.post(
                f"{BASE_URL}/api/agora/deals",
                json={"nom": name, "entreprise": "TEST_QA", "email": "", "valeur": 100},
                timeout=30,
            )
            assert created.status_code == 200, created.text
            deal = created.json().get("deal")
            assert created.json().get("ok") is True and isinstance(deal, dict)
            deal_id = deal.get("id")
            assert isinstance(deal_id, str) and deal["nom"] == name and deal["email"] == ""

            relance = api.post(
                f"{BASE_URL}/api/agora/deals/{deal_id}/relance",
                json={"smtp": {}},
                timeout=30,
            )
            assert relance.status_code == 400, relance.text
            detail = relance.json().get("detail")
            assert isinstance(detail, str) and "adresse e-mail" in detail.lower()
        finally:
            if deal_id:
                deleted = api.delete(f"{BASE_URL}/api/agora/deals/{deal_id}", timeout=30)
                assert deleted.status_code in (200, 404), deleted.text

        listing = api.get(f"{BASE_URL}/api/agora/deals", timeout=30)
        assert listing.status_code == 200, listing.text
        assert all(item.get("id") != deal_id and item.get("nom") != name for item in listing.json().get("deals", []))

"""Iteration 33 tests for consultation history/email and Pythagore geometry regressions."""
import os
import uuid
from datetime import datetime, timezone

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


# Cloud consultation history listing, create/persistence, and delete semantics.
class TestConsultHistory:
    def test_solon_seed_and_descending_order(self, api):
        response = api.get(
            f"{BASE_URL}/api/mythos/consult/history",
            params={"module": "SOLON#"},
            timeout=30,
        )
        assert response.status_code == 200, response.text
        history = response.json().get("history")
        assert isinstance(history, list)
        assert any(item.get("q") == "Test migration bail" for item in history)
        assert all(item.get("module") == "SOLON#" and "_id" not in item for item in history)
        dates = [item.get("date", "") for item in history]
        assert dates == sorted(dates, reverse=True)

    def test_create_verify_and_delete_history(self, api):
        marker = f"TEST_iteration33_{uuid.uuid4().hex[:10]}"
        payload = {
            "module": "SOLON#",
            "q": marker,
            "a": "Réponse TEST de consultation.",
            "date": datetime.now(timezone.utc).isoformat(),
        }
        created_id = None
        try:
            created = api.post(
                f"{BASE_URL}/api/mythos/consult/history", json=payload, timeout=30
            )
            assert created.status_code == 200, created.text
            data = created.json()
            assert data.get("ok") is True
            entry = data.get("entry")
            assert isinstance(entry, dict)
            assert isinstance(entry.get("id"), str) and entry["id"]
            created_id = entry["id"]
            assert {key: entry[key] for key in payload} == payload
            assert "_id" not in entry

            listing = api.get(
                f"{BASE_URL}/api/mythos/consult/history",
                params={"module": "SOLON#"},
                timeout=30,
            )
            assert listing.status_code == 200, listing.text
            persisted = next(
                (item for item in listing.json().get("history", []) if item.get("id") == created_id),
                None,
            )
            assert persisted is not None
            assert persisted["q"] == marker
            assert persisted["a"] == payload["a"]
        finally:
            if created_id:
                deleted = api.delete(
                    f"{BASE_URL}/api/mythos/consult/history/{created_id}", timeout=30
                )
                assert deleted.status_code == 200, deleted.text
                assert deleted.json() == {"ok": True}

        after = api.get(
            f"{BASE_URL}/api/mythos/consult/history",
            params={"module": "SOLON#"},
            timeout=30,
        )
        assert after.status_code == 200
        assert all(item.get("id") != created_id for item in after.json().get("history", []))

    def test_delete_missing_history_returns_french_404(self, api):
        response = api.delete(
            f"{BASE_URL}/api/mythos/consult/history/TEST_missing_{uuid.uuid4().hex}",
            timeout=30,
        )
        assert response.status_code == 404, response.text
        assert response.json().get("detail") == "Consultation introuvable."


# Consultation PDF email validation without sending real SMTP traffic.
class TestConsultEmailValidation:
    BASE_PAYLOAD = {
        "module": "SOLON#",
        "question": "Question de test",
        "reponse": "FAITS : test.",
        "date": "2026-07-01",
        "to": "qa@example.test",
        "smtp": {},
    }

    def test_empty_smtp_is_rejected_cleanly(self, api):
        response = api.post(
            f"{BASE_URL}/api/mythos/consult/email", json=self.BASE_PAYLOAD, timeout=30
        )
        assert response.status_code == 400, response.text
        detail = response.json().get("detail", "")
        assert "Serveur SMTP non configuré" in detail

    def test_invalid_recipient_is_rejected_before_smtp(self, api):
        payload = {**self.BASE_PAYLOAD, "to": "adresse-invalide"}
        response = api.post(
            f"{BASE_URL}/api/mythos/consult/email", json=payload, timeout=30
        )
        assert response.status_code == 400, response.text
        assert response.json().get("detail") == "Adresse e-mail du destinataire invalide."

    def test_unknown_module_returns_404(self, api):
        payload = {**self.BASE_PAYLOAD, "module": "INCONNU#"}
        response = api.post(
            f"{BASE_URL}/api/mythos/consult/email", json=payload, timeout=30
        )
        assert response.status_code == 404, response.text
        assert response.json().get("detail") == "Ce personnage ne propose pas de consultation."


# French geometry descriptions render PNG and malformed figures return clear 400s.
class TestPythagoreGeometry:
    @pytest.mark.parametrize(
        "description",
        [
            "triangle rectangle 3 4",
            "cercle de rayon 5",
            "polygone 9 côtés",
            "carré 4",
        ],
    )
    def test_recognized_geometry_returns_png(self, api, description):
        response = api.get(
            f"{BASE_URL}/api/pythagore/geometry",
            params={"desc": description},
            timeout=45,
        )
        assert response.status_code == 200, response.text
        assert response.headers.get("content-type", "").startswith("image/png")
        assert response.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert len(response.content) > 5_000

    def test_unknown_geometry_lists_recognized_forms(self, api):
        response = api.get(
            f"{BASE_URL}/api/pythagore/geometry", params={"desc": "blabla"}, timeout=30
        )
        assert response.status_code == 400, response.text
        detail = response.json().get("detail", "")
        assert "Formes reconnues" in detail
        for form in ("triangle", "cercle", "carré", "rectangle"):
            assert form in detail

    def test_impossible_triangle_returns_400(self, api):
        response = api.get(
            f"{BASE_URL}/api/pythagore/geometry",
            params={"desc": "triangle 1 1 9"},
            timeout=30,
        )
        assert response.status_code == 400, response.text
        assert response.json().get("detail") == "Ces trois côtés ne forment pas un triangle."


# Existing exact calculation, plotting, and consultation PDF APIs remain functional.
class TestPythagoreAndPdfRegression:
    def test_solve_quadratic(self, api):
        response = api.post(
            f"{BASE_URL}/api/pythagore/calc",
            json={"expression": "x^2-5x+6=0", "mode": "solve", "variable": "x"},
            timeout=30,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("result") == "x = 2, 3"
        assert data.get("mode") == "solve"
        assert data.get("approx") == "2.0000000, 3.0000000"

    def test_plot_sine_png(self, api):
        response = api.get(
            f"{BASE_URL}/api/pythagore/plot", params={"expr": "sin(x)"}, timeout=45
        )
        assert response.status_code == 200, response.text
        assert response.headers.get("content-type", "").startswith("image/png")
        assert response.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert len(response.content) > 5_000

    def test_consult_pdf(self, api):
        response = api.post(
            f"{BASE_URL}/api/mythos/consult/pdf",
            json={
                "module": "SOLON#",
                "question": "TEST bail",
                "reponse": "FAITS : test.\nDROIT : test.\nANALYSE : test.\nOPTIONS : test.",
                "date": "2026-07-01",
            },
            timeout=30,
        )
        assert response.status_code == 200, response.text[:300]
        assert response.headers.get("content-type", "").startswith("application/pdf")
        assert response.headers.get("content-disposition") == 'attachment; filename="solon-avis.pdf"'
        assert response.content.startswith(b"%PDF")
        assert len(response.content) > 1_000

"""Iteration 30 tests for deal→Thémis, Agora objection coaching, and Oracle news briefing."""
import os
import re
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


@pytest.fixture(scope="module", autouse=True)
def cleanup_residual_named_client(api):
    """Remove only the explicitly authorized residual client from earlier auto-tests."""
    listing = api.get(f"{BASE_URL}/api/themis/clients", timeout=30)
    if listing.status_code == 200:
        for client in listing.json().get("clients", []):
            if client.get("name") == "Test Themis Client":
                api.delete(f"{BASE_URL}/api/themis/clients/{client['id']}", timeout=30)
    yield


# Deal→Thémis integration: document totals, client creation, deal badge, validation, and cleanup.
class TestDealToThemis:
    @pytest.mark.parametrize("kind,prefix", [("devis", "DEV-"), ("facture", "FAC-")])
    def test_won_deal_generates_document_and_persists_badge(self, api, kind, prefix):
        unique_name = f"TEST_ThemisDeal_{kind}_{uuid.uuid4().hex[:8]}"
        value = 1234.50
        deal_id = doc_id = client_id = None
        try:
            created = api.post(
                f"{BASE_URL}/api/agora/deals",
                json={
                    "nom": unique_name,
                    "entreprise": "TEST_QA_CORP",
                    "valeur": value,
                    "etape": "GAGNÉ",
                    "note": "TEST_Prestation intégrée",
                },
                timeout=30,
            )
            assert created.status_code == 200, created.text
            deal = created.json().get("deal")
            assert created.json().get("ok") is True
            assert isinstance(deal, dict) and isinstance(deal.get("id"), str)
            assert deal["nom"] == unique_name and deal["etape"] == "GAGNÉ"
            deal_id = deal["id"]

            converted = api.post(
                f"{BASE_URL}/api/themis/from-deal",
                json={"deal_id": deal_id, "kind": kind},
                timeout=30,
            )
            assert converted.status_code == 200, converted.text
            payload = converted.json()
            assert payload.get("ok") is True
            doc = payload.get("doc")
            client = payload.get("client")
            assert isinstance(doc, dict) and isinstance(client, dict)
            doc_id = doc["id"]
            client_id = client["id"]
            assert doc["kind"] == kind
            assert re.fullmatch(rf"{prefix}\d{{4}}-\d{{4}}", doc["number"]), doc["number"]
            assert doc["client_id"] == client_id
            assert doc["client_name"] == unique_name
            assert doc["total_ht"] == pytest.approx(value, abs=0.01)
            assert doc["tva"] == 20.0
            assert doc["tva_amount"] == pytest.approx(value * 0.2, abs=0.01)
            assert doc["total_ttc"] == pytest.approx(value * 1.2, abs=0.01)
            assert "_id" not in doc and "_id" not in client

            clients = api.get(f"{BASE_URL}/api/themis/clients", timeout=30)
            assert clients.status_code == 200, clients.text
            persisted_client = next(
                (item for item in clients.json().get("clients", []) if item.get("id") == client_id), None
            )
            assert persisted_client is not None
            assert persisted_client["name"] == unique_name
            assert persisted_client["company"] == "TEST_QA_CORP"

            docs = api.get(f"{BASE_URL}/api/themis/docs?kind={kind}", timeout=30)
            assert docs.status_code == 200, docs.text
            persisted_doc = next(
                (item for item in docs.json().get("docs", []) if item.get("id") == doc_id), None
            )
            assert persisted_doc is not None
            assert persisted_doc["number"] == doc["number"]
            assert persisted_doc["total_ttc"] == pytest.approx(value * 1.2, abs=0.01)

            deals = api.get(f"{BASE_URL}/api/agora/deals", timeout=30)
            assert deals.status_code == 200, deals.text
            persisted_deal = next(item for item in deals.json()["deals"] if item.get("id") == deal_id)
            assert persisted_deal["themis_doc_id"] == doc_id
            assert persisted_deal["themis_doc_number"] == doc["number"]
            assert persisted_deal["themis_doc_kind"] == kind
        finally:
            if doc_id:
                api.delete(f"{BASE_URL}/api/themis/docs/{doc_id}", timeout=30)
            if client_id:
                api.delete(f"{BASE_URL}/api/themis/clients/{client_id}", timeout=30)
            if deal_id:
                api.delete(f"{BASE_URL}/api/agora/deals/{deal_id}", timeout=30)

        deals_after = api.get(f"{BASE_URL}/api/agora/deals", timeout=30)
        assert all(item.get("id") != deal_id for item in deals_after.json().get("deals", []))
        clients_after = api.get(f"{BASE_URL}/api/themis/clients", timeout=30)
        assert all(item.get("id") != client_id for item in clients_after.json().get("clients", []))
        docs_after = api.get(f"{BASE_URL}/api/themis/docs", timeout=30)
        assert all(item.get("id") != doc_id for item in docs_after.json().get("docs", []))

    def test_from_deal_rejects_invalid_kind_and_unknown_deal(self, api):
        invalid_kind = api.post(
            f"{BASE_URL}/api/themis/from-deal",
            json={"deal_id": f"TEST_missing_{uuid.uuid4().hex}", "kind": "avoir"},
            timeout=30,
        )
        assert invalid_kind.status_code == 400, invalid_kind.text
        assert "devis ou facture" in invalid_kind.json().get("detail", "").lower()

        unknown = api.post(
            f"{BASE_URL}/api/themis/from-deal",
            json={"deal_id": f"TEST_missing_{uuid.uuid4().hex}", "kind": "devis"},
            timeout=30,
        )
        assert unknown.status_code == 404, unknown.text
        assert "introuvable" in unknown.json().get("detail", "").lower()


# Multi-turn Kimi K3 coaching: prospect role continuity and required debrief structure.
class TestAgoraCoaching:
    def test_play_two_turns_then_structured_debrief(self, api):
        first = api.post(
            f"{BASE_URL}/api/agora/coach",
            json={"mode": "play", "scenario": "Objection prix", "history": [], "keys": {}},
            timeout=120,
        )
        assert first.status_code == 200, first.text
        first_answer = first.json().get("reponse")
        assert first.json().get("ok") is True
        assert isinstance(first_answer, str) and len(first_answer.strip()) >= 20
        assert any(term in first_answer.lower() for term in ("prix", "cher", "coût", "budget", "tarif")), first_answer

        seller_answer = "Mon offre inclut le support 24/7, un déploiement en 10 jours et une garantie de résultat."
        second_history = [
            {"role": "assistant", "content": first_answer},
            {"role": "user", "content": seller_answer},
        ]
        second = api.post(
            f"{BASE_URL}/api/agora/coach",
            json={"mode": "play", "scenario": "Objection prix", "history": second_history, "keys": {}},
            timeout=120,
        )
        assert second.status_code == 200, second.text
        second_answer = second.json().get("reponse")
        assert second.json().get("ok") is True
        assert isinstance(second_answer, str) and len(second_answer.strip()) >= 20
        assert not any(section in second_answer.upper() for section in ("POINTS FORTS", "AXES D'AMÉLIORATION", "SCRIPT GAGNANT"))
        assert len(re.split(r"[.!?]+", second_answer.strip())) <= 7, second_answer

        transcript = second_history + [{"role": "assistant", "content": second_answer}]
        debrief = api.post(
            f"{BASE_URL}/api/agora/coach",
            json={"mode": "debrief", "scenario": "Objection prix", "history": transcript, "keys": {}},
            timeout=120,
        )
        assert debrief.status_code == 200, debrief.text
        debrief_answer = debrief.json().get("reponse")
        assert debrief.json().get("ok") is True
        assert isinstance(debrief_answer, str) and debrief_answer.strip()
        for section in ("NOTE GLOBALE", "POINTS FORTS", "AXES D'AMÉLIORATION", "SCRIPT GAGNANT"):
            assert section in debrief_answer.upper(), f"Missing {section}: {debrief_answer}"


# Oracle briefing includes live NewsAPI headlines when the integration is available.
class TestOracleBriefing:
    def test_overview_nonempty_and_mentions_live_headline(self, api):
        headlines = api.get(f"{BASE_URL}/api/news/headlines?limit=3", timeout=40)
        overview = api.get(f"{BASE_URL}/api/oracle/overview", timeout=90)
        assert overview.status_code == 200, overview.text
        data = overview.json()
        briefing = data.get("briefing")
        assert isinstance(briefing, str) and len(briefing.strip()) >= 40
        assert isinstance(data.get("news"), list) and data["news"]
        if headlines.status_code == 200:
            titles = [item.get("titre", "") for item in headlines.json().get("articles", []) if item.get("titre")]
            assert titles
            normalized_briefing = briefing.lower()
            assert any(title.lower() in normalized_briefing for title in titles[:3]), (
                f"No live headline found in briefing. titles={titles[:3]!r}; briefing={briefing!r}"
            )
        else:
            assert headlines.status_code == 429, headlines.text
            assert "quota" in headlines.json().get("detail", "").lower()

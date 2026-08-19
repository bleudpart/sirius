"""Iteration 29 tests for MYTHOS biographies, Hermès Agora consultation/deals, and NewsAPI."""
import os
import uuid

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")
BASE_URL = base_url.rstrip("/")
EXPECTED_STAGES = [
    "PROSPECTION",
    "QUALIFICATION",
    "PROPOSITION",
    "NÉGOCIATION",
    "CLOSING",
    "GAGNÉ",
    "PERDU",
]


@pytest.fixture(scope="module")
def api():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    yield session
    session.close()


@pytest.fixture
def deal_id(api):
    payload = {
        "nom": f"TEST_Agora_{uuid.uuid4().hex[:8]}",
        "entreprise": "TEST_QA",
        "valeur": 12500,
        "etape": "PROSPECTION",
        "note": "TEST_pipeline iteration 29",
    }
    response = api.post(f"{BASE_URL}/api/agora/deals", json=payload, timeout=20)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data.get("ok") is True
    deal = data.get("deal")
    assert isinstance(deal, dict)
    assert isinstance(deal.get("id"), str) and deal["id"]
    assert deal["nom"] == payload["nom"]
    assert deal["entreprise"] == payload["entreprise"]
    assert deal["valeur"] == payload["valeur"]
    assert deal["etape"] == "PROSPECTION"
    yield deal["id"]
    api.delete(f"{BASE_URL}/api/agora/deals/{deal['id']}", timeout=20)


# MYTHOS character metadata and Hermès Agora persona contract.
class TestMythosAgora:
    def test_all_13_characters_have_bio_and_capacities(self, api):
        response = api.get(f"{BASE_URL}/api/mythos/characters", timeout=20)
        assert response.status_code == 200, response.text
        characters = response.json().get("characters")
        assert isinstance(characters, list)
        assert len(characters) == 13
        missing_bio = []
        missing_capacites = []
        for character in characters:
            assert isinstance(character.get("module"), str) and character["module"]
            if not isinstance(character.get("bio"), str) or not character["bio"].strip():
                missing_bio.append(character["module"])
            capacities = character.get("capacites")
            if not isinstance(capacities, list) or not capacities:
                missing_capacites.append(character["module"])
            else:
                assert all(isinstance(item, str) and item.strip() for item in capacities)
        assert not missing_bio and not missing_capacites, (
            f"Missing bio={missing_bio}; missing capacities={missing_capacites}"
        )

        agora = next(item for item in characters if item.get("module") == "HERMÈS AGORA#")
        assert agora.get("column", {}).get("enabled") is True
        assert isinstance(agora.get("consult"), dict)
        assert isinstance(agora["consult"].get("placeholder"), str) and agora["consult"]["placeholder"]
        assert agora["consult"].get("action") == "PLAN DE VENTE"

    def test_agora_consult_returns_required_sections(self, api):
        response = api.post(
            f"{BASE_URL}/api/mythos/consult",
            json={
                "module": "HERMÈS AGORA#",
                "question": "Mon prospect trouve mon offre trop chère, comment closer ?",
                "keys": {},
            },
            timeout=90,
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data.get("ok") is True
        answer = data.get("reponse")
        assert isinstance(answer, str) and answer.strip()
        for section in ("CONTEXTE", "ANALYSE", "STRATÉGIE", "ACTIONS IMMÉDIATES"):
            assert section in answer, f"Missing {section}: {answer}"


# Agora MongoDB CRUD, validation, persistence, and deletion contracts.
class TestAgoraDeals:
    def test_get_returns_deals_and_exact_stages(self, api):
        response = api.get(f"{BASE_URL}/api/agora/deals", timeout=20)
        assert response.status_code == 200, response.text
        data = response.json()
        assert isinstance(data.get("deals"), list)
        assert data.get("stages") == EXPECTED_STAGES
        for deal in data["deals"]:
            assert "_id" not in deal
            assert isinstance(deal.get("id"), str) and deal["id"]
            assert deal.get("etape") in EXPECTED_STAGES

    def test_create_requires_nonempty_name(self, api):
        for name in ("", "   "):
            response = api.post(f"{BASE_URL}/api/agora/deals", json={"nom": name}, timeout=20)
            assert response.status_code == 400, response.text
            detail = response.json().get("detail")
            assert isinstance(detail, str) and "requis" in detail.lower()

    def test_create_is_persisted_then_update_stage_is_persisted(self, api, deal_id):
        listing = api.get(f"{BASE_URL}/api/agora/deals", timeout=20)
        assert listing.status_code == 200, listing.text
        created = next((item for item in listing.json()["deals"] if item.get("id") == deal_id), None)
        assert created is not None
        assert created["etape"] == "PROSPECTION"
        assert created["valeur"] == 12500

        update = api.put(
            f"{BASE_URL}/api/agora/deals/{deal_id}",
            json={"etape": "QUALIFICATION"},
            timeout=20,
        )
        assert update.status_code == 200, update.text
        updated = update.json().get("deal")
        assert update.json().get("ok") is True
        assert updated.get("id") == deal_id
        assert updated.get("etape") == "QUALIFICATION"

        listing_after = api.get(f"{BASE_URL}/api/agora/deals", timeout=20)
        persisted = next(item for item in listing_after.json()["deals"] if item.get("id") == deal_id)
        assert persisted["etape"] == "QUALIFICATION"

    def test_unknown_stage_and_unknown_id_are_rejected(self, api, deal_id):
        bad_stage = api.put(
            f"{BASE_URL}/api/agora/deals/{deal_id}", json={"etape": "INCONNUE"}, timeout=20
        )
        assert bad_stage.status_code == 400, bad_stage.text
        assert "inconnue" in bad_stage.json().get("detail", "").lower()

        missing = f"TEST_missing_{uuid.uuid4().hex}"
        update_missing = api.put(
            f"{BASE_URL}/api/agora/deals/{missing}", json={"etape": "QUALIFICATION"}, timeout=20
        )
        assert update_missing.status_code == 404, update_missing.text
        assert "introuvable" in update_missing.json().get("detail", "").lower()

        delete_missing = api.delete(f"{BASE_URL}/api/agora/deals/{missing}", timeout=20)
        assert delete_missing.status_code == 404, delete_missing.text
        assert "introuvable" in delete_missing.json().get("detail", "").lower()

    def test_delete_removes_deal(self, api):
        create = api.post(
            f"{BASE_URL}/api/agora/deals",
            json={"nom": f"TEST_Delete_{uuid.uuid4().hex[:8]}", "valeur": 100},
            timeout=20,
        )
        assert create.status_code == 200, create.text
        created = create.json().get("deal")
        assert isinstance(created, dict) and created.get("id")
        deal_id = created["id"]

        deleted = api.delete(f"{BASE_URL}/api/agora/deals/{deal_id}", timeout=20)
        assert deleted.status_code == 200, deleted.text
        assert deleted.json() == {"ok": True}

        listing = api.get(f"{BASE_URL}/api/agora/deals", timeout=20)
        assert listing.status_code == 200, listing.text
        assert all(item.get("id") != deal_id for item in listing.json()["deals"])
        second_delete = api.delete(f"{BASE_URL}/api/agora/deals/{deal_id}", timeout=20)
        assert second_delete.status_code == 404


# NewsAPI French article response contract; quota exhaustion is accepted.
class TestNews:
    def test_headlines_contract_or_expected_quota(self, api):
        response = api.get(f"{BASE_URL}/api/news/headlines?limit=5", timeout=30)
        if response.status_code == 429:
            detail = response.json().get("detail")
            assert isinstance(detail, str) and "quota" in detail.lower()
            return
        assert response.status_code == 200, response.text
        articles = response.json().get("articles")
        assert isinstance(articles, list) and 1 <= len(articles) <= 5
        for article in articles:
            assert set(("titre", "source", "description", "url", "date")).issubset(article)
            assert isinstance(article["titre"], str) and article["titre"].strip()
            assert isinstance(article["source"], str) and article["source"].strip()
            assert isinstance(article["description"], str)
            assert isinstance(article["url"], str) and article["url"].startswith("http")
            assert isinstance(article["date"], str) and article["date"].strip()

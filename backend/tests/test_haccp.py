# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Public API regression tests for the complete HACCP module."""
from datetime import date, timedelta
import uuid

import pytest
import requests
from dotenv import dotenv_values

frontend_env = dotenv_values("/app/frontend/.env")
base_url = frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing from /app/frontend/.env")
BASE_URL = base_url.rstrip("/")
API = f"{BASE_URL}/api/haccp"


@pytest.fixture(scope="module")
def api_client():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    yield session
    session.close()


@pytest.fixture(scope="module")
def cleanup(api_client):
    tracked = {
        "trace": [],
        "equipment": [],
        "nc": [],
        "clean": [],
        "allergen": [],
        "document": [],
    }
    yield tracked
    endpoints = {
        "trace": "trace",
        "equipment": "equipements",
        "nc": "nc",
        "clean": "nettoyage/taches",
        "allergen": "allergenes",
        "document": "documents",
    }
    for resource, ids in tracked.items():
        for item_id in ids:
            api_client.delete(f"{API}/{endpoints[resource]}/{item_id}", timeout=15)


# Overview counters and default regulatory reference data.
class TestHaccpOverviewAndSeeds:
    def test_overview_shape(self, api_client):
        response = api_client.get(f"{API}/overview", timeout=15)
        assert response.status_code == 200, response.text
        data = response.json()
        expected = {
            "dlc_alertes",
            "nc_ouvertes",
            "docs_alertes",
            "temp_non_conformes_jour",
        }
        assert set(data) == expected
        assert all(isinstance(data[key], int) and data[key] >= 0 for key in expected)

    def test_default_equipment_ranges(self, api_client):
        response = api_client.get(f"{API}/equipements", timeout=15)
        assert response.status_code == 200, response.text
        items = response.json()["items"]
        defaults = {
            "Chambre froide positive": ("frigo", 0.0, 4.0),
            "Congélateur": ("congelateur", -30.0, -18.0),
            "Frigo de service": ("frigo", 0.0, 4.0),
        }
        indexed = {item["nom"]: item for item in items}
        for name, (kind, minimum, maximum) in defaults.items():
            assert name in indexed
            item = indexed[name]
            assert item["type"] == kind
            assert item["min"] == minimum
            assert item["max"] == maximum
            assert isinstance(item["id"], str) and item["id"]

    def test_default_pms_has_twelve_items(self, api_client):
        response = api_client.get(f"{API}/pms", timeout=15)
        assert response.status_code == 200, response.text
        items = response.json()["items"]
        assert len(items) >= 12
        assert all(item["statut"] in {"en_place", "a_mettre_a_jour", "a_verifier"} for item in items)
        assert {item["categorie"] for item in items} >= {
            "Bonnes pratiques d'hygiène (BPH)",
            "Procédures HACCP",
            "Traçabilité",
            "Gestion des non-conformités",
            "Plan de nettoyage",
        }


# Traceability create, list persistence, status and idempotent delete.
class TestTraceability:
    def test_trace_create_get_delete(self, api_client, cleanup):
        marker = f"TEST_Saumon_{uuid.uuid4().hex[:8]}"
        payload = {
            "produit": marker,
            "lot": "LOT-42",
            "fournisseur": "TEST_Fournisseur",
            "dlc": (date.today() + timedelta(days=1)).isoformat(),
            "temperature_reception": 3.2,
            "quantite": "2 kg",
        }
        created = api_client.post(f"{API}/trace", json=payload, timeout=15)
        assert created.status_code == 200, created.text
        item = created.json()
        cleanup["trace"].append(item["id"])
        assert item["produit"] == marker
        assert item["lot"] == "LOT-42"
        assert item["statut"] == "bientot"
        assert isinstance(item["id"], str) and item["id"]

        listed = api_client.get(f"{API}/trace", timeout=15)
        assert listed.status_code == 200
        persisted = next(row for row in listed.json()["items"] if row["id"] == item["id"])
        assert persisted["temperature_reception"] == 3.2
        assert persisted["quantite"] == "2 kg"

        deleted = api_client.delete(f"{API}/trace/{item['id']}", timeout=15)
        assert deleted.status_code == 200 and deleted.json() == {"ok": True}
        cleanup["trace"].remove(item["id"])
        after = api_client.get(f"{API}/trace", timeout=15).json()["items"]
        assert all(row["id"] != item["id"] for row in after)
        repeated = api_client.delete(f"{API}/trace/{item['id']}", timeout=15)
        assert repeated.status_code == 200 and repeated.json() == {"ok": True}


# Temperature compliance calculation and automatic non-conformity creation.
class TestTemperatures:
    def test_conforming_and_nonconforming_temperature(self, api_client, cleanup):
        equipment_name = f"TEST_Fridge_{uuid.uuid4().hex[:8]}"
        eq_response = api_client.post(
            f"{API}/equipements", json={"nom": equipment_name, "type": "frigo"}, timeout=15
        )
        assert eq_response.status_code == 200, eq_response.text
        equipment = eq_response.json()
        cleanup["equipment"].append(equipment["id"])
        assert (equipment["min"], equipment["max"]) == (0.0, 4.0)

        conforming = api_client.post(
            f"{API}/temperatures",
            json={"equipement_id": equipment["id"], "valeur": 3.5, "releve_par": "TEST_QA"},
            timeout=15,
        )
        assert conforming.status_code == 200, conforming.text
        good = conforming.json()
        assert good["equipement"] == equipment_name
        assert good["valeur"] == 3.5
        assert good["conforme"] is True

        nonconforming = api_client.post(
            f"{API}/temperatures",
            json={"equipement_id": equipment["id"], "valeur": 8.5},
            timeout=15,
        )
        assert nonconforming.status_code == 200, nonconforming.text
        bad = nonconforming.json()
        assert bad["valeur"] == 8.5
        assert bad["conforme"] is False

        history = api_client.get(
            f"{API}/temperatures", params={"equipement_id": equipment["id"]}, timeout=15
        )
        assert history.status_code == 200
        persisted = history.json()["items"]
        assert {row["id"] for row in persisted} >= {good["id"], bad["id"]}

        nc_response = api_client.get(f"{API}/nc", timeout=15)
        assert nc_response.status_code == 200
        auto_nc = next(
            row for row in nc_response.json()["items"]
            if row.get("auto") is True and equipment_name in row["description"] and "8.5°C" in row["description"]
        )
        cleanup["nc"].append(auto_nc["id"])
        assert auto_nc["type"] == "température"
        assert auto_nc["gravite"] == "majeure"
        assert auto_nc["statut"] == "ouverte"

        deleted_eq = api_client.delete(f"{API}/equipements/{equipment['id']}", timeout=15)
        assert deleted_eq.status_code == 200 and deleted_eq.json() == {"ok": True}
        cleanup["equipment"].remove(equipment["id"])
        after_history = api_client.get(
            f"{API}/temperatures", params={"equipement_id": equipment["id"]}, timeout=15
        ).json()["items"]
        assert after_history == []

    def test_unknown_equipment_rejected(self, api_client):
        response = api_client.post(
            f"{API}/temperatures",
            json={"equipement_id": "TEST_missing_equipment", "valeur": 4},
            timeout=15,
        )
        assert response.status_code == 404
        assert "introuvable" in response.json()["detail"].lower()


# PMS status transitions persist and seeded state is restored after validation.
class TestPms:
    def test_patch_all_supported_statuses_and_restore(self, api_client):
        items = api_client.get(f"{API}/pms", timeout=15).json()["items"]
        item = items[0]
        original = item["statut"]
        try:
            for status in ("a_verifier", "a_mettre_a_jour", "en_place"):
                response = api_client.patch(
                    f"{API}/pms/{item['id']}", json={"statut": status}, timeout=15
                )
                assert response.status_code == 200, response.text
                assert response.json()["statut"] == status
                assert response.json()["derniere_revision"] == date.today().isoformat()
                persisted = api_client.get(f"{API}/pms", timeout=15).json()["items"]
                current = next(row for row in persisted if row["id"] == item["id"])
                assert current["statut"] == status
                assert current["derniere_revision"] == date.today().isoformat()
        finally:
            api_client.patch(f"{API}/pms/{item['id']}", json={"statut": original}, timeout=15)

    def test_invalid_pms_status_rejected(self, api_client):
        item_id = api_client.get(f"{API}/pms", timeout=15).json()["items"][0]["id"]
        response = api_client.patch(
            f"{API}/pms/{item_id}", json={"statut": "TEST_invalid"}, timeout=15
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "Statut invalide"


# Manual non-conformity declaration, closure persistence and deletion.
class TestNonConformities:
    def test_nc_create_close_delete(self, api_client, cleanup):
        description = f"TEST_NC_{uuid.uuid4().hex[:8]}"
        created = api_client.post(
            f"{API}/nc",
            json={
                "type": "hygiène",
                "description": description,
                "action_corrective": "TEST action initiale",
                "gravite": "mineure",
            },
            timeout=15,
        )
        assert created.status_code == 200, created.text
        item = created.json()
        cleanup["nc"].append(item["id"])
        assert item["description"] == description
        assert item["statut"] == "ouverte"
        assert item["auto"] is False

        closed = api_client.patch(
            f"{API}/nc/{item['id']}/cloture",
            json={"action_corrective": "TEST action finale"},
            timeout=15,
        )
        assert closed.status_code == 200 and closed.json() == {"ok": True}
        persisted = api_client.get(f"{API}/nc", timeout=15).json()["items"]
        current = next(row for row in persisted if row["id"] == item["id"])
        assert current["statut"] == "cloturee"
        assert current["cloture_le"]
        assert current["action_corrective"] == "TEST action finale"

        deleted = api_client.delete(f"{API}/nc/{item['id']}", timeout=15)
        assert deleted.status_code == 200 and deleted.json() == {"ok": True}
        cleanup["nc"].remove(item["id"])
        after = api_client.get(f"{API}/nc", timeout=15).json()["items"]
        assert all(row["id"] != item["id"] for row in after)


# Cleaning plan persistence and daily completion state.
class TestCleaning:
    def test_clean_task_log_and_delete(self, api_client, cleanup):
        zone = f"TEST_Plan_de_travail_{uuid.uuid4().hex[:8]}"
        created = api_client.post(
            f"{API}/nettoyage/taches",
            json={
                "zone": zone,
                "surface": "inox",
                "produit": "TEST désinfectant",
                "frequence": "quotidien",
                "responsable": "TEST_QA",
            },
            timeout=15,
        )
        assert created.status_code == 200, created.text
        task = created.json()
        cleanup["clean"].append(task["id"])
        assert task["zone"] == zone
        assert task["a_faire"] is True
        assert task["dernier_nettoyage"] is None

        logged = api_client.post(
            f"{API}/nettoyage/logs",
            json={"tache_id": task["id"], "fait_par": "TEST_QA"},
            timeout=15,
        )
        assert logged.status_code == 200, logged.text
        log = logged.json()
        assert log["tache_id"] == task["id"]
        assert log["fait_par"] == "TEST_QA"

        listed = api_client.get(f"{API}/nettoyage/taches", timeout=15)
        assert listed.status_code == 200
        current = next(row for row in listed.json()["items"] if row["id"] == task["id"])
        assert current["a_faire"] is False
        assert current["dernier_nettoyage"] == log["created_at"]

        deleted = api_client.delete(f"{API}/nettoyage/taches/{task['id']}", timeout=15)
        assert deleted.status_code == 200 and deleted.json() == {"ok": True}
        cleanup["clean"].remove(task["id"])
        after = api_client.get(f"{API}/nettoyage/taches", timeout=15).json()["items"]
        assert all(row["id"] != task["id"] for row in after)


# EU allergen reference list, filtering, persistence and deletion.
class TestAllergens:
    def test_allergen_list_filter_create_delete(self, api_client, cleanup):
        before = api_client.get(f"{API}/allergenes", timeout=15)
        assert before.status_code == 200
        liste = before.json()["liste_14"]
        assert len(liste) == 14
        assert len(set(liste)) == 14
        assert {"Gluten", "Lait", "Œufs", "Crustacés", "Mollusques"} <= set(liste)

        dish = f"TEST_Quiche_{uuid.uuid4().hex[:8]}"
        created = api_client.post(
            f"{API}/allergenes",
            json={"plat": dish, "allergenes": ["Gluten", "Lait", "TEST_Inconnu"]},
            timeout=15,
        )
        assert created.status_code == 200, created.text
        item = created.json()
        cleanup["allergen"].append(item["id"])
        assert item["plat"] == dish
        assert item["allergenes"] == ["Gluten", "Lait"]

        listed = api_client.get(f"{API}/allergenes", timeout=15).json()["items"]
        persisted = next(row for row in listed if row["id"] == item["id"])
        assert persisted["allergenes"] == ["Gluten", "Lait"]

        deleted = api_client.delete(f"{API}/allergenes/{item['id']}", timeout=15)
        assert deleted.status_code == 200 and deleted.json() == {"ok": True}
        cleanup["allergen"].remove(item["id"])
        after = api_client.get(f"{API}/allergenes", timeout=15).json()["items"]
        assert all(row["id"] != item["id"] for row in after)


# Mandatory document expiry status, persistence and deletion.
class TestDocuments:
    def test_expired_document_create_get_delete(self, api_client, cleanup):
        name = f"TEST_Attestation_{uuid.uuid4().hex[:8]}"
        expiration = (date.today() - timedelta(days=1)).isoformat()
        created = api_client.post(
            f"{API}/documents",
            json={
                "nom": name,
                "categorie": "formation",
                "date_emission": (date.today() - timedelta(days=365)).isoformat(),
                "date_expiration": expiration,
                "notes": "TEST_QA",
            },
            timeout=15,
        )
        assert created.status_code == 200, created.text
        item = created.json()
        cleanup["document"].append(item["id"])
        assert item["nom"] == name
        assert item["date_expiration"] == expiration
        assert item["statut"] == "expire"

        listed = api_client.get(f"{API}/documents", timeout=15)
        assert listed.status_code == 200
        persisted = next(row for row in listed.json()["items"] if row["id"] == item["id"])
        assert persisted["statut"] == "expire"

        overview = api_client.get(f"{API}/overview", timeout=15).json()
        assert overview["docs_alertes"] >= 1

        deleted = api_client.delete(f"{API}/documents/{item['id']}", timeout=15)
        assert deleted.status_code == 200 and deleted.json() == {"ok": True}
        cleanup["document"].remove(item["id"])
        after = api_client.get(f"{API}/documents", timeout=15).json()["items"]
        assert all(row["id"] != item["id"] for row in after)



# Required business labels must reject empty or whitespace-only values.
@pytest.mark.parametrize(
    ("endpoint", "payload", "cleanup_endpoint"),
    [
        ("trace", {"produit": "   "}, "trace"),
        ("equipements", {"nom": "   ", "type": "frigo"}, "equipements"),
        ("nc", {"description": "   "}, "nc"),
        ("nettoyage/taches", {"zone": "   "}, "nettoyage/taches"),
        ("allergenes", {"plat": "   ", "allergenes": []}, "allergenes"),
        ("documents", {"nom": "   "}, "documents"),
    ],
)
def test_required_text_rejects_blank(api_client, endpoint, payload, cleanup_endpoint):
    response = api_client.post(f"{API}/{endpoint}", json=payload, timeout=15)
    if response.status_code == 200:
        item_id = response.json().get("id")
        if item_id:
            api_client.delete(f"{API}/{cleanup_endpoint}/{item_id}", timeout=15)
    assert response.status_code == 422, response.text
    detail = response.json().get("detail")
    assert detail

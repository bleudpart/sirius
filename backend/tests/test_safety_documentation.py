import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import auth_api
from account_deletion import REVIEW_COLLECTIONS
from enterprise import _backup_company, _restore_company_archive
from test_duerp import run, setup  # noqa: F401


def payload(**changes):
    return {
        "etablissement": "Cuisine test", "responsable": "Responsable sécurité", "adresse": "Rue de test",
        "date_document": "2026-10-23", "motif_revision": "Initiale",
        "accueil": [{"personne": "Employé A", "poste": "Cuisine", "date_accueil": "2026-10-23",
                     "accueillant": "Chef", "consignes_remises": "Livret", "observations": "Poste présenté"}],
        "formations": [{"personne": "Employé A", "formation": "Accueil sécurité",
                        "date_formation": "2026-10-23", "organisme": "Formateur",
                        "preuve": "Dossier interne référence 123", "renouvellement": None}],
        "incendie": {"responsable": "Responsable local", "alerte": "Référence des consignes locales",
                     "point_rassemblement": "Point validé sur site", "date_validation": None},
        "evacuations": [{"date_exercice": "2026-10-23", "scenario": "Exercice préparé",
                         "observations": "Compte rendu", "action": "Adapter l'affichage",
                         "pilote_action": "Responsable", "echeance": "2026-11-01", "statut": "en_cours"}],
        "verifications": [{"equipement": "Équipement A", "type_verification": "Vérification professionnelle",
                           "date_verification": "2026-10-23", "reference_rapport": "Rapport 123",
                           "resultat": "avec_observations", "observations": "Réserve au rapport",
                           "action": "Faire lever la réserve", "responsable": "Responsable technique",
                           "prochaine_date": "2027-10-23", "echeance": None, "statut": "a_faire"}],
        **changes,
    }


def save(client, uid="one", body=None):
    response = client.post("/api/haccp/personnel-securite", headers={"x-test-user": uid}, json=body or payload())
    assert response.status_code == 200, response.text
    return response.json()["document"]


def test_all_five_registers_are_saved_versioned_and_retrievable(setup):
    db, client, _ = setup
    assert client.get("/api/haccp/personnel-securite/current", headers={"x-test-user": "one"}).json() == {"document": None}
    first, second = save(client), save(client, body=payload(motif_revision="Révision"))
    assert first["id"] != second["id"]
    assert first["formations"][0]["preuve"] == "Dossier interne référence 123"
    assert first["incendie"]["point_rassemblement"] == "Point validé sur site"
    assert first["evacuations"][0]["statut"] == "en_cours"
    assert first["verifications"][0]["resultat"] == "avec_observations"
    assert run(db.haccp_safety.count_documents({"user_id": "one"})) == 2
    current = client.get("/api/haccp/personnel-securite/current", headers={"x-test-user": "one"}).json()
    assert current["document"]["id"] == second["id"]
    old = client.get("/api/haccp/personnel-securite/" + first["id"], headers={"x-test-user": "one"}).json()
    assert old["document"] == first
    assert "created_by" not in first
    assert client.delete("/api/haccp/personnel-securite/" + first["id"], headers={"x-test-user": "one"}).status_code == 405


@pytest.mark.parametrize("uid,status", [(None, 401), ("denied", 403)])
def test_authentication_and_permission_required_for_every_route(setup, uid, status):
    _, client, _ = setup
    headers = {"x-test-user": uid} if uid else {}
    for path in ("", "/current", "/some-version"):
        assert client.get("/api/haccp/personnel-securite" + path, headers=headers).status_code == status
    assert client.post("/api/haccp/personnel-securite", json=payload(), headers=headers).status_code == status


def test_private_and_company_data_are_isolated_and_company_changes_audited(setup):
    db, client, _ = setup
    private, company = save(client), save(client, "worker")
    for uid in ("two", "worker", "stranger"):
        assert client.get("/api/haccp/personnel-securite/" + private["id"], headers={"x-test-user": uid}).status_code == 404
    for uid in ("one", "two", "stranger"):
        assert client.get("/api/haccp/personnel-securite/" + company["id"], headers={"x-test-user": uid}).status_code == 404
    assert client.get("/api/haccp/personnel-securite/" + company["id"], headers={"x-test-user": "colleague"}).status_code == 200
    assert run(db.enterprise_audit.find_one({"resource_id": company["id"]}))["action"] == "haccp.safety.create"


@pytest.mark.parametrize("section,field,value", [
    ("accueil", "personne", ""), ("accueil", "poste", " "), ("accueil", "date_accueil", "2026-02-30"),
    ("formations", "formation", ""), ("formations", "date_formation", "bad"),
    ("formations", "renouvellement", "bad"), ("evacuations", "scenario", " "),
    ("evacuations", "statut", "certifie"), ("verifications", "equipement", ""),
    ("verifications", "resultat", "certifie_conforme"), ("verifications", "prochaine_date", "bad"),
    ("accueil", "donnees_medicales", "not allowed"),
])
def test_invalid_or_unexpected_register_data_is_rejected(setup, section, field, value):
    db, client, _ = setup
    body = payload()
    body[section][0][field] = value
    response = client.post("/api/haccp/personnel-securite", headers={"x-test-user": "one"}, json=body)
    assert response.status_code == 422
    assert run(db.haccp_safety.count_documents({})) == 0


@pytest.mark.parametrize("changes", [
    {"company_id": "other"}, {"etablissement": ""}, {"responsable": " "},
    {"date_document": "bad"}, {"incendie": {"date_validation": "bad"}},
    {"accueil": [payload()["accueil"][0]] * 201},
])
def test_document_validation_rejects_spoofed_scope_and_excess_rows(setup, changes):
    db, client, _ = setup
    assert client.post("/api/haccp/personnel-securite", headers={"x-test-user": "one"},
                       json=payload(**changes)).status_code == 422
    assert run(db.haccp_safety.count_documents({})) == 0


def test_empty_registers_are_stored_as_empty_without_auto_filled_instructions(setup):
    document = save(setup[1], body={
        "etablissement": "Test", "responsable": "Employeur", "date_document": "2026-10-23",
    })
    assert document["accueil"] == document["formations"] == document["evacuations"] == document["verifications"] == []
    assert document["incendie"]["alerte"] == "" and document["incendie"]["date_validation"] is None
    assert document["planning_cuisine"] == document["planning_salle"] == []


def shift(**changes):
    return {"personne": "Employé A", "poste": "Cuisine", "date_service": "2026-10-23",
            "debut": "08:00", "fin": "16:00", "pause_minutes": 30, "lendemain": "non", **changes}


def test_both_personnel_schedules_persist_without_mixing_teams(setup):
    document = save(setup[1], body=payload(planning_cuisine=[shift()],
        planning_salle=[shift(personne="Employé B", poste="Salle", debut="18:00", fin="23:00")]))
    assert document["planning_cuisine"][0]["personne"] == "Employé A"
    assert document["planning_salle"][0]["personne"] == "Employé B"
    overnight = save(setup[1], body=payload(planning_salle=[shift(debut="22:00", fin="02:00", lendemain="oui")]))
    assert overnight["planning_salle"][0]["lendemain"] == "oui"


@pytest.mark.parametrize("change", [
    {"debut": "25:00"}, {"fin": "02:00"}, {"pause_minutes": 480}, {"pause_minutes": -1},
    {"pause_minutes": "30"}, {"fin": "08:00"}, {"lendemain": "oui"}, {"personne": ""},
])
def test_invalid_schedule_hours_and_breaks_are_rejected(setup, change):
    response = setup[1].post("/api/haccp/personnel-securite", headers={"x-test-user": "one"},
                             json=payload(planning_cuisine=[shift(**change)]))
    assert response.status_code == 422


def test_history_limit_is_reported_without_erasing_older_versions(setup):
    db, client, _ = setup
    document = save(client)
    for index in range(100):
        run(db.haccp_safety.insert_one({**document, "id": str(index), "user_id": "one",
                                      "created_at": f"2025-{index:03}"}))
    listing = client.get("/api/haccp/personnel-securite", headers={"x-test-user": "one"}).json()
    assert listing["truncated"] is True and len(listing["items"]) == 100
    assert client.get("/api/haccp/personnel-securite/0", headers={"x-test-user": "one"}).status_code == 200


def test_backup_restore_and_private_export_cover_safety_without_cross_company_leak(setup, monkeypatch):
    db, client, users = setup
    private, company = save(client), save(client, "worker")
    path = run(_backup_company(db, {"id": "company", "name": "Test"}, {"email": "owner@example.test"}))
    with zipfile.ZipFile(path) as archive:
        rows = json.loads(archive.read("mongo/haccp_safety.json"))
        assert [row["id"] for row in rows] == [company["id"]]
    run(db.haccp_safety.delete_many({"company_id": "company"}))
    run(_restore_company_archive(db, "company", path.read_bytes()))
    assert run(db.haccp_safety.count_documents({"company_id": "company"})) == 1
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value=users["one"]))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(db).routes
                    if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(SimpleNamespace())
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        content = archive.read("sirius-personal-data.json").decode()
    assert private["id"] in content and company["id"] not in content
    assert "haccp_safety" in REVIEW_COLLECTIONS

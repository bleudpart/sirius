import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import auth_api
from account_deletion import REVIEW_COLLECTIONS
from enterprise import BACKUP_COLLECTIONS, _backup_company, _restore_company_archive
from test_duerp import run, setup  # noqa: F401


def payload(**changes):
    return {"titre": "Relevés frigo", "etablissement": "Cuisine",
            "colonnes": ["Date", "T°", "Opérateur"], "lignes": [["23/10/2026", "3", "Test"]],
            "responsable": "Responsable", "equipement": "Frigo 1", "cible": "Selon PMS",
            "remarques": "Vérifier", **changes}


def save(client, uid="one", template="frigo", body=None):
    response = client.post("/api/haccp/feuilles/" + template,
                            headers={"x-test-user": uid}, json=body or payload())
    assert response.status_code == 200, response.text
    return response.json()["document"]


@pytest.mark.parametrize("template", ["frigo", "congelateur", "chambre_froide", "epicerie", "boitage"])
def test_requested_editable_sheet_models_are_versioned(setup, template):
    db, client, _ = setup
    first = save(client, template=template)
    second = save(client, template=template, body=payload(lignes=[["24/10/2026", "2", "Autre"]]))
    assert first["id"] != second["id"]
    base = "/api/haccp/feuilles/" + template
    assert client.get(base + "/current", headers={"x-test-user": "one"}).json()["document"] == second
    assert client.get(base + "/versions/" + first["id"], headers={"x-test-user": "one"}).json()["document"] == first
    assert len(client.get(base + "/versions", headers={"x-test-user": "one"}).json()["items"]) == 2
    assert run(db.haccp_sheets.count_documents({"modele": template})) == 2


def test_sheet_routes_are_authenticated_scoped_and_template_isolated(setup):
    _, client, _ = setup
    saved = save(client)
    company = save(client, "worker")
    for path in ["/current", "/versions", "/versions/" + saved["id"]]:
        assert client.get("/api/haccp/feuilles/frigo" + path).status_code == 401
        assert client.get("/api/haccp/feuilles/frigo" + path, headers={"x-test-user": "denied"}).status_code == 403
    for uid in ["two", "worker", "stranger"]:
        assert client.get("/api/haccp/feuilles/frigo/versions/" + saved["id"], headers={"x-test-user": uid}).status_code == 404
    assert client.get("/api/haccp/feuilles/frigo/versions/" + company["id"], headers={"x-test-user": "colleague"}).status_code == 200
    assert client.get("/api/haccp/feuilles/epicerie/versions/" + saved["id"], headers={"x-test-user": "one"}).status_code == 404
    assert client.post("/api/haccp/feuilles/frigo", json=payload()).status_code == 401


@pytest.mark.parametrize("change", [
    {"colonnes": ["Date"]}, {"colonnes": ["", "Valeur"]}, {"lignes": [["Une seule case"]]},
    {"lignes": [["Date", "3", "Test"]] * 201}, {"company_id": "other"},
    {"lignes": [["Date", "3", "x" * 1001]]}, {"etablissement": ""},
])
def test_sheet_table_shape_limits_and_scope_are_validated(setup, change):
    db, client, _ = setup
    response = client.post("/api/haccp/feuilles/frigo", json=payload(**change), headers={"x-test-user": "one"})
    assert response.status_code == 422 and run(db.haccp_sheets.count_documents({})) == 0


def test_sheets_included_in_backup_and_restore_without_touching_private_versions(setup):
    db, client, _ = setup
    private, company = save(client), save(client, "worker")
    path = run(_backup_company(db, {"id": "company", "name": "Test"}, {"email": "owner@example.test"}))
    with zipfile.ZipFile(path) as archive:
        assert [row["id"] for row in json.loads(archive.read("mongo/haccp_sheets.json"))] == [company["id"]]
    run(db.haccp_sheets.delete_many({"company_id": "company"}))
    run(_restore_company_archive(db, "company", path.read_bytes()))
    assert run(db.haccp_sheets.find_one({"id": private["id"]}))
    assert run(db.haccp_sheets.find_one({"id": company["id"]}))
    assert "haccp_sheets" in BACKUP_COLLECTIONS and "haccp_sheets" in REVIEW_COLLECTIONS


def test_private_export_excludes_company_sheets_and_history_cannot_be_overwritten(setup, monkeypatch):
    db, client, users = setup
    private, company = save(client), save(client, "worker")
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value=users["one"]))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(db).routes
                    if route.path == "/auth/privacy/export")

    async def export():
        response = await endpoint(SimpleNamespace())
        return b"".join([chunk async for chunk in response.body_iterator])

    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        text = archive.read("sirius-personal-data.json").decode()
    assert private["id"] in text and company["id"] not in text
    path = "/api/haccp/feuilles/frigo/versions/" + private["id"]
    assert client.put(path, json=payload(), headers={"x-test-user": "one"}).status_code == 405
    assert client.delete(path, headers={"x-test-user": "one"}).status_code == 405


def test_empty_sheet_is_explicit_and_history_pagination_is_announced(setup):
    db, client, _ = setup
    document = save(client, body=payload(lignes=[]))
    assert document["lignes"] == []
    for index in range(100):
        run(db.haccp_sheets.insert_one({**payload(), "user_id": "one", "modele": "frigo",
                                       "id": str(index), "created_at": f"2025-{index:03}"}))
    history = client.get("/api/haccp/feuilles/frigo/versions", headers={"x-test-user": "one"}).json()
    assert history["truncated"] is True and len(history["items"]) == 100


@pytest.mark.parametrize("kind,lo,hi", [("chambre_froide_positive", 0, 4), ("chambre_froide_negative", -30, -18)])
def test_cold_rooms_can_be_created_and_have_distinct_reference_ranges(setup, kind, lo, hi):
    _, client, _ = setup
    # Existing equipment API retains its legacy local access behavior.
    response = client.post("/api/haccp/equipements", json={"nom": "Chambre test", "type": kind})
    assert response.status_code == 200
    assert response.json()["min"] == lo and response.json()["max"] == hi

import asyncio
import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import auth_api
import duerp
from account_deletion import REVIEW_COLLECTIONS
from enterprise import _backup_company, _restore_company_archive
from haccp import make_haccp_router
from local_docstore import LocalDocStore


def run(awaitable):
    return asyncio.run(awaitable)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "duerp.db")
    users = {
        "one": {"user_id": "one", "email": "one@example.test"},
        "two": {"user_id": "two", "email": "two@example.test"},
        "worker": {"user_id": "worker", "company_id": "company", "email": "worker@example.test"},
        "colleague": {"user_id": "colleague", "company_id": "company", "email": "colleague@example.test"},
        "stranger": {"user_id": "stranger", "company_id": "other", "email": "stranger@example.test"},
        "denied": {"user_id": "denied", "company_id": "company", "email": "denied@example.test"},
    }
    for uid, user in users.items():
        run(db.users.insert_one(dict(user)))
        if user.get("company_id"):
            run(db.enterprise_members.insert_one({"user_id": uid, "company_id": user["company_id"],
                "role": "operator", "permissions": ["documents"] if uid == "denied" else ["haccp"]}))

    async def identity(request, database):
        user = users.get(request.headers.get("x-test-user"))
        if not user:
            raise HTTPException(401, "Connexion requise.")
        return user

    monkeypatch.setattr(duerp, "require_user", identity)
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(make_haccp_router(db), prefix="/api")
    return db, TestClient(app), users


def payload(**changes):
    return {
        "etablissement": "Cuisine test", "adresse": "Rue de test", "employeur": "Responsable",
        "effectif": 4, "participants": "Équipe et représentant", "date_evaluation": "2026-10-23",
        "motif_revision": "Évaluation initiale",
        "risques": [{"unite": "Cuisine", "situation": "Découpe", "danger": "Lame",
                     "personnes": "Personnel en cuisine", "dommages": "Coupure",
                     "mesures_existantes": "Formation et rangement", "gravite": 3, "probabilite": 4,
                     "action": "Revoir le poste", "responsable": "Chef", "echeance": "2026-11-01",
                     "statut": "a_faire"}],
        **changes,
    }


def save(client, uid="one", body=None):
    response = client.post("/api/haccp/duerp", json=body or payload(), headers={"x-test-user": uid})
    assert response.status_code == 200, response.text
    return response.json()["document"]


def test_authenticated_scoped_versions_persist_and_cannot_overwrite(setup):
    db, client, _ = setup
    assert client.get("/api/haccp/duerp/current", headers={"x-test-user": "one"}).json() == {"document": None}
    first = save(client)
    assert first["risques"][0]["score"] == 12 and first["risques"][0]["priorite"] == "haute"
    second = save(client, body=payload(motif_revision="Révision"))
    assert first["id"] != second["id"]
    assert run(db.haccp_duerp.count_documents({"user_id": "one"})) == 2
    assert client.get("/api/haccp/duerp/current", headers={"x-test-user": "one"}).json()["document"]["id"] == second["id"]
    assert client.get("/api/haccp/duerp/" + first["id"], headers={"x-test-user": "one"}).json()["document"] == first
    assert client.put("/api/haccp/duerp/" + first["id"], json=payload(), headers={"x-test-user": "one"}).status_code == 405
    assert client.delete("/api/haccp/duerp/" + first["id"], headers={"x-test-user": "one"}).status_code == 405
    assert "created_by" not in first and "user_id" not in first
    history = client.get("/api/haccp/duerp", headers={"x-test-user": "one"}).json()
    assert len(history["items"]) == 2 and history["truncated"] is False


@pytest.mark.parametrize("path", ["", "/current", "/unknown"])
def test_new_routes_never_allow_anonymous_legacy_scope(setup, path):
    _, client, _ = setup
    assert client.get("/api/haccp/duerp" + path).status_code == 401
    assert client.post("/api/haccp/duerp", json=payload()).status_code == 401


def test_accounts_and_companies_are_isolated_and_haccp_permission_required(setup):
    db, client, _ = setup
    private = save(client)
    company = save(client, "worker")
    for uid in ("two", "worker", "stranger"):
        assert client.get("/api/haccp/duerp/" + private["id"], headers={"x-test-user": uid}).status_code == 404
    for uid in ("one", "two", "stranger"):
        assert client.get("/api/haccp/duerp/" + company["id"], headers={"x-test-user": uid}).status_code == 404
    assert client.get("/api/haccp/duerp/" + company["id"], headers={"x-test-user": "colleague"}).status_code == 200
    for method, path in [("get", ""), ("get", "/current"), ("get", "/" + company["id"]), ("post", "")]:
        kwargs = {"json": payload()} if method == "post" else {}
        assert getattr(client, method)("/api/haccp/duerp" + path, headers={"x-test-user": "denied"}, **kwargs).status_code == 403
    assert run(db.enterprise_audit.find_one({"resource_id": company["id"]}))["action"] == "haccp.duerp.create"
    stored = run(db.haccp_duerp.find_one({"id": company["id"]}))
    assert stored["company_id"] == "company" and "user_id" not in stored


@pytest.mark.parametrize("field,value", [
    ("gravite", 0), ("gravite", 5), ("gravite", True), ("probabilite", "2"),
    ("probabilite", 5), ("unite", " "), ("situation", ""), ("danger", ""),
    ("statut", "certifie"), ("echeance", "2026-02-30"),
])
def test_invalid_risks_are_not_saved(setup, field, value):
    db, client, _ = setup
    body = payload()
    body["risques"][0][field] = value
    assert client.post("/api/haccp/duerp", json=body, headers={"x-test-user": "one"}).status_code == 422
    assert run(db.haccp_duerp.count_documents({})) == 0


@pytest.mark.parametrize("field,value", [
    ("etablissement", ""), ("employeur", " "), ("effectif", -1), ("effectif", 1.5),
    ("date_evaluation", "bad"), ("company_id", "other"),
    ("risques", [payload()["risques"][0]] * 201),
])
def test_document_validation_and_no_client_chosen_scope(setup, field, value):
    db, client, _ = setup
    response = client.post("/api/haccp/duerp", json=payload(**{field: value}), headers={"x-test-user": "one"})
    assert response.status_code == 422 and run(db.haccp_duerp.count_documents({})) == 0


@pytest.mark.parametrize("g,p,priority", [(1, 1, "basse"), (1, 4, "basse"), (2, 3, "moyenne"),
                                        (3, 3, "moyenne"), (3, 4, "haute"), (4, 4, "haute")])
def test_priority_thresholds(setup, g, p, priority):
    body = payload()
    body["risques"][0].update(gravite=g, probabilite=p)
    row = save(setup[1], body=body)["risques"][0]
    assert row["score"] == g * p and row["priorite"] == priority


def test_empty_assessment_is_explicit_and_large_history_is_marked(setup):
    db, client, _ = setup
    empty = save(client, body=payload(risques=[]))
    assert empty["risques"] == []
    for index in range(100):
        run(db.haccp_duerp.insert_one({**payload(), "id": str(index), "user_id": "one",
                                      "created_at": f"2025-{index:03}"}))
    history = client.get("/api/haccp/duerp", headers={"x-test-user": "one"}).json()
    assert history["truncated"] is True and len(history["items"]) == 100
    assert client.get("/api/haccp/duerp/0", headers={"x-test-user": "one"}).status_code == 200


def test_company_backup_and_restore_include_all_duerp_versions(setup):
    db, client, _ = setup
    first, second = save(client, "worker"), save(client, "worker")
    save(client, "one")
    path = run(_backup_company(db, {"id": "company", "name": "Test"}, {"email": "owner@example.test"}))
    with zipfile.ZipFile(path) as archive:
        rows = json.loads(archive.read("mongo/haccp_duerp.json"))
        assert {row["id"] for row in rows} == {first["id"], second["id"]}
    run(db.haccp_duerp.delete_many({"company_id": "company"}))
    run(_restore_company_archive(db, "company", path.read_bytes()))
    assert run(db.haccp_duerp.count_documents({"company_id": "company"})) == 2
    assert run(db.haccp_duerp.count_documents({"user_id": "one"})) == 1


def test_private_export_includes_duerp_and_deletion_requires_business_review(setup, monkeypatch):
    db, client, users = setup
    private = save(client)
    company = save(client, "worker")
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value=users["one"]))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(db).routes
                    if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(SimpleNamespace())
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        document = archive.read("sirius-personal-data.json").decode()
    assert private["id"] in document and company["id"] not in document
    assert "haccp_duerp" in REVIEW_COLLECTIONS

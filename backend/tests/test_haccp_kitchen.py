from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import access_gate
import haccp_database
import haccp_kitchen
import routers.haccp as routes
from tests.test_haccp_labels import extracted, picture


class Collection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])

    @staticmethod
    def _match(doc, query):
        return all(doc.get(key) == value for key, value in query.items())

    async def find_one(self, query):
        return next((dict(doc) for doc in self.docs if self._match(doc, query)), None)

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def delete_many(self, query):
        self.docs = [doc for doc in self.docs if not self._match(doc, query)]


@pytest.fixture
def kitchen(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    haccp_database._configured_engine.cache_clear()
    db = SimpleNamespace(
        haccp_kitchen_links=Collection(),
        users=Collection([{"user_id": "chef"}, {"user_id": "autre"}]),
    )
    access = AsyncMock(return_value={"allowed": True})
    monkeypatch.setattr(access_gate, "access_status", access)
    owner_scopes = {"chef": "user:chef", "autre": "user:autre"}

    async def owner_scope(user):
        return owner_scopes[user["user_id"]]

    async def scope(request: Request) -> str:
        if haccp_kitchen.kitchen_token(request) is not None:
            return await haccp_kitchen.resolve_kitchen(request, db, owner_scope)
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "Authentification requise.")
        request.state.haccp_actor = uid
        return "user:" + uid

    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted()))
    app = FastAPI()
    app.include_router(haccp_kitchen.make_haccp_kitchen_router(scope, lambda: db), prefix="/api")
    app.include_router(routes.make_haccp_router(scope), prefix="/api")
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, db=db, access=access, owner_scopes=owner_scopes)
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()


CHEF = {"x-test-user": "chef"}


def create_link(client, name="Chez Daniel"):
    response = client.post("/api/haccp/cuisine/lien", json={"restaurant_name": name}, headers=CHEF)
    assert response.status_code == 200
    body = response.json()
    assert body["active"] is True
    assert body["url"].startswith("https://sirius-assistant.fr/cuisine#k=")
    return body, {haccp_kitchen.HEADER: body["url"].split("#k=", 1)[1]}


def kitchen_scan(client, headers, operation='{"type_operation": "reception"}'):
    return client.post(
        "/api/haccp/etiquettes/scan", files={"file": ("etiquette.png", picture(), "image/png")},
        data={"operateur": "Pirate", "restaurant_name": "Autre resto", "operation": operation},
        headers=headers,
    )


def test_le_qr_cuisine_photographie_et_retrouve_dans_le_registre_du_chef(kitchen):
    client = kitchen.client
    link, headers = create_link(client)
    assert client.get("/api/haccp/cuisine/lien", headers=CHEF).json() == link
    assert client.get("/api/haccp/cuisine/session", headers=headers).json() == {"restaurant_name": "Chez Daniel"}

    saved = kitchen_scan(client, headers)
    assert saved.status_code == 201, saved.text
    record = saved.json()
    assert record["operateur"] == "Cuisine"
    assert record["restaurant_name"] == "Chez Daniel"

    found = client.get("/api/haccp/registre/recherche", headers=headers).json()
    assert [item["id"] for item in found] == [record["id"]]
    assert client.get("/api/haccp/registre/recherche", headers=CHEF).json()[0]["id"] == record["id"]
    photo = client.get(f"/api/haccp/registre/{record['id']}/photo", headers=headers)
    assert photo.status_code == 200
    assert photo.headers["content-type"].startswith("image/")


def test_le_qr_cuisine_ne_donne_acces_a_rien_d_autre(kitchen):
    client = kitchen.client
    _, headers = create_link(client)
    assert kitchen_scan(client, headers, '{"type_operation": "ouverture", "sans_regle": true}').status_code in {403, 422}
    assert client.get("/api/haccp/registre/export-csv", headers=headers).status_code == 403
    assert client.get("/api/haccp/cuisine/lien", headers=headers).status_code == 403
    assert client.post("/api/haccp/cuisine/lien", json={"restaurant_name": "X"}, headers=headers).status_code == 403
    assert client.delete("/api/haccp/cuisine/lien", headers=headers).status_code == 403
    assert client.get("/api/haccp/cuisine/session", headers={haccp_kitchen.HEADER: "x" * 43}).status_code == 401
    assert client.get("/api/haccp/cuisine/session", headers=CHEF).status_code == 400


def test_desactiver_ou_recreer_le_qr_coupe_l_ancien(kitchen):
    client = kitchen.client
    _, old = create_link(client)
    _, new = create_link(client)
    assert client.get("/api/haccp/cuisine/session", headers=old).status_code == 401
    assert client.get("/api/haccp/cuisine/session", headers=new).status_code == 200
    assert client.delete("/api/haccp/cuisine/lien", headers=CHEF).json() == {"active": False}
    assert client.get("/api/haccp/cuisine/session", headers=new).status_code == 401
    assert client.get("/api/haccp/cuisine/lien", headers=CHEF).json() == {"active": False}


def test_le_qr_suit_l_abonnement_et_les_droits_du_chef(kitchen):
    client = kitchen.client
    _, headers = create_link(client)
    kitchen.access.return_value = {"allowed": False}
    assert client.get("/api/haccp/cuisine/session", headers=headers).status_code == 402
    kitchen.access.return_value = {"allowed": True}
    kitchen.owner_scopes["chef"] = "company:ailleurs"
    assert client.get("/api/haccp/cuisine/session", headers=headers).status_code == 401
    kitchen.owner_scopes["chef"] = "user:chef"
    kitchen.db.users.docs = [{"user_id": "chef", "disabled": True}]
    assert client.get("/api/haccp/cuisine/session", headers=headers).status_code == 401


def test_les_qr_de_deux_chefs_restent_separes(kitchen):
    client = kitchen.client
    _, chef_headers = create_link(client)
    other = client.post("/api/haccp/cuisine/lien", json={"restaurant_name": "Ailleurs"},
                        headers={"x-test-user": "autre"}).json()
    other_headers = {haccp_kitchen.HEADER: other["url"].split("#k=", 1)[1]}
    assert kitchen_scan(client, chef_headers).status_code == 201
    assert client.get("/api/haccp/registre/recherche", headers=other_headers).json() == []
    assert client.get("/api/haccp/cuisine/lien", headers=CHEF).json()["restaurant_name"] == "Chez Daniel"


def test_le_serveur_reconnait_l_entete_cuisine(monkeypatch):
    import asyncio

    import server

    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    resolve = AsyncMock(return_value="user:chef")
    monkeypatch.setattr(haccp_kitchen, "resolve_kitchen", resolve)
    request = Request({"type": "http", "method": "GET", "headers": [(b"x-sirius-cuisine", b"jeton")]})
    assert asyncio.run(server._haccp_labels_scope(request)) == "user:chef"
    assert resolve.call_args.args[2] is server._haccp_user_scope

import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import access_gate
import haccp_database
import haccp_kitchen
import routers.haccp as routes
from routers.haccp_printing import make_haccp_print_router
from tests.test_haccp_labels import extracted, picture
from schemas.haccp_documents import DeliveryDocument
from schemas.haccp import PARIS
from services.haccp_manufacturer import ManufacturerInstruction, manufacturer_operation
from services.haccp_opening import fin_de_date
import routers.haccp_documents as document_routes


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
    monkeypatch.setattr(routes, "read_manufacturer_instruction", AsyncMock(return_value=ManufacturerInstruction(
        texte="Après ouverture, conserver au froid et consommer sous 48 heures.",
        conditions="conserver au froid", lecture_complete=True,
    )))
    app = FastAPI()
    app.include_router(haccp_kitchen.make_haccp_kitchen_router(scope, lambda: db), prefix="/api")
    app.include_router(routes.make_haccp_router(scope), prefix="/api")
    app.include_router(make_haccp_print_router(scope, lambda request: True), prefix="/api")
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
    assert kitchen_scan(client, headers, '{"type_operation": "ouverture", "sans_regle": true}').status_code == 422
    assert client.get("/api/haccp/registre/export-csv", headers=headers).status_code == 403
    assert client.get("/api/haccp/registre/1/etiquette", headers=headers).status_code == 403
    assert client.post("/api/haccp/impression/poste", json={}, headers=headers).status_code == 403
    assert client.post("/api/haccp/impression/prochaine", json={}, headers=headers).status_code == 403
    assert client.post("/api/haccp/impression/android/demandes", json={}, headers=headers).status_code == 403
    assert client.get("/api/haccp/cuisine/lien", headers=headers).status_code == 403
    assert client.post("/api/haccp/cuisine/lien", json={"restaurant_name": "X"}, headers=headers).status_code == 403
    assert client.delete("/api/haccp/cuisine/lien", headers=headers).status_code == 403
    assert client.get("/api/haccp/cuisine/session", headers={haccp_kitchen.HEADER: "x" * 43}).status_code == 401
    assert client.get("/api/haccp/cuisine/session", headers=CHEF).status_code == 400


RULE = {"duree_conservation_heures": 72, "justification_duree": "Notice fabricant", "regle_confirmee": True}


def test_le_qr_cuisine_cree_ouverture_et_preparation_puis_demande_l_impression(kitchen):
    client = kitchen.client
    _, headers = create_link(client)
    opened = kitchen_scan(client, headers, json.dumps({"type_operation": "ouverture", **RULE}))
    assert opened.status_code == 201, opened.text
    assert opened.json()["operateur"] == "Cuisine"
    assert opened.json()["restaurant_name"] == "Chez Daniel"
    assert opened.json()["dlc_secondaire"]
    assert opened.json()["duree_conservation_heures"] == 48

    prepared = client.post("/api/haccp/preparations", headers=headers, json={
        "capture_id": str(uuid.uuid4()), "nom_produit": "Sauce tomate", "operateur": "Pirate",
        "restaurant_name": "Autre resto",
        "date_fabrication": (datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=1)).isoformat(),
        "conditions_conservation": "0 à 3 °C, boîte fermée", **RULE,
    })
    assert prepared.status_code == 201, prepared.text
    assert prepared.json()["operateur"] == "Cuisine"
    assert prepared.json()["restaurant_name"] == "Chez Daniel"

    # Sans poste Windows associé, la demande est refusée proprement, jamais en 403.
    queued = client.post("/api/haccp/impression/demandes", headers=headers,
                         json={"label_id": opened.json()["id"], "reviewed": True})
    assert queued.status_code == 409
    state = client.get("/api/haccp/impression/etat", headers=headers)
    assert state.status_code == 200
    assert state.json() == {"station": None, "jobs": []}


@pytest.mark.parametrize("text,hours", [
    ("Après ouverture, conserver au froid et consommer sous 48 heures.", 48),
    ("Après ouverture, conserver au froid et utiliser dans les 2 jours.", 48),
    ("Une fois ouvert, conserver au froid et consommer dans un délai de 24 h.", 24),
    ("Après ouverture, conserver au froid et consommer sous 0 heures.", None),
    ("Avant ouverture, conserver au froid et consommer sous 48 heures.", None),
    ("Après ouverture, conserver au froid et consommer sous 2 ou 3 jours.", None),
    ("Après ouverture, conserver au froid et consommer sous 1,5 jours.", None),
    ("Après ouverture, conserver au froid et consommer sous 48 heures si cuit.", None),
    ("Après ouverture, conserver au froid et consommer sous 48 heures après cuisson.", None),
    ("Après ouverture, conserver au froid et consommer sous 48 heures après refroidissement.", None),
    ("Après ouverture, conserver au froid et ne pas consommer sous 48 heures.", None),
    ("Après ouverture, conserver au froid et consommer sous 24 heures ou sous 48 heures.", None),
    ("Après ouverture, conserver au froid et consommer sous au moins 48 heures.", None),
    ("Conserver au froid et consommer sous 48 heures.", None),
])
def test_duree_fabricant_explicitement_lue_sans_invention(text, hours):
    operation = manufacturer_operation(ManufacturerInstruction(
        texte=text, conditions="conserver au froid", lecture_complete=True,
    ))
    assert operation.duree_conservation_heures == hours
    assert operation.regle_confirmee == (hours is not None)


@pytest.mark.parametrize("instruction", [
    ManufacturerInstruction(),
    ManufacturerInstruction(texte="Après ouverture, consommer sous 48 heures.", lecture_complete=True),
    ManufacturerInstruction(texte="Après ouverture, conserver au froid et consommer sous 48 heures.",
                           conditions="conserver au froid", lecture_complete=False),
    ManufacturerInstruction(texte="Après ouverture, consommer sous 48 heures.",
                           conditions="conserver au froid", lecture_complete=True),
])
def test_pas_de_regle_si_lecture_ou_conditions_manquantes(instruction):
    assert not manufacturer_operation(instruction).regle_confirmee


def test_ouverture_sans_consigne_archive_sans_impression(kitchen, monkeypatch):
    monkeypatch.setattr(routes, "read_manufacturer_instruction", AsyncMock(return_value=ManufacturerInstruction()))
    _, headers = create_link(kitchen.client)
    opened = kitchen_scan(kitchen.client, headers, json.dumps({"type_operation": "ouverture", **RULE}))
    assert opened.status_code == 201
    record = opened.json()
    assert record["dlc_secondaire"] is None
    assert record["regle_confirmee"] is False
    assert "DLC non calculable" in record["commentaire_anomalie"]
    assert kitchen.client.post("/api/haccp/impression/demandes", headers=headers,
                               json={"label_id": record["id"], "reviewed": True}).status_code == 422


def test_dlc_automatique_bornee_et_reessai_sans_double_analyse(kitchen, monkeypatch):
    today = datetime.now(PARIS).date()
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(
        return_value=extracted().model_copy(update={"dlc_ou_ddm": today}),
    ))
    _, headers = create_link(kitchen.client)
    capture_id = str(uuid.uuid4())
    data = {"capture_id": capture_id, "operation": '{"type_operation":"ouverture"}'}
    first = kitchen.client.post("/api/haccp/etiquettes/scan", headers=headers, data=data,
                                files={"file": ("label.png", picture(), "image/png")})
    second = kitchen.client.post("/api/haccp/etiquettes/scan", headers=headers, data=data,
                                 files={"file": ("label.png", picture(), "image/png")})
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert datetime.fromisoformat(first.json()["dlc_secondaire"]) == fin_de_date(today)
    assert routes.read_manufacturer_instruction.await_count == 1


def test_facture_et_bl_archives_par_etablissement_sans_lot_invente(kitchen, monkeypatch, tmp_path):
    document = DeliveryDocument(
        type_document="bon_livraison", fournisseur="Fournisseur TEST", reference="BL-1",
        lignes=[{"produit": "Crème", "lot": "L1", "categorie": "Produits Laitiers"},
                {"produit": "Lait", "lot": None, "categorie": "Produits Laitiers"},
                {"produit": "Boeuf", "lot": "B1", "categorie": "Viandes"},
                {"produit": "Riz", "lot": "R1", "categorie": "Épicerie"}],
        incertitudes=["Lot du lait absent"],
    )
    reader = AsyncMock(return_value=document)
    monkeypatch.setattr(document_routes, "read_delivery_document", reader)
    client = kitchen.client
    _, headers = create_link(client)
    capture_id = str(uuid.uuid4())
    data = {"capture_id": capture_id, "restaurant_name": "Autre resto"}
    first = client.post("/api/haccp/receptions/documents", headers=headers, data=data,
                        files={"file": ("bl.png", picture(), "image/png")})
    assert first.status_code == 201, first.text
    record = first.json()
    assert record["restaurant_name"] == "Chez Daniel"
    assert record["lignes"][1]["lot"] is None
    assert [line["categorie"] for line in record["lignes"]] == [
        "Produits Laitiers", "Produits Laitiers", "Viandes", "Épicerie",
    ]
    path = tmp_path / record["chemin_photo"]
    assert path.read_bytes() == picture()
    assert "chez-daniel" in record["chemin_photo"]
    second = client.post("/api/haccp/receptions/documents", headers=headers, data=data,
                         files={"file": ("bl.png", picture(), "image/png")})
    assert second.json()["id"] == record["id"]
    assert reader.await_count == 1
    found = client.get("/api/haccp/receptions/documents?restaurant_name=Autre", headers=headers)
    assert found.status_code == 200
    assert found.json()[0]["id"] == record["id"]
    assert found.json()[0]["lignes"][2]["categorie"] == "Viandes"
    assert found.headers["cache-control"] == "private, no-store"
    assert client.get("/api/haccp/registre/recherche", headers=headers).json() == []
    dossier = client.get("/api/haccp/receptions/dossier?restaurant_name=Chez%20Daniel", headers=CHEF).json()
    assert path.name in [item["name"] for item in dossier["items"]]
    assert client.get(f"/api/haccp/receptions/documents/{record['id']}/photo", headers=headers).status_code == 200
    _, other_headers = create_link(client, "Autre établissement")
    assert client.get("/api/haccp/receptions/documents?restaurant_name=Chez%20Daniel",
                      headers=other_headers).json() == []
    assert client.get(f"/api/haccp/receptions/documents/{record['id']}/photo",
                      headers=other_headers).status_code == 404
    assert client.get(f"/api/haccp/receptions/documents/{record['id']}/photo",
                      headers={"x-test-user": "autre"}).status_code == 404
    assert client.get(f"/api/haccp/receptions/documents/{record['id']}/photo").status_code == 401
    path.write_bytes(b"corrupted")
    assert client.get(f"/api/haccp/receptions/documents/{record['id']}/photo", headers=CHEF).status_code == 503


def test_document_invalide_et_erreur_vision_explicitement_refuses(kitchen, monkeypatch):
    _, headers = create_link(kitchen.client)
    data = {"capture_id": str(uuid.uuid4())}
    bad = kitchen.client.post("/api/haccp/receptions/documents", headers=headers, data=data,
                              files={"file": ("bad.png", b"not a photo", "image/png")})
    assert bad.status_code == 400
    monkeypatch.setattr(document_routes, "read_delivery_document",
                        AsyncMock(side_effect=document_routes.VisionServiceError("Vision indisponible")))
    failed = kitchen.client.post("/api/haccp/receptions/documents", headers=headers, data=data,
                                 files={"file": ("bl.png", picture(), "image/png")})
    assert failed.status_code == 503


@pytest.mark.parametrize("kind", ["facture", "bon_livraison"])
def test_lecture_document_ne_remplace_pas_un_lot_manquant(monkeypatch, kind):
    import asyncio

    monkeypatch.setattr(document_routes, "demander_document_vision", AsyncMock(return_value={
        "type_document": kind, "reference": "F-1", "date_document": "2026-11-13",
        "lignes": [{"produit": "Crème", "lot": None}],
    }))
    result = asyncio.run(document_routes.read_delivery_document(picture(), "image/png"))
    assert result.lignes[0].lot is None
    assert any("lots" in message for message in result.incertitudes)


@pytest.mark.parametrize("bad_date", ["13/11", "2026", 1794600000])
def test_document_date_incomplete_ou_numerique_refusee(monkeypatch, bad_date):
    import asyncio

    monkeypatch.setattr(document_routes, "demander_document_vision", AsyncMock(return_value={
        "type_document": "facture", "date_document": bad_date,
    }))
    with pytest.raises(document_routes.VisionAnalysisError):
        asyncio.run(document_routes.read_delivery_document(picture(), "image/png"))


@pytest.mark.parametrize("category,expected", [
    ("Viandes", "Viandes"), ("Poissons", "Poissons"), ("Produits Laitiers", "Produits Laitiers"),
    ("Fruits & Légumes", "Fruits & Légumes"), ("Épicerie", "Épicerie"),
    ("Non classé", "Non classé"), ("Divers", "Non classé"), (None, "Non classé"),
])
def test_document_familles_canoniques_et_produits_non_classes(category, expected):
    from schemas.haccp_documents import DeliveryLine

    assert DeliveryLine(produit="Produit TEST", lot=None, categorie=category).categorie == expected


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

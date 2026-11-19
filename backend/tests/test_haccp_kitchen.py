import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import access_gate
import haccp_database
import haccp_kitchen
import routers.haccp as routes
from models.haccp import EtiquetteHaccp
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


def test_impression_mobile_qr_revue_anti_doublon_et_separation_du_relais(kitchen):
    client = kitchen.client
    _, headers = create_link(client)
    opened = kitchen_scan(client, headers, json.dumps({"type_operation": "ouverture"})).json()
    device = str(uuid.uuid4())
    body = {"label_id": opened["id"], "reviewed": True, "device_id": device}
    path = "/api/haccp/impression/mobile/demandes"
    assert client.post(path, headers=CHEF, json=body).status_code == 403
    assert client.post(path, headers=headers, json={**body, "reviewed": False}).status_code == 422
    assert client.post(path, headers=headers, json={**body, "reviewed": "true"}).status_code == 422
    prepared = client.post(path, headers=headers, json=body)
    assert prepared.status_code == 200, prepared.text
    first = prepared.json()
    assert first["job"]["status"] == "pending" and first["job"]["transport"] == "mobile"
    assert "@page{size:62mm 50mm;margin:0}" in first["html"]
    assert "Saumon" in first["html"] and "LOT-42" in first["html"]
    assert client.post(path, headers=headers, json=body).json() == first

    other_device = str(uuid.uuid4())
    other = client.post(path, headers=headers, json={**body, "device_id": other_device}).json()
    assert other["job"]["id"] == first["job"]["id"] and "html" not in other
    claim = f"{path}/{first['job']['id']}/prise"
    assert client.post(claim, headers=headers, json={"device_id": other_device}).status_code == 404

    assert client.post("/api/haccp/impression/poste", headers=CHEF, json={
        "relay_id": device, "device_name": "PC test", "width_mm": 60, "height_mm": 50,
    }).status_code == 200
    assert client.post("/api/haccp/impression/prochaine", headers=CHEF, json={"relay_id": device}).json() == {"job": None}
    taken = client.post(claim, headers=headers, json={"device_id": device}).json()
    assert taken["job"]["status"] == "uncertain" and taken["job"]["accepted_at"] is None
    assert taken["html"] == first["html"] and taken["valid_for_ms"] > 0
    assert client.post(f"/api/haccp/impression/demandes/{first['job']['id']}/confirmation", headers=CHEF, json={
        "relay_id": device, "status": "accepted",
    }).status_code == 409
    assert client.post(f"/api/haccp/impression/android/demandes/{first['job']['id']}/prise", headers=CHEF, json={
        "device_id": device,
    }).status_code == 404
    repeated = client.post(claim, headers=headers, json={"device_id": device}).json()
    assert repeated["job"] is None and repeated["state"]["status"] == "uncertain"
    assert "html" not in client.post(path, headers=headers, json=body).json()
    state = client.get("/api/haccp/impression/etat", headers=headers).json()
    assert state["jobs"][0]["transport"] == "mobile"
    existing = client.post("/api/haccp/impression/demandes", headers=headers, json={
        "label_id": opened["id"], "reviewed": True,
    }).json()
    assert existing["transport"] == "mobile" and existing["status"] == "uncertain"
    assert client.post("/api/haccp/impression/prochaine", headers=CHEF, json={"relay_id": device}).json() == {"job": None}


def test_impression_mobile_limitee_au_qr_et_a_son_etablissement(kitchen):
    client = kitchen.client
    _, headers = create_link(client, "Premier restaurant")
    opened = kitchen_scan(client, headers, json.dumps({"type_operation": "ouverture"})).json()
    device = str(uuid.uuid4())
    path = "/api/haccp/impression/mobile/demandes"
    body = {"label_id": opened["id"], "reviewed": True, "device_id": device}
    job = client.post(path, headers=headers, json=body).json()["job"]
    other_link = client.post("/api/haccp/cuisine/lien", json={"restaurant_name": "Autre chef"},
                             headers={"x-test-user": "autre"}).json()
    other = {haccp_kitchen.HEADER: other_link["url"].split("#k=", 1)[1]}
    claim = f"{path}/{job['id']}/prise"
    assert client.post(path, headers=other, json=body).status_code == 404
    assert client.post(claim, headers=other, json={"device_id": device}).status_code == 404
    _, replacement = create_link(client, "Second restaurant")
    assert client.post(claim, headers=headers, json={"device_id": device}).status_code == 401
    assert client.post(path, headers=replacement, json=body).status_code == 404
    assert client.post(claim, headers=replacement, json={"device_id": device}).status_code == 404
    assert client.get(f"/api/haccp/registre/{opened['id']}/etiquette", headers=replacement).status_code == 403


def test_impression_mobile_refuse_une_dlc_invalide_ou_devenue_depassee(kitchen, monkeypatch):
    client = kitchen.client
    _, headers = create_link(client)
    path = "/api/haccp/impression/mobile/demandes"
    device = str(uuid.uuid4())
    monkeypatch.setattr(routes, "read_manufacturer_instruction", AsyncMock(return_value=ManufacturerInstruction()))
    invalid = kitchen_scan(client, headers, json.dumps({"type_operation": "ouverture"})).json()
    assert client.post(path, headers=headers, json={
        "label_id": invalid["id"], "reviewed": True, "device_id": device,
    }).status_code == 422
    monkeypatch.setattr(routes, "read_manufacturer_instruction", AsyncMock(return_value=ManufacturerInstruction(
        texte="Après ouverture, conserver au froid et consommer sous 48 heures.",
        conditions="conserver au froid", lecture_complete=True,
    )))
    opened = kitchen_scan(client, headers, json.dumps({"type_operation": "ouverture"})).json()
    job = client.post(path, headers=headers, json={
        "label_id": opened["id"], "reviewed": True, "device_id": device,
    }).json()["job"]
    with Session(haccp_database.get_engine()) as db:
        db.get(EtiquetteHaccp, opened["id"]).dlc_secondaire = datetime(2000, 1, 1)
        db.commit()
    result = client.post(f"{path}/{job['id']}/prise", headers=headers, json={"device_id": device}).json()
    assert result["job"] is None and result["state"]["status"] == "cancelled"
    assert "html" not in result


def test_impression_mobile_echappe_le_texte_de_la_fiche(kitchen, monkeypatch):
    client = kitchen.client
    _, headers = create_link(client)
    monkeypatch.setattr(routes, "analyser_etiquette_vision", AsyncMock(return_value=extracted(
        nom_produit='<script>alert("x")</script>', numero_lot="<LOT>",
    )))
    opened = kitchen_scan(client, headers, json.dumps({"type_operation": "ouverture"})).json()
    response = client.post("/api/haccp/impression/mobile/demandes", headers=headers, json={
        "label_id": opened["id"], "reviewed": True, "device_id": str(uuid.uuid4()),
    })
    assert response.status_code == 200
    assert "<script>" not in response.json()["html"]
    assert "&lt;script&gt;" in response.json()["html"] and "&lt;LOT&gt;" in response.json()["html"]


def test_impression_mobile_une_seule_prise_concurrente(kitchen):
    from concurrent.futures import ThreadPoolExecutor

    client = kitchen.client
    _, headers = create_link(client)
    opened = kitchen_scan(client, headers, json.dumps({"type_operation": "ouverture"})).json()
    device = str(uuid.uuid4())
    path = "/api/haccp/impression/mobile/demandes"
    body = {"label_id": opened["id"], "reviewed": True, "device_id": device}
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(path, headers=headers, json=body), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    jobs = [response.json()["job"] for response in responses]
    assert jobs[0]["id"] == jobs[1]["id"]
    claim = f"{path}/{jobs[0]['id']}/prise"
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.post(claim, headers=headers, json={"device_id": device}), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert sum(response.json()["job"] is not None for response in responses) == 1


def test_liste_preparations_partagee_isolee_et_regle_confirmee(kitchen):
    client = kitchen.client
    _, headers = create_link(client)
    path = "/api/haccp/preparations/liste"
    params = {"restaurant_name": "Chez Daniel"}
    empty = {"version": 0, "noms": [], "duree_heures": None, "reference_pms": ""}
    assert client.get(path, headers=headers, params=params).json() == empty
    payload = {
        **params, "version": 0, "noms": ["Pommes caramel", "Bac inox tranche de rumsteak"],
        "duree_heures": 72, "reference_pms": "PMS en vigueur", "regle_confirmee": True,
    }
    assert client.put(path, headers=headers, json={**payload, "regle_confirmee": False}).status_code == 422
    assert client.put(path, headers=headers, json={**payload, "duree_heures": 72.0}).status_code == 422
    assert client.put(path, headers=headers, json={**payload, "noms": ["Sauce", "sauce"]}).status_code == 422
    saved = client.put(path, headers=headers, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json() == {"version": 1, "noms": payload["noms"], "duree_heures": 72, "reference_pms": "PMS en vigueur"}
    assert client.get(path, headers=CHEF, params=params).json() == saved.json()
    assert client.get(path, headers=headers, params={"restaurant_name": "Ailleurs"}).status_code == 403
    assert client.put(path, headers=headers, json={**payload, "restaurant_name": "Ailleurs"}).status_code == 403
    other_link = client.post("/api/haccp/cuisine/lien", json=params, headers={"x-test-user": "autre"}).json()
    other = {haccp_kitchen.HEADER: other_link["url"].split("#k=", 1)[1]}
    assert client.get(path, headers=other, params=params).json() == empty
    assert client.put(path, headers=headers, json=payload).status_code == 409
    _, replacement = create_link(client, "Autre restaurant")
    assert client.get(path, headers=headers, params=params).status_code == 401
    assert client.get(path, headers=replacement, params={"restaurant_name": "Autre restaurant"}).json() == empty


def test_liste_preparations_ne_perd_pas_une_modification_concurrente(kitchen):
    from concurrent.futures import ThreadPoolExecutor

    client = kitchen.client
    _, headers = create_link(client)
    path = "/api/haccp/preparations/liste"
    payload = {
        "restaurant_name": "Chez Daniel", "version": 0, "noms": ["Soupe"],
        "duree_heures": 72, "reference_pms": "PMS en vigueur", "regle_confirmee": True,
    }
    assert client.put(path, headers=headers, json=payload).status_code == 200
    def modify(name):
        return client.put(path, headers=headers, json={**payload, "version": 1, "noms": ["Soupe", name]})
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(modify, ("Sauce", "Salade")))
    assert sorted(response.status_code for response in responses) == [200, 409]
    saved = client.get(path, headers=headers, params={"restaurant_name": "Chez Daniel"}).json()
    assert saved["version"] == 2 and saved["noms"] in (["Soupe", "Sauce"], ["Soupe", "Salade"])


def test_preparation_refuse_une_liste_perimee_mais_retrouve_sa_capture(kitchen):
    client = kitchen.client
    _, headers = create_link(client)
    path = "/api/haccp/preparations/liste"
    saved_list = {
        "restaurant_name": "Chez Daniel", "version": 0, "noms": ["Soupe"],
        "duree_heures": 72, "reference_pms": "PMS en vigueur", "regle_confirmee": True,
    }
    assert client.put(path, headers=headers, json=saved_list).status_code == 200
    fabrication = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=1)
    preparation = {
        "capture_id": str(uuid.uuid4()), "nom_produit": "Soupe", "operateur": "Cuisine",
        "restaurant_name": "Chez Daniel", "date_fabrication": fabrication.isoformat(),
        "duree_conservation_heures": 72, "conditions_conservation": "Voir le PMS",
        "justification_duree": "PMS en vigueur", "regle_confirmee": True, "liste_version": 1,
    }
    first = client.post("/api/haccp/preparations", headers=headers, json=preparation)
    assert first.status_code == 201, first.text
    assert datetime.fromisoformat(first.json()["dlc_secondaire"].replace("Z", "+00:00")) == fabrication + timedelta(hours=72)
    assert client.put(path, headers=headers, json={**saved_list, "version": 1, "duree_heures": 24}).status_code == 200
    retry = client.post("/api/haccp/preparations", headers=headers, json=preparation)
    assert retry.status_code == 201 and retry.json()["id"] == first.json()["id"]
    stale = client.post("/api/haccp/preparations", headers=headers, json={**preparation, "capture_id": str(uuid.uuid4())})
    assert stale.status_code == 412
    wrong_rule = client.post("/api/haccp/preparations", headers=headers, json={
        **preparation, "capture_id": str(uuid.uuid4()), "liste_version": 2,
    })
    assert wrong_rule.status_code == 412


def test_preparation_verrouille_la_regle_pendant_son_enregistrement(kitchen, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import sqlite3
    from threading import Event

    client = kitchen.client
    _, headers = create_link(client)
    path = "/api/haccp/preparations/liste"
    saved_list = {
        "restaurant_name": "Chez Daniel", "version": 0, "noms": ["Soupe"],
        "duree_heures": 72, "reference_pms": "PMS en vigueur", "regle_confirmee": True,
    }
    assert client.put(path, headers=headers, json=saved_list).status_code == 200
    fabrication = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=1)
    body = {
        "capture_id": str(uuid.uuid4()), "nom_produit": "Soupe", "operateur": "Cuisine",
        "restaurant_name": "Chez Daniel", "date_fabrication": fabrication.isoformat(),
        "duree_conservation_heures": 72, "conditions_conservation": "Voir le PMS",
        "justification_duree": "PMS en vigueur", "regle_confirmee": True, "liste_version": 1,
    }
    locked, release = Event(), Event()
    original = routes._save_record
    def wait_before_save(*args, **kwargs):
        locked.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(routes, "_save_record", wait_before_save)
    with ThreadPoolExecutor(max_workers=1) as pool:
        preparation = pool.submit(client.post, "/api/haccp/preparations", headers=headers, json=body)
        assert locked.wait(5)
        try:
            with sqlite3.connect(haccp_database.get_engine().url.database, timeout=0) as connection:
                with pytest.raises(sqlite3.OperationalError, match="locked"):
                    connection.execute("UPDATE haccp_preparation_lists SET duree_heures = 24")
        finally:
            release.set()
        assert preparation.result(timeout=10).status_code == 201
    assert client.put(path, headers=headers, json={**saved_list, "version": 1, "duree_heures": 24}).status_code == 200


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

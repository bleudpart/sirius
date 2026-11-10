import asyncio
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import cloud_link
import access_gate
import haccp_database
import haccp_kitchen
import routers.haccp_releves as releves
from docx import Document
from local_docstore import DatabaseRouter, LocalDocStore
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpRelevePrintJob, HaccpRelevePrintStation
from schemas.haccp import EtiquetteVisionOutput
from services.haccp_word import print_haccp_document
from test_haccp_word import signature


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    haccp_database._configured_engine.cache_clear()
    store = DatabaseRouter(LocalDocStore(tmp_path / "documents.sqlite3"))
    asyncio.run(store.users.insert_one({"user_id": "one"}))
    monkeypatch.setattr(access_gate, "access_status", AsyncMock(return_value={"allowed": True}))

    async def owner_scope(user):
        return "user:" + user["user_id"]

    async def scope(request: Request) -> str:
        if haccp_kitchen.kitchen_token(request) is not None:
            return await haccp_kitchen.resolve_kitchen(request, store, owner_scope)
        user = request.headers.get("x-test-user")
        if not user:
            raise HTTPException(401, "Connexion requise.")
        request.state.haccp_actor = user
        if request.headers.get("x-test-kitchen"):
            request.state.haccp_kitchen = {"restaurant_name": "Cuisine"}
        company = request.headers.get("x-test-company")
        return f"company:{company}" if company else f"user:{user}"

    app = FastAPI()
    app.include_router(haccp_kitchen.make_haccp_kitchen_router(scope, lambda: store), prefix="/api")
    app.include_router(
        releves.make_haccp_releves_router(store, scope, lambda request: request.headers.get("x-local") == "yes"),
        prefix="/api",
    )
    with TestClient(app) as client:
        yield client, store, tmp_path
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()


def headers(user="one", **values):
    return {"x-test-user": user, **values} if user else values


def body(kind="temperature", **changes):
    fields = {
        "temperature": {
            "usage": "Enceinte froide", "equipement": "Frigo", "date_heure": "2026-11-10T09:00",
            "temperature": "3,2", "consigne": "0 à 4 °C", "action": "",
        },
        "reception": {
            "date_heure": "2026-11-10T09:00", "fournisseur": "Fournisseur",
            "produit": "Poulet", "lot": "L1", "temperature": "3",
            "date_limite": "2026-11-14", "emballage": "Intact", "action": "",
        },
        "huile": {
            "date_heure": "2026-11-10T09:00", "friteuse": "Friteuse 1",
            "methode": "Testeur", "polaires": "18.5", "bandelette": "",
            "renouvellement": "Non", "action": "",
        },
        "refroidissement": {
            "produit": "Plat", "lot": "L2", "debut": "2026-11-10T09:00",
            "temperature_debut": "63", "fin": "2026-11-10T10:00",
            "temperature_fin": "10", "controle": "À vérifier", "action": "",
        },
        "remise": {
            "produit": "Plat", "lot": "L2", "debut": "2026-11-10T09:00",
            "temperature_debut": "10", "fin": "2026-11-10T10:00",
            "temperature_fin": "63", "controle": "Conforme", "action": "",
        },
        "nettoyage": {
            "date_heure": "2026-11-10T09:00", "zone": "Cuisine", "surface": "Plan",
            "produit": "Détergent", "frequence": "Chaque service",
            "controle": "Satisfaisant", "action": "",
        },
    }
    return {
        "capture_id": str(uuid.uuid4()), "type_releve": kind, "etablissement": "Cuisine",
        "operateur": "Alex", "champs": fields[kind], "signature_image": signature(), **changes,
    }


def save(client, payload, user="one", **extra_headers):
    return client.post("/api/haccp/releves", json=payload, headers=headers(user, **extra_headers))


def create_photo(tmp_path, scope="user:one", path="uploads/restaurant/label.jpg"):
    file = tmp_path / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(b"photo archived")
    with Session(haccp_database.get_engine()) as session:
        row = EtiquetteHaccp(
            **EtiquetteVisionOutput(nom_produit="Poulet", numero_lot="L1", type_date="DLC").model_dump(),
            scope_key=scope, image_path=path, type_operation="reception",
        )
        session.add(row)
        session.commit()
        return row.id


def test_authenticated_forms_and_signed_records_are_isolated_and_idempotent(api):
    client, store, _ = api
    assert client.get("/api/haccp/releves/modeles").status_code == 401
    models = client.get("/api/haccp/releves/modeles", headers=headers()).json()["modeles"]
    assert {item["id"] for item in models} == {
        "temperature", "reception", "huile", "refroidissement", "remise", "tracabilite", "nettoyage",
    }
    payload = body()
    first = save(client, payload)
    assert first.status_code == 200, first.text
    record = first.json()["releve"]
    assert record["id"] == payload["capture_id"]
    assert "signature_image" not in record and "user_id" not in record
    assert save(client, payload).json()["releve"]["id"] == record["id"]
    changed = {**payload, "operateur": "Autre"}
    assert save(client, changed).status_code == 409
    assert len(client.get("/api/haccp/releves", headers=headers()).json()["items"]) == 1
    assert client.get("/api/haccp/releves", headers=headers("two")).json()["items"] == []
    assert client.get(f"/api/haccp/releves/{record['id']}", headers=headers("two")).status_code == 404
    detail = client.get(f"/api/haccp/releves/{record['id']}", headers=headers()).json()["releve"]
    assert detail["signature_image"] == payload["signature_image"]
    assert detail["champs"]["temperature"] == "3,2"


@pytest.mark.parametrize("kind", ["temperature", "reception", "huile", "refroidissement", "remise", "nettoyage"])
def test_requested_form_types_accept_signed_data(api, kind):
    client, _, _ = api
    response = save(client, body(kind))
    assert response.status_code == 200, response.text
    assert response.json()["releve"]["type_releve"] == kind


@pytest.mark.parametrize("change", [
    {"signature_image": ""},
    {"signature_image": signature(blank=True)},
    {"champs": {"usage": "Enceinte froide"}},
    {"champs": {**body()["champs"], "temperature": "NaN"}},
    {"champs": {**body()["champs"], "temperature": "9999"}},
    {"champs": {**body()["champs"], "autre": "inattendu"}},
])
def test_invalid_records_are_rejected_without_being_saved(api, change):
    client, _, _ = api
    assert save(client, body(**change)).status_code == 422
    assert client.get("/api/haccp/releves", headers=headers()).json()["items"] == []


def test_oil_method_and_chronology_are_checked_without_guessing_conformity(api):
    client, _, _ = api
    oil = body("huile")
    oil["champs"].update({"methode": "Bandelette", "polaires": "", "bandelette": "Zone orange"})
    assert save(client, oil).status_code == 200
    oil["capture_id"] = str(uuid.uuid4())
    oil["champs"]["bandelette"] = ""
    assert save(client, oil).status_code == 422
    cooling = body("refroidissement")
    cooling["champs"]["fin"] = "2026-11-10T08:00"
    assert save(client, cooling).status_code == 422


def test_traceability_requires_an_archived_photo_in_the_same_scope(api):
    client, _, tmp_path = api
    label_id = create_photo(tmp_path)
    payload = {
        "capture_id": str(uuid.uuid4()), "type_releve": "tracabilite", "etablissement": "Cuisine",
        "operateur": "Alex", "signature_image": signature(),
        "champs": {
            "etiquette_id": str(label_id), "produit": "Poulet", "lot": "L1",
            "ouverture": "2026-11-10T09:00", "dlc_origine": "2026-11-14",
            "dlc_secondaire": "2026-11-12T09:00", "conservation": "Au froid",
        },
    }
    assert save(client, payload, user="two").status_code == 422
    response = save(client, payload)
    assert response.status_code == 200, response.text
    assert response.json()["releve"]["champs"]["etiquette_id"] == str(label_id)
    (tmp_path / "uploads" / "restaurant" / "label.jpg").unlink()
    payload["capture_id"] = str(uuid.uuid4())
    assert save(client, payload).status_code == 422


def test_kitchen_qr_can_only_access_the_new_narrow_routes(api):
    client, _, _ = api
    allowed = lambda method, path: any(method == verb and pattern.match(path) for verb, pattern in haccp_kitchen._ALLOWED)
    identity = str(uuid.uuid4())
    assert allowed("GET", "/api/haccp/releves/modeles")
    assert allowed("POST", "/api/haccp/releves")
    assert allowed("POST", f"/api/haccp/releves/{identity}/impression")
    assert allowed("GET", f"/api/haccp/releves/impression/{identity}")
    assert not allowed("POST", "/api/haccp/releves/impression/poste")
    assert not allowed("POST", "/api/haccp/releves/impression/traiter")
    assert not allowed("DELETE", f"/api/haccp/releves/{identity}")
    assert save(client, body(), **{"x-test-kitchen": "yes"}).status_code == 200
    assert save(client, body(etablissement="Autre"), **{"x-test-kitchen": "yes"}).status_code == 422


def test_print_queue_is_scoped_claimed_once_and_never_automatically_reprinted(api):
    client, _, _ = api
    record_id = save(client, body()).json()["releve"]["id"]
    relay, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    prefix = "/api/haccp/releves"
    assert client.post(f"{prefix}/{record_id}/impression", json={"id": job_id}, headers=headers()).status_code == 409
    assert client.post(f"{prefix}/impression/poste", json={"relay_id": relay}, headers=headers()).status_code == 200
    queued = client.post(f"{prefix}/{record_id}/impression", json={"id": job_id}, headers=headers())
    assert queued.status_code == 200 and queued.json()["status"] == "pending"
    assert client.post(f"{prefix}/{record_id}/impression", json={"id": job_id}, headers=headers()).json() == queued.json()
    claim = client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers()).json()["job"]
    assert claim["id"] == job_id and claim["releve"]["signature_image"].startswith("data:image/png;base64,")
    assert client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers()).json()["job"] is None
    confirmation = client.post(f"{prefix}/impression/{job_id}/confirmation", json={
        "relay_id": relay, "status": "accepted",
    }, headers=headers())
    assert confirmation.json()["status"] == "accepted"
    assert "vérifiez" in confirmation.json()["detail"]
    assert client.get(f"{prefix}/impression/{job_id}", headers=headers("two")).status_code == 404


def test_print_claim_timeout_stays_uncertain_and_tampering_cancels(api):
    client, store, _ = api
    record_id = save(client, body()).json()["releve"]["id"]
    relay, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    prefix = "/api/haccp/releves"
    client.post(f"{prefix}/impression/poste", json={"relay_id": relay}, headers=headers())
    client.post(f"{prefix}/{record_id}/impression", json={"id": job_id}, headers=headers())
    client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers())
    with Session(haccp_database.get_engine()) as session:
        session.get(HaccpRelevePrintJob, job_id).claimed_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=3)
        session.commit()
    assert client.get(f"{prefix}/impression/{job_id}", headers=headers()).json()["status"] == "uncertain"
    assert client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers()).json()["job"] is None
    assert client.post(f"{prefix}/impression/{job_id}/confirmation", json={
        "relay_id": relay, "status": "accepted",
    }, headers=headers()).json()["status"] == "uncertain"


def test_windows_worker_prints_once_and_reports_failure_as_uncertain(api, monkeypatch):
    client, _, _ = api
    monkeypatch.setattr(cloud_link, "relay_allowed", lambda: True)
    monkeypatch.setattr(cloud_link, "linked", lambda: True)
    monkeypatch.setattr(releves, "os", SimpleNamespace(name="nt"))
    job_id, relay = str(uuid.uuid4()), str(uuid.uuid4())
    cloud = AsyncMock(side_effect=[
        httpx.Response(200, json={"configured": True}),
        httpx.Response(200, json={"job": {"id": job_id, "releve": {"titre": "Test"}}}),
        httpx.Response(200, json={"id": job_id, "status": "accepted"}),
    ])
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", cloud)
    printer = lambda record, job: None
    monkeypatch.setattr(releves, "print_haccp_document", printer)
    response = client.post("/api/haccp/releves/impression/traiter", json={"relay_id": relay}, headers=headers(**{"x-local": "yes"}))
    assert response.status_code == 200, response.text
    assert response.json()["job"]["status"] == "accepted"
    assert cloud.await_args_list[2].kwargs["json"]["status"] == "accepted"

    cloud.side_effect = [
        httpx.Response(200, json={"configured": True}),
        httpx.Response(200, json={"job": {"id": job_id, "releve": {"titre": "Test"}}}),
        httpx.Response(200, json={"id": job_id, "status": "uncertain"}),
    ]

    def fail(_record, _job):
        raise OSError("Impression indisponible")

    monkeypatch.setattr(releves, "print_haccp_document", fail)
    response = client.post("/api/haccp/releves/impression/traiter", json={"relay_id": relay}, headers=headers(**{"x-local": "yes"}))
    assert response.status_code == 502
    assert cloud.await_args_list[-1].kwargs["json"]["status"] == "uncertain"


def test_real_kitchen_qr_can_record_but_cannot_manage_the_station(api):
    client, _, _ = api
    link = client.post("/api/haccp/cuisine/lien", json={"restaurant_name": "Cuisine"}, headers=headers()).json()
    qr = {haccp_kitchen.HEADER: link["url"].split("#k=", 1)[1]}
    assert client.get("/api/haccp/releves/modeles", headers=qr).status_code == 200
    payload = body()
    created = client.post("/api/haccp/releves", json=payload, headers=qr)
    assert created.status_code == 200, created.text
    assert created.json()["releve"]["source"] == "qr_cuisine"
    assert client.get("/api/haccp/releves", headers=qr).json()["items"][0]["id"] == payload["capture_id"]
    assert client.post("/api/haccp/releves", json={**body(), "etablissement": "Autre"}, headers=qr).status_code == 422
    assert client.post("/api/haccp/releves/impression/poste", json={"relay_id": str(uuid.uuid4())}, headers=qr).status_code == 403
    assert client.post("/api/haccp/releves/impression/prochaine", json={"relay_id": str(uuid.uuid4())}, headers=qr).status_code == 403
    client.delete("/api/haccp/cuisine/lien", headers=headers())
    assert client.get("/api/haccp/releves", headers=qr).status_code == 401


def test_kitchen_qr_only_reads_its_establishment_and_cannot_print_other_records(api):
    client, _, _ = api
    other = save(client, body(etablissement="Autre")).json()["releve"]["id"]
    own = save(client, body()).json()["releve"]["id"]
    qr = headers(**{"x-test-kitchen": "yes"})
    assert [row["id"] for row in client.get("/api/haccp/releves", headers=qr).json()["items"]] == [own]
    assert client.get(f"/api/haccp/releves/{other}", headers=qr).status_code == 404
    assert client.get(f"/api/haccp/releves/{other}/impression", headers=qr).status_code == 404
    assert client.post(f"/api/haccp/releves/{other}/impression", json={"id": str(uuid.uuid4())}, headers=qr).status_code == 404


def test_company_records_are_shared_only_with_the_same_company(api):
    client, _, _ = api
    company = {"x-test-company": "company-a"}
    created = save(client, body(), user="one", **company)
    record_id = created.json()["releve"]["id"]
    assert client.get(f"/api/haccp/releves/{record_id}", headers=headers("two", **company)).status_code == 200
    assert client.get(f"/api/haccp/releves/{record_id}", headers=headers("two", **{"x-test-company": "company-b"})).status_code == 404
    assert client.get(f"/api/haccp/releves/{record_id}", headers=headers("one")).status_code == 404


def test_tampered_signed_snapshot_cannot_be_read_retried_or_printed(api):
    client, store, _ = api
    payload = body()
    record_id = save(client, payload).json()["releve"]["id"]
    asyncio.run(store.haccp_sheets.update_one({"id": record_id}, {"$set": {"titre": "Modifié"}}))
    assert client.get(f"/api/haccp/releves/{record_id}", headers=headers()).status_code == 409
    assert save(client, payload).status_code == 409
    assert client.post(f"/api/haccp/releves/{record_id}/impression", json={"id": str(uuid.uuid4())}, headers=headers()).status_code == 409


def test_photo_must_belong_to_establishment_and_allowed_storage(api):
    client, _, tmp_path = api
    label_id = create_photo(tmp_path)
    payload = body("reception")
    payload["champs"]["etiquette_id"] = str(label_id)
    with Session(haccp_database.get_engine()) as session:
        row = session.get(EtiquetteHaccp, label_id)
        row.restaurant_name = "Autre"
        session.commit()
    assert save(client, payload).status_code == 422
    outside = tmp_path.parent / f"{tmp_path.name}-outside.jpg"
    outside.write_bytes(b"photo")
    with Session(haccp_database.get_engine()) as session:
        row = session.get(EtiquetteHaccp, label_id)
        row.restaurant_name = "Cuisine"
        row.image_path = f"../{outside.name}"
        session.commit()
    assert save(client, payload).status_code == 422


def test_concurrent_print_requests_share_one_active_job(api):
    client, _, _ = api
    record_id = save(client, body()).json()["releve"]["id"]
    relay = str(uuid.uuid4())
    assert client.post("/api/haccp/releves/impression/poste", json={"relay_id": relay}, headers=headers()).status_code == 200
    barrier = Barrier(8)

    def enqueue(_):
        barrier.wait()
        return client.post(f"/api/haccp/releves/{record_id}/impression", json={"id": str(uuid.uuid4())}, headers=headers())

    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(enqueue, range(8)))
    assert [response.status_code for response in responses] == [200] * 8
    assert len({response.json()["id"] for response in responses}) == 1
    with Session(haccp_database.get_engine()) as session:
        jobs = session.query(HaccpRelevePrintJob).filter_by(releve_id=record_id).all()
        assert len(jobs) == 1


def test_concurrent_record_retries_do_not_create_duplicates(api):
    client, _, _ = api
    payload = body()
    barrier = Barrier(6)

    def submit(_):
        barrier.wait()
        return save(client, payload)

    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(submit, range(6)))
    assert [response.status_code for response in responses] == [200] * 6
    assert {response.json()["releve"]["id"] for response in responses} == {payload["capture_id"]}
    assert len(client.get("/api/haccp/releves", headers=headers()).json()["items"]) == 1


def test_print_index_is_added_to_an_existing_database(api):
    engine = haccp_database.get_engine()
    with engine.begin() as connection:
        connection.exec_driver_sql("DROP INDEX uq_haccp_releve_print_active")
    engine.dispose()
    haccp_database._configured_engine.cache_clear()
    with haccp_database.get_engine().connect() as connection:
        indexes = connection.exec_driver_sql("PRAGMA index_list('haccp_releve_print_jobs')").fetchall()
    assert any(row[1] == "uq_haccp_releve_print_active" and row[2] == 1 for row in indexes)


def test_only_pending_prints_can_be_cancelled_idempotently(api):
    client, _, _ = api
    prefix = "/api/haccp/releves"
    record_id = save(client, body()).json()["releve"]["id"]
    relay, first_id, second_id = (str(uuid.uuid4()) for _ in range(3))
    client.post(f"{prefix}/impression/poste", json={"relay_id": relay}, headers=headers())
    client.post(f"{prefix}/{record_id}/impression", json={"id": first_id}, headers=headers())
    qr = headers(**{"x-test-kitchen": "yes"})
    assert client.post(f"{prefix}/impression/{first_id}/annulation", headers=headers("two")).status_code == 404
    cancelled = client.post(f"{prefix}/impression/{first_id}/annulation", headers=qr)
    assert cancelled.json()["status"] == "cancelled"
    assert client.post(f"{prefix}/impression/{first_id}/annulation", headers=qr).json()["status"] == "cancelled"
    assert client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers()).json()["job"] is None
    client.post(f"{prefix}/{record_id}/impression", json={"id": second_id, "previous_job_id": first_id}, headers=headers())
    assert client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers()).json()["job"]["id"] == second_id
    refused = client.post(f"{prefix}/impression/{second_id}/annulation", headers=qr)
    assert refused.status_code == 409 and "Vérifiez" in refused.json()["detail"]


def test_record_to_word_queue_workflow_without_a_physical_printer(api):
    client, _, tmp_path = api
    prefix = "/api/haccp/releves"
    record_id = save(client, body()).json()["releve"]["id"]
    relay, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    client.post(f"{prefix}/impression/poste", json={"relay_id": relay}, headers=headers())
    assert client.post(f"{prefix}/{record_id}/impression", json={"id": job_id}, headers=headers()).json()["status"] == "pending"
    job = client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers()).json()["job"]
    sent = []
    output = print_haccp_document(
        job["releve"], uuid.UUID(job["id"]), export_directory=tmp_path / "exports",
        startfile=lambda path, operation: sent.append((path, operation)),
    )
    document = Document(output)
    assert len(document.inline_shapes) == 1
    assert ["Température relevée (°C)", "3,2"] in [[cell.text for cell in row.cells] for row in document.tables[0].rows]
    assert sent == [(str(output), "print")]
    confirmation = client.post(f"{prefix}/impression/{job_id}/confirmation", json={
        "relay_id": relay, "status": "accepted",
    }, headers=headers())
    assert "vérifiez la sortie papier" in confirmation.json()["detail"]
    assert client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers()).json()["job"] is None


def test_stale_reprint_requests_cannot_create_an_extra_job(api):
    client, _, _ = api
    prefix = "/api/haccp/releves"
    record_id = save(client, body()).json()["releve"]["id"]
    relay, first_id, second_id = (str(uuid.uuid4()) for _ in range(3))
    client.post(f"{prefix}/impression/poste", json={"relay_id": relay}, headers=headers())
    client.post(f"{prefix}/{record_id}/impression", json={"id": first_id}, headers=headers())
    client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers())
    client.post(f"{prefix}/impression/{first_id}/confirmation", json={"relay_id": relay, "status": "accepted"}, headers=headers())
    stale = client.post(f"{prefix}/{record_id}/impression", json={"id": str(uuid.uuid4())}, headers=headers()).json()
    assert stale["id"] == first_id and stale["status"] == "accepted"
    second_body = {"id": second_id, "previous_job_id": first_id}
    second = client.post(f"{prefix}/{record_id}/impression", json=second_body, headers=headers()).json()
    assert second["id"] == second_id and second["status"] == "pending"
    client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers())
    client.post(f"{prefix}/impression/{second_id}/confirmation", json={"relay_id": relay, "status": "accepted"}, headers=headers())
    assert client.post(f"{prefix}/{record_id}/impression", json=second_body, headers=headers()).json()["id"] == second_id
    stale_after_completion = client.post(f"{prefix}/{record_id}/impression", json={
        "id": str(uuid.uuid4()), "previous_job_id": first_id,
    }, headers=headers()).json()
    assert stale_after_completion["id"] == second_id and stale_after_completion["status"] == "accepted"
    with Session(haccp_database.get_engine()) as session:
        assert len(session.query(HaccpRelevePrintJob).filter_by(releve_id=record_id).all()) == 2


def test_print_queue_waits_for_sqlite_without_blocking_the_event_loop(api):
    client, _, tmp_path = api
    prefix = "/api/haccp/releves"
    record_id = save(client, body()).json()["releve"]["id"]
    relay = str(uuid.uuid4())
    assert client.post(f"{prefix}/impression/poste", json={"relay_id": relay}, headers=headers()).status_code == 200

    async def request_while_locked():
        with sqlite3.connect(tmp_path / "haccp.sqlite3") as connection:
            connection.execute("BEGIN IMMEDIATE")
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://test") as async_client:
                task = asyncio.create_task(async_client.post(
                    f"{prefix}/{record_id}/impression", json={"id": str(uuid.uuid4())}, headers=headers(),
                ))
                await asyncio.sleep(0.2)
                assert not task.done()
                connection.rollback()
                response = await asyncio.wait_for(task, timeout=5)
                assert response.status_code == 200

    asyncio.run(request_while_locked())


def test_cancellation_and_claim_cannot_both_succeed(api):
    client, _, _ = api
    prefix = "/api/haccp/releves"
    record_id = save(client, body()).json()["releve"]["id"]
    relay, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    client.post(f"{prefix}/impression/poste", json={"relay_id": relay}, headers=headers())
    client.post(f"{prefix}/{record_id}/impression", json={"id": job_id}, headers=headers())
    barrier = Barrier(2)

    def cancel():
        barrier.wait()
        return client.post(f"{prefix}/impression/{job_id}/annulation", headers=headers())

    def claim():
        barrier.wait()
        return client.post(f"{prefix}/impression/prochaine", json={"relay_id": relay}, headers=headers())

    with ThreadPoolExecutor(max_workers=2) as pool:
        cancelled, claimed = pool.submit(cancel), pool.submit(claim)
        cancelled, claimed = cancelled.result(), claimed.result()
    assert claimed.status_code == 200
    if cancelled.status_code == 200:
        assert cancelled.json()["status"] == "cancelled" and claimed.json()["job"] is None
    else:
        assert cancelled.status_code == 409 and claimed.json()["job"]["id"] == job_id


def test_worker_blocks_non_windows_and_lost_ack_never_reprints(api, monkeypatch):
    client, _, _ = api
    relay = str(uuid.uuid4())
    monkeypatch.setattr(releves, "os", SimpleNamespace(name="posix"))
    assert client.post("/api/haccp/releves/impression/traiter", json={"relay_id": relay}, headers=headers(**{"x-local": "yes"})).status_code == 403

    monkeypatch.setattr(releves, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(cloud_link, "relay_allowed", lambda: True)
    monkeypatch.setattr(cloud_link, "linked", lambda: True)
    job_id = str(uuid.uuid4())
    cloud = AsyncMock(side_effect=[
        httpx.Response(200, json={"configured": True}),
        httpx.Response(200, json={"job": {"id": job_id, "releve": {"titre": "Test"}}}),
        HTTPException(503, "Connexion perdue"),
        httpx.Response(200, json={"configured": True}),
        httpx.Response(200, json={"job": None}),
    ])
    monkeypatch.setattr(cloud_link, "relay_haccp_registry", cloud)
    calls = []
    monkeypatch.setattr(releves, "print_haccp_document", lambda record, job: calls.append(job))
    endpoint = "/api/haccp/releves/impression/traiter"
    first = client.post(endpoint, json={"relay_id": relay}, headers=headers(**{"x-local": "yes"}))
    assert first.status_code == 502 and "confirmation perdue" in first.json()["detail"]
    assert client.post(endpoint, json={"relay_id": relay}, headers=headers(**{"x-local": "yes"})).status_code == 200
    assert calls == [uuid.UUID(job_id)]

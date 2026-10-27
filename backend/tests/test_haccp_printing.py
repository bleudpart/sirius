import asyncio
import json
import uuid
from datetime import datetime, timedelta
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

import cloud_link
import haccp_database
from models.haccp import EtiquetteHaccp
from models.haccp_printing import HaccpPrintJob, HaccpPrintStation
from routers.haccp_printing import make_haccp_print_router
from schemas.haccp import EtiquetteVisionOutput


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "0")
    haccp_database._configured_engine.cache_clear()

    async def scope(request: Request) -> str:
        user = request.headers.get("x-test-user")
        if not user:
            raise HTTPException(401, "Connexion requise.")
        return "user:" + user

    app = FastAPI()
    app.include_router(make_haccp_print_router(scope, lambda request: request.headers.get("x-local") == "yes"), prefix="/api")
    with Session(haccp_database.get_engine()) as db:
        row = EtiquetteHaccp(
            **EtiquetteVisionOutput(nom_produit="Saumon", numero_lot="LOT42", dlc_ou_ddm="2099-12-31", type_date="DLC").model_dump(),
            scope_key="user:one", image_path="unused",
            type_operation="ouverture", date_ouverture=datetime.utcnow(),
            dlc_secondaire=datetime.utcnow() + timedelta(hours=24),
            duree_conservation_heures=24, justification_duree="PMS relu", regle_confirmee=True,
        )
        db.add(row); db.commit()
        label_id = row.id
    with TestClient(app) as client:
        yield client, label_id
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()


def request(client, path, body=None, user="one", local=False):
    headers = {"x-test-user": user} if user else {}
    if local:
        headers["x-local"] = "yes"
    url = "/api/haccp/impression" + path
    return client.post(url, json=body, headers=headers) if body is not None else client.get(url, headers=headers)


def configure(client):
    relay = str(uuid.uuid4())
    response = request(client, "/poste", {
        "relay_id": relay, "device_name": "USB test", "width_mm": 60, "height_mm": 50,
    })
    assert response.status_code == 200, response.text
    return relay


def queue(client, label_id):
    return request(client, "/demandes", {"label_id": label_id, "reviewed": True})


def test_full_flow_is_durable_and_claim_is_never_delivered_twice(api):
    client, label_id = api
    relay = configure(client)
    assert request(client, "/etat").json()["station"]["online"]
    response = queue(client, label_id)
    assert response.status_code == 200, response.text
    job = response.json()
    assert queue(client, label_id).json()["id"] == job["id"]
    claimed = request(client, "/prochaine", {"relay_id": relay}).json()["job"]
    assert claimed["id"] == job["id"]
    assert claimed["widthMm"] == 60 and claimed["heightMm"] == 50
    assert "ΣIRIUS" in claimed["html"] and "<article>" in claimed["html"]
    assert "<!doctype" not in claimed["html"] and "<html" not in claimed["html"]
    assert request(client, "/prochaine", {"relay_id": relay}).json() == {"job": None}
    confirmed = request(client, f"/demandes/{job['id']}/confirmation", {
        "relay_id": relay, "status": "accepted",
    })
    assert confirmed.status_code == 200
    assert confirmed.json()["status"] == "accepted"
    assert "papier" in confirmed.json()["detail"]
    haccp_database.get_engine().dispose()
    haccp_database._configured_engine.cache_clear()
    assert queue(client, label_id).json()["status"] == "accepted"
    assert request(client, "/prochaine", {"relay_id": relay}).json()["job"] is None


def test_authentication_scope_and_station_identity(api):
    client, label_id = api
    relay = configure(client)
    job = queue(client, label_id).json()
    assert request(client, "/etat", user=None).status_code == 401
    assert request(client, "/etat", user="two").json()["jobs"] == []
    assert request(client, "/demandes", {"label_id": label_id, "reviewed": True}, user="two").status_code == 404
    assert request(client, "/prochaine", {"relay_id": str(uuid.uuid4())}).status_code == 409
    assert request(client, f"/demandes/{job['id']}/confirmation", {
        "relay_id": relay, "status": "accepted",
    }, user="two").status_code == 409
    assert request(client, "/poste", {
        "relay_id": str(uuid.uuid4()), "device_name": "New", "width_mm": 60, "height_mm": 50,
    }).status_code == 409


def test_review_offline_and_invalid_labels_are_explicit(api):
    client, label_id = api
    assert queue(client, label_id).status_code == 409
    relay = configure(client)
    assert request(client, "/demandes", {"label_id": label_id, "reviewed": False}).status_code == 422
    assert request(client, "/demandes", {"label_id": label_id, "reviewed": "true"}).status_code == 422
    with Session(haccp_database.get_engine()) as db:
        db.get(HaccpPrintStation, "user:one").last_seen = datetime.utcnow() - timedelta(minutes=5)
        db.commit()
    assert queue(client, label_id).status_code == 409
    request(client, "/prochaine", {"relay_id": relay})
    with Session(haccp_database.get_engine()) as db:
        db.get(EtiquetteHaccp, label_id).conforme_reception = False
        db.commit()
    assert queue(client, label_id).status_code == 422


def test_expired_job_is_cancelled_at_claim_and_never_printed(api):
    client, label_id = api
    relay = configure(client)
    job = queue(client, label_id).json()
    with Session(haccp_database.get_engine()) as db:
        db.get(EtiquetteHaccp, label_id).dlc_secondaire = datetime(2000, 1, 1)
        db.commit()
    assert request(client, "/prochaine", {"relay_id": relay}).json()["job"] is None
    assert request(client, "/etat").json()["jobs"][0]["status"] == "cancelled"
    assert request(client, f"/demandes/{job['id']}/confirmation", {
        "relay_id": relay, "status": "accepted",
    }).status_code == 409


def test_claim_without_confirmation_becomes_uncertain_never_requeued(api):
    client, label_id = api
    relay = configure(client)
    job = queue(client, label_id).json()
    request(client, "/prochaine", {"relay_id": relay})
    with Session(haccp_database.get_engine()) as db:
        db.get(HaccpPrintJob, job["id"]).claimed_at = datetime.utcnow() - timedelta(minutes=3)
        db.commit()
    assert request(client, "/etat").json()["jobs"][0]["status"] == "uncertain"
    assert request(client, "/prochaine", {"relay_id": relay}).json()["job"] is None
    assert queue(client, label_id).json()["status"] == "uncertain"


@pytest.mark.parametrize("changes", [
    {"width_mm": 0}, {"height_mm": 999}, {"width_mm": 60.5},
    {"device_name": " "}, {"relay_id": "invalid"}, {"width_mm": True},
])
def test_invalid_station_settings(api, changes):
    client, _ = api
    payload = {"relay_id": str(uuid.uuid4()), "device_name": "Test", "width_mm": 60, "height_mm": 50}
    assert request(client, "/poste", payload | changes).status_code == 422


def test_cloud_proxy_uses_linked_session_and_requires_direct_local_request(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("SIRIUS_CLOUD_RELAY", "1")
    monkeypatch.setattr(cloud_link, "linked", lambda: True)
    relay = AsyncMock(return_value={"station": None, "jobs": []})
    monkeypatch.setattr(cloud_link, "relay_haccp_print", relay)
    assert request(client, "/etat").status_code == 403
    assert request(client, "/etat", local=True).json()["jobs"] == []
    relay.assert_awaited_once_with("/etat", None)
    monkeypatch.setattr(cloud_link, "linked", lambda: False)
    assert request(client, "/etat", local=True).status_code == 409


def test_cloud_print_transport_bearer_and_no_credentials_in_payload(monkeypatch):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"job": None})
    monkeypatch.setattr(cloud_link, "transport", httpx.MockTransport(handle))
    monkeypatch.setattr(cloud_link, "load_state", lambda: {"access_token": "fake-unit-test-token"})
    assert asyncio.run(cloud_link.relay_haccp_print("/prochaine", {"relay_id": str(uuid.uuid4())})) == {"job": None}
    assert calls[0].url.path == "/api/haccp/impression/prochaine"
    assert calls[0].headers["authorization"] == "Bearer fake-unit-test-token"
    assert "access_token" not in json.loads(calls[0].content)


def test_concurrent_claims_only_one_consumer_gets_the_label(api):
    from concurrent.futures import ThreadPoolExecutor
    client, label_id = api
    relay = configure(client)
    assert queue(client, label_id).status_code == 200
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: request(client, "/prochaine", {"relay_id": relay}), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert sum(response.json()["job"] is not None for response in responses) == 1


def test_concurrent_enqueue_returns_one_unique_durable_request(api):
    from concurrent.futures import ThreadPoolExecutor
    client, label_id = api
    configure(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: queue(client, label_id), range(2)))
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json()["id"] == responses[1].json()["id"]

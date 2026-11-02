import asyncio
import io
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from starlette.websockets import WebSocketDisconnect

import cloud_link
from tri_cortex.routes import make_cortex_router
from tri_cortex.schemas import Job
from test_tri_cortex import label, prices, runtime


class Members:
    def __init__(self):
        self.rows = [
            {"user_id": "one", "company_id": "a", "role": "manager", "permissions": ["haccp"]},
            {"user_id": "two", "company_id": "b", "role": "employee", "permissions": ["haccp"]},
        ]

    async def find_one(self, query):
        return next((dict(row) for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)


class Database:
    def __init__(self):
        self.enterprise_members = Members()
        self.disabled = set()
        self.company_ids = {}


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(cloud_link, "relay_allowed", lambda: False)
    db = Database()

    async def authenticate(connection, _db):
        user = connection.headers.get("x-test-user")
        if user not in {"one", "two", "solo"} or user in db.disabled:
            raise HTTPException(401, "Session requise")
        return {"user_id": user, "company_id": db.company_ids.get(user)}

    core = runtime(tmp_path, AsyncMock(return_value=label()))

    @asynccontextmanager
    async def lifespan(_app):
        await core.start()
        try:
            yield
        finally:
            await core.stop()

    app = FastAPI(lifespan=lifespan)
    app.include_router(make_cortex_router(
        db, authenticate, core, allowed_origins=frozenset({"https://example.test"}),
    ), prefix="/api")
    with TestClient(app) as client:
        yield client, core, db


def headers(user="one"):
    return {"x-test-user": user, "origin": "https://example.test"}


def picture():
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "white").save(output, "PNG")
    return output.getvalue()


def test_snapshot_and_stream_are_authenticated_scoped_and_exact_shape(api):
    client, core, _db = api
    assert client.get("/api/cortex/tri").status_code == 401
    with core.telemetry.measure("company:a", "vision", "vision_label"):
        pass
    core.telemetry.flow("company:a", "vision", "brain_2")
    first = client.get("/api/cortex/tri", headers=headers())
    assert first.status_code == 200 and first.headers["cache-control"] == "private, no-store"
    assert {node["id"] for node in first.json()["nodes"]} == {"brain_1", "brain_2", "brain_3"}
    assert {node["parent"] for node in first.json()["satellites"]} == {"brain_3"}
    foreign = client.get("/api/cortex/tri", headers=headers("two")).json()
    assert not foreign["edge_flows"]
    assert all(node["completed"] == 0 for node in foreign["satellites"])
    with client.websocket_connect("/api/cortex/tri/stream", headers=headers()) as socket:
        frame = socket.receive_json()
        assert frame["version"] == 1
        assert len(frame["nodes"]) == 3 and len(frame["satellites"]) == 4
        assert frame["heartbeat_at"]


def test_websocket_rejects_missing_auth_and_foreign_origin(api):
    client, _core, _db = api
    for offered, expected in (({}, 4401), (headers() | {"origin": "https://foreign.test"}, 4403)):
        with pytest.raises(WebSocketDisconnect) as failure:
            with client.websocket_connect("/api/cortex/tri/stream", headers=offered):
                pytest.fail("Connexion non autorisee acceptee")
        assert failure.value.code == expected


def test_stream_rechecks_disabled_account(api):
    client, _core, db = api
    with client.websocket_connect("/api/cortex/tri/stream", headers=headers()) as socket:
        socket.receive_json()
        db.disabled.add("one")
        with pytest.raises(WebSocketDisconnect) as failure:
            for _ in range(8):
                socket.receive_json()
        assert failure.value.code == 4401


def test_async_vision_reading_idempotent_private_and_human_review(api):
    client, core, _db = api
    request_id = str(uuid.uuid4())
    arguments = {
        "headers": headers(), "data": {"kind": "label", "request_id": request_id},
        "files": {"file": ("sample.png", picture(), "image/png")},
    }
    response = client.post("/api/cortex/tri/vision", **arguments)
    assert response.status_code == 202, response.text
    job = Job.model_validate(response.json())
    assert job.context.scope == "company:a"

    async def done():
        return await core.brain3.wait(job)

    result = client.portal.call(done)
    assert result["requires_human_review"] is True
    assert result["field_confidence"]["nom_produit"] == 0.94
    duplicate = client.post("/api/cortex/tri/vision", **arguments)
    assert duplicate.json()["id"] == job.id
    assert client.get(f"/api/cortex/tri/jobs/{job.id}", headers=headers("two")).status_code == 404
    assert client.get("/api/cortex/tri/jobs", headers=headers("two")).json()["items"] == []
    own = client.get("/api/cortex/tri/jobs", headers=headers()).json()["items"]
    assert own[0]["id"] == job.id and own[0]["requires_human_review"]
    assert "PRODUIT-PRIVE" not in client.get("/api/cortex/tri", headers=headers()).text
    assert client.post(f"/api/cortex/tri/jobs/{job.id}/retry", headers=headers()).status_code == 409


def test_finance_permission_and_explicit_sources(api):
    client, _core, _db = api
    body = prices().model_dump(mode="json")
    assert client.post("/api/cortex/tri/price-audit", headers=headers("two"), json=body).status_code == 403
    assert client.post("/api/cortex/tri/price-audit", headers=headers(), json=body | {"sources_confirmed": False}).status_code == 422
    assert client.post("/api/cortex/tri/price-audit", headers=headers(), json=body).status_code == 202
    forbidden_invoice = client.post(
        "/api/cortex/tri/vision", headers=headers("two"), data={"kind": "invoice"},
        files={"file": ("invoice.png", picture(), "image/png")},
    )
    assert forbidden_invoice.status_code == 403


def test_haccp_denial_does_not_fall_back_to_personal_scope(api):
    client, _core, db = api
    db.enterprise_members.rows[1]["permissions"] = []
    arguments = {"data": {"kind": "label"}, "files": {"file": ("sample.png", picture(), "image/png")}}
    assert client.post("/api/cortex/tri/vision", headers=headers("two"), **arguments).status_code == 403
    db.company_ids["solo"] = "missing-membership"
    assert client.post("/api/cortex/tri/vision", headers=headers("solo"), **arguments).status_code == 403
    del db.company_ids["solo"]
    response = client.post("/api/cortex/tri/vision", headers=headers("solo"), **arguments)
    assert response.status_code == 202
    assert response.json()["context"]["scope"] == "user:solo"


def test_relay_does_not_replace_cloud_failure_by_empty_local_metrics(api, monkeypatch):
    client, core, _db = api
    monkeypatch.setattr(cloud_link, "relay_allowed", lambda: True)
    remote = core.telemetry.frame(frozenset({"user:one"})).model_dump(mode="json")
    mocked = AsyncMock(return_value=remote)
    monkeypatch.setattr(cloud_link, "relay_cortex", mocked)
    response = client.get("/api/cortex/tri", headers=headers())
    assert response.status_code == 200 and response.json()["source"] == "cloud"
    mocked.assert_awaited_once_with("GET")
    mocked.side_effect = HTTPException(503, "Cloud indisponible")
    assert client.get("/api/cortex/tri", headers=headers()).status_code == 503
    assert client.get("/api/cortex/tri", headers=headers() | {"x-forwarded-for": "1.2.3.4"}).status_code == 403

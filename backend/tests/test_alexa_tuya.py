import asyncio
import base64
import hashlib
import hmac
import io
import json
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import alexa_integration as alexa_module
import auth_api
import tuya_integration as tuya_module
from access_gate import AccessGateMiddleware, is_open_path
from account_deletion import PERSONAL_COLLECTIONS
from alexa_integration import AlexaIntegration, Consent, hashed, make_alexa_router, stamp
from local_docstore import LocalDocStore
from tuya_integration import (DeviceSelection, HomeCommand, TuyaIntegration, capabilities,
                              make_tuya_router, signature)


def run(value):
    return asyncio.run(value)


@pytest.fixture
def setup(tmp_path, monkeypatch):
    for key, value in {
        "SIRIUS_ALEXA_CLIENT_ID": "custom", "SIRIUS_ALEXA_CLIENT_SECRET": "c" * 32,
        "SIRIUS_ALEXA_HOME_CLIENT_ID": "home", "SIRIUS_ALEXA_HOME_CLIENT_SECRET": "h" * 32,
        "SIRIUS_ALEXA_PUBLIC_ORIGIN": "https://sirius.example",
        "SIRIUS_ALEXA_REDIRECT_URIS": "https://alexa.example/custom",
        "SIRIUS_ALEXA_HOME_REDIRECT_URIS": "https://alexa.example/home",
        "SIRIUS_TUYA_ENABLED": "1", "TUYA_CLIENT_ID": "tuya-project", "TUYA_CLIENT_SECRET": "t" * 32,
        "TUYA_REGION": "eu", "SIRIUS_TUYA_USER_BINDINGS": '{"one":"tuya-one","other":"tuya-other"}',
    }.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("SIRIUS_PACKAGED", raising=False)
    db = LocalDocStore(tmp_path / "alexa.db")
    for uid in ("one", "other"):
        run(db.users.insert_one({"user_id": uid, "role": "admin", "email": uid + "@example.test"}))
    alexa = AlexaIntegration(db)
    tuya = TuyaIntegration(db, alexa)

    async def user(request, database):
        uid = request.headers.get("x-test-user")
        if uid not in {"one", "other"}:
            raise HTTPException(401, "Session requise.")
        return {"user_id": uid}

    app = FastAPI()
    app.include_router(make_alexa_router(alexa, user), prefix="/api")
    app.include_router(make_tuya_router(tuya, user), prefix="/api")
    app.add_middleware(AccessGateMiddleware, db=db)
    client = TestClient(app)
    return alexa, tuya, client


def params(home=False, **updates):
    return {"client_id": "home" if home else "custom", "response_type": "code",
            "redirect_uri": "https://alexa.example/home" if home else "https://alexa.example/custom",
            "scope": "home:read home:control" if home else "dossiers:read meetings:read",
            "state": "amazon-state", **updates}


def basic(home=False):
    return "Basic " + base64.b64encode((("home:" + "h" * 32) if home else ("custom:" + "c" * 32)).encode()).decode()


def code(alexa, uid="one", home=False, **updates):
    ticket, _ = run(alexa.authorize(params(home, **updates)))
    consent = run(alexa.consent(uid, Consent(ticket=ticket, approve=True)))
    return parse_qs(urlsplit(consent["redirect"]).query)["code"][0]


def token(setup, uid="one", home=False, **updates):
    alexa, _, client = setup
    response = client.post("/api/integrations/alexa/oauth/token",
        headers={"Authorization": basic(home)}, data={
            "grant_type": "authorization_code", "code": code(alexa, uid, home),
            "redirect_uri": params(home)["redirect_uri"], **updates,
        })
    assert response.status_code == 200, response.text
    return response.json()


def bearer(tokens):
    return {"Authorization": "Bearer " + tokens["access_token"]}


class Cloud:
    def __init__(self):
        self.calls = []
        self.values = {"switch_led": False, "bright_value_v2": 10}
        self.devices = {
            "tuya-one": [{"id": "lamp", "name": "Lampe", "category": "dj", "online": True},
                         {"id": "plug", "name": "Prise", "category": "cz", "online": True},
                         {"id": "lock", "name": "Serrure", "category": "ms", "online": True}],
            "tuya-other": [{"id": "private", "name": "Autre lampe", "category": "dj", "online": True}],
        }
        self.commands = 0
        self.mode = "ok"

    def __call__(self, request):
        self.calls.append(request)
        path = request.url.path
        if path == "/v1.0/token":
            result = {"access_token": "tuya-access", "expire_time": 7200}
        elif path.endswith("/devices") and "/users/" in path:
            result = self.devices[path.split("/")[-2]]
        elif path.endswith("/specifications"):
            result = {"functions": [{"code": "switch_1" if "/plug/" in path else "switch_led", "type": "Boolean"},
                                     {"code": "bright_value_v2", "type": "Integer",
                                      "values": '{"min":10,"max":1000,"step":1,"scale":0}'}]}
        elif path.endswith("/commands"):
            self.commands += 1
            if self.mode == "network":
                raise httpx.ReadTimeout("lost acknowledgement", request=request)
            if self.mode != "stale":
                self.values.update({c["code"]: c["value"] for c in json.loads(request.content)["commands"]})
            result = False if self.mode == "rejected" else True
        elif path.endswith("/status"):
            result = [{"code": k, "value": v} for k, v in self.values.items()]
        else:
            raise AssertionError(f"Unexpected route {path}")
        return httpx.Response(200, json={"success": True, "result": result})


def selected(setup, device="lamp"):
    _, tuya, _ = setup
    cloud = Cloud()
    tuya.transport = httpx.MockTransport(cloud)
    item = run(tuya.select("one", DeviceSelection(device_id=device, name="Bureau", confirm_noncritical=True)))
    return item, cloud


def directive(item, action="TurnOn", **updates):
    return HomeCommand(**{"endpoint_id": item["endpoint_id"], "message_id": "amazon-command",
                          "action": action, **updates})


def test_oauth_requires_config_and_exact_request(setup, monkeypatch):
    alexa, _, _ = setup
    for change in ({"redirect_uri": "https://alexa.example/custom?evil=1"}, {"client_id": "alien"},
                   {"scope": "home:control"}, {"scope": ""}, {"state": ""}, {"response_type": "token"},
                   {"code_challenge_method": "S256"}):
        with pytest.raises(HTTPException):
            run(alexa.authorize(params(**change)))
    monkeypatch.setenv("SIRIUS_ALEXA_HOME_CLIENT_ID", "custom")
    with pytest.raises(HTTPException):
        run(alexa.authorize(params()))


def test_consent_html_is_scoped_no_secret_and_origin_protected(setup):
    alexa, _, client = setup
    for home, text in [(False, "Aucun envoi ni action externe"), (True, "sans confirmation supplémentaire")]:
        page = client.get("/api/integrations/alexa/oauth/authorize", params=params(home))
        assert page.status_code == 200 and text in page.text
        assert "c" * 32 not in page.text and "h" * 32 not in page.text
        assert page.headers["cache-control"] == "no-store"
    ticket, _ = run(alexa.authorize(params()))
    path = "/api/integrations/alexa/oauth/consent"
    body = {"ticket": ticket, "approve": True}
    assert client.post(path, json=body, headers={"x-test-user": "one", "Origin": "https://evil.test"}).status_code == 403
    assert client.post(path, json=body, headers={"Origin": "https://sirius.example"}).status_code == 401
    response = client.post(path, json=body, headers={"x-test-user": "one", "Origin": "https://sirius.example"})
    assert response.status_code == 200
    assert parse_qs(urlsplit(response.json()["redirect"]).query)["state"] == ["amazon-state"]
    assert client.post(path, json=body, headers={"x-test-user": "one", "Origin": "https://sirius.example"}).status_code == 409
    assert client.get("/api/integrations/alexa/oauth/authorize?client_id=custom&client_id=home").status_code == 400


def test_denied_expired_code_and_pkce(setup):
    alexa, _, client = setup
    ticket, _ = run(alexa.authorize(params()))
    result = run(alexa.consent("one", Consent(ticket=ticket, approve=False)))
    assert parse_qs(urlsplit(result["redirect"]).query)["error"] == ["access_denied"]
    verifier = "a" * 43
    proof = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    value = code(alexa, code_challenge=proof, code_challenge_method="S256")
    form = {"grant_type": "authorization_code", "redirect_uri": params()["redirect_uri"], "code": value}
    assert client.post("/api/integrations/alexa/oauth/token", headers={"Authorization": basic()}, data=form).status_code == 400
    response = client.post("/api/integrations/alexa/oauth/token", headers={"Authorization": basic()},
                           data={**form, "code_verifier": verifier})
    assert response.status_code == 200
    assert client.post("/api/integrations/alexa/oauth/token", headers={"Authorization": basic()},
                       data={**form, "code_verifier": verifier}).status_code == 400
    expired = code(alexa)
    run(alexa.db.sirius_alexa_codes.update_one({"code_hash": hashed(expired)}, {"$set": {"expires_at": stamp(-1)}}))
    assert client.post("/api/integrations/alexa/oauth/token", headers={"Authorization": basic()},
                       data={**form, "code": expired}).status_code == 400


@pytest.mark.parametrize("headers,content", [
    ({}, "grant_type=refresh_token"), ({"Authorization": "Basic %bad"}, "grant_type=refresh_token"),
    ({"Authorization": "Basic " + base64.b64encode(b"custom:wrong").decode()}, "grant_type=refresh_token"),
    ({"Authorization": basic()}, "grant_type=refresh_token&grant_type=authorization_code"),
])
def test_invalid_token_exchange_is_explicit(setup, headers, content):
    response = setup[2].post("/api/integrations/alexa/oauth/token", headers={
        "Content-Type": "application/x-www-form-urlencoded", **headers}, content=content)
    assert response.status_code in {400, 401}
    assert "error" in response.json() and response.headers["cache-control"] == "no-store"


def test_scope_separation_rotation_replay_and_storage(setup):
    alexa, _, client = setup
    custom, home = token(setup), token(setup, home=True)
    assert client.get("/api/integrations/alexa/dossiers", headers=bearer(custom)).status_code == 200
    assert client.get("/api/integrations/tuya/alexa/discovery", headers=bearer(custom)).status_code == 403
    assert client.get("/api/integrations/alexa/dossiers", headers=bearer(home)).status_code == 403
    refresh = {"grant_type": "refresh_token", "refresh_token": custom["refresh_token"]}
    assert client.post("/api/integrations/alexa/oauth/token", headers={"Authorization": basic(True)}, data=refresh).status_code == 400
    renewed = client.post("/api/integrations/alexa/oauth/token", headers={"Authorization": basic()}, data=refresh).json()
    assert renewed["refresh_token"] != custom["refresh_token"]
    assert client.get("/api/integrations/alexa/dossiers", headers=bearer(custom)).status_code == 401
    assert client.get("/api/integrations/alexa/dossiers", headers=bearer(renewed)).status_code == 200
    assert client.post("/api/integrations/alexa/oauth/token", headers={"Authorization": basic()}, data=refresh).status_code == 400
    assert client.get("/api/integrations/alexa/dossiers", headers=bearer(renewed)).status_code == 401
    saved = str(run(alexa.db.sirius_alexa_connections.find({}).to_list(10)))
    saved += str(run(alexa.db.sirius_alexa_refreshes.find({}).to_list(10)))
    assert custom["access_token"] not in saved and custom["refresh_token"] not in saved
    assert client.get("/api/integrations/alexa/dossiers", headers=bearer(home)).status_code == 403


def test_dossiers_and_nested_meeting_projection_are_private(setup):
    alexa, _, client = setup
    for uid in ("one", "other"):
        run(alexa.db.sirius_work_dossiers.insert_one({"user_id": uid, "id": uid, "title": uid,
                                                     "secret": "not returned", "created_at": stamp()}))
        run(alexa.db.sirius_meetings.insert_one({"user_id": uid, "id": uid, "title": uid,
            "state": "READY", "ready_at": stamp(), "result": {"summary": "Résumé " + uid, "tasks": ["private"]},
            "fragments": ["private"], "capture_complete": False}))
    headers = bearer(token(setup))
    assert client.get("/api/integrations/alexa/dossiers", headers=headers).json() == {"items": [{"id": "one", "title": "one"}]}
    assert client.get("/api/integrations/alexa/dossiers?title=other", headers=headers).json() == {"items": []}
    meeting = client.get("/api/integrations/alexa/meetings", headers=headers).json()["items"][0]
    assert meeting == {"id": "one", "title": "one", "summary": "Résumé one", "capture_complete": False}


def test_rate_limit_exactly_thirty_and_connection_revocation_is_private(setup):
    _, _, client = setup
    headers = bearer(token(setup))
    for _ in range(30):
        assert client.get("/api/integrations/alexa/dossiers", headers=headers).status_code == 200
    assert client.get("/api/integrations/alexa/dossiers", headers=headers).status_code == 429
    listing = client.get("/api/integrations/alexa/connections", headers={"x-test-user": "one"})
    assert "hash" not in listing.text
    identity = listing.json()["connections"][0]["id"]
    assert client.delete("/api/integrations/alexa/connections/" + identity, headers={"x-test-user": "other"}).status_code == 404
    assert client.delete("/api/integrations/alexa/connections/" + identity, headers={"x-test-user": "one"}).status_code == 200
    assert client.get("/api/integrations/alexa/dossiers", headers=headers).status_code == 401


def test_expired_license_blocks_reads_but_not_revocation(setup, monkeypatch):
    _, _, client = setup
    headers = bearer(token(setup))
    monkeypatch.setattr(alexa_module, "active_account", AsyncMock(side_effect=HTTPException(402, "Licence expirée.")))
    assert client.get("/api/integrations/alexa/dossiers", headers=headers).status_code == 402
    rows = client.get("/api/integrations/alexa/connections", headers={"x-test-user": "one"}).json()["connections"]
    assert client.delete("/api/integrations/alexa/connections/" + rows[0]["id"], headers={"x-test-user": "one"}).status_code == 200
    assert is_open_path("/api/integrations/tuya/selections")


def test_disabled_account_and_expired_access_are_rejected(setup):
    alexa, _, client = setup
    headers = bearer(token(setup))
    run(alexa.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": True}}))
    assert client.get("/api/integrations/alexa/dossiers", headers=headers).status_code == 401
    run(alexa.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": False}}))
    run(alexa.db.sirius_alexa_connections.update_one({}, {"$set": {"access_expires": stamp(-1)}}))
    assert client.get("/api/integrations/alexa/dossiers", headers=headers).status_code == 401


def test_tuya_signature_and_fixed_transport(setup):
    item, cloud = selected(setup)
    request = cloud.calls[0]
    text = "GET\n" + hashlib.sha256(b"").hexdigest() + "\n\n/v1.0/token?grant_type=1"
    expected = hmac.new(b"t" * 32, ("tuya-project" + request.headers["t"] + text).encode(), hashlib.sha256).hexdigest().upper()
    assert request.headers["sign"] == expected
    assert request.url.host == "openapi.tuyaeu.com"
    run(setup[1].command("one", directive(item)))
    post = next(r for r in cloud.calls if r.method == "POST")
    assert post.headers["sign"] == signature("tuya-project", "t" * 32, "tuya-access",
        post.headers["t"], "POST", post.url.raw_path.decode(), post.content)
    assert json.loads(post.content) == {"commands": [{"code": "switch_led", "value": True}]}


def test_device_binding_selection_and_discovery_are_per_user(setup):
    item, _ = selected(setup)
    alexa, tuya, client = setup
    devices = client.get("/api/integrations/tuya/devices", headers={"x-test-user": "one"}).json()["items"]
    assert {d["device_id"] for d in devices} == {"lamp", "plug"}
    for uid, device, confirm in [("one", "private", True), ("one", "lock", True), ("one", "lamp", False)]:
        with pytest.raises(HTTPException):
            run(tuya.select(uid, DeviceSelection(device_id=device, name="Device", confirm_noncritical=confirm)))
    home = token(setup, home=True)
    other = token(setup, uid="other", home=True)
    assert client.get("/api/integrations/tuya/alexa/discovery", headers=bearer(home)).json()["devices"] == [
        {"endpoint_id": item["endpoint_id"], "name": "Bureau", "category": "LIGHT", "brightness": True}]
    assert client.get("/api/integrations/tuya/alexa/discovery", headers=bearer(other)).json() == {"devices": []}
    assert client.get("/api/integrations/tuya/alexa/state/" + item["endpoint_id"], headers=bearer(other)).status_code == 404
    assert client.get("/api/integrations/tuya/selections", headers={"x-test-user": "other"}).json() == {
        "items": [], "truncated": False}
    assert client.delete("/api/integrations/tuya/selections/" + item["endpoint_id"], headers={"x-test-user": "other"}).status_code == 404
    assert run(alexa.db.sirius_tuya_devices.count_documents({})) == 1


@pytest.mark.parametrize("change", [
    {"TUYA_REGION": "https://evil.test"}, {"SIRIUS_TUYA_ENABLED": "0"},
    {"SIRIUS_TUYA_USER_BINDINGS": '{"one":"same","other":"same"}'},
    {"SIRIUS_TUYA_USER_BINDINGS": '{"one":"../other"}'}, {"SIRIUS_TUYA_USER_BINDINGS": "[]"},
])
def test_invalid_tuya_configuration_never_connects(setup, monkeypatch, change):
    _, tuya, _ = setup
    for key, value in change.items():
        monkeypatch.setenv(key, value)
    with pytest.raises(HTTPException):
        run(tuya.discover("one"))


@pytest.mark.parametrize("action,value,expected", [
    ("SetBrightness", 0, 10), ("SetBrightness", 50, 505), ("SetBrightness", 100, 1000),
    ("AdjustBrightness", 25, 258), ("AdjustBrightness", -100, 10),
])
def test_brightness_range_and_adjustment(setup, action, value, expected):
    item, cloud = selected(setup)
    result = run(setup[1].command("one", directive(item, action, value=value)))
    assert cloud.values["bright_value_v2"] == expected
    assert result["state"]["brightness"] == round((expected - 10) * 100 / 990)
    assert cloud.commands == 1


@pytest.mark.parametrize("mode", ["network", "rejected", "stale"])
def test_uncertain_commands_are_never_retried(setup, mode):
    item, cloud = selected(setup)
    cloud.mode = mode
    body = directive(item)
    for _ in range(2):
        with pytest.raises(HTTPException):
            run(setup[1].command("one", body))
    assert cloud.commands == 1
    assert run(setup[0].db.sirius_tuya_commands.find_one({}))["state"] == "UNCERTAIN"


def test_replay_mismatch_revocation_and_removed_ownership(setup):
    item, cloud = selected(setup)
    _, tuya, client = setup
    body = directive(item)
    assert run(tuya.command("one", body)) == run(tuya.command("one", body))
    with pytest.raises(HTTPException):
        run(tuya.command("one", body.model_copy(update={"action": "TurnOff"})))
    cloud.devices["tuya-one"] = []
    with pytest.raises(HTTPException):
        run(tuya.command("one", body.model_copy(update={"message_id": "new"})))
    assert client.delete("/api/integrations/tuya/selections/" + item["endpoint_id"], headers={"x-test-user": "one"}).status_code == 200
    with pytest.raises(HTTPException):
        run(tuya.command("one", body))
    assert cloud.commands == 1


def test_simultaneous_command_claim_prevents_duplicate_write(setup):
    item, cloud = selected(setup)
    async def race():
        return await asyncio.gather(setup[1].command("one", directive(item)),
                                    setup[1].command("one", directive(item)), return_exceptions=True)
    results = run(race())
    assert any(isinstance(r, dict) for r in results)
    assert cloud.commands == 1


@pytest.mark.parametrize("spec", [
    {"functions": []},
    {"functions": [None]},
    {"functions": [{"code": "switch_1", "type": "Boolean"}, {"code": "switch_2", "type": "Boolean"}]},
    {"functions": [{"code": "switch_1", "type": "Boolean"}, {"code": "switch_10", "type": "Boolean"}]},
    {"functions": [{"code": "switch_led", "type": "Boolean"},
                   {"code": "bright_value_v2", "type": "Integer", "values": '{"min":100,"max":10}'}]},
])
def test_unsupported_tuya_capabilities_fail_closed(spec):
    with pytest.raises(HTTPException):
        capabilities({"category": "dj"}, spec)


def test_tuya_timeout_is_explicit_and_does_not_repeat(setup, monkeypatch):
    item, cloud = selected(setup)
    monkeypatch.setattr(setup[1], "execute", AsyncMock(side_effect=TimeoutError()))
    tokens = token(setup, home=True)
    response = setup[2].post("/api/integrations/tuya/alexa/command",
                             headers=bearer(tokens), json=directive(item).model_dump())
    assert response.status_code == 504
    assert "incertain" in response.text and cloud.commands == 0
    assert run(setup[0].db.sirius_tuya_commands.find_one({}))["state"] == "UNCERTAIN"


def test_binding_change_and_revocation_remain_effective_without_license(setup, monkeypatch):
    item, cloud = selected(setup)
    monkeypatch.setenv("SIRIUS_TUYA_USER_BINDINGS", '{"one":"tuya-other","other":"tuya-one"}')
    assert run(setup[1].discover("one")) == {"devices": []}
    with pytest.raises(HTTPException):
        run(setup[1].command("one", directive(item)))
    monkeypatch.setattr(tuya_module, "active_account", AsyncMock(side_effect=HTTPException(402, "Licence expirée.")))
    response = setup[2].delete("/api/integrations/tuya/selections/" + item["endpoint_id"], headers={"x-test-user": "one"})
    assert response.status_code == 200 and cloud.commands == 0


def test_export_and_erasure_include_owned_data_without_oauth_secrets(setup, monkeypatch):
    item, _ = selected(setup)
    alexa, tuya, _ = setup
    tokens = token(setup)
    run(tuya.command("one", directive(item)))
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value={"user_id": "one"}))
    endpoint = next(r.endpoint for r in auth_api.make_auth_router(alexa.db).routes if r.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(SimpleNamespace())
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        data = archive.read("sirius-personal-data.json").decode()
    assert "Bureau" in data and "SUCCEEDED" in data
    assert tokens["access_token"] not in data and "access_hash" not in data and "refresh_hash" not in data
    assert {"sirius_alexa_codes", "sirius_alexa_connections", "sirius_alexa_refreshes", "sirius_alexa_limits",
            "sirius_tuya_devices", "sirius_tuya_commands", "sirius_tuya_locks"}.issubset(PERSONAL_COLLECTIONS)


def test_device_limit_boundary_and_selection_list_reports_truncation(setup):
    selected(setup)
    alexa, tuya, client = setup
    for index in range(99):
        run(alexa.db.sirius_tuya_devices.insert_one({"user_id": "one", "id": str(index),
            "enabled": True, "confirmed_at": stamp()}))
    # Renaming an existing authorization does not consume another slot.
    run(tuya.select("one", DeviceSelection(device_id="lamp", name="Renommée", confirm_noncritical=True)))
    with pytest.raises(HTTPException) as failure:
        run(tuya.select("one", DeviceSelection(device_id="plug", name="Prise", confirm_noncritical=True)))
    assert failure.value.status_code == 409
    run(alexa.db.sirius_tuya_devices.insert_one({"user_id": "one", "id": "retired",
        "enabled": False, "confirmed_at": stamp()}))
    response = client.get("/api/integrations/tuya/selections", headers={"x-test-user": "one"})
    assert response.json()["truncated"] is True and len(response.json()["items"]) == 100


def test_parallel_different_commands_to_same_device_are_serialized(setup):
    item, cloud = selected(setup)
    _, tuya, _ = setup
    original = cloud.__call__
    async def delayed(request):
        if request.method == "POST":
            await asyncio.sleep(0.02)
        return original(request)
    tuya.transport = httpx.MockTransport(delayed)
    async def race():
        return await asyncio.gather(tuya.command("one", directive(item)),
            tuya.command("one", directive(item, "TurnOff", message_id="second")), return_exceptions=True)
    results = run(race())
    assert sum(isinstance(result, dict) for result in results) == 1
    assert cloud.commands == 1

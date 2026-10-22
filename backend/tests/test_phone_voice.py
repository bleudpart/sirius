import asyncio
import io
import json
import uuid
import zipfile
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from access_gate import is_open_path
from action_registry import ActionContext, ActionRegistry
from action_runs import ActionRuns, ConfirmIn, RunIn
from local_docstore import LocalDocStore
from phone_voice import (DialInputs, FIRST_MESSAGE, InboundSettings, PhoneConfig,
                         PhoneVoice, VapiClient, control_url, make_phone_router)
from work_draft_recordings import digest

CALL_ID = "11111111-1111-4111-8111-111111111111"
CONTROL = f"https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/{CALL_ID}/control"


def run(value):
    return asyncio.run(value)


@pytest.fixture
def service(tmp_path):
    db = LocalDocStore(tmp_path / "phone.db")
    run(db.users.insert_one({"user_id": "one", "role": "admin"}))
    engine = ActionRuns(db, ActionRegistry())
    config = PhoneConfig(True, "private-key-not-public", "one", "assistant-one", "phone-one",
                         "https://example.test/api/ariane/phone/webhook", "x" * 40, "credential-one",
                         ("+33123456789",), "org-one")
    client = AsyncMock()
    phone = PhoneVoice(db, engine, config, client)
    phone.register()
    assistant = {**phone.blueprint(), "id": config.assistant_id, "orgId": config.org_id}

    async def request(method, path, body=None):
        if path == f"/assistant/{config.assistant_id}":
            return assistant
        if path == f"/phone-number/{config.phone_id}":
            return {"id": config.phone_id, "orgId": config.org_id, "server": assistant["server"]}
        assert method == "POST" and path == "/call"
        return {"id": CALL_ID, "orgId": config.org_id, "phoneNumberId": config.phone_id,
                "assistantId": config.assistant_id, "status": "queued", "monitor": {"controlUrl": CONTROL}}

    client.request.side_effect = request
    return phone


def inputs(**values):
    return DialInputs(number="+33123456789", objective="Demander les horaires d'ouverture",
                      recipient_consent=True, **values)


def context():
    return ActionContext("one", "run-one", "appel", "operation-one")


def mission():
    return RunIn(request_id=uuid.uuid4(), objective="Appeler le magasin", steps=[
        {"id": "appel", "action": "phone.dial", "inputs": inputs().model_dump()}])


def confirm(service, saved):
    return service.runs.confirm("one", saved["id"], "appel", ConfirmIn(
        confirm=True, fingerprint=saved["steps"][0]["prepared"]["fingerprint"]))


def event(kind="status-update", state="in-progress", **call_updates):
    return {"message": {"type": kind, "status": state, "call": {
        "id": CALL_ID, "type": "inboundPhoneCall", "phoneNumberId": "phone-one",
        "assistantId": "assistant-one", "orgId": "org-one", **call_updates},
        "artifact": {"transcript": "secret-transcript", "recording": {"url": "https://private.test"}}}}


def test_no_provider_contact_before_exact_confirmation_and_one_post_after(service):
    prepared = run(service.runs.create("one", mission()))
    assert prepared["state"] == "WAITING_CONFIRMATION"
    service.client.request.assert_not_called()
    assert service.runs.registry.get("phone.dial").max_attempts == 1
    with pytest.raises(HTTPException):
        run(service.runs.confirm("one", prepared["id"], "appel", ConfirmIn(confirm=True, fingerprint="0" * 64)))
    service.client.request.assert_not_called()
    result = run(confirm(service, prepared))
    assert result["state"] == "COMPLETED"
    calls = [call for call in service.client.request.call_args_list if call.args[0] == "POST"]
    assert len(calls) == 1
    payload = calls[0].args[2]
    assert payload["customer"]["number"] == "+33123456789"
    assert payload["name"].startswith("sirius-") and "metadata" not in payload
    assert "server" not in payload["assistantOverrides"]
    assert payload["assistantOverrides"]["model"]["tools"] == []
    assert payload["assistantOverrides"]["model"]["messages"][1]["role"] == "user"
    assert "control_url" not in json.dumps(result)
    run(service.runs.execute("one", prepared["id"]))
    assert len([call for call in service.client.request.call_args_list if call.args[0] == "POST"]) == 1


def test_timeout_claim_is_durable_and_cannot_recompose_after_restart(service):
    original = service.client.request.side_effect

    async def timeout(method, path, body=None):
        if method == "POST":
            raise HTTPException(503, "timeout")
        return await original(method, path, body)

    service.client.request.side_effect = timeout
    result = run(service.dial(context(), inputs()))
    assert result.completion == "PARTIAL" and result.data["phone_call"]["state"] == "UNKNOWN"
    restarted = PhoneVoice(service.db, service.runs, service.config, service.client)
    assert run(restarted.dial(context(), inputs())).completion == "PARTIAL"
    assert len([call for call in service.client.request.call_args_list if call.args[0] == "POST"]) == 1
    operation = digest(["vapi-dial", context().idempotency_key])[:32]
    run(service.webhook(event(name=f"sirius-{operation}")))
    saved = run(service.listing("one"))["items"][0]
    assert saved["state"] == "in-progress" and saved["provider_id"] == CALL_ID


@pytest.mark.parametrize("change", [
    {"firstMessage": "I am human"}, {"maxDurationSeconds": 121},
    {"firstMessageMode": "assistant-waits-for-user"}, {"firstMessageInterruptionsEnabled": True},
    {"artifactPlan": {"recordingEnabled": True}}, {"hooks": [{"on": "call.start"}]},
    {"model": {"provider": "openai", "messages": [], "toolIds": ["private"]}},
    {"serverMessages": ["transcript"]}, {"orgId": "another-org"},
    {"server": {"url": "https://elsewhere.test"}}, {"model": "bad-model"},
    {"monitorPlan": {"controlEnabled": False, "listenEnabled": True}},
    {"artifactPlan": {"recordingEnabled": False, "loggingEnabled": True}},
])
def test_unsafe_assistant_never_dials(service, change):
    assistant = run(service.client.request("GET", "/assistant/assistant-one"))
    assistant.update(change)
    with pytest.raises(HTTPException):
        run(service.dial(context(), inputs()))
    assert not any(call.args[0] == "POST" for call in service.client.request.call_args_list)
    assert run(service.db.sirius_phone_calls.count_documents({})) == 0


def test_missing_configuration_unapproved_number_or_consent_never_calls(service):
    for body in (inputs().model_copy(update={"number": "+33999999999"}),
                 inputs().model_copy(update={"recipient_consent": False})):
        with pytest.raises(HTTPException):
            run(service.dial(context(), body))
    service.config = replace(service.config, enabled=False)
    with pytest.raises(HTTPException):
        run(service.dial(context(), inputs()))
    service.client.request.assert_not_called()


def test_owner_isolation_and_disabled_account(service):
    with pytest.raises(HTTPException) as failure:
        run(service.settings("other"))
    assert failure.value.status_code == 403
    run(service.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": True}}))
    with pytest.raises(HTTPException):
        run(service.dial(context(), inputs()))
    service.client.request.assert_not_called()


def test_daily_limit_is_shared_persistent_and_atomic(service):
    async def compete():
        return await asyncio.gather(*(service.daily_slot("one", str(index)) for index in range(9)),
                                    return_exceptions=True)
    results = run(compete())
    assert len([result for result in results if isinstance(result, HTTPException)]) == 4
    assert run(service.db.sirius_phone_limits.count_documents({})) == 5
    for index in range(5):
        run(service.daily_slot("one", str(index)))
    assert run(service.db.sirius_phone_limits.count_documents({})) == 5


def test_inbound_opt_in_saved_assistant_only_duplicate_and_no_transcript(service):
    assert "error" in run(service.webhook(event("assistant-request")))
    run(service.configure("one", InboundSettings(enabled=True)))
    assert run(service.webhook(event("assistant-request"))) == {"assistantId": "assistant-one"}
    run(service.webhook(event("assistant-request")))
    assert run(service.db.sirius_phone_calls.count_documents({})) == 1
    assert run(service.db.sirius_phone_limits.count_documents({})) == 1
    run(service.webhook(event("end-of-call-report", cost=0.12, monitor={"controlUrl": CONTROL})))
    run(service.webhook(event(state="ringing")))
    saved = run(service.listing("one"))["items"][0]
    assert saved["state"] == "ended" and saved["reported_cost_usd"] == 0.12
    assert "secret-transcript" not in str(run(service.db.sirius_phone_calls.find_one({})))
    assert "control_url" not in saved
    run(service.configure("one", InboundSettings(enabled=False)))
    assert "error" in run(service.webhook(event("assistant-request", id=str(uuid.uuid4()))))


def test_phone_with_direct_assistant_or_fallback_refused(service):
    original = service.client.request.side_effect
    async def request(method, path, body=None):
        result = await original(method, path, body)
        if path.startswith("/phone-number/"):
            result["assistantId"] = "direct-assistant-bypassing-admission"
        return result
    service.client.request.side_effect = request
    with pytest.raises(HTTPException):
        run(service.configure("one", InboundSettings(enabled=True)))
    assert not run(service.settings("one"))["inbound_enabled"]


def test_webhooks_during_post_do_not_regress_terminal_state(service):
    original = service.client.request.side_effect
    async def request(method, path, body=None):
        result = await original(method, path, body)
        if method == "POST":
            run_event = event("end-of-call-report", name=body["name"])
            await service.webhook(run_event)
        return result
    service.client.request.side_effect = request
    result = run(service.dial(context(), inputs()))
    assert result.data["phone_call"]["state"] == "ended"
    saved = run(service.db.sirius_phone_calls.find_one({}))
    assert saved["control_url"] == CONTROL


@pytest.mark.parametrize("change", [{"phoneNumberId": "other"}, {"orgId": "other"}, {"assistantId": "other"}])
def test_webhook_rejects_foreign_identity(service, change):
    run(service.dial(context(), inputs()))
    with pytest.raises(HTTPException):
        run(service.webhook(event(**change)))


def test_unknown_or_unbound_webhook_rejected(service):
    with pytest.raises(HTTPException):
        run(service.webhook(event()))
    with pytest.raises(HTTPException):
        run(service.webhook({"message": {"type": "status-update", "call": {"id": "bad"}}}))


def test_hangup_uses_private_validated_provider_url_no_terminal_success(service):
    run(service.dial(context(), inputs()))
    saved = run(service.listing("one"))["items"][0]
    with pytest.raises(HTTPException):
        run(service.stop("other", saved["id"]))
    result = run(service.stop("one", saved["id"]))
    assert result["state"] == "STOP_REQUESTED"
    service.client.end_call.assert_awaited_once_with(CONTROL)
    assert run(service.listing("one"))["items"][0]["state"] == "queued"
    run(service.db.sirius_phone_calls.update_one({"id": saved["id"]}, {"$set": {"control_url": "http://127.0.0.1/control"}}))
    with pytest.raises(HTTPException):
        run(service.stop("one", saved["id"]))
    assert service.client.end_call.await_count == 1


@pytest.mark.parametrize("url", [
    f"http://aws-us-west-2-production1-phone-call-websocket.vapi.ai/{CALL_ID}/control",
    f"https://aws-test-phone-call-websocket.vapi.ai.evil.test/{CALL_ID}/control",
    f"https://user@aws-test-phone-call-websocket.vapi.ai/{CALL_ID}/control",
    f"https://aws-test-phone-call-websocket.vapi.ai:invalid/{CALL_ID}/control",
    f"https://aws-test-phone-call-websocket.vapi.ai/{CALL_ID}/control?secret=1",
    "https://127.0.0.1/control", "https://[invalid",
])
def test_control_url_rejects_untrusted_targets(url):
    assert control_url(url, CALL_ID) is None


def test_router_auth_before_body_size_bound_and_account_session(service):
    async def require_user(request, db):
        if request.headers.get("x-test-user") != "one":
            raise HTTPException(401, "Session requise.")
        return {"user_id": "one"}
    app = FastAPI()
    app.include_router(make_phone_router(service, require_user), prefix="/api")
    client = TestClient(app)
    path = "/api/ariane/phone/webhook"
    assert is_open_path(path) and not is_open_path(path + "/anything")
    assert not is_open_path("/api/ariane/phone")
    assert client.post(path, content=b"x" * 70000).status_code == 401
    auth = {"Authorization": "Bearer " + service.config.webhook_secret}
    assert client.post(path, headers=auth, content=b"x" * 65537).status_code == 413
    assert client.post(path, headers=auth, content="not-json").status_code == 422
    assert client.post(path, headers=auth, json=[]).status_code == 422
    assert client.post(path, headers=auth, json=event("assistant-request")).json().get("error")
    assert client.get("/api/ariane/phone").status_code == 401
    overview = client.get("/api/ariane/phone", headers={"x-test-user": "one"}).json()
    assert service.config.key not in str(overview) and service.config.webhook_secret not in str(overview)
    assert FIRST_MESSAGE in str(overview)


@pytest.mark.parametrize("status", [302, 503])
def test_http_transport_never_retries_or_follows_redirects(monkeypatch, status):
    import phone_voice
    real_client = httpx.AsyncClient
    requests = []
    def handler(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer test-private-key"
        return httpx.Response(status, headers={"Location": "https://untrusted.test"},
                              json={"private": "not-exposed"})
    monkeypatch.setattr(phone_voice.httpx, "AsyncClient",
                        lambda **kwargs: real_client(**kwargs, transport=httpx.MockTransport(handler)))
    with pytest.raises(HTTPException) as failed:
        run(VapiClient("test-private-key").request("POST", "/call", {}))
    assert len(requests) == 1 and "not-exposed" not in str(failed.value.detail)


def test_phone_privacy_export_account_deletion_and_control_secret_excluded(service, monkeypatch):
    import auth_api
    from account_deletion import PERSONAL_COLLECTIONS
    run(service.dial(context(), inputs()))
    run(service.configure("one", InboundSettings(enabled=False)))
    run(service.db.sirius_phone_calls.insert_one({"user_id": "other", "id": "hidden", "number": "private-other"}))
    async def require_user(request, db):
        return {"user_id": "one", "role": "admin"}
    monkeypatch.setattr(auth_api, "require_user", require_user)
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(service.db).routes
                    if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(None)
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        data = json.loads(archive.read("sirius-personal-data.json"))
    for name in ("sirius_phone_calls", "sirius_phone_settings", "sirius_phone_limits"):
        assert name in PERSONAL_COLLECTIONS and len(data["collections"][name]) == 1
    assert "control_url" not in str(data) and CONTROL not in str(data) and "private-other" not in str(data)

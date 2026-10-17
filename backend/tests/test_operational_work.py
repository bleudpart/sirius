import asyncio
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from action_registry import ActionRegistry
from action_runs import ActionRuns, ConfirmIn, make_action_router
from local_docstore import LocalDocStore
from operational_work import OperationalWork, ReminderRequest, StartFollowup, make_operational_router
from routes.work_dossiers import make_work_dossiers_router
from work_conversation import WorkConversation


def run(coro):
    return asyncio.run(coro)


def future():
    return (datetime.now(timezone.utc) + timedelta(days=3)).isoformat()


@pytest.fixture
def service(tmp_path):
    db = LocalDocStore(tmp_path / "operational.db")
    conversation = WorkConversation(db)
    async def user(request, _db):
        uid = request.headers.get("x-user")
        if not uid:
            raise HTTPException(401)
        return {"user_id": uid}
    dossiers_router = make_work_dossiers_router(db, user, conversation=conversation)
    async def seed():
        for uid in ("u1", "u2"):
            await db.users.insert_one({"user_id": uid, "name": "Test", "email": uid + "@example.test"})
        await db.sirius_work_dossiers.insert_one({
            "id": "D-A", "user_id": "u1", "title": "Client A", "category": "commerce", "notes": [],
            "created_at": "2026-01-01", "sources": [{"kind": "facture", "id": "INV-A", "module": "themis"}],
        })
        await db.themis_docs.insert_one({"id": "INV-A", "user_id": "u1", "kind": "facture", "number": "F001",
            "status": "envoyé", "total_ttc": 120, "paid": 20,
            "due_date": (datetime.now(timezone.utc) - timedelta(days=20)).date().isoformat(), "client_id": "C-A", "client_name": "Client A"})
        await db.themis_clients.insert_one({"id": "C-A", "user_id": "u1", "email": "client@example.test", "name": "Client A"})
        await db.microsoft_oauth.insert_one({"user_id": "u1", "email": "sender@example.test"})
    run(seed())
    engine = ActionRuns(db, ActionRegistry())
    service = OperationalWork(db, engine, conversation, sender=AsyncMock(return_value=(202, "ms-request")),
                              token_reader=AsyncMock(return_value="secret-test-token"))
    service.register()
    service.test_user = user
    service.test_dossiers_router = dossiers_router
    return service


def start(service):
    return run(service.start("u1", StartFollowup(request_id=uuid.uuid4(), dossier_id="D-A",
                                                invoice_id="INV-A", followup_at=future())))


def confirm(service, result):
    return run(service.runs.confirm("u1", result["id"], "envoi", ConfirmIn(
        fingerprint=result["steps"][1]["prepared"]["fingerprint"], confirm=True)))


def test_full_invoice_flow_uses_real_source_preview_then_exact_confirmation(service):
    result = start(service)
    assert result["state"] == "WAITING_CONFIRMATION"
    service.sender.assert_not_called()
    preview = result["steps"][0]["output"]["data"]
    assert preview["invoice"]["content"]["remaining"] == 100
    assert preview["sender"] == "sender@example.test"
    assert preview["message"]["toRecipients"][0]["emailAddress"]["address"] == "client@example.test"
    assert "100.00" in preview["message"]["body"]["content"]
    assert "secret-test-token" not in json.dumps(result)
    result = confirm(service, result)
    assert result["state"] == "COMPLETED"
    receipt = result["steps"][1]["output"]["data"]["receipt"]
    assert receipt["state"] == "ACCEPTED" and receipt["request_id"] == "ms-request"
    assert "livraison non attestée" in receipt["reason"]
    assert run(service.db.sirius_work_reminders.count_documents({})) == 1
    entry = run(service.db.sirius_work_entries.find_one({"user_id": "u1"}))
    assert entry["dossier_id"] == "D-A" and entry["execution"] == "provider_accepted"
    assert run(service.db.themis_docs.find_one({"id": "INV-A"}))["paid"] == 20
    run(service.runs.execute("u1", result["id"]))
    duplicate = start(service)
    duplicated = confirm(service, duplicate)
    assert duplicated["state"] == "BLOCKED"
    assert "suivi initial" in duplicated["steps"][1]["reason"]
    metric = run(service.inbox("u1"))["metrics"]
    assert metric["human_confirmations"] == 2 and metric["send_reuse_steps"] == 1
    assert service.sender.call_count == 1
    assert run(service.db.sirius_work_reminders.count_documents({})) == 1


@pytest.mark.parametrize("change", ["paid", "recipient", "status", "connection", "expiry", "deleted", "duplicate"])
def test_confirmation_rechecks_sources_and_blocks_stale_preview(service, change):
    result = start(service)
    if change == "paid":
        run(service.db.themis_docs.update_one({"id": "INV-A"}, {"$set": {"paid": 120}}))
    elif change == "recipient":
        run(service.db.themis_clients.update_one({"id": "C-A"}, {"$set": {"email": "changed@example.test"}}))
    elif change == "status":
        run(service.db.themis_docs.update_one({"id": "INV-A"}, {"$set": {"status": "brouillon"}}))
    elif change == "connection":
        run(service.db.microsoft_oauth.update_one({"user_id": "u1"}, {"$set": {"email": "another@example.test"}}))
    elif change == "expiry":
        prepared = result["steps"][1]["prepared"]
        expired = prepared["inputs"]["preview"]
        expired["expires_at"] = "2000-01-01"
        # Exercise the handler's service guard independently of immutable plan storage.
        from action_registry import ActionContext
        from operational_work import ApplyFollowup
        with pytest.raises(HTTPException):
            run(service.send_action(ActionContext("u1", result["id"], "envoi", "same"), ApplyFollowup(preview=expired)))
        service.sender.assert_not_called()
        return
    elif change == "deleted":
        run(service.db.sirius_work_dossiers.delete_one({"id": "D-A"}))
    else:
        document = run(service.db.themis_docs.find_one({"id": "INV-A"}, {"_id": 0}))
        run(service.db.themis_docs.insert_one(document))
    result = confirm(service, result)
    assert result["state"] == "BLOCKED"
    service.sender.assert_not_called()


@pytest.mark.parametrize("status", [400, 401, 403, 429, 500, 503])
def test_provider_rejection_or_ambiguous_server_failure_never_resends(service, status):
    service.sender.return_value = (status, "request-rejected")
    result = confirm(service, start(service))
    for _ in range(4):
        result = run(service.runs.execute("u1", result["id"]))
    assert result["state"] == "BLOCKED"
    service.sender.assert_awaited_once()
    assert run(service.db.sirius_work_reminders.count_documents({})) == 0
    assert run(service.db.sirius_work_entries.count_documents({})) == 0
    receipt = run(service.db.sirius_work_receipts.find_one({}))
    assert receipt["state"] == ("REJECTED" if status < 500 else "UNKNOWN")


def test_source_is_rechecked_after_waiting_for_outlook_token_refresh(service):
    result = start(service)
    async def refresh(_db, _uid):
        await service.db.themis_docs.update_one({"id": "INV-A"}, {"$set": {"paid": 120}})
        return "new-token"
    service.token_reader.side_effect = refresh
    result = confirm(service, result)
    assert result["state"] == "BLOCKED"
    service.sender.assert_not_called()
    assert run(service.db.sirius_work_dispatches.count_documents({})) == 0


def test_network_loss_and_process_crash_latch_never_authorize_second_send(service):
    service.sender.side_effect = httpx.ReadTimeout("lost response")
    result = confirm(service, start(service))
    restored = OperationalWork(service.db, service.runs, service.conversation, sender=service.sender, token_reader=service.token_reader)
    run(restored.runs.execute("u1", result["id"]))
    service.sender.assert_awaited_once()
    assert run(service.db.sirius_work_receipts.find_one({}))["state"] == "UNKNOWN"
    assert run(service.inbox("u1"))["metrics"]["provider_unknown_all_time"] == 1


def test_crash_after_dispatch_claim_without_receipt_is_explicit_and_never_reissued(service):
    service.sender.side_effect = RuntimeError("process crash after accepting")
    result = start(service)
    with pytest.raises(RuntimeError):
        confirm(service, result)
    run(service.db.sirius_action_attempts.update_many({"run_id": result["id"]}, {"$set": {"lease_until": "2000-01-01"}}))
    service.sender.side_effect = None
    recovered = run(service.runs.execute("u1", result["id"]))
    assert recovered["state"] == "BLOCKED"
    assert "aucun renvoi" in recovered["steps"][1]["reason"]
    assert service.sender.call_count == 1
    assert run(service.inbox("u1"))["metrics"]["provider_unknown_all_time"] == 1


def test_success_receipt_recovers_missing_followup_without_resending(service, monkeypatch):
    import operational_work
    original = operational_work.insert_once
    async def failed(db, collection, document):
        if collection == "sirius_work_reminders":
            raise RuntimeError("disk problem after receipt")
        return await original(db, collection, document)
    result = start(service)
    monkeypatch.setattr(operational_work, "insert_once", failed)
    with pytest.raises(RuntimeError):
        confirm(service, result)
    monkeypatch.setattr(operational_work, "insert_once", original)
    run(service.db.sirius_action_attempts.update_many({"run_id": result["id"]}, {"$set": {"lease_until": "2000-01-01"}}))
    recovered = run(service.runs.execute("u1", result["id"]))
    assert recovered["state"] == "COMPLETED"
    service.sender.assert_awaited_once()
    assert run(service.db.sirius_work_reminders.count_documents({})) == 1
    metric = run(service.inbox("u1"))["metrics"]
    assert metric["recovered_steps"] == 1 and metric["send_reuse_steps"] == 1


def test_concurrent_confirmations_send_only_once(service):
    result = start(service)
    async def confirm_both():
        body = ConfirmIn(fingerprint=result["steps"][1]["prepared"]["fingerprint"], confirm=True)
        await asyncio.gather(*(service.runs.confirm("u1", result["id"], "envoi", body) for _ in range(2)))
    run(confirm_both())
    service.sender.assert_awaited_once()


@pytest.mark.parametrize("paid,outcome,notifications", [(20, "DUE", 1), (120, "RESOLVED", 0), ("bad", "UNAVAILABLE", 1)])
def test_invoice_followup_checks_payment_at_due_time_and_deduplicates_notifications(service, paid, outcome, notifications):
    confirm(service, start(service))
    run(service.db.sirius_work_reminders.update_many({}, {"$set": {"due_at": "2000-01-01"}}))
    run(service.db.themis_docs.update_one({"id": "INV-A"}, {"$set": {"paid": paid}}))
    run(service.tick()); run(service.tick())
    assert run(service.db.sirius_work_reminder_outcomes.find_one({}))["state"] == outcome
    assert run(service.db.sirius_work_notifications.count_documents({})) == notifications
    assert service.sender.call_count == 1


def test_general_reminders_are_confirmed_suspendable_and_catch_up_after_restart(service):
    request = ReminderRequest(request_id=uuid.uuid4(), text="Appeler le client", due_at=future())
    result = run(service.start_reminder("u1", request))
    assert result["state"] == "WAITING_CONFIRMATION"
    assert run(service.db.sirius_work_reminders.count_documents({})) == 0
    result = run(service.runs.confirm("u1", result["id"], "rappel", ConfirmIn(
        fingerprint=result["steps"][0]["prepared"]["fingerprint"], confirm=True)))
    reminder = result["steps"][0]["output"]["data"]
    run(service.db.sirius_work_reminders.update_one({"id": reminder["id"]}, {"$set": {"due_at": "2000-01-01"}}))
    restored = OperationalWork(service.db, service.runs, service.conversation)
    run(restored.tick()); run(restored.tick())
    inbox = run(restored.inbox("u1"))
    assert inbox["reminders"][0]["state"] == "DUE"
    assert len(inbox["notifications"]) == 1
    assert "échéance" in inbox["notifications"][0]["evidence"]["condition"].lower()
    assert run(restored.inbox("u1"))["workspace_id"] == inbox["workspace_id"]
    assert run(restored.inbox("u2"))["workspace_id"] != inbox["workspace_id"]
    assert run(restored.inbox("u2"))["notifications"] == []


def test_reminder_suspension_is_confirmed_and_never_notifies(service):
    from action_runs import RunIn
    created = run(service.start_reminder("u1", ReminderRequest(request_id=uuid.uuid4(), text="Appeler", due_at=future())))
    created = run(service.runs.confirm("u1", created["id"], "rappel", ConfirmIn(
        fingerprint=created["steps"][0]["prepared"]["fingerprint"], confirm=True)))
    reminder = created["steps"][0]["output"]["data"]
    suspended = run(service.runs.create("u1", RunIn(request_id=uuid.uuid4(), objective="Suspendre", steps=[
        {"id": "suspendre", "action": "work.reminder_cancel", "inputs": {"reminder_id": reminder["id"]}},
    ])))
    assert suspended["state"] == "WAITING_CONFIRMATION"
    run(service.runs.confirm("u1", suspended["id"], "suspendre", ConfirmIn(
        fingerprint=suspended["steps"][0]["prepared"]["fingerprint"], confirm=True)))
    run(service.db.sirius_work_reminders.update_one({"id": reminder["id"]}, {"$set": {"due_at": "2000-01-01"}}))
    run(service.tick())
    assert run(service.db.sirius_work_notifications.count_documents({})) == 0
    assert run(service.inbox("u1"))["reminders"][0]["state"] == "CANCELLED"


def test_reminder_backlog_progresses_past_completed_rows(service):
    async def seed():
        for index in range(105):
            await service.db.sirius_work_reminders.insert_one({
                "id": f"{index:032x}", "user_id": "u1", "text": f"Rappel {index}",
                "due_at": "2000-01-01", "created_at": "1999-01-01", "trigger": "once", "run_id": "old",
            })
    run(seed())
    run(service.tick())
    assert run(service.db.sirius_work_notifications.count_documents({})) == 100
    run(service.tick())
    assert run(service.db.sirius_work_notifications.count_documents({})) == 105
    run(service.tick())
    assert run(service.db.sirius_work_notifications.count_documents({})) == 105


def test_real_outlook_transport_uses_no_automatic_retries_and_requires_202(service, monkeypatch):
    import operational_work
    requests = []
    def handler(request):
        requests.append(request)
        assert request.url.path == "/v1.0/me/sendMail"
        assert request.headers["authorization"] == "Bearer test-access"
        assert json.loads(request.content)["saveToSentItems"] is True
        return httpx.Response(202, headers={"request-id": "accepted-proof"})
    real_client = httpx.AsyncClient
    monkeypatch.setattr(operational_work.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    status, proof = run(service.send_graph("test-access", {"message": {"subject": "Relance"}, "saveToSentItems": True}))
    assert status == 202 and proof == "accepted-proof" and len(requests) == 1


def test_relative_conversational_reminder_requires_shared_confirmation(service):
    answer = run(service.handle(SimpleNamespace(text="Rappelle-moi dans 3 jours de Vérifier Dupont", environment={}), {"user_id": "u1"}))
    assert answer["state"] == "WAITING_CONFIRMATION"
    assert "Vérifier Dupont" in answer["answer"]
    assert run(service.db.sirius_work_reminders.count_documents({})) == 0
    assert run(service.handle(SimpleNamespace(text="Rappelle-moi vendredi", environment={}), {"user_id": "u1"}))["state"] == "NEEDS_CLARIFICATION"
    assert run(service.handle(SimpleNamespace(text="Rappelle-moi dans 3 jours de " + "x" * 301, environment={}),
                              {"user_id": "u1"}))["state"] == "NEEDS_CLARIFICATION"
    with pytest.raises(ValidationError):
        ReminderRequest(request_id=uuid.uuid4(), text="   ", due_at=future())


@pytest.mark.parametrize("reference", ["cette facture", "la facture INV-A"])
def test_natural_conversation_resolves_invoice_but_never_sends_without_exact_approval(service, reference):
    response = run(service.handle(SimpleNamespace(
        text=f"Prépare la relance de {reference} avec un suivi dans trois jours",
        environment={"work_dossier_id": "D-A"}), {"user_id": "u1"}))
    assert response["state"] == "WAITING_CONFIRMATION"
    assert "client@example.test" in response["answer"] and "Confirme parcours" in response["answer"]
    assert "contentBytes" not in response["answer"] and len(response["answer"]) < 10000
    service.sender.assert_not_called()
    run(service.db.sirius_work_dossiers.update_one({"id": "D-A"}, {"$set": {"sources": [
        {"kind": "facture", "id": "INV-A"}, {"kind": "facture", "id": "INV-B"},
    ]}}))
    result = run(service.handle(SimpleNamespace(text="Prépare la relance de cette facture avec un suivi dans 3 jours",
                              environment={"work_dossier_id": "D-A"}), {"user_id": "u1"}))
    assert result["state"] == "NEEDS_CLARIFICATION"
    assert run(service.handle(SimpleNamespace(text="Prépare la relance de cette facture avec un suivi dans 3 jours",
                              environment={"work_dossier_id": {"$ne": None}}),
                              {"user_id": "u1"}))["state"] == "NEEDS_CLARIFICATION"


def test_accepted_invoice_is_visible_as_sourced_event_in_real_dossier_thread(service):
    confirm(service, start(service))
    app = FastAPI()
    app.include_router(service.test_dossiers_router, prefix="/api")
    with TestClient(app) as client:
        result = client.get("/api/work-dossiers/D-A/thread", headers={"x-user": "u1"})
        assert result.status_code == 200, result.text
        assert "invoice_dispatch" in result.text and "provider_accepted" in result.text
        result = client.get("/api/work-dossiers/D-A/client-events", headers={"x-user": "u1"})
        assert result.status_code == 200 and result.json()["events"] == []


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_real_chat_http_and_sse_use_shared_work_engine_without_llm(service, monkeypatch, endpoint):
    import server
    async def no_model(*_args, **_kwargs):
        pytest.fail("Operational requests must not be delegated to a model")
    monkeypatch.setattr(server, "db", service.db)
    monkeypatch.setattr(server, "require_user", service.test_user)
    monkeypatch.setattr(server, "operational_work", service)
    monkeypatch.setattr(server, "_rate_ok", lambda _uid: True)
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda _keys: True)
    monkeypatch.setattr(server.cloud_link, "relay_json", no_model)
    app = FastAPI()
    app.include_router(server.api_router)
    with TestClient(app) as client:
        assert client.post(endpoint, json={"text": "Mes parcours à traiter"}).status_code == 401
        result = client.post(endpoint, headers={"x-user": "u1"},
                             json={"text": "Rappelle-moi dans 3 jours de Vérifier Dupont", "session_id": "operational"})
        assert result.status_code == 200
        if endpoint.endswith("/stream"):
            data = [json.loads(line[6:]) for line in result.text.splitlines() if line.startswith("data: ")][-1]
        else:
            data = result.json()
        assert data["work_state"] == "WAITING_CONFIRMATION"
        assert "Vérifier Dupont" in data["answer"]
        assert run(service.db.sirius_work_reminders.count_documents({})) == 0


def test_outlook_tokens_remain_account_scoped_after_local_store_restart(service, monkeypatch):
    from cryptography.fernet import Fernet
    from microsoft_graph import _access_token, _save_tokens, microsoft_connection
    monkeypatch.setenv("MS_TOKEN_KEY", Fernet.generate_key().decode())
    run(service.db.microsoft_oauth.delete_many({}))
    run(_save_tokens(service.db, "u1", {"access_token": "one", "refresh_token": "refresh1"}, "one@example.test"))
    run(_save_tokens(service.db, "u2", {"access_token": "two", "refresh_token": "refresh2"}, "two@example.test"))
    assert run(_access_token(service.db, "u1")) == "one"
    assert run(_access_token(service.db, "u2")) == "two"
    run(_save_tokens(service.db, "u1", {"access_token": "new"}, "one@example.test"))
    assert run(service.db.microsoft_oauth.count_documents({"user_id": "u1"})) == 1
    assert run(microsoft_connection(service.db, "u1"))["refresh_token"]
    assert run(_access_token(service.db, "u1")) == "new"


def test_inbox_metrics_are_scoped_and_do_not_invent_delivery_or_time_saved(service):
    result = start(service)
    inbox = run(service.inbox("u1"))
    assert inbox["metrics"]["waiting"] == 1
    assert inbox["metrics"]["completion_rate_pct"] == 0
    assert "contentBytes" not in json.dumps(inbox)
    assert "secret-test-token" not in json.dumps(inbox)
    assert inbox["runs"][0]["steps"][1]["prepared"]["inputs"]["remaining"] == 100
    confirm(service, result)
    inbox = run(service.inbox("u1"))
    assert inbox["metrics"]["completion_rate_pct"] == 100
    assert inbox["metrics"]["provider_accepted_all_time"] == 1
    assert inbox["metrics"]["time_saved_minutes"] is None
    assert inbox["metrics"]["delivery_confirmed"] is None
    assert run(service.inbox("u2"))["runs"] == []


def test_conversation_uses_shared_engine_exact_approval_and_case_preserving_invoice_id(service):
    def ask(text, environment=None):
        return run(service.handle(SimpleNamespace(text=text, environment=environment or {}), {"user_id": "u1"}))
    assert ask("oui") is None
    assert ask("Prépare le parcours de relance")["state"] == "NEEDS_CLARIFICATION"
    text = f"Prépare le parcours de relance de la facture INV-A suivi le {future()}"
    assert ask(text)["state"] == "NEEDS_CLARIFICATION"
    answer = ask(text, {"work_dossier_id": "D-A"})
    assert answer["state"] == "WAITING_CONFIRMATION"
    assert "100.00" in answer["answer"]
    service.sender.assert_not_called()
    confirmation = next(line for line in answer["answer"].splitlines() if line.startswith("Confirme parcours"))
    result = ask(confirmation)
    assert result["state"] == "COMPLETED"
    assert "livraison non attestée" in result["answer"]
    assert "1 terminés" in ask("Montre mes résultats de travail")["answer"]


def test_routes_authentication_identity_and_two_clients_see_same_workspace(service):
    app = FastAPI()
    app.include_router(make_operational_router(service, service.test_user), prefix="/api")
    app.include_router(make_action_router(service.runs, service.test_user), prefix="/api")
    with TestClient(app) as client:
        assert client.get("/api/work-hub").status_code == 401
        body = {"request_id": str(uuid.uuid4()), "dossier_id": "D-A", "invoice_id": "INV-A", "followup_at": future()}
        assert client.post("/api/work-hub/invoice-followup", json=body).status_code == 401
        assert client.post("/api/work-hub/invoice-followup", headers={"x-user": "u2"}, json=body).status_code == 200
        foreign = client.get("/api/work-hub", headers={"x-user": "u2"}).json()
        assert foreign["runs"][0]["state"] == "BLOCKED"
        assert "client@example.test" not in json.dumps(foreign)
        result = client.post("/api/work-hub/invoice-followup", headers={"x-user": "u1"}, json=body).json()
        assert result["state"] == "WAITING_CONFIRMATION"
        inbox = client.get("/api/work-hub", headers={"x-user": "u1"}).json()
        assert inbox["runs"][0]["id"] == result["id"]
        assert client.get("/api/work-hub", headers={"x-user": "u1"}).json()["workspace_id"] == inbox["workspace_id"]
        assert client.post("/api/work-hub/reminders", json={"request_id": str(uuid.uuid4()),
                           "text": "hello", "due_at": future()}).status_code == 401
        assert client.post("/api/work-hub/reminders/" + "a" * 32 + "/cancel-preview").status_code == 401
        assert client.post("/api/work-hub/reminders/" + "a" * 32 + "/cancel-preview", headers={"x-user": "u2"}).status_code == 404


def test_invalid_dates_and_unknown_inputs_are_rejected_before_any_send():
    for due in ("2026-11-01T09:00:00", "not-a-date"):
        with pytest.raises(ValidationError):
            StartFollowup(request_id=uuid.uuid4(), dossier_id="D", invoice_id="I", followup_at=due)

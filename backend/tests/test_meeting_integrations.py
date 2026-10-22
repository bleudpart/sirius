import asyncio
import io
import json
import uuid
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from account_deletion import PERSONAL_COLLECTIONS
from action_registry import ActionRegistry
from action_runs import ActionRuns
from local_docstore import LocalDocStore
from meeting_integrations import (Approve, Finish, Fragment, MeetingIntegrations, MeetingStart,
                                  Publish, make_meeting_router)
from specialist_agents import SpecialistAgents


def run(value):
    return asyncio.run(value)


@pytest.fixture
def service(tmp_path):
    db = LocalDocStore(tmp_path / "meetings.db")
    run(db.users.insert_one({"user_id": "one", "role": "admin"}))
    run(db.sirius_work_dossiers.insert_one({"user_id": "one", "id": "dossier-one", "title": "Projet"}))
    complete = AsyncMock(return_value=json.dumps({
        "summary": "Le stock doit être vérifié.", "tasks": [{"text": "Vérifier le stock", "evidence_sequence": 0}],
    }))
    agents = SpecialistAgents(db, ActionRuns(db, ActionRegistry()), complete=complete)
    return MeetingIntegrations(db, agents)


def start_body(**updates):
    return MeetingStart.model_validate({
        "request_id": str(uuid.uuid4()), "title": "Point stock",
        "participants": [{"id": "123456", "label": "Daniel"}, {"id": "234567", "label": "Martin"}],
        "consent_ids": ["123456", "234567"], "consent": True, **updates,
    })


def capture(service):
    saved = run(service.start("one", start_body()))
    run(service.fragment("one", saved["id"], Fragment(sequence=0, speaker_id="234567", text="Je vais vérifier le stock.")))
    return saved["id"]


def ready(service):
    return run(service.finish("one", capture(service), Finish(capture_complete=True)))


def approval(saved, **updates):
    return Approve.model_validate({"confirm": True, "fingerprint": saved["fingerprint"], "dossier_id": "dossier-one",
                                  "assignments": [{"task_index": 0, "participant_id": "234567"}], **updates})


@pytest.mark.parametrize("updates", [
    {"consent": False}, {"consent_ids": ["123456"]}, {"consent_ids": ["123456", "123456"]},
    {"title": " "}, {"participants": [{"id": "123456", "label": " "}, {"id": "234567", "label": "Martin"}]},
])
def test_every_participant_must_explicitly_consent(service, updates):
    with pytest.raises(HTTPException):
        run(service.start("one", start_body(**updates)))
    assert run(service.db.sirius_meetings.count_documents({})) == 0
    service.specialists.complete.assert_not_called()


def test_session_start_and_fragments_have_exact_durable_idempotence(service):
    body = start_body()
    saved = run(service.start("one", body))
    assert run(service.start("one", body))["id"] == saved["id"]
    with pytest.raises(HTTPException):
        run(service.start("one", body.model_copy(update={"title": "Different"})))
    fragment = Fragment(sequence=0, speaker_id="123456", text="Bonjour")
    assert run(service.fragment("one", saved["id"], fragment))["duplicate"] is False
    assert run(service.fragment("one", saved["id"], fragment))["duplicate"] is True
    with pytest.raises(HTTPException):
        run(service.fragment("one", saved["id"], fragment.model_copy(update={"text": "Autre texte"})))
    assert run(service.get("one", saved["id"]))["character_count"] == 7
    service.specialists.complete.assert_not_called()


def test_foreign_participant_and_owner_rejected(service):
    identity = capture(service)
    with pytest.raises(HTTPException):
        run(service.fragment("one", identity, Fragment(sequence=1, speaker_id="999999", text="not-consented")))
    for action in (service.get("other", identity), service.fragment("other", identity, Fragment(
            sequence=1, speaker_id="123456", text="private"))):
        with pytest.raises(HTTPException) as failure:
            run(action)
        assert failure.value.status_code == 404


def test_size_limit_and_finish_seal_cannot_lose_concurrent_fragments(service):
    identity = capture(service)
    async def fill():
        await asyncio.gather(*(service.fragment("one", identity, Fragment(
            sequence=index, speaker_id="123456", text="x" * 2000)) for index in range(1, 12)))
    run(fill())
    with pytest.raises(HTTPException) as failure:
        run(service.fragment("one", identity, Fragment(sequence=12, speaker_id="123456", text="y" * 2000)))
    assert failure.value.status_code == 413
    saved = run(service.get("one", identity))
    assert len(saved["fragments"]) == 12 and saved["character_count"] <= 24000


def test_automatic_summary_is_bounded_no_task_write_no_repeated_provider_call(service):
    saved = ready(service)
    assert saved["state"] == "READY" and len(saved["fingerprint"]) == 64
    assert run(service.db.sirius_work_entries.count_documents({})) == 0
    run(service.finish("one", saved["id"], Finish(capture_complete=True)))
    assert service.specialists.complete.await_count == 1
    payload = json.loads(service.specialists.complete.call_args.args[0][1]["content"])
    assert payload["fragments"][0]["speaker_id"] == "234567"


@pytest.mark.parametrize("output", [
    "not-json", '{"summary":"x","tasks":[],"extra":"bad"}',
    '{"summary":"x","summary":"duplicate","tasks":[]}',
    '{"summary":"x","tasks":[{"text":"do it","evidence_sequence":12}]}',
    '{"summary":" ","tasks":[]}',
    '{"summary":"x","tasks":[{"text":" ","evidence_sequence":0}]}',
])
def test_invalid_generated_summary_never_creates_tasks_or_retries(service, output):
    service.specialists.complete.return_value = output
    identity = capture(service)
    with pytest.raises(HTTPException):
        run(service.finish("one", identity, Finish(capture_complete=False, reason="Interruption")))
    assert run(service.get("one", identity))["state"] == "FAILED"
    with pytest.raises(HTTPException):
        run(service.finish("one", identity, Finish(capture_complete=True)))
    assert service.specialists.complete.await_count == 1
    assert run(service.db.sirius_work_entries.count_documents({})) == 0


def test_concurrent_finish_only_one_provider_call_and_explicit_incomplete_capture(service):
    identity = capture(service)
    async def compete():
        return await asyncio.gather(*(service.finish("one", identity, Finish(
            capture_complete=False, reason="Un participant a retiré son accord.")) for _ in range(2)),
            return_exceptions=True)
    result = run(compete())
    assert service.specialists.complete.await_count == 1
    assert any(isinstance(item, HTTPException) or item["state"] == "READY" for item in result)
    assert run(service.get("one", identity))["capture_complete"] is False


def test_no_task_assignment_without_exact_human_confirmation(service):
    saved = ready(service)
    for updates in ({"confirm": False}, {"fingerprint": "0" * 64}, {"dossier_id": "foreign-dossier"},
                    {"assignments": [{"task_index": 0, "participant_id": "999999"}]},
                    {"assignments": [{"task_index": 5, "participant_id": "234567"}]},
                    {"assignments": [{"task_index": 0, "participant_id": "234567"}] * 2}):
        with pytest.raises(HTTPException):
            run(service.approve("one", saved["id"], approval(saved, **updates)))
    assert run(service.db.sirius_work_entries.count_documents({})) == 0


def test_exact_approved_tasks_use_existing_private_work_dossiers_and_are_idempotent(service):
    saved = ready(service)
    body = approval(saved)
    first = run(service.approve("one", saved["id"], body))
    assert run(service.approve("one", saved["id"], body)) == first
    assert first["tasks"][0]["owner"] == "Martin"
    assert first["cross_user_delivery"] is False
    entry = run(service.db.sirius_work_entries.find_one({"id": first["entry_id"]}))
    assert entry["kind"] == "meeting" and entry["status"] == "confirmed"
    assert entry["content"]["tasks"][0]["status"] == "confirmed"
    with pytest.raises(HTTPException):
        run(service.approve("one", saved["id"], approval(saved, assignments=[
            {"task_index": 0, "participant_id": "123456"}])))
    assert run(service.db.sirius_work_entries.count_documents({})) == 1


def test_publication_requires_approved_tasks_and_can_only_be_claimed_once(service):
    saved = ready(service)
    body = Publish(confirm=True, fingerprint=saved["fingerprint"])
    with pytest.raises(HTTPException):
        run(service.publication("one", saved["id"], body))
    run(service.approve("one", saved["id"], approval(saved)))
    body = Publish(confirm=True, fingerprint=run(service.publication_preview("one", saved["id"]))["fingerprint"])
    with pytest.raises(HTTPException):
        run(service.publication("one", saved["id"], body.model_copy(update={"confirm": False})))
    result = run(service.publication("one", saved["id"], body))
    assert "Martin" in result["text"] and "Je vais" not in result["text"]
    restarted = MeetingIntegrations(service.db, service.specialists)
    with pytest.raises(HTTPException):
        run(restarted.publication("one", saved["id"], body))


def test_empty_meeting_does_not_invent_summary(service):
    saved = run(service.start("one", start_body()))
    with pytest.raises(HTTPException):
        run(service.finish("one", saved["id"], Finish(capture_complete=True)))
    service.specialists.complete.assert_not_called()

def test_publication_refuses_stale_preview_and_never_claims_changed_tasks(service):
    saved = ready(service)
    result = run(service.approve("one", saved["id"], approval(saved)))
    preview = run(service.publication_preview("one", saved["id"]))
    entry = run(service.db.sirius_work_entries.find_one({"id": result["entry_id"]}))
    entry["content"]["tasks"][0]["owner"] = "Autre responsable"
    run(service.db.sirius_work_entries.update_one({"id": result["entry_id"]}, {"$set": {"content": entry["content"]}}))
    with pytest.raises(HTTPException):
        run(service.publication("one", saved["id"], Publish(confirm=True, fingerprint=preview["fingerprint"])))
    assert run(service.db.sirius_meeting_publications.count_documents({})) == 0


def test_no_task_proposal_allows_explicit_summary_only_publication(service):
    service.specialists.complete.return_value = '{"summary":"Aucune action demandée.","tasks":[]}'
    saved = ready(service)
    preview = run(service.publication_preview("one", saved["id"]))
    result = run(service.publication("one", saved["id"], Publish(confirm=True, fingerprint=preview["fingerprint"])))
    assert "Aucune action demandée." in result["text"]
    assert run(service.db.sirius_work_entries.count_documents({})) == 0


def test_router_auth_list_isolation_deletion_and_expiration(service):
    async def require_user(request, db):
        if request.headers.get("x-test-user") != "one":
            raise HTTPException(401, "Session requise.")
        return {"user_id": "one"}
    app = FastAPI()
    app.include_router(make_meeting_router(service, require_user), prefix="/api")
    client = TestClient(app)
    path = "/api/integrations/meetings"
    assert client.get(path).status_code == 401
    identity = capture(service)
    headers = {"x-test-user": "one"}
    assert client.delete(f"{path}/{identity}", headers=headers).status_code == 409
    run(service.db.sirius_meetings.update_one({"id": identity}, {"$set": {"expires_at": "2000-01-01T00:00:00+00:00"}}))
    assert client.put(f"{path}/{identity}/fragments", headers=headers, json={
        "sequence": 1, "speaker_id": "123456", "text": "trop tard"}).status_code == 409
    assert client.post(f"{path}/{identity}/finish", headers=headers, json={
        "capture_complete": False, "reason": "Bot arrêté"}).status_code == 200
    listing = client.get(path, headers=headers).json()
    assert len(listing["items"]) == 1 and "fragments" not in listing["items"][0]
    assert client.delete(f"{path}/{identity}", headers=headers).status_code == 200
    assert client.get(f"{path}/{identity}", headers=headers).status_code == 404
    assert client.get(path, headers=headers).json()["items"] == []
    assert "fragments" not in run(service.db.sirius_meetings.find_one({"id": identity}))


def test_privacy_export_and_account_deletion_cover_meetings(service, monkeypatch):
    import auth_api
    saved = ready(service)
    run(service.approve("one", saved["id"], approval(saved)))
    preview = run(service.publication_preview("one", saved["id"]))
    run(service.publication("one", saved["id"], Publish(confirm=True, fingerprint=preview["fingerprint"])))
    run(service.db.sirius_meetings.insert_one({"user_id": "other", "id": "hidden", "private": "not-yours"}))
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value={"user_id": "one", "role": "admin"}))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(service.db).routes
                    if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(SimpleNamespace())
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        data = json.loads(archive.read("sirius-personal-data.json"))
    for name in ("sirius_meetings", "sirius_meeting_publications"):
        assert name in PERSONAL_COLLECTIONS and len(data["collections"][name]) == 1
    assert len(data["collections"]["sirius_work_entries"]) == 1
    assert data["collections"]["sirius_work_entries"][0]["content"]["tasks"][0]["owner"] == "Martin"
    assert "not-yours" not in str(data) and "Je vais vérifier" in str(data)


def test_orphaned_capture_can_be_deleted_after_expiry_without_calling_ai(service):
    async def require_user(request, db):
        return {"user_id": "one"}
    app = FastAPI()
    app.include_router(make_meeting_router(service, require_user), prefix="/api")
    identity = capture(service)
    run(service.db.sirius_meetings.update_one({"id": identity}, {"$set": {
        "expires_at": "2000-01-01T00:00:00+00:00"}}))
    assert TestClient(app).delete(f"/api/integrations/meetings/{identity}").status_code == 200
    service.specialists.complete.assert_not_called()

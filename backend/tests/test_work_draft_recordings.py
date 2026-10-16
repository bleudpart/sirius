import asyncio
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

import work_draft_recordings
from local_docstore import DatabaseRouter, LocalDocStore
from test_work_conversation import ask, dossier, harness, run, seed_invoice
from work_draft_recordings import insert_once


HEADERS = {"x-test-user": "u1"}
ROOT = "/api/work-dossiers/draft-recordings"


def prepare(harness, *, endpoint="/api/chat"):
    chat, work, db, _ = harness
    did = dossier(work)
    seed_invoice(db, did)
    ask(chat, "Prépare la relance de la facture FAC-42 du dossier Client Martin", endpoint=endpoint)
    return did


def stage(chat):
    return ask(chat, "Enregistre ce brouillon")["work_recording"]


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_explicit_recording_requires_distinct_confirmation_and_retries_are_idempotent(harness, endpoint):
    chat, work, db, _ = harness
    did = prepare(harness, endpoint=endpoint)
    operation = stage(chat)
    assert operation["state"] == "AWAITING_CONFIRMATION"
    assert operation["recorded"] == 0 and not operation["approved"]
    assert run(db.sirius_work_entries.count_documents({})) == 0
    assert stage(chat)["id"] == operation["id"]
    assert ask(chat, "Oui")["work_state"] == "NOT_EXECUTED"
    assert ask(chat, "Envoie-les")["work_state"] == "NOT_EXECUTED"
    assert run(db.sirius_work_entries.count_documents({})) == 0
    result = ask(chat, f"Confirme l'enregistrement {operation['id']}", endpoint=endpoint)
    assert result["work_state"] == "RECORDED"
    assert result["executed"] is False and result["persisted"] is True
    assert "Aucun message envoyé" in result["answer"]
    for command in (f"Confirme l'enregistrement {operation['id']}",
                    f"Reprends l'enregistrement {operation['id']}",
                    f"Suivi de l'enregistrement {operation['id']}"):
        assert ask(chat, command)["work_recording"]["recorded"] == 1
    entries = run(db.sirius_work_entries.find({}).to_list(10))
    assert len(entries) == 1
    assert entries[0]["dossier_id"] == did
    assert entries[0]["status"] == "proposed"
    assert entries[0]["content"]["remaining"] == 100
    assert entries[0]["recording_id"] == operation["id"]
    thread = work.get(f"/api/work-dossiers/{did}/thread", headers=HEADERS).json()
    assert thread["entries"][0]["id"] == entries[0]["id"]
    assert run(db.themis_docs.find_one({"id": "invoice-42"}))["paid"] == 20


def test_recording_api_strict_confirmation_and_account_isolation(harness):
    _, work, db, _ = harness
    did = prepare(harness)
    response = work.post(ROOT, headers=HEADERS, json={"session_id": "main", "dossier_id": did})
    assert response.status_code == 200
    operation_id = response.json()["id"]
    path = f"{ROOT}/{operation_id}/confirm"
    for value in (False, "true", 1, None):
        assert work.post(path, headers=HEADERS, json={"confirmed": value}).status_code == 422
    assert work.post(path, json={"confirmed": True}).status_code == 401
    assert work.post(path, headers={"x-test-user": "u2"}, json={"confirmed": True}).status_code == 404
    assert work.get(f"{ROOT}/{operation_id}", headers={"x-test-user": "u2"}).status_code == 404
    assert work.post(ROOT, headers={"x-test-user": "u2"},
                     json={"session_id": "main", "dossier_id": did}).status_code == 404
    assert run(db.sirius_work_entries.count_documents({})) == 0
    assert work.post(path, headers=HEADERS, json={"confirmed": True}).json()["recorded"] == 1


def test_source_change_before_confirmation_blocks_without_overwriting_a_draft(harness):
    chat, _, db, _ = harness
    prepare(harness)
    operation = stage(chat)
    run(db.themis_docs.update_one({"id": "invoice-42"}, {"$set": {"paid": 50}}))
    result = ask(chat, f"Confirme l'enregistrement {operation['id']}")
    assert result["work_recording"]["recorded"] == 0
    assert result["work_recording"]["items"][0]["state"] == "blocked"
    assert result["work_recording"]["items"][0]["content"] is None
    assert run(db.sirius_work_entries.count_documents({})) == 0


@pytest.mark.parametrize("change", ["paid", "email", "unlink", "permission"])
def test_stage_revalidates_source_and_dossier_membership(harness, change):
    chat, _, db, _ = harness
    did = prepare(harness)
    if change == "paid":
        run(db.themis_docs.update_one({"id": "invoice-42"}, {"$set": {"paid": 120}}))
    elif change == "email":
        run(db.themis_clients.update_one({"id": "client-invoice-42"}, {"$set": {"email": "changed@example.test"}}))
    elif change == "permission":
        run(db.themis_docs.update_one({"id": "invoice-42"}, {"$set": {"user_id": "u2"}}))
    else:
        run(db.sirius_work_dossiers.update_one({"id": did}, {"$set": {"sources": []}}))
    response = chat.post("/api/chat", headers=HEADERS, json={
        "text": "Enregistre ce brouillon", "session_id": "main",
    })
    assert response.status_code == 409
    assert run(db.sirius_work_entries.count_documents({})) == 0
    assert run(db.sirius_work_recordings.count_documents({})) == 0


def test_batch_requires_explicit_destination_and_only_records_linked_eligible_sources(harness):
    chat, work, db, _ = harness
    did = dossier(work)
    for source_id in ("one", "two", "unlinked"):
        seed_invoice(db, did, source_id=source_id, number="FAC-" + source_id)
        run(db.themis_docs.update_one({"id": source_id}, {
            "$set": {"due_date": (datetime.now(timezone.utc) - timedelta(days=20)).date().isoformat()},
        }))
    run(db.sirius_work_dossiers.update_one({"id": did}, {
        "$set": {"sources": [{"kind": "facture", "id": source_id} for source_id in ("one", "two")]},
    }))
    ask(chat, "Prépare les relances de mes factures en retard de plus de 15 jours")
    assert ask(chat, "Enregistre ce brouillon")["work_state"] == "NEEDS_CLARIFICATION"
    result = ask(chat, "Enregistre ces préparations dans le dossier Client Martin")
    operation = result["work_recording"]
    assert operation["total"] == 2
    assert len(operation["blocked_at_preparation"]) == 1
    assert operation["recorded"] == 0
    run(db.themis_docs.update_one({"id": "two"}, {"$set": {"paid": 120}}))
    result = ask(chat, f"Confirme l'enregistrement {operation['id']}")
    assert result["work_state"] == "PARTIAL"
    assert result["work_recording"]["recorded"] == 1
    assert result["work_recording"]["total"] == 2
    entries = work.get(f"/api/work-dossiers/{did}/thread", headers=HEADERS).json()["entries"]
    assert len(entries) == 1 and entries[0]["sources"][0]["id"] == "one"


def test_interrupted_recording_resumes_after_restart_without_a_duplicate(harness, monkeypatch):
    import server
    from routes.work_dossiers import make_work_dossiers_router
    from work_conversation import WorkConversation

    chat, work, db, _ = harness
    did = prepare(harness)
    seed_invoice(db, did, source_id="second", number="FAC-43")
    # Prepare an authorized batch through the same conversational reader.
    for source_id in ("invoice-42", "second"):
        run(db.themis_docs.update_one({"id": source_id}, {
            "$set": {"due_date": (datetime.now(timezone.utc) - timedelta(days=20)).date().isoformat()},
        }))
    ask(chat, "Prépare les relances de mes factures en retard de plus de 15 jours")
    operation = ask(chat, "Enregistre ces préparations dans le dossier Client Martin")["work_recording"]
    original = work_draft_recordings.insert_once
    inserted = []

    async def fail_second_entry(database, collection, document):
        if collection == "sirius_work_entries":
            if inserted:
                raise sqlite3.OperationalError("simulated connection loss")
            inserted.append(document["id"])
        return await original(database, collection, document)

    monkeypatch.setattr(work_draft_recordings, "insert_once", fail_second_entry)
    response = chat.post("/api/chat", headers=HEADERS, json={
        "text": f"Confirme l'enregistrement {operation['id']}", "session_id": "main",
    })
    assert response.status_code == 503
    assert "partiel" in response.json()["detail"]
    assert run(db.sirius_work_entries.count_documents({})) == 1
    monkeypatch.setattr(work_draft_recordings, "insert_once", original)

    async def auth(request, _db):
        return {"user_id": request.headers["x-test-user"]}

    restarted_db = DatabaseRouter(LocalDocStore(db._path))
    restarted = WorkConversation(restarted_db)
    make_work_dossiers_router(restarted_db, auth, conversation=restarted)
    monkeypatch.setattr(server, "work_conversation", restarted)
    status = ask(chat, f"Suivi de l'enregistrement {operation['id']}", session="new-session")
    assert status["work_state"] == "PARTIAL"
    resumed = ask(chat, f"Reprends l'enregistrement {operation['id']}", session="new-session")
    assert resumed["work_state"] == "RECORDED"
    assert resumed["work_recording"]["recorded"] == 2
    assert run(db.sirius_work_entries.count_documents({})) == 2
    assert work.get(f"/api/work-dossiers/{did}/thread", headers=HEADERS).status_code == 200


def test_resume_is_not_a_substitute_for_first_confirmation(harness):
    chat, _, db, _ = harness
    prepare(harness)
    operation = stage(chat)
    result = ask(chat, f"Reprends l'enregistrement {operation['id']}")
    assert result["work_state"] == "AWAITING_CONFIRMATION"
    assert run(db.sirius_work_entries.count_documents({})) == 0


def test_operation_expiry_preserves_existing_entries_but_prevents_new_writes(harness):
    chat, _, db, _ = harness
    prepare(harness)
    operation = stage(chat)
    run(db.sirius_work_recordings.update_one({"id": operation["id"]}, {
        "$set": {"expires_at": "2000-01-01T00:00:00+00:00"},
    }))
    result = ask(chat, f"Confirme l'enregistrement {operation['id']}")
    assert result["work_state"] == "EXPIRED"
    assert run(db.sirius_work_entries.count_documents({})) == 0
    assert not result["work_recording"]["approved"]


def test_status_masks_old_contents_after_source_revocation(harness):
    chat, _, db, _ = harness
    prepare(harness)
    operation = stage(chat)
    ask(chat, f"Confirme l'enregistrement {operation['id']}")
    run(db.themis_docs.update_one({"id": "invoice-42"}, {"$set": {"user_id": "u2"}}))
    result = ask(chat, f"Suivi de l'enregistrement {operation['id']}")
    assert result["work_recording"]["recorded"] == 1
    assert "martin@example.test" not in str(result)
    assert result["work_recording"]["items"][0]["content"] is None


def test_cancellation_or_context_expiry_prevents_staging_old_preview(harness):
    chat, _, db, _ = harness
    prepare(harness)
    ask(chat, "Annule")
    response = chat.post("/api/chat", headers=HEADERS,
                         json={"text": "Enregistre ce brouillon", "session_id": "main"})
    assert response.status_code == 200
    assert response.json()["work_state"] == "NEEDS_CLARIFICATION"
    assert run(db.sirius_work_entries.count_documents({})) == 0


def test_unique_insert_is_atomic_across_separate_store_connections(tmp_path):
    path = tmp_path / "atomic.db"
    LocalDocStore(path)

    def insert(index):
        return run(insert_once(DatabaseRouter(LocalDocStore(path)), "sirius_work_entries", {
            "user_id": "u1", "id": "same-id", "index": index,
        }))

    with ThreadPoolExecutor(max_workers=8) as workers:
        results = list(workers.map(insert, range(16)))
    assert sum(created for _, created in results) == 1
    assert len({document["index"] for document, _ in results}) == 1
    assert run(LocalDocStore(path).sirius_work_entries.count_documents({})) == 1


def test_mongo_insert_uses_native_unique_id_and_only_accepts_real_duplicates():
    document = {"id": "same", "user_id": "u1", "value": 42}
    collection = AsyncMock()
    collection.insert_one.side_effect = DuplicateKeyError("duplicate")
    collection.find_one.return_value = document
    result = run(insert_once({"records": collection}, "records", document))
    assert result == (document, False)
    native_id = collection.insert_one.call_args.args[0]["_id"]
    assert len(native_id) == 64
    collection.find_one.return_value = None
    with pytest.raises(DuplicateKeyError):
        run(insert_once({"records": collection}, "records", document))


def test_unexpected_business_error_is_not_silently_treated_as_a_blocked_item(harness, monkeypatch):
    _, work, _, service = harness
    prepare(harness)

    async def unavailable(*_args):
        raise HTTPException(503, "Source indisponible.")

    monkeypatch.setattr(service.recordings, "preview_invoice", unavailable)
    response = work.post(ROOT, headers=HEADERS, json={"dossier_id": run(
        service.db.sirius_work_dossiers.find_one({"user_id": "u1"}))["id"], "session_id": "main"})
    assert response.status_code == 503


def test_contextual_confirmation_is_scoped_to_latest_operation_and_cleared_context(harness):
    chat, _, db, _ = harness
    prepare(harness)
    operation = stage(chat)
    denied = ask(chat, "Confirme l'enregistrement des brouillons", environment={"work_context_clear": True})
    assert denied["work_state"] == "NEEDS_CLARIFICATION"
    assert run(db.sirius_work_entries.count_documents({})) == 0
    assert ask(chat, "Confirme l'enregistrement des brouillons")["work_state"] == "NEEDS_CLARIFICATION"
    result = ask(chat, f"Confirme l'enregistrement {operation['id']}")
    assert result["work_recording"]["id"] == operation["id"]
    assert result["work_state"] == "RECORDED"


def test_contextual_confirmation_never_crosses_account_or_session(harness):
    chat, _, db, _ = harness
    prepare(harness)
    stage(chat)
    for kwargs in ({"uid": "u2"}, {"session": "another"}):
        result = ask(chat, "Confirme l'enregistrement des brouillons", **kwargs)
        assert result["work_state"] == "NEEDS_CLARIFICATION"
    assert run(db.sirius_work_entries.count_documents({})) == 0


def test_persistent_listing_recovers_references_but_does_not_disclose_foreign_requests(harness):
    chat, work, _, _ = harness
    prepare(harness)
    operation = stage(chat)
    result = ask(chat, "Liste mes enregistrements de brouillons", session="after-restart")
    assert result["work_recordings"]["items"][0]["id"] == operation["id"]
    assert result["work_recordings"]["items"][0]["recorded"] == 0
    assert work.get(ROOT, headers=HEADERS).json()["items"][0]["id"] == operation["id"]
    assert work.get(ROOT, headers={"x-test-user": "u2"}).json()["items"] == []
    assert work.get(ROOT).status_code == 401


@pytest.mark.parametrize("text", [
    "Enregistre ce brouillon et envoie-le",
    "Confirme l'enregistrement des brouillons et envoie-les",
    "Confirme l'enregistrement",
    "Enregistre ces préparations dans le dossier inconnu",
])
def test_ambiguous_or_combined_commands_never_record_or_send(harness, text):
    chat, _, db, _ = harness
    prepare(harness)
    stage(chat)
    result = ask(chat, text)
    assert result["work_state"] == "NEEDS_CLARIFICATION"
    assert run(db.sirius_work_entries.count_documents({})) == 0


def test_changed_screen_cannot_record_an_old_single_preview(harness):
    chat, _, db, _ = harness
    prepare(harness)
    result = chat.post("/api/chat", headers=HEADERS, json={
        "text": "Enregistre ce brouillon", "session_id": "main",
        "environment": {"work_dossier_id": "another-dossier"},
    })
    assert result.status_code == 409
    assert run(db.sirius_work_entries.count_documents({})) == 0


def test_expired_session_cannot_stage_a_persistent_request(harness):
    chat, work, db, _ = harness
    did = prepare(harness)
    run(db.sirius_work_contexts.update_one({"user_id": "u1", "session_id": "main"}, {
        "$set": {"expires_at": "2000-01-01T00:00:00+00:00"},
    }))
    response = work.post(ROOT, headers=HEADERS, json={"session_id": "main", "dossier_id": did})
    assert response.status_code == 409
    assert run(db.sirius_work_recordings.count_documents({})) == 0
    assert ask(chat, "Enregistre ce brouillon")["work_state"] == "NEEDS_CLARIFICATION"


def test_all_retained_drafts_are_shown_before_a_batch_confirmation():
    from work_draft_recordings import recording_report

    result = {
        "id": "test", "dossier_id": "dossier", "recorded": 0, "total": 12,
        "state": "AWAITING_CONFIRMATION", "expires_at": "2100-01-01T00:00:00+00:00",
        "blocked_at_preparation": [],
        "items": [
            {"source": {"id": f"invoice-{index}"}, "entry_id": None,
             "reason": "À relire", "content": {"to": f"client-{index}@example.test",
                                              "subject": f"Relance {index}", "message": f"Texte {index}."}}
            for index in range(12)
        ],
    }
    report = recording_report(result)
    assert "client-11@example.test" in report
    assert "Texte 11." in report
    assert "Confirme l'enregistrement des brouillons" in report


def test_concurrent_confirmations_create_one_entry_per_recording(harness):
    chat, work, db, _ = harness
    prepare(harness)
    operation = stage(chat)

    def confirm(_index):
        return work.post(f"{ROOT}/{operation['id']}/confirm", headers=HEADERS,
                         json={"confirmed": True})

    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(confirm, range(8)))
    assert all(result.status_code == 200 and result.json()["recorded"] == 1 for result in results)
    assert run(db.sirius_work_entries.count_documents({})) == 1

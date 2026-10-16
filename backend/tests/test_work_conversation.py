import asyncio
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import server
import work_conversation as conversation_module
from local_docstore import LocalDocStore
from routes.work_dossiers import make_work_dossiers_router
from work_conversation import WorkConversation, WorkReaders, work_intent


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def harness(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "work.db")

    async def user(request, _db):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401)
        result = {"user_id": uid}
        if request.headers.get("x-test-company"):
            result["company_id"] = request.headers["x-test-company"]
        return result

    service = WorkConversation(db)
    router = make_work_dossiers_router(db, user, conversation=service)
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "work_conversation", service)
    monkeypatch.setattr(server, "require_user", user)
    monkeypatch.setattr(server, "_rate_ok", lambda _uid: True)

    async def no_relay(*_args, **_kwargs):
        pytest.fail("A work read must not use a cloud provider")

    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda _keys: True)
    monkeypatch.setattr(server.cloud_link, "relay_json", no_relay)
    app = FastAPI()
    app.include_router(server.api_router)
    # The API above holds its original work router; the isolated router supplies
    # the actual authorized readers and fixture setup endpoints.
    setup = FastAPI()
    setup.include_router(router, prefix="/api")
    with TestClient(app) as chat, TestClient(setup) as work:
        yield chat, work, db, service


def dossier(work, title="Client Martin", uid="u1"):
    response = work.post("/api/work-dossiers", headers={"x-test-user": uid}, json={"title": title})
    assert response.status_code == 201
    return response.json()["dossier"]["id"]


def ask(client, text, *, uid="u1", session="main", environment=None, endpoint="/api/chat", headers=None):
    response = client.post(endpoint, headers={"x-test-user": uid, **(headers or {})},
                           json={"text": text, "session_id": session, "environment": environment or {}})
    assert response.status_code == 200, response.text
    if endpoint.endswith("/stream"):
        return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")][-1]
    return response.json()


@pytest.mark.parametrize("text", [
    "Qu'ai-je à traiter aujourd'hui ?", "Qu'est-ce que je dois traiter aujourd'hui ?",
    "Où en est ce dossier ?", "Résume le dossier Martin", "Pourquoi ces propositions ?",
    "Prépare une relance de facture", "Liste mes dossiers", "Oublie ce dossier",
    "Compare les dossiers Martin et Dupont", "Résume mes dossiers",
    "Qu'est-ce qui a changé depuis ma dernière visite ?",
    "Envoie la facture du dossier Martin", "Surveille le dossier Martin",
])
def test_work_routing(text):
    assert work_intent(text)


@pytest.mark.parametrize("text", [
    "Ouvre mes dossiers", "Ferme ce dossier", "La météo demain",
    "Ajoute un rendez-vous demain de 14 h à 15 h", "Les résultats sportifs",
])
def test_other_routes_preserved(text):
    assert work_intent(text) is None


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_daily_read_is_fast_grounded_and_never_uses_ai(harness, endpoint):
    chat, work, db, _ = harness
    dossier(work)
    run(db.themis_items.insert_one({"id": "stock", "user_id": "u1", "name": "Café", "stock": 1, "alert": 5}))
    started = time.monotonic()
    result = ask(chat, "Qu'ai-je à traiter aujourd'hui ?", endpoint=endpoint)
    assert time.monotonic() - started < 2
    assert result["work_state"] == "READ_ONLY"
    assert result["executed"] is False
    assert "Café" in result["answer"]
    assert "Validations de dossier à examiner : 0" in result["answer"]
    assert result["work_sources"][0]["module"] == "work-dossiers"
    assert run(db.sirius_chats.find_one({"session_id": "u1:main"}))["user_id"] == "u1"
    assert run(db.sirius_work_entries.count_documents({})) == 0


def test_context_is_scoped_expires_and_rereads_notes(harness):
    chat, work, db, _ = harness
    did = dossier(work)
    result = ask(chat, "Où en est le dossier Client Martin ?")
    assert result["work_context"]["dossier_id"] == did
    work.post(f"/api/work-dossiers/{did}/notes", headers={"x-test-user": "u1"}, json={"text": "Rappeler lundi"})
    assert "Rappeler lundi" in ask(chat, "Résume ce dossier")["answer"]
    assert ask(chat, "Résume ce dossier", uid="u2")["work_state"] == "NEEDS_CLARIFICATION"
    assert ask(chat, "Résume ce dossier", session="another")["work_state"] == "NEEDS_CLARIFICATION"
    run(db.sirius_work_contexts.update_one({"user_id": "u1"}, {
        "$set": {"expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()},
    }))
    assert ask(chat, "Résume ce dossier")["work_state"] == "NEEDS_CLARIFICATION"


def test_explicit_screen_context_is_reauthorized_and_can_be_cleared(harness):
    chat, work, db, _ = harness
    did = dossier(work)
    assert ask(chat, "Où en est ce dossier ?", environment={"work_dossier_id": did})["work_context"]["dossier_id"] == did
    response = chat.post("/api/chat", headers={"x-test-user": "u2"},
                         json={"text": "Résume ce dossier", "environment": {"work_dossier_id": did}})
    assert response.status_code == 404
    assert ask(chat, "Résume ce dossier", environment={"work_context_clear": True})["work_state"] == "NEEDS_CLARIFICATION"
    ask(chat, "Résume ce dossier", environment={"work_dossier_id": did})
    assert ask(chat, "Oublie ce dossier")["work_context_cleared"]
    assert run(db.sirius_work_dossiers.count_documents({"id": did})) == 1
    assert ask(chat, "Résume ce dossier")["work_state"] == "NEEDS_CLARIFICATION"


def test_ambiguous_or_unknown_names_do_not_use_old_context(harness):
    chat, work, _, _ = harness
    dossier(work, "Martin")
    dossier(work, "Dupont")
    ask(chat, "Résume le dossier Martin")
    unknown = ask(chat, "Résume le dossier Inconnu")
    assert unknown["work_state"] == "NEEDS_CLARIFICATION"
    assert unknown["work_context_cleared"] is True
    assert ask(chat, "Résume ce dossier")["work_state"] == "NEEDS_CLARIFICATION"
    ask(chat, "Résume le dossier Martin")
    assert ask(chat, "Compare les dossiers Martin et Dupont")["work_state"] == "NEEDS_CLARIFICATION"
    assert ask(chat, "Résume ce dossier")["work_state"] == "NEEDS_CLARIFICATION"
    dossier(work, "Martin")
    assert ask(chat, "Résume le dossier Martin")["work_state"] == "NEEDS_CLARIFICATION"


def test_longer_title_and_sensitive_requests_are_not_fake_success(harness):
    chat, work, db, _ = harness
    dossier(work, "Martin")
    did = dossier(work, "Martin chantier")
    result = ask(chat, "Prépare la relance pour le dossier Martin chantier")
    assert result["work_context"]["dossier_id"] == did
    assert result["work_state"] == "NOT_EXECUTED"
    assert "aucune surveillance activée" in result["answer"]
    assert run(db.sirius_work_entries.count_documents({})) == 0
    assert "référence exacte" in ask(chat, "Retrouve le dernier devis de ce client")["answer"]


def test_revoked_sources_are_not_disclosed(harness):
    chat, work, db, _ = harness
    did = dossier(work)
    run(db.haccp_nc.insert_one({"id": "secret", "company_id": "company", "description": "SECRET HACCP", "statut": "ouvert"}))
    run(db.sirius_work_dossiers.update_one({"id": did}, {
        "$set": {"sources": [{"kind": "haccp_nonconformity", "id": "secret"}]},
    }))
    result = ask(chat, "Résume ce dossier", environment={"work_dossier_id": did}, headers={"x-test-company": "company"})
    assert "SECRET HACCP" not in result["answer"]
    assert result["work_sources"] == []
    assert "1 source(s) ne sont plus accessibles" in result["answer"]


def test_conversation_rereads_source_changes_and_explains_rules(harness):
    chat, work, db, _ = harness
    did = dossier(work)
    run(db.themis_items.insert_one({"id": "stock", "user_id": "u1", "name": "Café", "stock": 4, "alert": 5}))
    run(db.sirius_work_dossiers.update_one({"id": did}, {
        "$set": {"sources": [{"kind": "stock", "id": "stock"}]},
    }))
    base = f"/api/work-dossiers/{did}"
    assert work.post(base + "/snapshots", headers={"x-test-user": "u1"}).status_code == 201
    ask(chat, "Résume le dossier Client Martin")
    run(db.themis_items.update_one({"id": "stock"}, {"$set": {"stock": 1}}))
    result = ask(chat, "Qu'est-ce qui a changé depuis ma dernière visite ?")
    assert "stock : 4 → 1" in result["answer"]
    explanation = ask(chat, "Pourquoi ces propositions ?")
    assert "Pourquoi ces propositions" in explanation["answer"]
    assert "Café" in explanation["answer"]
    assert run(db.sirius_work_entries.count_documents({})) == 0


def test_blocking_sqlite_reader_does_not_prevent_timeout_or_save_late_context(harness, monkeypatch):
    chat, work, db, service = harness
    did = dossier(work)
    original = service.readers

    async def blocking_thread(*args, **kwargs):
        time.sleep(0.1)
        return await original.thread(*args, **kwargs)

    service.readers = WorkReaders(original.day, original.dossiers, blocking_thread, original.queue)
    monkeypatch.setattr(conversation_module, "READ_TIMEOUT", 0.02)
    response = chat.post("/api/chat", headers={"x-test-user": "u1"},
                         json={"text": "Résume ce dossier", "environment": {"work_dossier_id": did}})
    assert response.status_code == 503
    time.sleep(0.15)
    assert run(db.sirius_work_contexts.count_documents({})) == 0


def test_missing_readers_and_timeouts_are_explicit(harness, monkeypatch):
    chat, _, _, service = harness
    original = service.readers
    service.readers = None
    response = chat.post("/api/chat", headers={"x-test-user": "u1"}, json={"text": "Mes priorités"})
    assert response.status_code == 503

    async def slow(*_args, **_kwargs):
        await asyncio.sleep(1)
        return {}

    monkeypatch.setattr(conversation_module, "READ_TIMEOUT", 0.01)
    service.readers = WorkReaders(slow, original.dossiers, original.thread, slow)
    response = chat.post("/api/chat", headers={"x-test-user": "u1"}, json={"text": "Mes priorités"})
    assert response.status_code == 503
    assert "Aucune action effectuée" in response.text


def test_invalid_timezone_and_unauthenticated_reads(harness):
    chat, _, _, _ = harness
    assert chat.post("/api/chat", json={"text": "Mes priorités"}).status_code == 401
    response = chat.post("/api/chat", headers={"x-test-user": "u1"},
                         json={"text": "Mes priorités", "environment": {"timezone": "invalid"}})
    assert response.status_code == 422

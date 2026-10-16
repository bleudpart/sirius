import asyncio
import json
from contextlib import asynccontextmanager
from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import chronos_assistant as assistant
from chronos_store import ChronosStore
from local_docstore import LocalDocStore


def tool(name, arguments):
    call = SimpleNamespace(id="call_1", function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))
    class Message:
        tool_calls = [call]
        content = None

        def model_dump(self, **_kwargs):
            return {"role": "assistant", "tool_calls": [{"id": call.id, "type": "function",
                    "function": {"name": name, "arguments": call.function.arguments}}]}
    return Message()


EVENT = {"title": "Client Martin", "start": "2026-10-17T14:00:00+02:00",
         "end": "2026-10-17T15:00:00+02:00", "timezone": "Europe/Paris", "notes": "Devis"}


@pytest.fixture
def harness(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "actions.db")
    store = ChronosStore(tmp_path / "agenda.db")
    calls = []

    @asynccontextmanager
    async def meter(*_args, **_kwargs):
        yield {}

    import provider_access
    monkeypatch.setattr(provider_access, "metered_scope", meter)

    async def next_tool(*_args):
        return calls.pop(0)
    monkeypatch.setattr(assistant, "_next_tool", next_tool)

    async def ask(text, uid="u1", session="main", history=None):
        req = SimpleNamespace(text=text, session_id=session, keys={}, environment={"timezone": "Europe/Paris"})
        return await assistant.handle_chronos_chat(req, {"user_id": uid}, db, history or [], store)
    return ask, calls, store, db


def run(coro):
    return asyncio.run(coro)


def test_prepare_create_requires_one_use_account_session_bound_confirmation(harness):
    ask, calls, store, _db = harness
    calls.append(tool("chronos_create", EVENT))
    proposal = run(ask("Ajoute un rendez-vous Client Martin demain de 14h à 15h"))
    assert proposal["state"] == "WAITING_CONFIRMATION"
    token = proposal["pending_token"]
    assert store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"] == []
    assert "expirée" in run(ask(f"confirme agenda {token}", uid="u2"))["answer"]
    assert "expirée" in run(ask(f"confirme agenda {token}", session="other"))["answer"]
    result = run(ask(f"confirme agenda {token}"))
    assert result["changed"] is True
    assert len(store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"]) == 1
    replay = run(ask(f"confirme agenda {token}"))
    assert not replay.get("changed")
    assert len(store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"]) == 1


def test_cancel_and_expiry_never_write(harness):
    ask, calls, store, db = harness
    calls.append(tool("chronos_create", EVENT))
    proposal = run(ask("Ajoute un rendez-vous"))
    assert "annulée" in run(ask(f"annule agenda {proposal['pending_token']}"))["answer"]
    calls.append(tool("chronos_create", EVENT))
    proposal = run(ask("Ajoute un rendez-vous"))
    run(db.chronos_actions.update_one({"token": proposal["pending_token"]},
                                    {"$set": {"expires_at": "2000-01-01T00:00:00+00:00"}}))
    assert "expirée" in run(ask(f"confirme agenda {proposal['pending_token']}"))["answer"]
    assert not store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"]


def test_update_requires_read_and_current_revision(harness):
    ask, calls, store, _db = harness
    event = store.create_event("u1", EVENT)["event"]
    update = {**EVENT, "title": "Client reporté", "event_id": event["id"], "revision": event["revision"]}
    calls.append(tool("chronos_update", update))
    assert "incomplète" in run(ask("Modifie mon rendez-vous"))["answer"]
    calls.extend([tool("chronos_list", {"on": "2026-10-17", "timezone": "Europe/Paris"}),
                  tool("chronos_update", update)])
    proposal = run(ask("Modifie mon rendez-vous"))
    assert proposal["pending_token"]
    store.update_event("u1", event["id"], {**EVENT, "title": "Modifié ailleurs", "revision": event["revision"]})
    result = run(ask(f"confirme agenda {proposal['pending_token']}"))
    assert "non effectuée" in result["answer"]
    assert store.get_event("u1", event["id"])["title"] == "Modifié ailleurs"


def test_listing_is_factual_and_other_accounts_never_exposed(harness):
    ask, calls, store, _db = harness
    store.create_event("u1", EVENT)
    store.create_event("u2", {**EVENT, "title": "Secret autre compte"})
    calls.extend([tool("chronos_list", {"on": "2026-10-17", "timezone": "Europe/Paris"}),
                  SimpleNamespace(tool_calls=None, content="Voici votre agenda.")])
    result = run(ask("Quel est mon agenda ?"))
    assert "Client Martin" in result["answer"] and "14:00" in result["answer"]
    assert "Secret autre compte" not in result["answer"]
    assert not result.get("changed")


def test_invalid_and_multiple_tools_never_mutate(harness):
    ask, calls, store, _db = harness
    calls.append(tool("chronos_create", {**EVENT, "end": "2026-10-17T13:00:00+02:00"}))
    assert not run(ask("Ajoute un rendez-vous")).get("pending_token")
    calls.append(tool("chronos_create", {**EVENT, "user_id": "other"}))
    assert not run(ask("Ajoute un rendez-vous")).get("pending_token")
    message = tool("chronos_create", EVENT)
    message.tool_calls = message.tool_calls * 2
    calls.append(message)
    assert "un seul" in run(ask("Ajoute un rendez-vous"))["answer"]
    assert not store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"]


def test_other_requests_and_explicit_external_calendar_are_untouched(harness):
    ask, _calls, _store, _db = harness
    assert run(ask("Bonjour")) is None
    assert run(ask("Mon agenda Outlook")) is None


def test_new_overlap_after_proposal_forces_new_confirmation(harness):
    ask, calls, store, _db = harness
    calls.append(tool("chronos_create", EVENT))
    proposal = run(ask("Ajoute un rendez-vous"))
    store.create_event("u1", {**EVENT, "title": "Ajout concurrent"})
    result = run(ask(f"confirme agenda {proposal['pending_token']}"))
    assert "non effectuée" in result["answer"]
    assert not result.get("changed")
    assert [item["title"] for item in store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"]] == ["Ajout concurrent"]


def test_overlap_preview_covers_entire_multiday_interval(harness):
    ask, calls, store, _db = harness
    store.create_event("u1", {**EVENT, "title": "Jour suivant",
        "start": "2026-10-18T10:00:00+02:00", "end": "2026-10-18T11:00:00+02:00"})
    calls.append(tool("chronos_create", {**EVENT, "end": "2026-10-18T12:00:00+02:00"}))
    proposal = run(ask("Ajoute un rendez-vous jusqu'à demain"))
    assert "Jour suivant" in proposal["answer"]
    result = run(ask(f"confirme agenda {proposal['pending_token']}"))
    assert result["changed"]
    assert len(store.list_events("u1", date(2026, 10, 18), "Europe/Paris")["events"]) == 2


def test_delete_is_prepared_then_confirms_exact_revision(harness):
    ask, calls, store, _db = harness
    event = store.create_event("u1", EVENT)["event"]
    calls.extend([tool("chronos_list", {"on": "2026-10-17", "timezone": "Europe/Paris"}),
                  tool("chronos_delete", {"event_id": event["id"], "revision": event["revision"]})])
    proposal = run(ask("Supprime mon rendez-vous"))
    assert "Client Martin" in proposal["answer"]
    assert store.get_event("u1", event["id"])
    assert run(ask(f"confirme agenda {proposal['pending_token']}"))["changed"]
    assert not store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"]


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_both_chat_transports_use_authenticated_local_agenda(harness, monkeypatch, endpoint):
    ask, calls, store, db = harness
    import server
    original_handle = assistant.handle_chronos_chat
    async def handle(req, user, database, history):
        return await original_handle(req, user, database, history, store)
    async def user(request, _db):
        return {"user_id": request.headers.get("x-test-user", "u1")}
    monkeypatch.setattr(assistant, "handle_chronos_chat", handle)
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server, "require_user", user)
    monkeypatch.setattr(server, "_rate_ok", lambda _uid: True)
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda _keys: True)
    calls.append(tool("chronos_create", EVENT))
    app = FastAPI()
    app.include_router(server.api_router)
    with TestClient(app) as client:
        response = client.post(endpoint, json={"text": "Ajoute un rendez-vous", "session_id": "test"})
        assert response.status_code == 200
        if endpoint.endswith("stream"):
            frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
            result = frames[-1]
            assert frames[0]["type"] == "delta" and result["type"] == "done"
        else:
            result = response.json()
        assert result["chronos_state"] == "WAITING_CONFIRMATION"
        response = client.post(endpoint, json={"text": f"confirme agenda {result['chronos_pending']}", "session_id": "test"})
        assert response.status_code == 200 and "enregistré" in response.text
        assert len(store.list_events("u1", date(2026, 10, 17), "Europe/Paris")["events"]) == 1
        chat = run(db.sirius_chats.find_one({"session_id": "u1:test"}))
        assert chat["user_id"] == "u1"

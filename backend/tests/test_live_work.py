import asyncio
from unittest.mock import AsyncMock
from datetime import datetime, timezone

import pytest
from starlette.requests import Request

from live_work import compare_sources, explain_changes
from routes.work_dossiers import LiveSettingsIn
from test_work_dossiers import app_client


OWNER = {"x-test-user": "u1"}


def setup_dossier(client, db):
    async def seed():
        await db.themis_items.insert_one({
            "id": "item", "user_id": "u1", "name": "Papier", "stock": 2, "alert": 3,
        })
    asyncio.run(seed())
    did = client.post("/api/work-dossiers", headers=OWNER, json={"title": "Boutique"}).json()["dossier"]["id"]
    proposal = client.get("/api/work-dossiers/proposals", headers=OWNER).json()["proposals"][0]
    assert client.post(f"/api/work-dossiers/{did}/proposals/{proposal['id']}", headers=OWNER).status_code == 200
    return did


def update_stock(db, value):
    asyncio.run(db.themis_items.update_one({"id": "item", "user_id": "u1"}, {"$set": {"stock": value}}))


def enable(client, did, allow_ai=False):
    return client.put(f"/api/work-dossiers/{did}/live-settings", headers=OWNER,
                      json={"enabled": True, "allow_ai": allow_ai})


def evaluate(client, **kwargs):
    return client.post("/api/work-dossiers/live/evaluate", headers=OWNER, json=kwargs)


def test_disabled_by_default_and_owner_scoped(app_client, monkeypatch):
    client, db = app_client
    ai = AsyncMock()
    monkeypatch.setattr("routes.work_dossiers.explain_changes", ai)
    did = setup_dossier(client, db)
    assert evaluate(client).json()["updates"] == []
    assert client.get(f"/api/work-dossiers/{did}/live", headers=OWNER).json()["settings"]["enabled"] is False
    assert client.put(f"/api/work-dossiers/{did}/live-settings", headers={"x-test-user": "u2"},
                      json={"enabled": True, "allow_ai": True}).status_code == 404
    assert enable(client, did).status_code == 200
    assert evaluate(client).json()["updates"] == []
    update_stock(db, 1)
    update = evaluate(client).json()["updates"][0]
    field = next(f for f in update["changes"][0]["fields"] if f["name"] == "stock")
    assert field == {"name": "stock", "before": 2, "after": 1, "delta": "-1", "percent": "-50.00"}
    assert update["analysis"]["status"] == "not_authorized"
    assert update["executed"] is False
    assert evaluate(client).json()["updates"][0]["id"] == update["id"]
    ai.assert_not_awaited()
    assert asyncio.run(db.themis_items.find_one({"id": "item"}))["stock"] == 1


def test_ai_only_after_explicit_consent_and_only_changed_fields(app_client, monkeypatch):
    client, db = app_client
    ai = AsyncMock(return_value={"status": "ready", "text": "Vérifie le stock.", "error": ""})
    monkeypatch.setattr("routes.work_dossiers.explain_changes", ai)
    did = setup_dossier(client, db)
    enable(client, did, True)
    evaluate(client)
    ai.assert_not_awaited()
    update_stock(db, 1)
    result = evaluate(client, keys={"groq_key": "fake-key"}).json()["updates"][0]
    assert result["analysis"]["text"] == "Vérifie le stock."
    changes, keys = ai.call_args.args
    assert [f["name"] for f in changes[0]["fields"]] == ["stock"]
    assert "Papier" not in str(changes)
    assert keys == {"groq_key": "fake-key"}
    evaluate(client)
    ai.assert_awaited_once()
    assert "fake-key" not in str(asyncio.run(db.sirius_work_live_states.find_one({"dossier_id": did})))


def test_stop_erases_working_state_and_dismissal_persists(app_client):
    client, db = app_client
    did = setup_dossier(client, db)
    enable(client, did)
    update_stock(db, 1)
    event = evaluate(client).json()["updates"][0]
    assert client.post(f"/api/work-dossiers/{did}/live/dismiss", headers=OWNER, json={"text": event["id"]}).status_code == 200
    assert evaluate(client).json()["updates"] == []
    assert client.put(f"/api/work-dossiers/{did}/live-settings", headers=OWNER,
                      json={"enabled": False, "allow_ai": False}).status_code == 200
    assert asyncio.run(db.sirius_work_live_states.find_one({"dossier_id": did})) is None
    assert evaluate(client).json()["updates"] == []


def test_revoked_source_is_not_exposed_or_sent_to_ai(app_client, monkeypatch):
    client, db = app_client
    ai = AsyncMock(return_value={"status": "ready", "text": "Texte", "error": ""})
    monkeypatch.setattr("routes.work_dossiers.explain_changes", ai)
    did = setup_dossier(client, db)
    enable(client, did, True)
    update_stock(db, 1)
    evaluate(client)
    ai.reset_mock()
    asyncio.run(db.themis_items.update_one({"id": "item"}, {"$set": {"user_id": "u2", "stock": 0}}))
    assert client.get(f"/api/work-dossiers/{did}/live", headers=OWNER).json()["latest"] is None
    assert evaluate(client).json()["updates"] == []
    ai.assert_not_awaited()
    assert asyncio.run(db.sirius_work_live_states.find_one({"dossier_id": did}))["sources"] == []


def test_source_change_during_interpretation_discards_obsolete_analysis(app_client, monkeypatch):
    client, db = app_client
    did = setup_dossier(client, db)
    enable(client, did, True)
    update_stock(db, 1)

    async def changing(changes, keys):
        await db.themis_items.update_one({"id": "item"}, {"$set": {"stock": 0}})
        return {"status": "ready", "text": "Obsolète", "error": ""}

    monkeypatch.setattr("routes.work_dossiers.explain_changes", changing)
    assert evaluate(client).json()["updates"] == []
    assert client.get(f"/api/work-dossiers/{did}/live", headers=OWNER).json()["latest"] is None


def test_settings_reject_unknown_fields_and_invalid_boolean(app_client):
    client, db = app_client
    did = setup_dossier(client, db)
    for body in [{"enabled": "true", "allow_ai": False}, {"enabled": True, "allow_ai": False, "path": "C:"}]:
        assert client.put(f"/api/work-dossiers/{did}/live-settings", headers=OWNER, json=body).status_code == 422
    assert client.put(f"/api/work-dossiers/{did}/live-settings", headers=OWNER,
                      json={"enabled": False, "allow_ai": True}).status_code == 422


def test_zero_baseline_has_no_invented_percentage():
    before = [{"source": {"kind": "stock", "id": "one"}, "fingerprint": "a", "data": {"stock": 0}}]
    after = [{"source": {"kind": "stock", "id": "one"}, "fingerprint": "b", "data": {"stock": 3}}]
    assert compare_sources(before, after)[0]["fields"] == [{"name": "stock", "before": 0, "after": 3, "delta": "3"}]


def test_stale_event_hidden_and_ai_calls_grouped_for_one_minute(app_client, monkeypatch):
    client, db = app_client
    ai = AsyncMock(return_value={"status": "ready", "text": "Vérifier.", "error": ""})
    monkeypatch.setattr("routes.work_dossiers.explain_changes", ai)
    did = setup_dossier(client, db)
    enable(client, did, True)
    update_stock(db, 1)
    first = evaluate(client).json()["updates"][0]
    update_stock(db, 3)
    assert client.get(f"/api/work-dossiers/{did}/live", headers=OWNER).json()["latest"] is None
    assert evaluate(client).json()["updates"] == []
    ai.assert_awaited_once()
    state = asyncio.run(db.sirius_work_live_states.find_one({"dossier_id": did}))
    assert 55 < state["next_ai_at"] - datetime.now(timezone.utc).timestamp() <= 60
    update_stock(db, 4)
    asyncio.run(db.sirius_work_live_states.update_one({"dossier_id": did}, {"$set": {"next_ai_at": 0}}))
    second = evaluate(client).json()["updates"][0]
    assert second["id"] != first["id"]
    assert second["changes"][0]["fields"][0]["before"] == 1
    assert second["changes"][0]["fields"][0]["after"] == 4
    assert ai.await_count == 2


@pytest.mark.parametrize("enabled", [False, True])
def test_settings_can_revoke_consent_during_ai_without_restoring_old_result(app_client, monkeypatch, enabled):
    client, db = app_client
    did = setup_dossier(client, db)
    enable(client, did, True)
    update_stock(db, 1)
    settings_route = next(r.endpoint for r in client.app.routes if r.path.endswith("/{dossier_id}/live-settings"))

    async def revoke(changes, keys):
        request = Request({"type": "http", "headers": [(b"x-test-user", b"u1")]})
        await asyncio.wait_for(settings_route(did, LiveSettingsIn(enabled=enabled, allow_ai=False), request), 1)
        return {"status": "ready", "text": "Résultat périmé", "error": ""}

    monkeypatch.setattr("routes.work_dossiers.explain_changes", revoke)
    assert evaluate(client).json()["updates"] == []
    assert client.get(f"/api/work-dossiers/{did}/live", headers=OWNER).json()["latest"] is None
    state = asyncio.run(db.sirius_work_live_states.find_one({"dossier_id": did}))
    assert state is None if not enabled else state["latest"] is None


def test_over_limit_dossier_can_always_stop_and_credentials_are_bounded(app_client):
    client, db = app_client
    did = setup_dossier(client, db)
    enable(client, did)
    sources = [{"kind": "stock", "id": str(i)} for i in range(51)]
    asyncio.run(db.sirius_work_dossiers.update_one({"id": did}, {"$set": {"sources": sources}}))
    assert enable(client, did).status_code == 422
    assert client.put(f"/api/work-dossiers/{did}/live-settings", headers=OWNER,
                      json={"enabled": False, "allow_ai": False}).status_code == 200
    for keys in ({"unapproved": "key"}, {"groq_key": "k" * 513}, {"k3": 123}):
        assert evaluate(client, keys=keys).status_code == 422


def test_removed_field_is_reported_without_invented_numeric_delta():
    before = [{"source": {"kind": "stock", "id": "one"}, "fingerprint": "a", "data": {"stock": 2}}]
    after = [{"source": {"kind": "stock", "id": "one"}, "fingerprint": "b", "data": {}}]
    assert compare_sources(before, after)[0]["fields"] == [{"name": "stock", "before": 2, "after": None}]


def test_invalid_ai_payload_returns_explicit_error_without_network(monkeypatch):
    monkeypatch.setattr("sirius_brain.provider_key", lambda *args: "fake-key")
    result = asyncio.run(explain_changes([{"value": float("nan")}], {}))
    assert result["status"] == "error"
    assert result["error"]

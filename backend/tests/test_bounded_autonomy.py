import asyncio
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from action_registry import ActionDefinition, ActionInputs, ActionOutput, ActionRegistry
from action_runs import ActionRuns, RunIn
from bounded_autonomy import BoundedAutonomy, StartAutonomy, make_autonomy_router, now_utc
from local_docstore import LocalDocStore


def run(operation):
    return asyncio.run(operation)


@pytest.fixture
def harness(tmp_path):
    db = LocalDocStore(tmp_path / "autonomy.db")
    run(db.users.insert_one({"user_id": "one"}))
    handler = AsyncMock(return_value=ActionOutput(data={"summary": "lecture locale"}))
    registry = ActionRegistry()
    for name in ("budget.history", "lab.policy", "test.unapproved"):
        registry.register(ActionDefinition(name, "TEST", name, "1", ActionInputs, ActionOutput, handler))
    registry.register(ActionDefinition("finance.confirm", "TEST", "Sensible", "1",
                                       ActionInputs, ActionOutput, handler, kind="mutation", risk="sensitive"))
    return BoundedAutonomy(db, ActionRuns(db, registry)), handler


def plan(actions=("budget.history", "lab.policy")):
    return RunIn(request_id=uuid.uuid4(), objective="Bilan local", steps=[
        {"id": f"step{index}", "action": action, "depends_on": [f"step{index-1}"] if index else []}
        for index, action in enumerate(actions)])


def prepare_start(service, actions=("budget.history",), **limits):
    prepared = run(service.prepare("one", plan(actions)))
    run(service.start("one", prepared["id"], StartAutonomy(confirm=True, **limits)))
    return prepared["id"]


def ready(service, identity):
    run(service.db.sirius_autonomy_sessions.update_one({"id": identity, "user_id": "one"},
                                                      {"$set": {"next_check_at": now_utc().isoformat()}}))


def test_prepare_never_executes_then_dag_completes_verified_once(harness):
    service, handler = harness
    prepared = run(service.prepare("one", plan()))
    assert prepared["state"] == "PENDING"
    handler.assert_not_called()
    run(service.start("one", prepared["id"], StartAutonomy(confirm=True)))
    async def concurrent():
        await asyncio.gather(service.tick(), service.tick())
    run(concurrent())
    result = run(service.status("one", prepared["id"]))
    assert result["state"] == "COMPLETED" and result["run"]["state"] == "COMPLETED"
    assert result["cycles"] == 1 and handler.await_count == 2
    run(service.tick())
    assert handler.await_count == 2


@pytest.mark.parametrize("action", ["finance.confirm", "test.unapproved", "agents.mission"])
def test_nonallowlisted_actions_never_execute_or_persist_an_autonomous_plan(harness, action):
    service, handler = harness
    with pytest.raises(HTTPException) as blocked:
        run(service.prepare("one", plan((action,))))
    assert blocked.value.status_code == 422
    handler.assert_not_called()
    assert run(service.db.sirius_action_runs.count_documents({})) == 0


def test_retry_only_temporary_reads_and_never_repeat_completed_dependency(harness):
    service, handler = harness
    handler.side_effect = [ActionOutput(data={"summary": "saved"}),
                           HTTPException(503, "Temporaire"), ActionOutput(data={"summary": "recovered"})]
    identity = prepare_start(service, ("budget.history", "lab.policy"), max_cycles=2)
    run(service.tick())
    first = run(service.status("one", identity))
    assert first["state"] == "ACTIVE" and handler.await_count == 2
    run(service.tick())
    assert handler.await_count == 2
    ready(service, identity)
    run(service.tick())
    result = run(service.status("one", identity))
    assert result["state"] == "COMPLETED" and result["cycles"] == 2
    assert handler.await_count == 3
    assert result["run"]["steps"][0]["attempts"] == 1


@pytest.mark.parametrize("error", [HTTPException(401, "No"), HTTPException(403, "No"),
                                  HTTPException(429, "Quota"), HTTPException(422, "Inputs"), TimeoutError()])
def test_denials_and_uncertain_timeouts_are_never_retried(harness, error):
    service, handler = harness
    handler.side_effect = error
    identity = prepare_start(service)
    run(service.tick())
    assert run(service.status("one", identity))["state"] == "BLOCKED"
    ready(service, identity); run(service.tick())
    assert handler.await_count == 1


def test_partial_output_does_not_count_as_success_or_retry(harness):
    service, handler = harness
    handler.return_value = ActionOutput(completion="PARTIAL", issues=["Donnée manquante"], data={})
    identity = prepare_start(service)
    run(service.tick())
    result = run(service.status("one", identity))
    assert result["state"] == "BLOCKED" and result["run"]["state"] == "BLOCKED"
    assert handler.await_count == 1


def test_cycle_limit_stop_and_start_idempotency(harness):
    service, handler = harness
    handler.side_effect = HTTPException(503, "Temporaire")
    identity = prepare_start(service, max_cycles=1)
    run(service.tick())
    assert run(service.status("one", identity))["state"] == "BLOCKED"
    repeated = run(service.start("one", identity, StartAutonomy(confirm=True, max_cycles=3)))
    assert repeated["max_cycles"] == 1 and repeated["state"] == "BLOCKED"
    run(service.tick())
    assert handler.await_count == 1
    second = prepare_start(service)
    run(service.stop("one", second)); run(service.tick())
    assert run(service.status("one", second))["state"] == "STOPPED"
    assert handler.await_count == 1


def test_three_cycles_never_become_an_unbounded_retry_loop(harness):
    service, handler = harness
    handler.side_effect = HTTPException(503, "Temporaire")
    identity = prepare_start(service, max_cycles=3)
    for _ in range(5):
        ready(service, identity)
        run(service.tick())
    result = run(service.status("one", identity))
    assert result["state"] == "BLOCKED" and result["cycles"] == 3
    assert handler.await_count == 3 and result["run"]["steps"][0]["attempts"] == 3


def test_expiry_disabled_account_and_interrupted_cycle_fail_closed(harness):
    service, handler = harness
    identity = prepare_start(service)
    run(service.db.sirius_autonomy_sessions.update_one({"id": identity},
        {"$set": {"deadline": (now_utc() - timedelta(seconds=1)).isoformat()}}))
    run(service.tick())
    assert run(service.status("one", identity))["state"] == "EXPIRED"
    second = prepare_start(service)
    run(service.db.sirius_autonomy_sessions.update_one({"id": second}, {"$set": {"state": "EXECUTING", "cycles": 1}}))
    run(service.tick())
    assert run(service.status("one", second))["cycles"] == 1
    third = prepare_start(service)
    run(service.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": True}}))
    run(service.tick())
    assert run(service.status("one", third))["state"] == "STOPPED"
    handler.assert_not_called()


def test_concurrent_stop_cannot_be_overwritten_by_finishing_cycle(harness):
    service, handler = harness
    identity = prepare_start(service)
    async def stop_inside(*args):
        await service.stop("one", identity)
        return ActionOutput(data={"late": True})
    handler.side_effect = stop_inside
    run(service.tick())
    assert run(service.status("one", identity))["state"] == "STOPPED"


def test_contract_changes_block_autonomy(harness):
    from dataclasses import replace
    service, handler = harness
    identity = prepare_start(service)
    service.runs.registry._actions["budget.history"] = replace(service.runs.registry.get("budget.history"), version="2")
    run(service.tick())
    assert run(service.status("one", identity))["state"] == "BLOCKED"
    handler.assert_not_called()


def test_deadline_interrupts_inflight_read_without_replay(harness, monkeypatch):
    service, handler = harness
    identity = prepare_start(service)
    instant = now_utc()
    monkeypatch.setattr("bounded_autonomy.now_utc", lambda: instant)
    async def slow(*args):
        await asyncio.sleep(1)
        return ActionOutput(data={"late": True})
    handler.side_effect = slow
    async def execute(*args):
        return await handler(None, ActionInputs())
    monkeypatch.setattr(service.runs, "execute", execute)
    run(service.db.sirius_autonomy_sessions.update_one({"id": identity},
        {"$set": {"deadline": (instant + timedelta(milliseconds=150)).isoformat()}}))
    run(service.tick())
    result = run(service.status("one", identity))
    assert result["state"] == "BLOCKED" and result["run"]["state"] == "CANCELLED"
    assert handler.await_count == 1
    ready(service, identity); run(service.tick())
    assert handler.await_count == 1


def test_invalid_output_schema_is_blocked_not_success_or_retry(harness):
    service, handler = harness
    identity = prepare_start(service)
    handler.return_value = {"invented_field": "not a valid result"}
    run(service.tick())
    assert run(service.status("one", identity))["state"] == "BLOCKED"
    assert handler.await_count == 1


def test_slow_state_read_cannot_start_an_api_after_deadline(harness, monkeypatch):
    service, handler = harness
    identity = prepare_start(service)
    instant = now_utc()
    clock = {"now": instant}
    monkeypatch.setattr("bounded_autonomy.now_utc", lambda: clock["now"])
    run(service.db.sirius_autonomy_sessions.update_one({"id": identity},
        {"$set": {"deadline": (instant + timedelta(seconds=1)).isoformat()}}))
    original = service.status
    async def delayed(*args):
        result = await original(*args)
        clock["now"] = instant + timedelta(seconds=2)
        return result
    monkeypatch.setattr(service, "status", delayed)
    run(service.tick())
    assert run(original("one", identity))["state"] == "EXPIRED"
    handler.assert_not_called()


def test_routes_auth_isolation_and_strict_limits(harness):
    service, handler = harness
    app = FastAPI()
    async def auth(request, db):
        uid = request.headers.get("x-user")
        if not uid:
            raise HTTPException(401, "Connexion requise")
        return {"user_id": uid}
    app.include_router(make_autonomy_router(service, auth), prefix="/api")
    with TestClient(app) as client:
        body = plan().model_dump(mode="json")
        assert client.post("/api/ariane/autonomy/prepare", json=body).status_code == 401
        prepared = client.post("/api/ariane/autonomy/prepare", json=body, headers={"x-user": "one"}).json()
        handler.assert_not_called()
        path = f"/api/ariane/autonomy/{prepared['id']}"
        for invalid in ({"confirm": "true"}, {"confirm": False}, {"confirm": True, "max_cycles": 4},
                        {"confirm": True, "max_seconds": 181}, {"confirm": True, "screen": True}):
            assert client.post(path + "/start", json=invalid, headers={"x-user": "one"}).status_code == 422
        assert client.post(path + "/start", json={"confirm": True}, headers={"x-user": "one"}).status_code == 200
        assert client.get(path, headers={"x-user": "two"}).status_code == 404
        assert client.post(path + "/stop", headers={"x-user": "two"}).status_code == 404
        assert client.post(path + "/stop", headers={"x-user": "one"}).json()["state"] == "STOPPED"
    with pytest.raises(ValidationError):
        StartAutonomy(confirm=True, max_cycles=True)

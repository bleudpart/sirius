import asyncio
import io
import json
import uuid
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from action_registry import ActionRegistry
from action_runs import ActionRuns, ConfirmIn, RunIn
from local_docstore import LocalDocStore
from microtool_agents import MicroToolAgents
from provider_access import personal_key, provider_scope
from specialist_agents import SpecialistAgents

PLAN = json.dumps({"feasible": True, "approach": "Supprimer les espaces de bord."})
PROGRAM = json.dumps({"version": 1, "steps": [{"op": "strip"}]})
VERDICT = json.dumps({"approved": True, "reason": "Compatible avec les exemples et l'objectif."})


def run(operation):
    return asyncio.run(operation)


@pytest.fixture
def harness(tmp_path):
    db = LocalDocStore(tmp_path / "microtools.db")
    run(db.users.insert_one({"user_id": "one", "role": "admin"}))
    engine = ActionRuns(db, ActionRegistry())
    complete = AsyncMock(side_effect=[PLAN, PROGRAM, VERDICT])
    specialists = SpecialistAgents(db, engine, complete=complete)
    specialists.register()
    microtools = MicroToolAgents(specialists)
    microtools.register()
    return engine, specialists, complete


def mission():
    return RunIn(request_id=uuid.uuid4(), objective="Nettoyer un texte", steps=[{
        "id": "micro_outil", "action": "microtools.compile",
        "inputs": {"objective": "Supprimer seulement les espaces aux bords", "data": "  Bonjour  ",
                   "examples": [{"input": "  exemple  ", "expected": "exemple"}]},
    }])


def confirm(engine, prepared):
    return engine.confirm("one", prepared["id"], "micro_outil", ConfirmIn(
        confirm=True, fingerprint=prepared["steps"][0]["prepared"]["fingerprint"]))


def test_prepare_is_free_then_three_roles_tests_and_execution_are_journaled(harness):
    engine, specialists, complete = harness
    saved = run(engine.create("one", mission()))
    assert saved["state"] == "WAITING_CONFIRMATION"
    complete.assert_not_called()
    result = run(confirm(engine, saved))
    assert result["state"] == "COMPLETED"
    data = result["steps"][0]["output"]["data"]
    assert data["result"] == "Bonjour" and data["provider_calls"] == 3
    assert [item["role"] for item in data["stages"]] == ["planificateur", "codeur", "vérificateur"]
    assert all(item["state"] == "COMPLETED" for item in data["stages"])
    assert data["candidates"][0]["tests"][0]["passed"]
    assert len(data["candidates"][0]["fingerprint"]) == 64
    assert not specialists.active
    run(engine.execute("one", result["id"]))
    assert complete.await_count == 3


def test_one_repair_only_never_changes_user_examples(harness):
    engine, _, complete = harness
    wrong = json.dumps({"version": 1, "steps": [{"op": "upper"}]})
    complete.side_effect = [PLAN, wrong, PROGRAM, VERDICT]
    result = run(confirm(engine, run(engine.create("one", mission()))))
    data = result["steps"][0]["output"]["data"]
    assert result["state"] == "COMPLETED" and complete.await_count == 4
    assert [item["tests"][0]["passed"] for item in data["candidates"]] == [False, True]
    assert data["result"] == "Bonjour"
    for call in complete.await_args_list:
        payload = json.loads(call.args[0][1]["content"])
        assert payload["examples"] == [{"input": "  exemple  ", "expected": "exemple"}]


@pytest.mark.parametrize("invalid", [
    "print('private_rejected_script')",
    '{"version":1,"steps":[{"op":"shell","command":"private_rejected_script"}]}',
    '{"version":1,"steps":[],"steps":[{"op":"strip"}]}',
])
def test_invalid_generated_code_is_never_executed_or_persisted(harness, invalid):
    engine, _, complete = harness
    complete.side_effect = [PLAN, invalid, PROGRAM, VERDICT]
    result = run(confirm(engine, run(engine.create("one", mission()))))
    assert result["state"] == "COMPLETED" and complete.await_count == 4
    assert "private_rejected_script" not in json.dumps(result)
    assert result["steps"][0]["output"]["data"]["candidates"][0]["state"] == "INVALID"


def test_two_failures_stop_without_verification_or_final_execution(harness):
    engine, _, complete = harness
    complete.side_effect = [PLAN, "not json", "still not json"]
    result = run(confirm(engine, run(engine.create("one", mission()))))
    assert result["state"] == "BLOCKED" and complete.await_count == 3
    data = result["steps"][0]["output"]["data"]
    assert data["state"] == "BLOCKED" and data["result"] is None and data["trace"] == []
    run(engine.execute("one", result["id"]))
    assert complete.await_count == 3


def test_verifier_veto_is_final_not_overridden_by_passing_tests(harness):
    engine, _, complete = harness
    complete.side_effect = [PLAN, PROGRAM, json.dumps({"approved": False, "reason": "Exemples insuffisants."})]
    result = run(confirm(engine, run(engine.create("one", mission()))))
    data = result["steps"][0]["output"]["data"]
    assert result["state"] == "BLOCKED" and data["result"] is None
    assert data["verdict"]["approved"] is False and data["trace"] == []
    assert complete.await_count == 3


def test_unsupported_task_stops_at_planner(harness):
    engine, _, complete = harness
    complete.side_effect = [json.dumps({"feasible": False, "approach": "Nécessite un fichier interdit."})]
    result = run(confirm(engine, run(engine.create("one", mission()))))
    assert result["state"] == "BLOCKED" and complete.await_count == 1


@pytest.mark.parametrize("failure", [HTTPException(429, "private_error"), TimeoutError(), HTTPException(503, "private_error")])
def test_provider_errors_have_no_retry_or_raw_leak(harness, failure):
    engine, _, complete = harness
    complete.side_effect = failure
    result = run(confirm(engine, run(engine.create("one", mission()))))
    assert result["state"] == "BLOCKED" and complete.await_count == 1
    assert "private_error" not in json.dumps(result)


def test_cancellation_between_roles_prevents_more_calls(harness):
    engine, _, complete = harness
    saved = run(engine.create("one", mission()))
    async def answer(*args):
        await engine.cancel("one", saved["id"])
        return PLAN
    complete.side_effect = answer
    result = run(confirm(engine, saved))
    assert result["state"] == "CANCELLED" and complete.await_count == 1


def test_data_runtime_failure_after_tests_is_not_a_validated_result(harness):
    engine, _, complete = harness
    body = mission()
    body.steps[0].inputs["data"] = ["not text"]
    result = run(confirm(engine, run(engine.create("one", body))))
    data = result["steps"][0]["output"]["data"]
    assert result["state"] == "BLOCKED" and data["result"] is None
    assert data["candidates"][0]["tests"][0]["passed"] and complete.await_count == 3


def test_personal_key_scope_shared_capacity_and_account_isolation(harness):
    engine, specialists, complete = harness
    outputs = iter([PLAN, PROGRAM, VERDICT])
    seen = []
    async def answer(*args):
        seen.append(personal_key("cerebras"))
        return next(outputs)
    complete.side_effect = answer
    saved = run(engine.create("one", mission()))
    with pytest.raises(HTTPException) as failure:
        run(engine.status("two", saved["id"]))
    assert failure.value.status_code == 404
    with provider_scope({"user_id": "one", "role": "admin"}, {"cerebras": "test-key-not-secret"}):
        result = run(confirm(engine, saved))
    assert seen == ["test-key-not-secret"] * 3
    assert "test-key-not-secret" not in json.dumps(result)
    assert "test-key-not-secret" not in str(complete.await_args_list)
    assert personal_key("cerebras") == ""
    specialists.active.add("one")
    second = run(engine.create("one", mission()))
    result = run(confirm(engine, second))
    assert result["state"] == "BLOCKED" and complete.await_count == 3


def test_shared_account_capacity_cannot_race_during_user_lookup(harness, monkeypatch):
    _, specialists, _ = harness
    async def user_lookup(*args):
        await asyncio.sleep(0)
        return {"user_id": "one", "role": "admin"}
    monkeypatch.setattr(specialists.db.users, "find_one", user_lookup)
    entered = []
    async def operation():
        entered.append(True)
        await asyncio.sleep(.01)
        return "done"
    async def concurrent():
        context = SimpleNamespace(user_id="one")
        return await asyncio.gather(specialists.execute_scoped(context, operation),
                                    specialists.execute_scoped(context, operation), return_exceptions=True)
    outcomes = run(concurrent())
    assert entered == [True]
    assert sum(isinstance(item, HTTPException) and item.status_code == 409 for item in outcomes) == 1
    assert outcomes.count("done") == 1 and not specialists.active


def test_final_execution_is_not_entered_when_verifier_vetoes(harness, monkeypatch):
    engine, _, complete = harness
    complete.side_effect = [PLAN, PROGRAM, json.dumps({"approved": False, "reason": "Refus."})]
    def must_not_execute(*args):
        pytest.fail("Le résultat final ne doit pas être calculé après un veto.")
    monkeypatch.setattr("microtool_agents.execute_program", must_not_execute)
    result = run(confirm(engine, run(engine.create("one", mission()))))
    assert result["state"] == "BLOCKED" and complete.await_count == 3


def test_account_disabled_between_roles_stops_shared_capacity_cleanly(harness):
    engine, specialists, complete = harness
    async def disable(*args):
        await engine.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": True}})
        return PLAN
    complete.side_effect = disable
    result = run(confirm(engine, run(engine.create("one", mission()))))
    assert result["state"] == "BLOCKED" and complete.await_count == 1
    assert not specialists.active


def test_microtool_remains_excluded_from_background_read_only_autonomy(harness):
    from bounded_autonomy import BoundedAutonomy
    engine, _, complete = harness
    with pytest.raises(HTTPException) as denied:
        run(BoundedAutonomy(engine.db, engine).prepare("one", mission()))
    assert denied.value.status_code == 422
    complete.assert_not_called()
    assert run(engine.db.sirius_action_runs.count_documents({})) == 0


def test_microtool_plan_examples_program_and_result_are_in_owner_export(harness):
    import auth_api
    from test_account_inactivity import request_for
    engine, _, _ = harness
    run(confirm(engine, run(engine.create("one", mission()))))
    run(engine.db.sirius_action_runs.insert_one({"user_id": "two", "id": "other", "private": "not-yours"}))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(engine.db).routes
                    if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(request_for({"user_id": "one", "role": "admin"}))
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        data = json.loads(archive.read("sirius-personal-data.json"))
    assert len(data["collections"]["sirius_action_runs"]) == 1
    assert "exemple" in str(data["collections"]["sirius_action_runs"])
    assert "Bonjour" in str(data["collections"]["sirius_action_steps"])
    assert "fingerprint" in str(data["collections"]["sirius_action_steps"])
    assert "not-yours" not in str(data)

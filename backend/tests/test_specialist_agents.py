import asyncio
import io
import json
import uuid
import zipfile
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from action_registry import ActionRegistry
from action_runs import ActionRuns, ConfirmIn, RunIn
from local_docstore import LocalDocStore
from provider_access import personal_key, provider_scope
from specialist_agents import MissionInputs, SpecialistAgents


def run(operation):
    return asyncio.run(operation)


@pytest.fixture
def harness(tmp_path):
    db = LocalDocStore(tmp_path / "agents.db")
    run(db.users.insert_one({"user_id": "one", "role": "admin"}))
    engine = ActionRuns(db, ActionRegistry())
    complete = AsyncMock(return_value="Proposition uniquement.")
    agents = SpecialistAgents(db, engine, complete=complete)
    agents.register()
    return engine, agents, complete


def mission(roles=None):
    return RunIn(request_id=uuid.uuid4(), objective="Mission test", steps=[{
        "id": "delegation", "action": "agents.mission", "inputs": {
            "objective": "Préparer une réunion", "context": "Texte explicitement fourni.",
            "specialists": roles or ["documents", "messagerie", "planning"],
        },
    }])


def approve(engine, prepared):
    return engine.confirm("one", prepared["id"], "delegation", ConfirmIn(
        confirm=True, fingerprint=prepared["steps"][0]["prepared"]["fingerprint"]))


def test_exact_confirmation_then_parallel_specialists_and_synthesis(harness):
    engine, agents, complete = harness
    prepared = run(engine.create("one", mission()))
    assert prepared["state"] == "WAITING_CONFIRMATION"
    complete.assert_not_called()
    active = []
    async def answer(messages, max_tokens):
        active.append(messages)
        if max_tokens == 1024:
            await asyncio.sleep(.01)
            assert len(active) >= 3
        return "Résultat textuel."
    complete.side_effect = answer
    result = run(approve(engine, prepared))
    assert result["state"] == "COMPLETED"
    data = result["steps"][0]["output"]["data"]
    assert [item["role"] for item in data["specialists"]] == ["documents", "messagerie", "planning"]
    assert complete.await_count == 4
    assert complete.await_args_list[-1].args[1] == 1536
    synthesis_data = json.loads(complete.await_args_list[-1].args[0][1]["content"])
    assert len(synthesis_data["contributions"]) == 3
    run(engine.execute("one", prepared["id"]))
    assert complete.await_count == 4
    assert not agents.active


@pytest.mark.parametrize("change", [
    {"specialists": []}, {"specialists": ["documents"] * 2}, {"specialists": ["shell"]},
    {"objective": " "}, {"objective": "x" * 1001}, {"context": "x" * 12001},
    {"url": "https://invalid"}, {"tools": ["mail.send"]},
])
def test_unknown_tools_roles_and_oversize_context_are_rejected(change):
    with pytest.raises(ValidationError):
        MissionInputs.model_validate({"objective": "Essai", "specialists": ["documents"], **change})


def test_failed_specialist_is_partial_no_hidden_retry_or_success(harness):
    engine, _, complete = harness
    async def answer(messages, max_tokens):
        if "HERMÈS" in messages[0]["content"]:
            raise TimeoutError()
        return "Proposition."
    complete.side_effect = answer
    result = run(approve(engine, run(engine.create("one", mission()))))
    assert result["state"] == "BLOCKED"
    output = result["steps"][0]["output"]
    assert output["completion"] == "PARTIAL"
    assert "messagerie" in output["issues"][0]
    assert output["data"]["specialists"][1]["state"] == "BLOCKED"
    assert complete.await_count == 4
    run(engine.execute("one", result["id"]))
    assert complete.await_count == 4


def test_local_reflection_repairs_and_journals_without_extra_model_call(harness):
    engine, _, complete = harness
    complete.return_value = "\ufeff Proposition.\r\nDétails.  \r\n"
    result = run(approve(engine, run(engine.create("one", mission(["documents"])))))
    assert result["state"] == "COMPLETED" and complete.await_count == 2
    data = result["steps"][0]["output"]["data"]
    assert data["specialists"][0]["text"] == "Proposition.\nDétails."
    assert data["specialists"][0]["reflection"]["state"] == "REPAIRED"
    assert data["reflection"]["synthesis"]["state"] == "REPAIRED"
    assert data["reflection"]["extra_api_calls"] == 0
    assert data["reflection"]["factual_verification"] is False


def test_invalid_specialist_or_synthesis_is_not_a_validated_answer(harness):
    engine, _, complete = harness
    complete.return_value = "<think>private</think>"
    result = run(approve(engine, run(engine.create("one", mission(["documents"])))))
    assert result["state"] == "BLOCKED" and complete.await_count == 1
    output = result["steps"][0]["output"]
    assert output["data"]["specialists"][0]["reflection"]["state"] == "BLOCKED"
    assert "private" not in json.dumps(output)
    assert output["data"]["synthesis"] is None
    complete.reset_mock()
    complete.side_effect = ["Proposition correcte.", "```python\nunfinished"]
    result = run(approve(engine, run(engine.create("one", mission(["documents"])))))
    assert result["state"] == "BLOCKED" and complete.await_count == 2
    assert result["steps"][0]["output"]["data"]["synthesis"] is None
    assert result["steps"][0]["output"]["data"]["reflection"]["synthesis"]["state"] == "BLOCKED"


def test_no_synthesis_when_all_fail_or_cancellation_requested(harness):
    engine, _, complete = harness
    complete.side_effect = HTTPException(503, "Fournisseur indisponible.")
    result = run(approve(engine, run(engine.create("one", mission(["documents"])))))
    assert complete.await_count == 1
    assert result["steps"][0]["output"]["data"]["synthesis"] is None

    prepared = run(engine.create("one", mission(["documents"])))
    async def cancel(messages, max_tokens):
        await engine.cancel("one", prepared["id"])
        return "Proposition avant arrêt."
    complete.side_effect = cancel
    result = run(approve(engine, prepared))
    assert result["state"] == "CANCELLED"
    assert complete.await_count == 2
    assert result["steps"][0]["output"]["data"]["synthesis"] is None


def test_account_isolation_disabled_users_and_concurrency_limit(harness):
    engine, agents, complete = harness
    prepared = run(engine.create("one", mission()))
    with pytest.raises(HTTPException) as forbidden:
        run(engine.status("two", prepared["id"]))
    assert forbidden.value.status_code == 404
    agents.active.add("one")
    with pytest.raises(HTTPException) as busy:
        run(agents.execute(SimpleNamespace(user_id="one"), MissionInputs(objective="Essai", specialists=["documents"])))
    assert busy.value.status_code == 409
    agents.active.clear()
    run(engine.db.users.update_one({"user_id": "one"}, {"$set": {"disabled": True}}))
    result = run(approve(engine, prepared))
    assert result["state"] == "BLOCKED"
    complete.assert_not_called()


def test_personal_provider_key_is_scoped_never_persisted_or_in_prompts(harness):
    engine, _, complete = harness
    seen = []
    async def answer(messages, max_tokens):
        seen.append(personal_key("cerebras"))
        return "Proposition."
    complete.side_effect = answer
    with provider_scope({"user_id": "one", "role": "admin"}, {"cerebras": "fixture-not-a-secret"}):
        result = run(approve(engine, run(engine.create("one", mission(["documents"])))))
    assert seen == ["fixture-not-a-secret"] * 2
    assert "fixture-not-a-secret" not in json.dumps(result)
    assert "fixture-not-a-secret" not in str(complete.await_args_list)
    assert personal_key("cerebras") == ""


def test_cerebras_has_no_retry_fallback_or_truncated_success(monkeypatch):
    import sirius_brain
    import specialist_agents as module
    monkeypatch.setattr(sirius_brain, "ENV_CEREBRAS_KEY", "fixture")
    create = AsyncMock(return_value=SimpleNamespace(choices=[
        SimpleNamespace(finish_reason="length", message=SimpleNamespace(content="Texte coupé"))]))
    options = []
    class Client:
        def __init__(self, **kwargs):
            options.append(kwargs)
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=create))
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
    monkeypatch.setattr(module, "AsyncOpenAI", Client)
    with provider_scope({"user_id": "one", "role": "admin"}):
        with pytest.raises(HTTPException) as truncated:
            run(SpecialistAgents.cerebras([{"role": "user", "content": "Essai"}], 1024))
    assert truncated.value.status_code == 502
    assert options[0]["max_retries"] == 0
    assert create.await_count == 1
    assert create.await_args.kwargs["max_completion_tokens"] == 1024


def test_mission_context_and_results_are_in_account_export_only_for_owner(harness):
    import auth_api
    from test_account_inactivity import request_for
    engine, _, _ = harness
    run(approve(engine, run(engine.create("one", mission(["documents"])))))
    run(engine.db.sirius_action_runs.insert_one({"user_id": "two", "id": "private-other", "context": "not yours"}))
    endpoint = next(route.endpoint for route in auth_api.make_auth_router(engine.db).routes
                    if route.path == "/auth/privacy/export")
    async def export():
        response = await endpoint(request_for({"user_id": "one", "role": "admin"}))
        return b"".join([chunk async for chunk in response.body_iterator])
    with zipfile.ZipFile(io.BytesIO(run(export()))) as archive:
        data = json.loads(archive.read("sirius-personal-data.json"))
    assert len(data["collections"]["sirius_action_runs"]) == 1
    assert "Texte explicitement fourni." in str(data["collections"]["sirius_action_runs"])
    assert "not yours" not in str(data)
    assert len(data["collections"]["sirius_action_attempts"]) == 1

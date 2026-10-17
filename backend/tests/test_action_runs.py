import asyncio
import uuid
from dataclasses import replace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import Field

from action_registry import ActionDefinition, ActionInputs, ActionOutput, ActionRegistry
from action_runs import ActionRuns, ConfirmIn, RunIn, make_action_router
from finance_actions import make_finance_actions
from finance_workspace import FinanceWorkspace
from local_docstore import LocalDocStore
from nummarius_api import STOCKS


def run(coroutine):
    return asyncio.run(coroutine)


class Inputs(ActionInputs):
    value: float = Field(default=1, strict=True)


@pytest.fixture
def harness(tmp_path):
    db = LocalDocStore(tmp_path / "actions.db")
    reader = AsyncMock(side_effect=lambda _context, inputs: ActionOutput(data={"value": inputs.value}))
    mutation = AsyncMock(side_effect=lambda _context, inputs: ActionOutput(data={"applied": inputs.value}))
    registry = ActionRegistry()
    registry.register(ActionDefinition("test.read", "TEST", "Lire", "1", Inputs, ActionOutput, reader))
    registry.register(ActionDefinition("test.apply", "TEST", "Modifier", "1", Inputs, ActionOutput, mutation,
                                       kind="mutation", risk="sensitive"))
    return ActionRuns(db, registry), reader, mutation


def plan(steps, **kwargs):
    return RunIn(request_id=uuid.uuid4(), objective="Essai borné", steps=steps, **kwargs)


def read_step(identity="read", **kwargs):
    return {"id": identity, "action": "test.read", **kwargs}


def test_registry_contract_rejects_unsafe_retry_and_exposes_schema(harness):
    service, _, _ = harness
    definition = service.registry.get("test.apply")
    contract = definition.contract()
    assert contract["confirmation_required"] and contract["risk"] == "sensitive"
    assert contract["input_schema"]["additionalProperties"] is False
    assert "data" in contract["output_schema"]["properties"]
    for change in ({"idempotent": False}, {"risk": "low"}, {"reversible": True}, {"max_attempts": 4}):
        registry = ActionRegistry()
        with pytest.raises(ValueError):
            registry.register(replace(definition, **change))


@pytest.mark.parametrize("steps", [
    [read_step(), read_step()],
    [read_step(depends_on=["unknown"])],
    [read_step("a", depends_on=["b"]), read_step("b", depends_on=["a"])],
    [read_step("a"), read_step("b", bindings={"value": {"step": "a", "path": ["data", "value"]}})],
    [read_step(inputs={"unknown": 1})],
    [read_step(inputs={"value": True})],
    [{"id": "a", "action": "unknown.action"}],
    [read_step(inputs={"value": 1}, bindings={"value": {"step": "a", "path": ["data"]}}, depends_on=["a"])],
])
def test_invalid_graph_never_records_or_executes(harness, steps):
    service, reader, mutation = harness
    with pytest.raises(HTTPException) as failure:
        run(service.create("u1", plan(steps)))
    assert failure.value.status_code == 422
    reader.assert_not_called()
    mutation.assert_not_called()
    assert run(service.db.sirius_action_runs.count_documents({})) == 0


def test_parallel_reads_bindings_and_conditions_are_persisted_not_recomputed(harness):
    service, reader, _ = harness
    active = set()
    async def independent(context, inputs):
        active.add(context.step_id)
        await asyncio.sleep(.01)
        if context.step_id in ("a", "b"):
            assert {"a", "b"} <= active
        return ActionOutput(data={"value": inputs.value})
    reader.side_effect = independent
    request = plan([
        read_step("a", inputs={"value": 3}),
        read_step("b"),
        read_step("c", depends_on=["a", "b"], bindings={"value": {"step": "a", "path": ["data", "value"]}},
                  when={"source": {"step": "b", "path": ["data", "value"]}, "operator": "lt", "value": 2}),
        read_step("d", depends_on=["c"], when={"source": {"step": "c", "path": ["data", "value"]},
                                              "operator": "gt", "value": 5}),
        read_step("e", depends_on=["d"]),
    ])
    result = run(service.create("u1", request))
    assert result["state"] == "COMPLETED"
    assert [step["state"] for step in result["steps"]] == ["COMPLETED"] * 3 + ["SKIPPED"] * 2
    assert result["steps"][2]["output"]["data"]["value"] == 3
    assert result["steps"][3]["reason"] == "Condition non satisfaite."
    assert result["steps"][4]["reason"] == "Dépendance ignorée."
    assert reader.call_count == 3
    assert result["steps"][0]["duration_ms"] >= 0
    run(service.create("u1", request))
    assert reader.call_count == 3
    assert result["summary"]["SKIPPED"] == 2


def test_sensitive_step_waits_for_exact_preview_and_never_authorizes_following_mutations(harness):
    service, _, mutation = harness
    result = run(service.create("u1", plan([
        read_step(),
        {"id": "apply", "action": "test.apply", "depends_on": ["read"],
         "bindings": {"value": {"step": "read", "path": ["data", "value"]}}},
        {"id": "second", "action": "test.apply", "depends_on": ["apply"]},
    ])))
    assert result["state"] == "WAITING_CONFIRMATION"
    assert result["steps"][1]["prepared"]["inputs"] == {"value": 1.0}
    mutation.assert_not_called()
    fingerprint = result["steps"][1]["prepared"]["fingerprint"]
    for body in (ConfirmIn(fingerprint="0" * 64, confirm=True), ConfirmIn(fingerprint=fingerprint, confirm=False)):
        with pytest.raises(HTTPException) as failure:
            run(service.confirm("u1", result["id"], "apply", body))
        assert failure.value.status_code == 409
    result = run(service.confirm("u1", result["id"], "apply", ConfirmIn(fingerprint=fingerprint, confirm=True)))
    assert mutation.call_count == 1
    assert result["state"] == "WAITING_CONFIRMATION"
    assert result["steps"][2]["state"] == "WAITING_CONFIRMATION"
    run(service.execute("u1", result["id"]))
    assert mutation.call_count == 1


def test_expected_failures_are_bounded_and_resume_only_missing_steps(harness):
    service, reader, _ = harness
    async def offline(context, inputs):
        if context.step_id == "b":
            raise HTTPException(503, "Source indisponible.")
        return ActionOutput(data={"value": inputs.value})
    reader.side_effect = offline
    result = run(service.create("u1", plan([read_step("a"), read_step("b")])))
    assert result["state"] == "BLOCKED"
    first = result["steps"][0]["completed_at"]
    reader.side_effect = lambda _context, inputs: ActionOutput(data={"value": inputs.value})
    result = run(service.execute("u1", result["id"]))
    assert result["state"] == "COMPLETED"
    assert result["steps"][0]["completed_at"] == first
    assert reader.call_count == 3
    reader.side_effect = HTTPException(503, "Toujours indisponible")
    failed = run(service.create("u1", plan([read_step()])))
    for _ in range(5):
        failed = run(service.execute("u1", failed["id"]))
    assert failed["steps"][0]["attempts"] == 3
    assert failed["steps"][0]["state"] == "BLOCKED"


def test_missing_source_and_wrong_condition_types_are_not_silently_skipped(harness):
    service, _, _ = harness
    for condition in ({"source": {"step": "a", "path": ["missing"]}, "operator": "eq", "value": 1},
                      {"source": {"step": "a", "path": ["data"]}, "operator": "gt", "value": 2}):
        result = run(service.create("u1", plan([read_step("a"), read_step("b", depends_on=["a"], when=condition)])))
        assert result["steps"][1]["state"] == "BLOCKED"
        assert result["steps"][1]["reason"]


def test_account_isolation_expiry_cancellation_and_changed_contract(harness):
    service, reader, mutation = harness
    result = run(service.create("u1", plan([{"id": "apply", "action": "test.apply"}])))
    for operation in (service.status("u2", result["id"]), service.execute("u2", result["id"]),
                      service.cancel("u2", result["id"])):
        with pytest.raises(HTTPException) as failure:
            run(operation)
        assert failure.value.status_code == 404
    fingerprint = result["steps"][0]["prepared"]["fingerprint"]
    assert run(service.cancel("u1", result["id"]))["state"] == "CANCELLED"
    with pytest.raises(HTTPException):
        run(service.confirm("u1", result["id"], "apply", ConfirmIn(fingerprint=fingerprint, confirm=True)))
    mutation.assert_not_called()
    expired = run(service.create("u1", plan([{"id": "apply", "action": "test.apply"}])))
    run(service.db.sirius_action_runs.update_one({"id": expired["id"]}, {"$set": {"expires_at": "2000-01-01"}}))
    assert run(service.execute("u1", expired["id"]))["state"] == "EXPIRED"
    service.registry._actions["test.apply"] = replace(service.registry.get("test.apply"), version="2")
    with pytest.raises(HTTPException) as failure:
        run(service.execute("u1", expired["id"]))
    assert failure.value.status_code == 409
    reader.assert_not_called()


def test_concurrent_resume_and_confirm_do_not_duplicate_registered_mutation(harness):
    service, _, mutation = harness
    result = run(service.create("u1", plan([{"id": "apply", "action": "test.apply"}])))
    body = ConfirmIn(fingerprint=result["steps"][0]["prepared"]["fingerprint"], confirm=True)
    async def concurrent():
        await asyncio.gather(service.confirm("u1", result["id"], "apply", body),
                             service.confirm("u1", result["id"], "apply", body),
                             service.execute("u1", result["id"]))
    run(concurrent())
    assert run(service.status("u1", result["id"]))["state"] == "COMPLETED"
    assert mutation.call_count == 1


def test_persisted_success_survives_journal_failure_before_response(harness, monkeypatch):
    service, reader, _ = harness
    original = service.event
    async def event(*args, **kwargs):
        if args[3] == "COMPLETED":
            raise RuntimeError("journal failure")
        await original(*args, **kwargs)
    monkeypatch.setattr(service, "event", event)
    request = plan([read_step()])
    with pytest.raises(RuntimeError):
        run(service.create("u1", request))
    monkeypatch.setattr(service, "event", original)
    result = run(service.create("u1", request))
    assert result["state"] == "COMPLETED"
    assert reader.call_count == 1


def test_unknown_bug_propagates_and_orphan_attempt_can_recover_after_lease(harness):
    service, reader, _ = harness
    reader.side_effect = ValueError("calculation bug")
    request = plan([read_step()])
    with pytest.raises(ValueError):
        run(service.create("u1", request))
    identity = run(service.listing("u1"))["items"][0]["id"]
    assert run(service.status("u1", identity))["steps"][0]["state"] == "RUNNING"
    reader.side_effect = lambda _context, inputs: ActionOutput(data={"value": inputs.value})
    run(service.db.sirius_action_attempts.update_many({"run_id": identity}, {"$set": {"lease_until": "2000-01-01"}}))
    assert run(service.execute("u1", identity))["state"] == "COMPLETED"
    assert reader.call_count == 2


def test_registered_financial_preview_and_confirmation_use_existing_service(harness):
    service, _, _ = harness
    finance = FinanceWorkspace(service.db)
    engine = ActionRuns(service.db, make_finance_actions(finance))
    result = run(engine.create("u1", plan([
        {"id": "preview", "action": "finance.prepare", "inputs": {"action": {
            "kind": "alert", "symbol": "AAPL", "condition": "price_above", "threshold": 200}}},
        {"id": "apply", "action": "finance.confirm", "depends_on": ["preview"],
         "bindings": {"preview": {"step": "preview", "path": ["data"]}}},
    ])))
    assert result["state"] == "WAITING_CONFIRMATION"
    assert run(service.db.sirius_finance_alerts.count_documents({})) == 0
    prepared = result["steps"][1]["prepared"]
    assert "200" in prepared["inputs"]["preview"]["summary"]
    result = run(engine.confirm("u1", result["id"], "apply", ConfirmIn(fingerprint=prepared["fingerprint"], confirm=True)))
    assert result["state"] == "COMPLETED"
    assert run(service.db.sirius_finance_alerts.count_documents({})) == 1
    run(engine.execute("u1", result["id"]))
    assert run(service.db.sirius_finance_alerts.count_documents({})) == 1


def test_financial_transformations_require_declared_source_action_and_path(harness):
    service, _, _ = harness
    engine = ActionRuns(service.db, make_finance_actions(FinanceWorkspace(service.db)))
    invalid = [
        [{"id": "apply", "action": "finance.confirm", "inputs": {"preview": {"id": "a" * 32}}}],
        [{"id": "rules", "action": "portus.volatility_rules", "inputs": {"analysis": {"symbol": "AAPL"}}}],
        [{"id": "source", "action": "finance.overview"},
         {"id": "apply", "action": "finance.confirm", "depends_on": ["source"],
          "bindings": {"preview": {"step": "source", "path": ["data"]}}}],
        [{"id": "source", "action": "finance.prepare", "inputs": {"action": {
            "kind": "alert", "symbol": "AAPL", "condition": "price_above", "threshold": 200}}},
         {"id": "apply", "action": "finance.confirm", "depends_on": ["source"],
          "bindings": {"preview": {"step": "source", "path": ["data", "action"]}}}],
    ]
    for steps in invalid:
        with pytest.raises(HTTPException) as failure:
            run(engine.create("u1", plan(steps)))
        assert failure.value.status_code == 422
    assert run(service.db.sirius_action_runs.count_documents({})) == 0


@pytest.mark.parametrize("observed,findings,missing", [(30, 0, 0), (30.01, 1, 0), (None, 0, 1)])
def test_financial_analysis_adapter_preserves_provenance_and_strict_threshold(harness, observed, findings, missing):
    service, _, _ = harness
    snapshot = {"symbol": "AAPL", "source": "test feed", "as_of": "2026-10-16",
                "fetched_at": "2026-10-16T22:00:00+00:00", "data_version": "a" * 64,
                "volatility_20d_annualized_pct": observed, "age_calendar_days": 1, "rejected_bars": 0}
    source = AsyncMock(return_value=snapshot)
    engine = ActionRuns(service.db, make_finance_actions(FinanceWorkspace(service.db, source)))
    result = run(engine.create("u1", plan([
        {"id": "analysis", "action": "portus.analysis", "inputs": {"symbol": "AAPL", "period": "1y"}},
        {"id": "rules", "action": "portus.volatility_rules", "depends_on": ["analysis"],
         "bindings": {"analysis": {"step": "analysis", "path": ["analysis"]}}},
    ])))
    assert result["state"] == "COMPLETED"
    assert result["steps"][0]["output"]["analysis"] == snapshot
    rules = result["steps"][1]["output"]
    assert len(rules["findings"]) == findings
    assert len(rules["missing"]) == missing
    assert rules["alerts_created"] == 0
    assert rules["rule_parameters"] == {"volatility_threshold_pct": 30, "operator": "strictly_greater"}
    run(engine.execute("u1", result["id"]))
    assert source.call_count == 1
    source.assert_awaited_with("AAPL", dict(STOCKS)["AAPL"], "1y")


def test_readonly_overview_and_portfolio_adapters_do_not_guess_positions(harness):
    service, _, _ = harness
    source = AsyncMock()
    engine = ActionRuns(service.db, make_finance_actions(FinanceWorkspace(service.db, source)))
    result = run(engine.create("u1", plan([
        {"id": "portfolio", "action": "finance.portfolio"}, {"id": "overview", "action": "finance.overview"},
    ])))
    assert result["state"] == "COMPLETED"
    assert result["steps"][0]["output"]["data"]["positions"] == []
    assert result["steps"][1]["output"]["data"]["alerts"]["items"] == []
    assert result["steps"][1]["output"]["data"]["routines"]["items"] == []
    source.assert_not_called()


def test_partial_portfolio_is_not_a_success_and_does_not_release_dependent_steps(harness):
    service, _, _ = harness
    finance = FinanceWorkspace(service.db, AsyncMock(side_effect=HTTPException(503, "Source indisponible")))
    from finance_workspace import Holding, PortfolioAction, PreviewIn
    preview = run(finance.preview("u1", PreviewIn(request_id=uuid.uuid4(), action=PortfolioAction(
        positions=[Holding(symbol="AAPL", quantity=2, average_cost=100)]))))
    run(finance.confirm("u1", preview["id"]))
    engine = ActionRuns(service.db, make_finance_actions(finance))
    result = run(engine.create("u1", plan([
        {"id": "portfolio", "action": "finance.portfolio"},
        {"id": "overview", "action": "finance.overview", "depends_on": ["portfolio"]},
    ])))
    assert result["state"] == "BLOCKED"
    assert result["steps"][0]["state"] == "BLOCKED"
    assert "AAPL" in result["steps"][0]["reason"]
    assert result["steps"][0]["output"]["completion"] == "PARTIAL"
    assert result["steps"][0]["output"]["data"]["total_value"] is None
    assert result["steps"][1]["state"] == "PENDING"


def test_new_engine_instance_resumes_frozen_outputs_and_real_financial_guards(harness):
    service, _, _ = harness
    finance = FinanceWorkspace(service.db)
    request = plan([
        {"id": "preview", "action": "finance.prepare", "inputs": {"action": {
            "kind": "portfolio", "positions": [{"symbol": "AAPL", "quantity": 2, "average_cost": 100}]}}},
        {"id": "apply", "action": "finance.confirm", "depends_on": ["preview"],
         "bindings": {"preview": {"step": "preview", "path": ["data"]}}},
    ])
    engine = ActionRuns(service.db, make_finance_actions(finance))
    first = run(engine.create("u1", request))
    prepared = first["steps"][1]["prepared"]
    # Another confirmed change invalidates the revision, not just the UI preview.
    from finance_workspace import PortfolioAction, PreviewIn
    outside = run(finance.preview("u1", PreviewIn(request_id=uuid.uuid4(), action=PortfolioAction(positions=[]))))
    run(finance.confirm("u1", outside["id"]))
    restored = ActionRuns(service.db, make_finance_actions(FinanceWorkspace(service.db)))
    result = run(restored.confirm("u1", first["id"], "apply", ConfirmIn(fingerprint=prepared["fingerprint"], confirm=True)))
    assert result["state"] == "BLOCKED"
    assert result["steps"][0]["output"] == first["steps"][0]["output"]
    assert result["steps"][1]["approval"]["confirmed_at"]
    assert "changé" in result["steps"][1]["reason"]
    assert run(finance.portfolio("u1"))["revision"] == 1
    assert run(finance.portfolio("u1"))["positions"] == []


def test_timeouts_are_explicit_and_cancellation_does_not_claim_to_undo_inflight(harness, monkeypatch):
    service, reader, _ = harness
    import action_runs
    real_timeout = asyncio.timeout
    monkeypatch.setattr(action_runs.asyncio, "timeout", lambda _seconds: real_timeout(.01))
    async def slow(context, inputs):
        await asyncio.sleep(.05)
        return ActionOutput(data={"value": inputs.value})
    reader.side_effect = slow
    result = run(service.create("u1", plan([read_step()])))
    assert result["state"] == "BLOCKED"
    assert "Délai dépassé" in result["steps"][0]["reason"]
    async def stop_midway(context, inputs):
        await service.cancel(context.user_id, context.run_id)
        return ActionOutput(data={"value": inputs.value})
    reader.side_effect = stop_midway
    result = run(service.create("u1", plan([read_step("a"), read_step("b", depends_on=["a"])])))
    assert result["state"] == "CANCELLED"
    assert result["steps"][0]["state"] == "COMPLETED"
    assert result["steps"][1]["state"] == "PENDING"
    assert result["cancellation"]["cancelled_at"]


def test_all_routes_authenticate_and_reference_scope_is_enforced(harness):
    service, _, mutation = harness
    async def user(request, _db):
        if not request.headers.get("x-user"):
            raise HTTPException(401)
        return {"user_id": request.headers["x-user"]}
    app = FastAPI()
    app.include_router(make_action_router(service, user), prefix="/api")
    with TestClient(app) as client:
        assert client.get("/api/ariane/actions").status_code == 401
        request = plan([{"id": "apply", "action": "test.apply"}]).model_dump(mode="json")
        assert client.post("/api/ariane/runs", json=request).status_code == 401
        result = client.post("/api/ariane/runs", headers={"x-user": "u1"}, json=request).json()
        url = "/api/ariane/runs/" + result["id"]
        for method, path in (("get", "/api/ariane/runs"), ("get", url), ("post", url + "/resume"), ("post", url + "/cancel")):
            assert getattr(client, method)(path).status_code == 401
        fingerprint = result["steps"][0]["prepared"]["fingerprint"]
        assert client.post(url + "/steps/apply/confirm", json={"fingerprint": fingerprint, "confirm": True}).status_code == 401
        assert client.get(url, headers={"x-user": "u2"}).status_code == 404
        assert client.post(url + "/steps/apply/confirm", headers={"x-user": "u2"},
                           json={"fingerprint": fingerprint, "confirm": True}).status_code == 404
        assert client.post(url + "/steps/apply/confirm", headers={"x-user": "u1"},
                           json={"fingerprint": fingerprint, "confirm": "yes"}).status_code == 422
        mutation.assert_not_called()

import asyncio
import sqlite3
import uuid
from collections import Counter
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import ariane_market_runs as module
from ariane_market_runs import MarketRunIn, MarketRuns, evaluate_rules, make_ariane_market_router
from local_docstore import LocalDocStore


def analysis(symbol="AAPL", volatility=35):
    return {
        "symbol": symbol, "source": "fixture", "source_url": "https://finance.yahoo.com/",
        "fetched_at": "2026-10-16T20:00:00+00:00", "as_of": "2026-10-16", "currency": "USD",
        "data_version": "version-" + symbol, "calculation_version": "nummarius-daily-v1",
        "calculation_parameters": {"volatility_log_returns_sample": 20, "annualization_sessions": 252},
        "calculation_inputs": {"daily_bars": [{"date": "2026-10-16", "close": 100}]},
        "volatility_20d_annualized_pct": volatility, "age_calendar_days": 1, "rejected_bars": 0,
    }


def body(**kwargs):
    return MarketRunIn(request_id=uuid.uuid4(), symbols=["AAPL", "MSFT"], **kwargs)


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.fixture
def db(tmp_path):
    return LocalDocStore(tmp_path / "runs.sqlite3")


def test_rule_is_strict_and_missing_history_is_not_a_safe_portfolio_claim():
    result = evaluate_rules([analysis(volatility=30), analysis("MSFT", None)], 30)
    assert result["findings"] == []
    assert result["missing"][0]["symbol"] == "MSFT"
    result = evaluate_rules([analysis(volatility=30.01)], 30)
    assert result["findings"][0]["observed"] == 30.01
    assert result["findings"][0]["data_version"] == "version-AAPL"
    assert result["alerts_created"] == 0


def test_plan_runs_independent_reads_in_parallel_and_persists_each_step(db):
    calls, active = [], set()
    async def read(symbol, *_args):
        active.add(symbol)
        await asyncio.sleep(.02)
        assert active == {"AAPL", "MSFT"}
        calls.append(symbol)
        return analysis(symbol)
    service = MarketRuns(db, read)
    request = body()
    result = run(service.create("u1", request))
    assert result["state"] == "COMPLETED"
    assert len(result["steps"]) == 4
    assert [step["id"] for step in result["steps"]] == ["analysis:AAPL", "analysis:MSFT", "rules", "summary"]
    assert result["steps"][2]["depends_on"] == ["analysis:AAPL", "analysis:MSFT"]
    assert result["steps"][-1]["depends_on"] == ["rules"]
    assert "pas de votre portefeuille" in result["steps"][-1]["output"]["text"]
    assert result["external_actions_executed"] is False
    assert result["alerts_created"] == 0
    again = run(service.create("u1", request))
    assert again["id"] == result["id"]
    assert Counter(calls) == {"AAPL": 1, "MSFT": 1}
    assert run(db.sirius_ariane_runs.count_documents({})) == 1
    assert run(db.sirius_ariane_steps.count_documents({})) == 4
    assert len([event for event in result["trace"] if event["outcome"] == "COMPLETED"]) == 2
    assert result["trace"][-1]["calculation_version"] == "nummarius-daily-v1"


def test_failed_read_blocks_global_summary_and_restart_resumes_only_missing_steps(db):
    async def initial(symbol, *_args):
        if symbol == "MSFT":
            raise HTTPException(503, "provider temporarily unavailable")
        return analysis(symbol)
    service = MarketRuns(db, initial)
    result = run(service.create("u1", body()))
    assert result["state"] == "BLOCKED"
    assert result["steps"][-1]["output"] is None
    assert result["steps"][0]["state"] == "COMPLETED"
    assert result["steps"][1]["state"] == "BLOCKED"
    reader = AsyncMock(side_effect=lambda symbol, *_args: analysis(symbol))
    restarted = MarketRuns(db, reader)
    resumed = run(restarted.execute("u1", result["id"]))
    assert resumed["state"] == "COMPLETED"
    assert reader.call_args.args[0] == "MSFT"
    assert reader.call_count == 1
    assert resumed["steps"][0]["completed_at"] == result["steps"][0]["completed_at"]
    assert resumed["steps"][0]["output"] == result["steps"][0]["output"]


def test_changed_request_with_same_id_is_rejected_without_reexecution(db):
    reader = AsyncMock(return_value=analysis())
    service = MarketRuns(db, reader)
    request = body()
    run(service.create("u1", request))
    request.period = "5y"
    with pytest.raises(HTTPException) as failure:
        run(service.create("u1", request))
    assert failure.value.status_code == 409
    assert reader.call_count == 2


def test_saved_result_survives_journal_failure_before_retry(db, monkeypatch):
    service = MarketRuns(db, AsyncMock(return_value=analysis()))
    original = service.event
    async def failure(uid, run_id, step, outcome, **details):
        if outcome == "COMPLETED":
            raise sqlite3.OperationalError("journal disconnected")
        return await original(uid, run_id, step, outcome, **details)
    monkeypatch.setattr(service, "event", failure)
    request = body()
    with pytest.raises(sqlite3.OperationalError):
        run(service.create("u1", request))
    assert run(db.sirius_ariane_steps.count_documents({})) == 2
    monkeypatch.setattr(service, "event", original)
    resumed = run(service.create("u1", request))
    assert resumed["state"] == "COMPLETED"
    assert service.reader.call_count == 2
    assert run(db.sirius_ariane_steps.count_documents({})) == 4


def test_concurrent_retries_never_duplicate_completed_steps(db):
    reader = AsyncMock(side_effect=lambda symbol, *_args: analysis(symbol))
    service = MarketRuns(db, reader)
    request = body()
    async def concurrent():
        return await asyncio.gather(service.create("u1", request), service.create("u1", request))
    results = run(concurrent())
    assert {item["id"] for item in results} == {results[0]["id"]}
    assert run(db.sirius_ariane_steps.count_documents({})) == 4
    assert run(db.sirius_ariane_runs.count_documents({})) == 1


def test_expiry_preserves_saved_data_and_blocks_new_reads(db):
    async def unavailable(*_args):
        raise HTTPException(503, "offline")
    service = MarketRuns(db, unavailable)
    result = run(service.create("u1", body()))
    run(db.sirius_ariane_runs.update_one({"id": result["id"]}, {"$set": {"expires_at": "2000-01-01"}}))
    service.reader = AsyncMock(return_value=analysis())
    result = run(service.execute("u1", result["id"]))
    assert result["state"] == "EXPIRED"
    service.reader.assert_not_called()


def test_unexpected_error_is_not_a_success_shaped_blocked_result(db):
    async def bug(*_args):
        raise ValueError("unexpected computation bug")
    with pytest.raises(ValueError):
        run(MarketRuns(db, bug).create("u1", body()))


def test_api_account_isolation_validation_and_readonly_plan(db, monkeypatch):
    monkeypatch.setattr(module.MarketRuns, "analysis_step", AsyncMock())
    async def user(request, _db):
        uid = request.headers.get("x-user")
        if not uid:
            raise HTTPException(401)
        return {"user_id": uid}
    app = FastAPI()
    app.include_router(make_ariane_market_router(db, user), prefix="/api")
    path = "/api/ariane/market-runs"
    with TestClient(app) as client:
        config = {"request_id": str(uuid.uuid4()), "symbols": ["AAPL"]}
        assert client.post(path, json=config).status_code == 401
        assert client.get(path).status_code == 401
        for bad in ({**config, "symbols": ["unknown"]}, {**config, "symbols": ["AAPL", "AAPL"]},
                    {**config, "send": True}, {**config, "volatility_threshold_pct": -1},
                    {**config, "volatility_threshold_pct": True},
                    {**config, "volatility_threshold_pct": "30"}):
            assert client.post(path, headers={"x-user": "u1"}, json=bad).status_code == 422
        result = client.post(path, headers={"x-user": "u1"}, json=config)
        assert result.status_code == 200
        run_id = result.json()["id"]
        assert client.get(f"{path}/{run_id}").status_code == 401
        assert client.post(f"{path}/{run_id}/resume").status_code == 401
        assert client.get(path, headers={"x-user": "u2"}).json()["items"] == []
        assert client.get(f"{path}/{run_id}", headers={"x-user": "u2"}).status_code == 404
        assert client.post(f"{path}/{run_id}/resume", headers={"x-user": "u2"}).status_code == 404
        assert client.get(path, headers={"x-user": "u2"}).json()["items"] == []
        assert client.get(path, headers={"x-user": "u1"}).json()["items"][0]["id"] == run_id

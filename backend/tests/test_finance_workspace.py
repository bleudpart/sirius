import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import finance_workspace as module
from finance_conversation import FinanceConversation, is_finance_command
from finance_workspace import (AlertAction, DisableAction, FinanceWorkspace, Holding, PortfolioAction,
                               PreviewIn, RoutineAction, make_finance_router, parse_holdings_csv)
from local_docstore import LocalDocStore


def run(coroutine):
    return asyncio.run(coroutine)


def data(symbol, *_args):
    bars = [{"date": f"2026-09-{i:02d}", "close": 90 + i} for i in range(1, 25)]
    return {"symbol": symbol, "source": "fixture", "source_url": "https://finance.yahoo.com/",
            "as_of": bars[-1]["date"], "currency": "USD", "fetched_at": "2026-09-25T20:00:00+00:00",
            "data_version": "a" * 64, "calculation_version": "v1", "calculation_parameters": {"sma": [200]},
            "age_calendar_days": 1, "rejected_bars": 0, "latest": {"close": 114, "mm200": 110, "rsi14": 60},
            "series": [{"close": 108, "mm200": 109}, {"close": 114, "mm200": 110}],
            "calculation_inputs": {"daily_bars": bars}, "volatility_20d_annualized_pct": 35,
            "performance_pct": {"1d": 2}}


@pytest.fixture
def service(tmp_path):
    db = LocalDocStore(tmp_path / "finance.db")
    run(db.users.insert_one({"user_id": "u1"}))
    run(db.users.insert_one({"user_id": "u2"}))
    return FinanceWorkspace(db, AsyncMock(side_effect=data))


def preview(service, action):
    return run(service.preview("u1", PreviewIn(request_id=uuid.uuid4(), action=action)))


def approved(service, action):
    saved = preview(service, action)
    return run(service.confirm("u1", saved["id"]))["result"]


def positions(quantity=2):
    return PortfolioAction(positions=[Holding(symbol="AAPL", quantity=quantity, average_cost=100)])


def test_csv_is_strict_atomic_and_accepts_bom_and_header_only_for_clear():
    result = parse_holdings_csv("\ufeffsymbol,quantity,average_cost,currency\nAAPL,2,100,USD\n")
    assert result.positions[0].quantity == 2
    assert parse_holdings_csv("symbol,quantity,average_cost,currency\n").positions == []
    for csv in ("symbol;quantity;average_cost;currency\nAAPL;2;100;USD",
                "symbol,quantity,average_cost,currency\nAAPL,nan,100,USD",
                "symbol,quantity,average_cost,currency\nAAPL,2,100,EUR",
                "symbol,quantity,average_cost,currency\nAAPL,2,100,USD\nAAPL,3,100,USD",
                "symbol,quantity,average_cost,currency\nUNKNOWN,2,100,USD",
                "symbol,quantity,average_cost,currency\nAAPL,2,100,USD,extra",
                'symbol,quantity,average_cost,currency\n"AAPL,2,100,USD'):
        with pytest.raises(HTTPException) as error:
            parse_holdings_csv(csv)
        assert error.value.status_code == 422
    for field in ("quantity", "average_cost"):
        with pytest.raises(ValidationError):
            Holding(**{"symbol": "AAPL", "quantity": 2, "average_cost": 1, field: True})
    with pytest.raises(ValidationError):
        AlertAction(symbol="AAPL", condition="price_above")
    with pytest.raises(ValidationError):
        AlertAction(symbol="AAPL", condition="cross_above_mm200", threshold=200)


def test_preview_confirmation_expiry_replay_and_no_duplicate_snapshots(service):
    body = PreviewIn(request_id=uuid.uuid4(), action=positions())
    first = run(service.preview("u1", body))
    assert first["state"] == "WAITING_CONFIRMATION"
    assert run(service.portfolio("u1"))["positions"] == []
    assert run(service.preview("u1", body))["id"] == first["id"]
    body.action = positions(3)
    with pytest.raises(HTTPException) as conflict:
        run(service.preview("u1", body))
    assert conflict.value.status_code == 409
    run(service.confirm("u1", first["id"]))
    again = run(service.confirm("u1", first["id"]))
    assert again["replayed"]
    assert run(service.db.sirius_finance_portfolios.count_documents({})) == 1
    later = preview(service, positions(4))
    run(service.db.sirius_finance_previews.update_one({"id": later["id"]}, {"$set": {"expires_at": "2000-01-01"}}))
    with pytest.raises(HTTPException):
        run(service.confirm("u1", later["id"]))
    assert run(service.portfolio("u1"))["positions"][0]["quantity"] == 2


def test_lost_confirmation_journal_response_recovers_without_a_second_write(service, monkeypatch):
    saved = preview(service, positions())
    original = service.trace
    monkeypatch.setattr(service, "trace", AsyncMock(side_effect=module.sqlite3.OperationalError("journal offline")))
    with pytest.raises(module.sqlite3.OperationalError):
        run(service.confirm("u1", saved["id"]))
    assert run(service.db.sirius_finance_portfolios.count_documents({})) == 1
    monkeypatch.setattr(service, "trace", original)
    result = run(service.confirm("u1", saved["id"]))
    assert result["replayed"]
    assert run(service.db.sirius_finance_portfolios.count_documents({})) == 1
    assert len(run(service.overview("u1"))["events"]) == 1


def test_concurrent_confirms_and_stale_replacements_cannot_lose_positions(service):
    one, two = preview(service, positions(2)), preview(service, positions(3))
    async def race():
        return await asyncio.gather(service.confirm("u1", one["id"]), service.confirm("u1", two["id"]),
                                    return_exceptions=True)
    results = run(race())
    assert sum(isinstance(result, dict) for result in results) == 1
    assert next(result for result in results if isinstance(result, HTTPException)).status_code == 409
    assert run(service.db.sirius_finance_portfolios.count_documents({})) == 1


def test_real_holdings_valuation_and_missing_source_never_announce_partial_total(service):
    approved(service, positions())
    result = run(service.valuation("u1"))
    assert result["state"] == "COMPLETE"
    assert result["total_value"] == 228
    assert result["unrealized_pnl"] == 28
    assert result["positions"][0]["weight_pct"] == 100
    assert result["series"][-1]["value"] == 228
    assert result["volatility_pct"] > 0
    assert result["max_drawdown_pct"] == 0
    service.reader.side_effect = HTTPException(503, "offline")
    missing = run(service.valuation("u1"))
    assert missing["total_value"] is None and missing["unrealized_pnl"] is None
    assert missing["state"] == "PARTIAL" and missing["positions"][0]["value"] is None


def test_confirmed_watch_creates_sourced_notification_once_per_session_and_can_suspend(service):
    alert = approved(service, AlertAction(symbol="AAPL", condition="cross_above_mm200"))
    stamp = datetime.now(timezone.utc) + timedelta(minutes=1)
    run(service.tick(stamp))
    run(service.tick(stamp + timedelta(minutes=20)))
    notifications = run(service.overview("u1"))["notifications"]
    assert len(notifications) == 1
    assert notifications[0]["evidence"]["data_version"] == "a" * 64
    assert notifications[0]["evidence"]["triggered"] is True
    count = service.reader.call_count
    approved(service, DisableAction(target_kind="alert", target_id=alert["id"]))
    run(service.tick(stamp + timedelta(hours=1)))
    assert service.reader.call_count == count
    assert run(service.overview("u1"))["alerts"]["items"][0]["disabled"]
    assert run(service.overview("u2"))["notifications"] == []


def test_stale_and_insufficient_mm200_are_explicitly_unavailable(service):
    alert = approved(service, AlertAction(symbol="AAPL", condition="cross_above_mm200"))
    old = data("AAPL")
    old["age_calendar_days"] = 8
    service.reader.side_effect = None
    service.reader.return_value = old
    with pytest.raises(HTTPException):
        run(service.evaluate_alert(alert))
    old["age_calendar_days"] = 1
    old["series"][0]["mm200"] = None
    with pytest.raises(HTTPException):
        run(service.evaluate_alert(alert))
    assert run(service.overview("u1"))["notifications"] == []


def test_routine_uses_same_ariane_request_and_does_not_backfill_missed_days(service):
    start = datetime.now(timezone.utc) + timedelta(hours=1)
    routine = approved(service, RoutineAction(symbols=["AAPL", "MSFT"], start_at=start, recurrence="daily"))
    run(service.tick(start - timedelta(minutes=1)))
    assert service.reader.call_count == 0
    run(service.tick(start + timedelta(days=3, minutes=1)))
    run(service.tick(start + timedelta(days=3, minutes=2)))
    assert service.reader.call_count == 2
    assert run(service.db.sirius_ariane_runs.count_documents({})) == 1
    notification = run(service.overview("u1"))["notifications"][0]
    assert notification["evidence"]["slot"] == 3
    result = run(service.runs.status("u1", notification["evidence"]["run_id"]))
    assert result["state"] == "COMPLETED"
    approved(service, DisableAction(target_kind="routine", target_id=routine["id"]))
    run(service.tick(start + timedelta(days=4)))
    assert service.reader.call_count == 2


def test_scheduled_failures_are_bounded_logged_and_do_not_claim_success(service):
    approved(service, AlertAction(symbol="AAPL", condition="price_above", threshold=1))
    service.reader.side_effect = HTTPException(503, "offline")
    stamp = datetime.now(timezone.utc) + timedelta(minutes=1)
    for seconds in (0, 30, 100, 200, 300):
        run(service.tick(stamp + timedelta(seconds=seconds)))
    assert service.reader.call_count == 3
    overview = run(service.overview("u1"))
    assert len(overview["notifications"]) == 1
    assert overview["notifications"][0]["evidence"]["state"] == "BLOCKED"
    assert sum(event["outcome"] == "BLOCKED" for event in overview["events"]) == 3
    run(service.db.users.update_one({"user_id": "u1"}, {"$set": {"disabled": True}}))
    run(service.tick(stamp + timedelta(hours=2)))
    assert service.reader.call_count == 3


def test_scheduler_batches_four_independent_reads_and_concurrent_ticks_do_not_duplicate(service):
    for symbol in ("AAPL", "MSFT", "NVDA", "TSLA"):
        approved(service, AlertAction(symbol=symbol, condition="price_above", threshold=1))
    active, peak = 0, 0
    async def reader(symbol, *_args):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(.02)
        active -= 1
        return data(symbol)
    service.reader = AsyncMock(side_effect=reader)
    stamp = datetime.now(timezone.utc) + timedelta(minutes=1)
    async def parallel_ticks():
        await asyncio.gather(service.tick(stamp), service.tick(stamp))
    run(parallel_ticks())
    assert peak == 4
    assert service.reader.call_count == 4
    assert len(run(service.overview("u1"))["notifications"]) == 4


def test_recovery_of_last_reserved_attempt_after_crash_is_visible_and_never_reexecutes(service):
    from work_draft_recordings import digest
    alert = approved(service, AlertAction(symbol="AAPL", condition="price_above", threshold=1))
    stamp = datetime.now(timezone.utc) + timedelta(minutes=3)
    occurrence = digest([alert["id"], 0])[:32]
    run(service.db.sirius_finance_attempts.insert_one({
        "id": occurrence + ":3", "user_id": "u1", "number": 3, "occurrence": occurrence,
        "created_at": (stamp - timedelta(seconds=100)).isoformat(),
    }))
    run(service.tick(stamp))
    service.reader.assert_not_called()
    assert run(service.overview("u1"))["notifications"][0]["evidence"]["state"] == "BLOCKED"


def test_routes_authenticate_all_surfaces_isolate_users_and_reject_invalid_configuration(service):
    async def user(request, _db):
        if not request.headers.get("x-user"):
            raise HTTPException(401)
        return {"user_id": request.headers["x-user"]}
    app = FastAPI()
    app.include_router(make_finance_router(service, user), prefix="/api")
    root = "/api/nummarius"
    with TestClient(app) as client:
        for method, path in (("get", "/workspace"), ("get", "/portfolio"), ("get", "/actions/" + "a" * 32),
                             ("post", "/actions/" + "a" * 32 + "/confirm")):
            assert getattr(client, method)(root + path).status_code == 401
        assert client.get("/api/chronos/market-routines").status_code == 401
        valid = {"request_id": str(uuid.uuid4()), "action": {"kind": "alert", "symbol": "AAPL",
                  "condition": "price_above", "threshold": 200}}
        assert client.post(root + "/actions/preview", json=valid).status_code == 401
        result = client.post(root + "/actions/preview", headers={"x-user": "u1"}, json=valid).json()
        assert result["state"] == "WAITING_CONFIRMATION"
        assert client.post(root + f"/actions/{result['id']}/confirm", headers={"x-user": "u2"}).status_code == 404
        assert client.get(root + f"/actions/{result['id']}", headers={"x-user": "u2"}).status_code == 404
        for bad in (True, -1, "200"):
            valid["action"]["threshold"] = bad
            assert client.post(root + "/actions/preview", headers={"x-user": "u1"}, json=valid).status_code == 422
        assert client.post(root + "/portfolio/csv/preview", headers={"x-user": "u1"},
                           json={"request_id": str(uuid.uuid4()), "text": "bad"}).status_code == 422


def test_conversation_read_source_table_explicit_confirm_and_refuses_invented_causes(service):
    conversation = FinanceConversation(service)
    def ask(text):
        return run(conversation.handle(SimpleNamespace(text=text, environment={"timezone": "Europe/Paris"}), {"user_id": "u1"}))
    result = ask("Compare Apple et Microsoft sur cinq ans")
    assert "| AAPL |" in result["answer"] and "source" in result["answer"].lower()
    assert result["state"] == "COMPLETED"
    result = ask("Alerte-moi si AAPL dépasse 200 dollars")
    assert result["state"] == "WAITING_CONFIRMATION"
    assert run(service.db.sirius_finance_alerts.count_documents({})) == 0
    assert ask("oui") is None
    confirmed = ask("Confirme finance " + result["finance_preview"]["id"])
    assert confirmed["executed"]
    assert run(service.db.sirius_finance_alerts.count_documents({})) == 1
    assert "pas inventer une cause" in ask("Pourquoi Apple baisse aujourd'hui")["answer"]
    assert ask("Achète AAPL")["executed"] is False
    assert "Aucune position" in ask("Quels risques de mon portefeuille")["answer"]
    assert ask("Chaque matin à 9 h analyse AAPL")["state"] == "WAITING_CONFIRMATION"
    assert ask("Ouvre Portus") is None
    assert not is_finance_command("Quelles actions dans ce dossier client")
    assert not is_finance_command("Connecte Microsoft")
    assert ask("Surveille AAPL au-dessus de 200 euros")["state"] == "NEEDS_CLARIFICATION"
    assert ask("Programme AAPL demain à 9 h")["state"] == "NEEDS_CLARIFICATION"
    assert ask("Surveille AAPL MM200 à la hausse")["state"] == "WAITING_CONFIRMATION"
    assert ask("Pourquoi cette action a-t-elle baissé ?")["state"] == "NEEDS_CLARIFICATION"
    assert "pas inventer" in ask("Quels dividendes pour Apple ?")["answer"]
    assert ask("Montre mes alertes financières")["state"] == "READ_ONLY"


@pytest.mark.parametrize("endpoint", ["/api/chat", "/api/chat/stream"])
def test_real_http_and_sse_use_same_financial_service_and_never_llm(service, monkeypatch, endpoint):
    import json
    import server
    async def user(request, _db):
        if request.headers.get("x-user") != "u1":
            raise HTTPException(401)
        return {"user_id": "u1"}
    async def no_model(*_args, **_kwargs):
        pytest.fail("Financial commands must not invent results through a language model")
    monkeypatch.setattr(server, "db", service.db)
    monkeypatch.setattr(server, "require_user", user)
    monkeypatch.setattr(server, "finance_conversation", FinanceConversation(service))
    monkeypatch.setattr(server, "_rate_ok", lambda _uid: True)
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda _keys: True)
    monkeypatch.setattr(server.cloud_link, "relay_json", no_model)
    app = FastAPI()
    app.include_router(server.api_router)
    def ask(client, text):
        response = client.post(endpoint, headers={"x-user": "u1"}, json={"text": text, "session_id": "finance-test"})
        assert response.status_code == 200, response.text
        if endpoint.endswith("/stream"):
            return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")][-1]
        return response.json()
    with TestClient(app) as client:
        assert client.post(endpoint, json={"text": "Analyse AAPL"}).status_code == 401
        result = ask(client, "Compare AAPL et MSFT")
        assert result["work_state"] == "COMPLETED" and "| AAPL |" in result["answer"]
        result = ask(client, "Surveille AAPL au-dessus de 200 dollars")
        assert result["work_state"] == "WAITING_CONFIRMATION"
        assert run(service.db.sirius_finance_alerts.count_documents({})) == 0
        result = ask(client, "Confirme finance " + result["finance_preview"]["id"])
        assert result["work_state"] == "COMPLETED"
        assert run(service.db.sirius_finance_alerts.count_documents({})) == 1

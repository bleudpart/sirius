import asyncio
import io
import json
import sqlite3
import uuid
import zipfile
from datetime import date, timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from action_registry import ActionRegistry
from action_runs import ActionRuns, ConfirmIn, RunIn
from budget_lab import BudgetLab, CsvBudgetIn, UsageIn, local_benchmark, make_budget_lab_router, parse_transactions
from local_docstore import LocalDocStore

CSV = ("date,label,amount,currency\n"
       "2026-01-01,Salaire,1000.01,EUR\n"
       '2026-01-02,"Musique, famille",-9.99,EUR\n'
       '2026-02-02,"Musique, famille",-9.99,EUR\n'
       '2026-03-02,"Musique, famille",-9.99,EUR')


def run(operation):
    return asyncio.run(operation)


@pytest.fixture
def service(tmp_path):
    return BudgetLab(LocalDocStore(tmp_path / "budget.db"))


def test_exact_cents_recurrence_and_replay_without_raw_csv(service):
    first = run(service.analyze("one", CsvBudgetIn(text="\ufeff" + CSV)))
    assert first["months"][0] == {"month": "2026-01", "income_cents": 100001, "expenses_cents": 999, "net_cents": 99002}
    assert first["candidates"][0]["annual_estimate_cents"] == 11988
    assert first["candidates"][0]["label"] == "Musique, famille"
    replay = run(service.analyze("one", CsvBudgetIn(text=CSV)))
    assert replay == first
    assert len(run(service.history("one"))["analyses"]) == 1
    assert "text" not in first and "rows" not in first
    assert "Salaire" not in str(first)


@pytest.mark.parametrize("row", [
    "2026-01-01,Cafe,NaN,EUR", "2026-01-01,Cafe,Infinity,EUR",
    "2026-01-01,Cafe,1e3,EUR", "2026-01-01,Cafe,1.001,EUR",
    "2026-01-01,Cafe,1.00,USD", "2026-01-01,Cafe,1,EUR,extra",
    "2026-01-01,Cafe,1", "2026-02-30,Cafe,1,EUR", "9999-01-01,Cafe,1,EUR",
    "20260101,Cafe,1,EUR", '2026-01-01,"Cafe,1,EUR', "2026-01-01, ,1,EUR",
    "2026-01-01,Cafe,1000000001,EUR",
])
def test_reject_invalid_rows_atomically(row, service):
    with pytest.raises(HTTPException) as failure:
        run(service.analyze("one", CsvBudgetIn(text=CSV + "\n" + row)))
    assert failure.value.status_code == 422
    assert run(service.history("one"))["analyses"] == []


def test_empty_wrong_header_limits_and_non_recurring_payments(service):
    for text in ("date,label,amount,currency\n", "date;label;amount;currency\n",
                 "date,label,amount,currency\n" + "2026-01-01,Cafe,-1,EUR\n" * 2001):
        with pytest.raises(HTTPException):
            parse_transactions(text)
    result = run(service.analyze("one", CsvBudgetIn(text=CSV.replace("2026-03-02", "2026-03-15"))))
    assert result["candidates"] == []
    result = run(service.analyze("one", CsvBudgetIn(text=CSV.replace("-9.99", "-1.01", 1))))
    assert result["candidates"] == []
    result = run(service.analyze("one", CsvBudgetIn(text=CSV + "\n2026-03-02,Autre,-9.99,EUR")))
    assert len(result["candidates"]) == 1
    assert result["candidates"][0]["occurrences"] == 3


def test_human_usage_is_scoped_replaceable_and_never_executes(service):
    saved = run(service.analyze("one", CsvBudgetIn(text=CSV)))
    candidate = saved["candidates"][0]["id"]
    for uid, identity, item in (("two", saved["id"], candidate), ("one", saved["id"], "unknown")):
        with pytest.raises(HTTPException) as failure:
            run(service.usage(uid, identity, item, UsageIn(used=False)))
        assert failure.value.status_code == 404
    decision = run(service.usage("one", saved["id"], candidate, UsageIn(used=False)))
    assert decision["potential_annual_cents"] == 11988 and not decision["executed"]
    run(service.usage("one", saved["id"], candidate, UsageIn(used=True)))
    decisions = run(service.history("one"))["decisions"]
    assert len(decisions) == 1 and decisions[0]["used"] is True
    assert decisions[0]["potential_annual_cents"] == 0
    assert run(service.history("two")) == {"analyses": [], "decisions": [], "experiments": []}


@pytest.mark.parametrize("gap,expected", [(24, 0), (25, 1), (35, 1), (36, 0)])
def test_recurrence_interval_bounds(service, gap, expected):
    text = "date,label,amount,currency\n" + "\n".join(
        f"{date(2026, 1, 1) + timedelta(days=gap * index)},Service,-9.99,EUR" for index in range(3))
    result = run(service.analyze("one", CsvBudgetIn(text=text)))
    assert len(result["candidates"]) == expected


@pytest.mark.parametrize("last,expected", [("10.48", 1), ("10.49", 0)])
def test_recurrence_amount_tolerance_is_exact(service, last, expected):
    text = ("date,label,amount,currency\n2026-01-01,Service,-9.99,EUR\n"
            f"2026-02-01,Service,-9.99,EUR\n2026-03-01,Service,-{last},EUR")
    result = run(service.analyze("one", CsvBudgetIn(text=text)))
    assert len(result["candidates"]) == expected


def test_even_median_uses_integer_cents(service):
    text = "date,label,amount,currency\n" + "\n".join(
        f"2026-0{index + 1}-01,Service,-{amount},EUR" for index, amount in enumerate(("9.99", "10.00", "10.01", "10.02")))
    result = run(service.analyze("one", CsvBudgetIn(text=text)))
    assert result["candidates"][0]["monthly_cents"] == 1000


def test_lab_only_fixed_synthetic_cases_and_zero_network(service, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("No networking in the local benchmark")
    monkeypatch.setattr("socket.create_connection", forbidden)
    policy = service.policy()
    assert policy["cerebras"] == {"enabled": False, "monthly_budget_eur": 0, "free_quota_verified": False,
                                 "reason": "Quota gratuit non vérifié : aucun appel Cerebras autorisé."}
    result = local_benchmark()
    assert [(row["correct"], row["cases"]) for row in result["results"]] == [(5, 6), (6, 6)]
    assert result["cost_eur"] == result["external_calls"] == 0
    assert result["production_modified"] is False
    first = run(service.run_local("one", "same"))
    assert run(service.run_local("one", "same")) == first
    assert len(run(service.history("one"))["experiments"]) == 1
    assert run(service.history("two"))["experiments"] == []


def test_actions_delegate_through_existing_orchestrator_and_require_confirmation(service):
    registry = ActionRegistry()
    service.register(registry)
    orchestrator = ActionRuns(service.db, registry)
    result = run(orchestrator.create("one", RunIn(request_id=uuid.uuid4(), objective="Budget et laboratoire local", steps=[
        {"id": "budget", "action": "budget.history"},
        {"id": "policy", "action": "lab.policy"},
        {"id": "experiment", "action": "lab.local", "depends_on": ["policy"],
         "when": {"source": {"step": "policy", "path": ["data", "local", "enabled"]}, "operator": "eq", "value": True}},
    ])))
    assert result["state"] == "WAITING_CONFIRMATION"
    assert run(service.history("one"))["experiments"] == []
    fingerprint = result["steps"][2]["prepared"]["fingerprint"]
    completed = run(orchestrator.confirm("one", result["id"], "experiment", ConfirmIn(fingerprint=fingerprint, confirm=True)))
    assert completed["state"] == "COMPLETED"
    assert completed["steps"][2]["output"]["data"]["external_calls"] == 0
    run(orchestrator.execute("one", result["id"]))
    assert len(run(service.history("one"))["experiments"]) == 1


def test_routes_authentication_strict_inputs_and_account_scope(service):
    app = FastAPI()
    async def require_user(request, db):
        identity = request.headers.get("x-test-user")
        if not identity:
            raise HTTPException(401, "Connexion requise.")
        return {"user_id": identity}
    app.include_router(make_budget_lab_router(service, require_user), prefix="/api")
    with TestClient(app) as client:
        for method, path, body in (
            ("get", "/budget/history", None), ("get", "/lab/policy", None),
            ("post", "/budget/analyze", {"text": CSV}), ("post", "/lab/local", None),
            ("put", "/budget/missing/usage/missing", {"used": False}),
        ):
            assert client.request(method, "/api/nummarius" + path, json=body).status_code == 401
        headers = {"x-test-user": "one"}
        assert client.post("/api/nummarius/budget/analyze", headers=headers, json={"text": CSV, "url": "https://invalid"}).status_code == 422
        saved = client.post("/api/nummarius/budget/analyze", headers=headers, json={"text": CSV}).json()
        path = f"/api/nummarius/budget/{saved['id']}/usage/{saved['candidates'][0]['id']}"
        assert client.put(path, headers=headers, json={"used": "false"}).status_code == 422
        assert client.put(path, headers={"x-test-user": "two"}, json={"used": False}).status_code == 404
        assert client.put(path, headers=headers, json={"used": False}).status_code == 200
        assert client.post("/api/nummarius/lab/local", headers=headers).json()["external_calls"] == 0


def test_storage_errors_are_explicit_not_success(service, monkeypatch, caplog):
    monkeypatch.setattr("budget_lab.insert_once", AsyncMock(side_effect=sqlite3.OperationalError("offline")))
    with pytest.raises(HTTPException) as failure:
        run(service.analyze("one", CsvBudgetIn(text=CSV)))
    assert failure.value.status_code == 503
    assert "persistence unavailable" in caplog.text


def test_budget_and_lab_in_personal_export_without_other_account(service):
    import auth_api
    from test_account_inactivity import request_for

    user = {"user_id": "one", "email": "one@example.test", "role": "user"}
    run(service.db.users.insert_one(user))
    for uid in ("one", "two"):
        saved = run(service.analyze(uid, CsvBudgetIn(text=CSV)))
        run(service.usage(uid, saved["id"], saved["candidates"][0]["id"], UsageIn(used=False)))
        run(service.run_local(uid, "run-" + uid))
    route = next(route for route in auth_api.make_auth_router(service.db).routes if route.path == "/auth/privacy/export")

    async def exported():
        response = await route.endpoint(request_for(user))
        return b"".join([chunk async for chunk in response.body_iterator])

    with zipfile.ZipFile(io.BytesIO(run(exported()))) as archive:
        exported = json.loads(archive.read("sirius-personal-data.json"))
    for name in ("sirius_budget_analyses", "sirius_budget_decisions", "sirius_lab_runs"):
        assert len(exported["collections"][name]) == 1
        assert exported["collections"][name][0]["user_id"] == "one"

"""Démonstrations fictives : comptes équilibrés, moteur rapproché du grand livre, API en lecture seule."""
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from decimal import Decimal as D
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import finance_demo
from finance_demo import (
    DEMO_END, DEMO_PROFILES, DEMO_START, OPENING_DATE, YEARS, build_construction, demo_catalog, demo_company,
    easter, prewarm_demo_companies, public_holidays,
)
from kpi_engine import build_report
from routers.finance import make_company_finance_router
from schemas.finance import ComparisonMode, Period, SectorEnum

SECTORS = list(SectorEnum)
USER = {"x-test-user": "banquier"}
DASHBOARD = "/api/finance/demo/SERVICES/dashboard?start_date=2024-01-01&end_date=2024-12-31"


def calendar_year(value):
    return Period(start_date=date(value, 1, 1), end_date=date(value, 12, 31))


def reject_float(text):
    raise AssertionError(f"Nombre JSON flottant inattendu : {text}")


@pytest.mark.parametrize("year, sunday", [(2023, date(2023, 4, 9)), (2024, date(2024, 3, 31)), (2025, date(2025, 4, 20))])
def test_easter_and_moving_public_holidays(year, sunday):
    assert easter(year) == sunday
    holidays = public_holidays(year)
    assert {sunday + timedelta(days=1), sunday + timedelta(days=39), sunday + timedelta(days=50)} <= holidays
    assert len(holidays) == 11


def test_catalog_is_static_and_every_company_is_labelled_fictitious(monkeypatch):
    monkeypatch.setattr(finance_demo, "DEMO_BUILDERS", {})
    catalog = demo_catalog()
    assert catalog.period == Period(start_date=DEMO_START, end_date=DEMO_END)
    assert [item.company.sector for item in catalog.companies] == SECTORS
    assert all(item.company.id.startswith("demo-") and "(fictive)" in item.company.name for item in catalog.companies)
    assert all(item.description for item in catalog.companies)
    assert "fictives" in catalog.notice


@pytest.mark.parametrize("sector", SECTORS)
def test_books_balance_and_engine_matches_the_double_entry_ledger(sector):
    demo = demo_company(sector)
    dataset, profile = demo.dataset, DEMO_PROFILES[sector]
    assert dataset.company == profile.company and demo.description == profile.description
    rows = (*dataset.revenues, *dataset.expenses, *dataset.overheads, *dataset.inventories,
            *dataset.cash_balances, *dataset.cash_movements, *dataset.balance_sheets)
    assert all(row.company_id == profile.company.id for row in rows)
    assert all(DEMO_START <= row.date <= DEMO_END for row in (*dataset.revenues, *dataset.expenses))
    assert demo.minimum_cash > 0
    sheets = {sheet.date: sheet for sheet in dataset.balance_sheets}
    assert sorted(sheets) == [OPENING_DATE, *(date(year, 12, 31) for year in YEARS)]
    for sheet in sheets.values():
        assert sheet.total_assets == sheet.equity + sheet.financial_debt + sheet.trade_payables + sheet.tax_social_payables
    month_start_cash = {balance.date: balance.amount for balance in dataset.cash_balances}
    assert [ledger.year for ledger in demo.years] == list(YEARS)
    for ledger in demo.years:
        report = build_report(dataset, calendar_year(ledger.year), ComparisonMode.NONE, demo=True)
        prior, closing = sheets[date(ledger.year - 1, 12, 31)], sheets[date(ledger.year, 12, 31)]
        assert report.demo is True and "DEMO_DATA" in {alert.code for alert in report.alerts}
        assert report.common.revenue_ht == ledger.revenue_ht
        assert report.common.approximate_ebe == ledger.ebe
        assert (report.common.opening_cash, report.common.closing_cash) == (prior.cash, closing.cash)
        assert month_start_cash.get(date(ledger.year + 1, 1, 1), closing.cash) == closing.cash
        assert ledger.net_income == ledger.pretax_income - ledger.income_tax
        assert closing.equity - prior.equity == ledger.net_income - ledger.dividends_paid
        expected = ["LOSS_MAKING_PROJECT"] if (sector, ledger.year) == (SectorEnum.CONSTRUCTION, 2024) else []
        assert sorted(alert.code for alert in report.alerts if alert.severity != "info") == expected
        banking = report.banking
        assert banking.balance_sheet_date == closing.date
        assert D("5") <= banking.ebe_margin_pct <= D("20")
        assert None not in (
            banking.debt_service_coverage, banking.cash_days, banking.working_capital_requirement,
            banking.customer_days, banking.supplier_days, banking.gearing, banking.equity_ratio_pct,
        )
        if dataset.inventories:
            assert report.common.stock_variation is not None and banking.inventory_days > 0


def test_monthly_series_over_the_whole_window_reconciles_cash_and_stock():
    demo = demo_company(SectorEnum.RETAIL)
    report = build_report(demo.dataset, Period(start_date=DEMO_START, end_date=DEMO_END), ComparisonMode.NONE, demo=True)
    sheets = {sheet.date: sheet for sheet in demo.dataset.balance_sheets}
    assert len(report.monthly) == 36
    decembers = [point.closing_cash for point in report.monthly if point.period.end_date.month == 12]
    assert decembers == [sheets[date(year, 12, 31)].cash for year in YEARS]
    assert report.common.closing_cash == sheets[DEMO_END].cash
    assert sum(point.stock_variation for point in report.monthly) == report.common.stock_variation


def test_generation_is_deterministic():
    assert build_construction() == demo_company(SectorEnum.CONSTRUCTION)


def test_each_demo_is_built_once_under_concurrent_requests(monkeypatch):
    calls = []
    built = object()

    def slow_builder():
        calls.append(threading.get_ident())
        time.sleep(0.05)
        return built

    monkeypatch.setattr(finance_demo, "_DEMO_CACHE", {})
    monkeypatch.setitem(finance_demo.DEMO_BUILDERS, SectorEnum.SERVICES, slow_builder)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: demo_company(SectorEnum.SERVICES), range(8)))
    assert len(calls) == 1 and all(result is built for result in results)


def test_prewarm_builds_every_sector_unless_stopped(monkeypatch):
    built = []
    monkeypatch.setattr(finance_demo, "_DEMO_CACHE", {})
    for sector in SECTORS:
        monkeypatch.setitem(finance_demo.DEMO_BUILDERS, sector, lambda sector=sector: built.append(sector) or sector)
    stop = threading.Event()
    stop.set()
    prewarm_demo_companies(stop)
    assert built == []
    prewarm_demo_companies(threading.Event())
    assert built == SECTORS


@pytest.fixture
def api():
    database = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(return_value=None)))

    async def require_user(request, _database):
        if not request.headers.get("x-test-user"):
            raise HTTPException(401, "Authentification requise.")
        return {"user_id": request.headers["x-test-user"]}

    app = FastAPI()
    app.include_router(make_company_finance_router(database, require_user), prefix="/api")
    with TestClient(app) as client:
        yield client, database


def test_demo_api_requires_a_session_but_no_company_membership(api):
    client, database = api
    for url in ("/api/finance/demo/companies", DASHBOARD, "/api/finance/demo/SERVICES/entries/revenues"):
        assert client.get(url).status_code == 401
    catalog = client.get("/api/finance/demo/companies", headers=USER)
    assert catalog.status_code == 200
    assert [item["company"]["sector"] for item in catalog.json()["companies"]] == [sector.value for sector in SECTORS]
    assert catalog.json()["period"] == {"start_date": "2023-01-01", "end_date": "2025-12-31"}
    response = client.get(DASHBOARD, headers=USER)
    assert response.status_code == 200
    payload = json.loads(response.text, parse_float=reject_float)
    assert payload["demo"] is True and payload["calculation_version"] == "2"
    assert payload["company"]["id"] == "demo-services"
    assert "DEMO_DATA" in {alert["code"] for alert in payload["alerts"]}
    assert payload["comparison"]["has_data"] is True
    assert payload["comparison"]["period"] == {"start_date": "2023-01-01", "end_date": "2023-12-31"}
    assert len(payload["monthly"]) == 12
    database.enterprise_members.find_one.assert_not_called()


@pytest.mark.parametrize("path", [
    "/api/finance/demo/SERVICES/dashboard?start_date=2022-12-01&end_date=2023-01-31",
    "/api/finance/demo/SERVICES/dashboard?start_date=2025-12-01&end_date=2026-01-31",
    "/api/finance/demo/SERVICES/dashboard?start_date=2024-02-01&end_date=2024-01-01",
    "/api/finance/demo/SERVICES/dashboard?start_date=2024-01-01",
    "/api/finance/demo/FARMING/dashboard?start_date=2024-01-01&end_date=2024-12-31",
    "/api/finance/demo/SERVICES/entries/unknown",
    "/api/finance/demo/SERVICES/entries/revenues?start_date=2024-02-01&end_date=2024-01-01",
    "/api/finance/demo/SERVICES/entries/revenues?limit=0",
])
def test_demo_api_rejects_unknown_or_out_of_window_requests(api, path):
    client, _ = api
    assert client.get(path, headers=USER).status_code == 422


def test_out_of_window_message_states_the_covered_years(api):
    client, _ = api
    response = client.get(DASHBOARD.replace("2024-12-31", "2026-03-31"), headers=USER)
    assert response.status_code == 422
    assert response.json()["detail"] == "La démonstration couvre les exercices 2023 à 2025 (du 01/01/2023 au 31/12/2025)."


def test_demo_entries_are_read_only_traceable_documents(api):
    client, _ = api
    url = "/api/finance/demo/RETAIL/entries/revenues?start_date=2024-12-01&end_date=2024-12-31&limit=5"
    response = client.get(url, headers=USER)
    assert response.status_code == 200
    payload = json.loads(response.text, parse_float=reject_float)
    assert payload["kind"] == "revenues" and payload["truncated"] is True and len(payload["entries"]) == 5
    dates = [entry["values"]["date"] for entry in payload["entries"]]
    assert dates == sorted(dates, reverse=True) and all(day.startswith("2024-12") for day in dates)
    assert all(entry["origin"] == "demo" and "company_id" not in entry["values"] for entry in payload["entries"])
    assert all(isinstance(entry["values"]["amount_ht"], str) for entry in payload["entries"])
    overheads = client.get(
        "/api/finance/demo/RETAIL/entries/overheads?start_date=2024-01-01&end_date=2024-12-31", headers=USER,
    ).json()["entries"]
    assert overheads and all(entry["values"]["active_from"] <= "2024-12-31" for entry in overheads)
    assert all(entry["values"]["active_to"] is None or entry["values"]["active_to"] >= "2024-01-01" for entry in overheads)
    assert client.post("/api/finance/demo/RETAIL/entries/revenues", headers=USER, json={}).status_code == 405
    assert client.delete("/api/finance/demo/RETAIL/entries/revenues/1", headers=USER).status_code == 404

import json
from datetime import date
from decimal import Decimal as D, ROUND_DOWN, localcontext
from types import SimpleNamespace
from typing import get_args
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import URL, select
from sqlalchemy.exc import IntegrityError, OperationalError, StatementError
from sqlalchemy.orm import Session

from finance_database import create_finance_engine, get_db
from kpi_engine import (
    SPECIFIC_LABELS, ConstructionStrategy, HospitalityStrategy, RetailStrategy, ServicesStrategy,
    allocate_overheads, build_dashboard, sector_strategy,
)
from models.finance import (
    CashBalance, CashMovement, CompanyProfile, InventorySnapshot, PurchaseExpense,
    RecurringOverhead, TransactionRevenue,
)
from routers.finance import load_dashboard, make_company_finance_router
from schemas.finance import (
    AllocationEnum as Allocation, CashBalanceIn, CashMovementIn, CategorieExpense as Category,
    CompanyProfileIn, ConstructionKPIs, HospitalityKPIs, InventorySnapshotIn, OverheadCategory, Period,
    PurchaseExpenseIn, RecurringOverheadIn, RetailKPIs, SectorEnum as Sector, ServicesKPIs, TransactionRevenueIn,
)

PERIOD = Period(start_date="2026-01-01", end_date="2026-01-31")


def company(sector=Sector.SERVICES, identity="a"):
    return CompanyProfileIn(id=identity, name="Entreprise test", sector=sector)


def revenue(amount="1000.00", **changes):
    ht = D(amount)
    return TransactionRevenueIn.model_validate({
        "company_id": "a", "date": "2026-01-15", "amount_ht": ht,
        "amount_ttc": ht * D("1.20"), "vat_rate": "20.0000", "payment_method": "TRANSFER",
        **changes,
    })


def expense(amount="300.00", **changes):
    ht = D(amount)
    return PurchaseExpenseIn.model_validate({
        "company_id": "a", "date": "2026-01-15", "supplier": "Fournisseur",
        "amount_ht": ht, "amount_vat": ht * D(".20"), "amount_ttc": ht * D("1.20"),
        "deductible_vat": ht * D(".20"), "category": "MATIERE_PREMIERE", **changes,
    })


def overhead(amount="100.00", **changes):
    return RecurringOverheadIn.model_validate({
        "company_id": "a", "label": "Charge", "category": "RENT",
        "monthly_amount_ht": amount, "active_from": "2026-01-01", **changes,
    })


def inventories(allocation, opening, closing):
    return [
        InventorySnapshotIn(company_id="a", date="2026-01-01", allocation=allocation, value=opening),
        InventorySnapshotIn(company_id="a", date="2026-02-01", allocation=allocation, value=closing),
    ]


def test_common_kpis_vat_break_even_ebe_and_real_cash():
    result = build_dashboard(
        company(), PERIOD, [revenue("10000")],
        [expense("3000"), expense("1000", category=Category.EQUIPEMENT)],
        [overhead("1000", vat_rate="20", vat_recoverable=True),
         overhead("2000", category=OverheadCategory.PAYROLL, employer_charges="800"),
         overhead("500", category=OverheadCategory.LOAN, loan_principal="400")],
        cash_balance=CashBalanceIn(company_id="a", date="2025-12-31", amount="500"),
        cash_movements=[
            CashMovementIn(company_id="a", date="2025-12-31", amount="200", label="Avant periode"),
            CashMovementIn(company_id="a", date="2026-01-01", amount="-1000", label="Paiement"),
            CashMovementIn(company_id="a", date="2026-01-31", amount="12000", label="Encaissement"),
        ],
    )
    expected = {
        "revenue_ht": "10000", "revenue_ttc": "12000", "variable_costs": "3000",
        "fixed_costs": "3800", "recurring_commitments": "4500", "financial_expenses": "100",
        "operating_expenses": "6800",
        "contribution_margin_pct": "70", "break_even_revenue_ht": "5428.57",
        "approximate_ebe": "3200", "vat_collected": "2000", "vat_deductible": "1000",
        "vat_balance_estimate": "1000", "cash_inflows": "12000", "cash_outflows": "1000",
        "cash_net_flow": "11000", "opening_cash": "700", "closing_cash": "11700",
    }
    assert result.common.model_dump() == {key: D(value) for key, value in expected.items()} | {"stock_variation": None}
    payload = json.loads(result.model_dump_json())
    assert payload["common"].pop("stock_variation") is None
    assert all(isinstance(value, str) for value in payload["common"].values())
    assert payload["specific"]["sector"] == "SERVICES"


def test_stock_variation_turns_purchases_into_consumed_costs():
    result = build_dashboard(
        company(Sector.HOSPITALITY), PERIOD,
        [revenue("1000", allocation="FOOD"), revenue("500", allocation="BEVERAGE")],
        [expense("350", allocation="FOOD"), expense("80", allocation="BEVERAGE"), expense("20", category="FOURNITURES")],
        [overhead("200")],
        inventories("FOOD", "100", "50") + inventories("BEVERAGE", "50", "30"),
    )
    assert result.common.stock_variation == D("70")
    assert result.common.variable_costs == D("520")
    assert result.common.approximate_ebe == D("780")
    assert result.common.variable_costs - result.common.stock_variation == D("450")
    assert "variation de stocks intégrée" in next(a.message for a in result.alerts if a.code == "MANAGEMENT_ESTIMATES")


def test_stock_build_up_reduces_costs_and_partial_inventories_only_count_complete_families():
    built_up = build_dashboard(
        company(Sector.RETAIL), PERIOD, [revenue("4000", ticket_count=80)],
        [expense("2000", allocation="MERCHANDISE")], [], inventories("MERCHANDISE", "600", "1000"),
    )
    assert built_up.common.stock_variation == D("-400")
    assert built_up.common.variable_costs == D("1600")
    partial = build_dashboard(
        company(Sector.HOSPITALITY), PERIOD, [revenue("1000", allocation="FOOD")],
        [expense("300", allocation="FOOD")], [],
        inventories("FOOD", "100", "40") + inventories("BEVERAGE", "50", "30")[:1],
    )
    assert partial.common.stock_variation == D("60")
    assert "MISSING_STOCK_BEVERAGE" in {a.code for a in partial.alerts}
    missing = build_dashboard(company(Sector.RETAIL), PERIOD, [revenue()], [expense("300", allocation="MERCHANDISE")], [])
    assert missing.common.stock_variation is None
    assert missing.common.variable_costs == D("300")
    assert "hors variation de stocks" in next(a.message for a in missing.alerts if a.code == "MANAGEMENT_ESTIMATES")


def test_monthly_series_uses_month_start_inventories_when_available():
    period = Period(start_date="2026-01-01", end_date="2026-03-31")
    rows = [
        InventorySnapshotIn(company_id="a", date=day, allocation="MERCHANDISE", value=value)
        for day, value in (("2026-01-01", "500"), ("2026-02-01", "900"), ("2026-03-01", "700"))
    ]
    result = build_dashboard(
        company(Sector.RETAIL), period, [revenue("1000", ticket_count=10, date=f"2026-0{m}-15") for m in (1, 2, 3)],
        [expense("600", allocation="MERCHANDISE", date=f"2026-0{m}-10") for m in (1, 2, 3)], [], rows,
    )
    assert [p.stock_variation for p in result.monthly] == [D("-400"), D("200"), None]
    assert [p.approximate_ebe for p in result.monthly] == [D("800"), D("200"), D("400")]
    assert result.common.stock_variation is None


def test_hospitality_consumption_and_prime_cost_include_employer_charges():
    result = build_dashboard(
        company(Sector.HOSPITALITY), PERIOD,
        [revenue("1000", allocation="FOOD"), revenue("500", allocation="BEVERAGE")],
        [expense("350", allocation="FOOD"), expense("80", allocation="BEVERAGE")],
        [overhead("200", category="PAYROLL", employer_charges="80")],
        inventories("FOOD", "100", "50") + inventories("BEVERAGE", "50", "30"),
    )
    assert result.specific.model_dump(exclude={"sector"}) == {
        "food_consumed_cost": D("400"), "beverage_consumed_cost": D("100"),
        "food_cost_pct": D("40"), "beverage_cost_pct": D("20"), "prime_cost_pct": D("52"),
    }


def test_construction_margins_include_cost_only_projects_and_report_unassigned_rows():
    result = build_dashboard(
        company(Sector.CONSTRUCTION), PERIOD,
        [revenue("1000", business_reference="A"), revenue("100")],
        [expense("400", business_reference="A"),
         expense("100", category="SOUS_TRAITANCE", business_reference="B"),
         expense("50", category="EQUIPEMENT", business_reference="A")], [],
    )
    values = result.specific.model_dump()
    assert values["dry_cost"] == D("500")
    assert values["margin"] == D("600")
    assert values["unallocated_revenue_ht"] == D("100")
    assert values["projects"] == [
        {"business_reference": "A", "revenue_ht": D("1000"), "dry_cost": D("400"),
         "margin": D("600"), "margin_pct": D("60")},
        {"business_reference": "B", "revenue_ht": D("0"), "dry_cost": D("100"),
         "margin": D("-100"), "margin_pct": None},
    ]
    assert "UNALLOCATED_PROJECTS" in {a.code for a in result.alerts}


def test_retail_margin_turnover_and_average_basket():
    result = build_dashboard(
        company(Sector.RETAIL), PERIOD, [revenue("4000", ticket_count=80)],
        [expense("2000", allocation="MERCHANDISE")], [],
        inventories("MERCHANDISE", "1000", "600"),
    )
    assert result.specific.model_dump(exclude={"sector"}) == {
        "goods_consumed_cost": D("2400"), "commercial_margin": D("1600"),
        "commercial_margin_pct": D("40"), "estimated_stock_turnover": D("3"),
        "average_basket_ht": D("50"),
    }


def test_services_rates_do_not_infer_workdays_from_hours():
    result = build_dashboard(
        company(), PERIOD, [revenue(hours="20", days="2")], [],
        [overhead("200")],
    )
    assert result.specific.model_dump(exclude={"sector"}) == {
        "average_hourly_rate_ht": D("50"), "average_daily_rate_ht": D("500"),
        "structure_cost_ratio_pct": D("20"),
    }
    incomplete = build_dashboard(company(), PERIOD, [revenue(hours="20")], [], [])
    assert incomplete.specific.model_dump()["average_daily_rate_ht"] is None
    assert "MISSING_DAYS" in {a.code for a in incomplete.alerts}
    unavailable = {a.code: a.message for a in incomplete.alerts}["UNAVAILABLE_AVERAGE_DAILY_RATE_HT"]
    assert unavailable.startswith("Taux journalier moyen réel indisponible")


def test_every_nullable_sector_kpi_has_a_french_label():
    nullable = {
        name for schema in (HospitalityKPIs, ConstructionKPIs, RetailKPIs, ServicesKPIs)
        for name, info in schema.model_fields.items() if type(None) in get_args(info.annotation)
    }
    assert nullable <= SPECIFIC_LABELS.keys()
    assert all("_" not in label for label in SPECIFIC_LABELS.values())


@pytest.mark.parametrize("sector", list(Sector))
def test_empty_ledgers_are_safe_and_emit_alerts_without_nan_or_false_balances(sector):
    result = build_dashboard(company(sector), PERIOD, [], [], [])
    assert result.common.break_even_revenue_ht is None
    assert result.common.opening_cash is None and result.common.closing_cash is None
    assert result.common.cash_net_flow == D("0")
    assert {"NO_REVENUE_DATA", "MISSING_OPENING_CASH", "NO_BREAK_EVEN"} <= {a.code for a in result.alerts}
    assert "NaN" not in result.model_dump_json() and "Infinity" not in result.model_dump_json()
    assert type(sector_strategy(sector, PERIOD)) is {
        Sector.HOSPITALITY: HospitalityStrategy, Sector.CONSTRUCTION: ConstructionStrategy,
        Sector.RETAIL: RetailStrategy, Sector.SERVICES: ServicesStrategy,
    }[sector]


def test_missing_or_incoherent_stock_is_not_replaced_by_zero():
    missing = build_dashboard(company(Sector.RETAIL), PERIOD, [revenue()], [expense("300", allocation="MERCHANDISE")], [])
    assert missing.specific.model_dump()["commercial_margin"] is None
    bad = build_dashboard(company(Sector.RETAIL), PERIOD, [revenue()], [expense("300", allocation="MERCHANDISE")], [],
                          inventories("MERCHANDISE", "100", "1000"))
    assert bad.specific.model_dump()["goods_consumed_cost"] is None
    assert "INCONSISTENT_STOCK_MERCHANDISE" in {a.code for a in bad.alerts}
    unallocated = build_dashboard(company(Sector.RETAIL), PERIOD, [revenue()], [expense("300")], [],
                                  inventories("MERCHANDISE", "100", "200"))
    assert "UNALLOCATED_PURCHASES" in {a.code for a in unallocated.alerts}


@pytest.mark.parametrize("start,end,amount,expected", [
    ("2026-01-16", "2026-01-31", "310", "160"),
    ("2026-01-31", "2026-02-28", "310", "320"),
    ("2024-02-29", "2024-02-29", "290", "10"),
])
def test_calendar_proration_including_leap_year(start, end, amount, expected):
    period = Period(start_date=start, end_date=end)
    result = allocate_overheads([overhead(amount, active_from=start)], period)
    assert result[0].operating == D(expected)


def test_active_dates_limit_proration_and_future_charges_contribute_nothing():
    values = allocate_overheads([
        overhead("310", active_from="2026-01-10", active_to="2026-01-20"),
        overhead("310", active_from="2026-02-01"),
    ], PERIOD)
    assert [v.operating for v in values] == [D("110"), D("0")]


@pytest.mark.parametrize("amount", ["0", "100"])
def test_nonpositive_contribution_has_no_break_even(amount):
    result = build_dashboard(company(), PERIOD, [revenue(amount)], [expense("100")], [overhead("20")])
    assert result.common.break_even_revenue_ht is None
    assert "NEGATIVE_EBE" in {a.code for a in result.alerts}


def test_negative_cash_is_alerted_but_unpaid_invoices_do_not_create_cash():
    result = build_dashboard(
        company(), PERIOD, [revenue()], [], [],
        cash_balance=CashBalanceIn(company_id="a", date="2026-01-01", amount="10"),
        cash_movements=[CashMovementIn(company_id="a", date="2026-01-20", amount="-20", label="Paiement")],
    )
    assert result.common.closing_cash == D("-10")
    assert "NEGATIVE_CASH" in {a.code for a in result.alerts}


def test_credit_notes_and_partial_vat_deduction():
    result = build_dashboard(company(), PERIOD, [revenue(), revenue("-100")],
                             [expense("100", deductible_vat="10")], [])
    assert result.common.revenue_ht == D("900")
    assert result.common.vat_collected == D("180")
    assert result.common.variable_costs == D("110")
    assert result.common.vat_balance_estimate == D("170")


def test_decimal_context_does_not_change_results_and_money_is_not_double_rounded():
    revenues = [revenue("1.23", amount_ttc="1.23", vat_rate="0", hours="0.9960")]
    expected = build_dashboard(company(), PERIOD, revenues, [], [overhead("1")])
    with localcontext() as context:
        context.prec = 6
        context.rounding = ROUND_DOWN
        actual = build_dashboard(company(), PERIOD, revenues, [], [overhead("1")])
    assert actual.model_dump_json() == expected.model_dump_json()
    assert actual.specific.model_dump()["average_hourly_rate_ht"] == D("1.23")
    assert revenue("0.05", vat_rate="10", amount_ttc="0.06").amount_ttc == D(".06")


@pytest.mark.parametrize("change", [
    {"amount_ht": 10.1}, {"amount_ht": 10}, {"amount_ht": True},
    {"amount_ht": "NaN"}, {"amount_ht": "Infinity"}, {"amount_ht": "1.001"},
    {"vat_rate": -1}, {"vat_rate": "101"}, {"amount_ttc": "1234"},
    {"date": "2026-02-30"}, {"date": "2026-01-15T00:00:00"},
    {"payment_method": "INVENTED"}, {"ticket_count": True}, {"extra_field": "x"},
])
def test_revenue_schema_is_strict(change):
    with pytest.raises(ValidationError):
        revenue(**change)


@pytest.mark.parametrize("change", [
    {"amount_ttc": "400"}, {"deductible_vat": "61"}, {"deductible_vat": "-1"},
    {"category": "INVENTED"}, {"category": "EQUIPEMENT", "allocation": "FOOD"},
])
def test_expense_schema_is_strict(change):
    with pytest.raises(ValidationError):
        expense(**change)


@pytest.mark.parametrize("change", [
    {"employer_charges": "10"}, {"loan_principal": "10"},
    {"category": "PAYROLL", "vat_rate": "20"},
    {"category": "LOAN", "loan_principal": "101"},
    {"active_to": "2025-12-31"}, {"monthly_amount_ht": "-1"},
])
def test_overhead_schema_is_strict(change):
    with pytest.raises(ValidationError):
        overhead(**change)


def test_engine_rejects_mixed_companies_bad_periods_and_duplicate_snapshots():
    with pytest.raises(ValueError, match="plusieurs entreprises mélangées"):
        build_dashboard(company(), PERIOD, [revenue(company_id="b")], [], [])
    with pytest.raises(ValueError, match="hors de la période demandée"):
        build_dashboard(company(), PERIOD, [revenue(date="2026-02-01")], [], [])
    snapshot = inventories("FOOD", "10", "20")[0]
    with pytest.raises(ValueError, match="Inventaires en double"):
        build_dashboard(company(), PERIOD, [], [], [], [snapshot, snapshot])
    with pytest.raises(ValueError, match="postérieur au début de la période"):
        build_dashboard(company(), PERIOD, [], [], [], cash_balance=CashBalanceIn(
            company_id="a", date="2026-01-02", amount="0",
        ))


@pytest.fixture
def engine(tmp_path):
    engine = create_finance_engine(URL.create("sqlite", database=str(tmp_path / "finance.sqlite3")))
    with Session(engine) as session:
        session.add_all([CompanyProfile(**company().model_dump()), CompanyProfile(**company(identity="b").model_dump())])
        session.commit()
    yield engine
    engine.dispose()


def test_sqlite_preserves_exact_large_decimals_and_enforces_foreign_keys(engine):
    value = revenue("999999999999.99", vat_rate="0", amount_ttc="999999999999.99")
    with Session(engine) as session:
        session.add(TransactionRevenue(**value.model_dump()))
        session.commit()
    with Session(engine) as session:
        stored = session.scalars(select(TransactionRevenue)).one()
        assert stored.amount_ht == D("999999999999.99")
        assert stored.vat_rate == D("0.0000")
        assert session.connection().exec_driver_sql("SELECT typeof(amount_ht) FROM finance_revenues").scalar() == "integer"
        session.add(TransactionRevenue(**revenue(company_id="missing").model_dump()))
        with pytest.raises(IntegrityError):
            session.flush()


@pytest.mark.parametrize("invalid", [1.01, D("1.001"), D("NaN")])
def test_sqlite_rejects_float_and_lossy_values_even_without_pydantic(engine, invalid):
    with Session(engine) as session:
        session.add(TransactionRevenue(**(revenue().model_dump() | {"amount_ht": invalid})))
        with pytest.raises(StatementError):
            session.flush()


def test_loader_scopes_every_table_and_filters_dates(engine):
    with Session(engine) as session:
        for identity in ("a", "b"):
            session.add_all([
                TransactionRevenue(**revenue(company_id=identity, date="2026-01-01").model_dump()),
                TransactionRevenue(**revenue(company_id=identity, date="2026-01-31").model_dump()),
                TransactionRevenue(**revenue(company_id=identity, date="2026-02-01").model_dump()),
                PurchaseExpense(**expense(company_id=identity).model_dump()),
                RecurringOverhead(**overhead(company_id=identity).model_dump()),
                InventorySnapshot(company_id=identity, date=date(2026, 1, 1), allocation=Allocation.FOOD, value=D("12")),
                CashBalance(company_id=identity, date=date(2025, 12, 31), amount=D("5")),
                CashBalance(company_id=identity, date=date(2026, 2, 1), amount=D("9999")),
                CashMovement(company_id=identity, date=date(2025, 12, 31), amount=D("3"), label="Avant"),
                CashMovement(company_id=identity, date=date(2026, 1, 1), amount=D("2"), label="Apres"),
            ])
        session.commit()
    with Session(engine) as session:
        result = load_dashboard(session, "a", PERIOD)
        assert result.common.revenue_ht == D("2000")
        assert result.common.variable_costs == D("300")
        assert result.common.fixed_costs == D("100")
        assert result.common.opening_cash == D("8")
        assert result.common.closing_cash == D("10")
        assert load_dashboard(session, "b", PERIOD).common == result.common


@pytest.fixture
def api(engine):
    members = {
        ("u1", "a"): {"role": "manager"}, ("u2", "b"): {"role": "admin"}, ("viewer", "a"): {"role": "viewer"},
        ("u3", "c"): {"role": "admin"},
    }
    database = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(
        side_effect=lambda query: members.get((query["user_id"], query["company_id"])),
    )))

    async def require_user(request, _db):
        user = request.headers.get("x-test-user")
        if not user:
            raise HTTPException(401, "Authentification requise.")
        return {"user_id": user}

    def session_dependency():
        with Session(engine) as session:
            yield session

    app = FastAPI()
    app.include_router(make_company_finance_router(database, require_user), prefix="/api")
    app.dependency_overrides[get_db] = session_dependency
    with TestClient(app) as client:
        yield client, app, database


def test_api_is_authenticated_company_scoped_and_preserves_decimal_json(api):
    client, _, database = api
    url = "/api/finance/a/dashboard?start_date=2026-01-01&end_date=2026-01-31"
    assert client.get(url).status_code == 401
    assert client.get(url, headers={"x-test-user": "u2"}).status_code == 404
    assert client.get(url, headers={"x-test-user": "viewer"}).status_code == 403
    response = client.get(url, headers={"x-test-user": "u1"})
    assert response.status_code == 200
    assert response.json()["common"]["revenue_ht"] == "0.00"
    assert response.json()["common"]["closing_cash"] is None
    database.enterprise_members.find_one.assert_awaited_with({"user_id": "u1", "company_id": "a"})
    assert client.get(url.replace("/a/", "/b/"), headers={"x-test-user": "u2"}).status_code == 200
    assert client.get(url.replace("/a/", "/b/"), headers={"x-test-user": "u1"}).status_code == 404


def test_member_without_finance_profile_is_invited_to_create_it(api):
    client, _, _ = api
    response = client.get(
        "/api/finance/c/dashboard?start_date=2026-01-01&end_date=2026-01-31", headers={"x-test-user": "u3"},
    )
    assert response.status_code == 404
    # Contrat avec frontend/src/companyFinance.js (PROFILE_MISSING_PREFIX).
    assert response.json()["detail"].startswith("Profil financier")
    assert "Saisie & imports" in response.json()["detail"]


@pytest.mark.parametrize("query", [
    "", "?start_date=2026-02-01&end_date=2026-01-01",
    "?start_date=0&end_date=2026-01-31",
    "?start_date=2026-02-30&end_date=2026-03-01",
    "?start_date=2026-01-01&end_date=9999-12-31",
])
def test_invalid_dashboard_periods_return_422(api, query):
    client, _, _ = api
    assert client.get("/api/finance/a/dashboard" + query, headers={"x-test-user": "u1"}).status_code == 422


def test_storage_failure_is_logged_and_returns_503(api, monkeypatch, caplog):
    import routers.finance as routes
    client, _, _ = api

    def failure(*args):
        raise OperationalError("SELECT", {}, Exception("offline"))

    monkeypatch.setattr(routes, "load_dashboard", failure)
    response = client.get("/api/finance/a/dashboard?start_date=2026-01-01&end_date=2026-01-31",
                          headers={"x-test-user": "u1"})
    assert response.status_code == 503
    assert "Lecture du registre financier impossible" in caplog.text


@pytest.mark.parametrize("sector", list(Sector))
def test_api_serializes_each_sector_response(api, engine, sector):
    with Session(engine) as session:
        profile = session.get(CompanyProfile, "a")
        profile.sector = sector
        session.commit()
    client, _, _ = api
    response = client.get("/api/finance/a/dashboard?start_date=2026-01-01&end_date=2026-01-31",
                          headers={"x-test-user": "u1"})
    assert response.status_code == 200
    assert response.json()["specific"]["sector"] == sector.value


def test_authorization_storage_failure_is_not_an_empty_dashboard(api, caplog):
    import sqlite3
    client, _, database = api
    database.enterprise_members.find_one.side_effect = sqlite3.OperationalError("offline")
    response = client.get("/api/finance/a/dashboard?start_date=2026-01-01&end_date=2026-01-31",
                          headers={"x-test-user": "u1"})
    assert response.status_code == 503
    assert "Vérification des droits entreprise impossible" in caplog.text


def test_inconsistent_persisted_vat_returns_explicit_error(api, engine, caplog):
    with Session(engine) as session:
        session.add(TransactionRevenue(**(revenue().model_dump() | {"amount_ttc": D("999")})))
        session.commit()
    client, _, _ = api
    response = client.get("/api/finance/a/dashboard?start_date=2026-01-01&end_date=2026-01-31",
                          headers={"x-test-user": "u1"})
    assert response.status_code == 500
    assert "Données enregistrées incohérentes" in caplog.text

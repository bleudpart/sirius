import json
from datetime import date
from decimal import Decimal as D

import pytest
from pydantic import ValidationError

from kpi_engine import FinanceDataset, build_dashboard, build_report, comparison_period, month_periods
from schemas.finance import (
    BalanceSheetSnapshotIn, CashBalanceIn, CashMovementIn, CategorieExpense as Category, CompanyProfileIn,
    ComparisonMode, OverheadCategory, Period, PurchaseExpenseIn, RecurringOverheadIn, SectorEnum as Sector,
    TransactionRevenueIn,
)

PERIOD = Period(start_date="2026-01-01", end_date="2026-01-31")
COMPANY = CompanyProfileIn(id="a", name="Entreprise test", sector=Sector.SERVICES)


def revenue(amount="1000", day="2026-01-15", **changes):
    ht = D(amount)
    return TransactionRevenueIn.model_validate({
        "company_id": "a", "date": day, "amount_ht": ht, "amount_ttc": ht * D("1.2"),
        "vat_rate": "20", "payment_method": "TRANSFER", **changes,
    })


def expense(amount="300", day="2026-01-15", **changes):
    ht = D(amount)
    return PurchaseExpenseIn.model_validate({
        "company_id": "a", "date": day, "supplier": "Fournisseur", "amount_ht": ht,
        "amount_vat": ht * D("0.2"), "amount_ttc": ht * D("1.2"), "deductible_vat": ht * D("0.2"),
        "category": "MATIERE_PREMIERE", **changes,
    })


def overhead(amount="100", **changes):
    return RecurringOverheadIn.model_validate({
        "company_id": "a", "label": "Charge", "category": "RENT", "monthly_amount_ht": amount,
        "active_from": "2026-01-01", **changes,
    })


def sheet(**changes):
    return BalanceSheetSnapshotIn.model_validate({
        "company_id": "a", "date": "2025-12-31", "equity": "20000", "financial_debt": "30000",
        "inventory": "5000", "trade_receivables": "12000", "trade_payables": "6000",
        "tax_social_payables": "3000", "cash": "4000", "total_assets": "70000", **changes,
    })


def reference_case(balance_sheet=None):
    return build_dashboard(
        COMPANY, PERIOD, [revenue("10000")],
        [expense("3000"), expense("1000", category=Category.EQUIPEMENT)],
        [overhead("1000", vat_rate="20", vat_recoverable=True),
         overhead("2000", category=OverheadCategory.PAYROLL, employer_charges="800"),
         overhead("500", category=OverheadCategory.LOAN, loan_principal="400")],
        cash_balance=CashBalanceIn(company_id="a", date="2025-12-31", amount="500"),
        cash_movements=[
            CashMovementIn(company_id="a", date="2025-12-31", amount="200", label="Avant période"),
            CashMovementIn(company_id="a", date="2026-01-01", amount="-1000", label="Paiement"),
            CashMovementIn(company_id="a", date="2026-01-31", amount="12000", label="Encaissement"),
        ],
        balance_sheet=balance_sheet,
    )


def codes(dashboard):
    return {alert.code for alert in dashboard.alerts}


def test_intermediate_balances_caf_and_debt_service_are_exact():
    banking = reference_case().banking
    assert banking.model_dump(include={
        "external_charges", "external_charges_pct", "value_added", "value_added_pct", "payroll_costs",
        "payroll_costs_pct", "payroll_to_value_added_pct", "ebe_margin_pct", "financial_expenses_to_revenue_pct",
        "approximate_caf", "caf_margin_pct", "loan_principal_repaid", "debt_service", "debt_service_coverage",
        "caf_after_principal", "financial_expenses_to_ebe_pct", "safety_margin", "safety_margin_pct",
        "break_even_date", "cash_days",
    }) == {
        "external_charges": D("4000.00"), "external_charges_pct": D("40.00"),
        "value_added": D("6000.00"), "value_added_pct": D("60.00"),
        "payroll_costs": D("2800.00"), "payroll_costs_pct": D("28.00"),
        "payroll_to_value_added_pct": D("46.67"), "ebe_margin_pct": D("32.00"),
        "financial_expenses_to_revenue_pct": D("1.00"),
        "approximate_caf": D("3100.00"), "caf_margin_pct": D("31.00"),
        "loan_principal_repaid": D("400.00"), "debt_service": D("500.00"),
        "debt_service_coverage": D("6.40"), "caf_after_principal": D("2700.00"),
        "financial_expenses_to_ebe_pct": D("3.13"),
        "safety_margin": D("4571.43"), "safety_margin_pct": D("45.71"),
        "break_even_date": date(2026, 1, 15), "cash_days": D("362.7"),
    }


def test_value_added_identity_holds_to_the_cent():
    result = reference_case()
    assert result.banking.value_added - result.banking.payroll_costs == result.common.approximate_ebe
    assert result.common.approximate_ebe - result.common.financial_expenses == result.banking.approximate_caf


def test_balance_sheet_ratios_and_structure_alerts():
    result = reference_case(sheet())
    banking = result.banking
    assert banking.model_dump(include={
        "balance_sheet_date", "working_capital_requirement", "working_capital_days", "customer_days",
        "supplier_days", "inventory_days", "financial_debt", "net_debt", "equity", "gearing",
        "equity_ratio_pct", "debt_repayment_years",
    }) == {
        "balance_sheet_date": date(2025, 12, 31), "working_capital_requirement": D("8000.00"),
        "working_capital_days": D("24.8"), "customer_days": D("31.0"), "supplier_days": D("38.8"),
        "inventory_days": D("51.7"), "financial_debt": D("30000"), "net_debt": D("26000.00"),
        "equity": D("20000"), "gearing": D("1.30"), "equity_ratio_pct": D("28.57"),
        "debt_repayment_years": D("0.8"),
    }
    assert "HIGH_GEARING" in codes(result)
    assert not codes(result) & {"BALANCE_SHEET_MISSING", "LOW_EQUITY_RATIO", "LONG_REPAYMENT", "NEGATIVE_EQUITY"}


def test_missing_then_stale_balance_sheet_is_reported():
    assert "BALANCE_SHEET_MISSING" in codes(reference_case())
    assert reference_case().banking.gearing is None
    stale = reference_case(sheet(date="2024-07-30"))
    assert "BALANCE_SHEET_STALE" in codes(stale)
    assert "BALANCE_SHEET_STALE" not in codes(reference_case(sheet(date="2024-07-31")))


def test_negative_equity_disables_gearing_and_equity_ratio():
    result = reference_case(sheet(equity="-5000", total_assets="70000"))
    assert result.banking.gearing is None
    assert result.banking.equity_ratio_pct == D("-7.14")
    assert "NEGATIVE_EQUITY" in codes(result)
    assert "LOW_EQUITY_RATIO" not in codes(result)


def test_uncovered_debt_service_and_missing_repayment_capacity_are_critical():
    result = build_dashboard(
        COMPANY, PERIOD, [revenue("1000")], [expense("300")],
        [overhead("900"), overhead("500", category=OverheadCategory.LOAN, loan_principal="300")],
        balance_sheet=sheet(),
    )
    alerts = {alert.code: alert.severity for alert in result.alerts}
    assert result.banking.approximate_caf == D("-400.00")
    assert result.banking.debt_service_coverage == D("-0.40")
    assert alerts["DEBT_SERVICE_NOT_COVERED"] == "critical"
    assert alerts["NO_REPAYMENT_CAPACITY"] == "critical"
    assert result.banking.financial_expenses_to_ebe_pct is None
    assert result.banking.debt_repayment_years is None
    assert "LONG_REPAYMENT" not in alerts


def test_tight_coverage_and_heavy_interest_warnings():
    result = build_dashboard(
        COMPANY, PERIOD, [revenue("1000")], [],
        [overhead("100"), overhead("500", category=OverheadCategory.LOAN, loan_principal="400")],
    )
    assert result.banking.debt_service_coverage == D("1.80")
    assert not codes(result) & {"DEBT_SERVICE_TIGHT", "DEBT_SERVICE_NOT_COVERED"}
    result = build_dashboard(
        COMPANY, PERIOD, [revenue("1000")], [],
        [overhead("400"), overhead("500", category=OverheadCategory.LOAN, loan_principal="400")],
    )
    assert result.banking.debt_service_coverage == D("1.20")
    assert "DEBT_SERVICE_TIGHT" not in codes(result)
    result = build_dashboard(
        COMPANY, PERIOD, [revenue("1000")], [],
        [overhead("450"), overhead("500", category=OverheadCategory.LOAN, loan_principal="300")],
    )
    alerts = codes(result)
    assert result.banking.debt_service_coverage == D("1.10")
    assert result.banking.financial_expenses_to_ebe_pct == D("36.36")
    assert {"DEBT_SERVICE_TIGHT", "HIGH_FINANCIAL_EXPENSES"} <= alerts
    assert "DEBT_SERVICE_NOT_COVERED" not in alerts


def test_break_even_date_and_cash_days_edge_cases():
    early = build_dashboard(COMPANY, PERIOD, [revenue("100", day="2026-01-03")], [], [])
    assert early.banking.break_even_date == date(2026, 1, 1)
    late = build_dashboard(
        COMPANY, PERIOD, [revenue("600", day="2026-01-05"), revenue("600", day="2026-01-20")], [], [overhead("1000")],
    )
    assert late.banking.break_even_date == date(2026, 1, 20)
    missed = build_dashboard(COMPANY, PERIOD, [revenue("600")], [], [overhead("1000")])
    assert missed.banking.break_even_date is None
    assert missed.banking.safety_margin == D("-400.00")
    negative_cash = build_dashboard(
        COMPANY, PERIOD, [], [], [],
        cash_balance=CashBalanceIn(company_id="a", date="2025-12-31", amount="-10"),
    )
    assert negative_cash.banking.cash_days is None
    assert build_dashboard(COMPANY, PERIOD, [], [], []).banking.break_even_date is None


def test_low_cash_days_and_long_repayment_alerts():
    result = build_dashboard(
        COMPANY, PERIOD, [revenue("1000")], [], [overhead("100")],
        cash_balance=CashBalanceIn(company_id="a", date="2025-12-31", amount="100"),
        cash_movements=[CashMovementIn(company_id="a", date="2026-01-10", amount="-310", label="Loyer")],
        balance_sheet=sheet(financial_debt="40000", total_assets="80000"),
    )
    assert result.banking.cash_days is None
    assert "NEGATIVE_CASH" in codes(result)
    result = build_dashboard(
        COMPANY, PERIOD, [revenue("1000")], [], [overhead("100")],
        cash_balance=CashBalanceIn(company_id="a", date="2025-12-31", amount="410"),
        cash_movements=[CashMovementIn(company_id="a", date="2026-01-10", amount="-310", label="Loyer")],
        balance_sheet=sheet(financial_debt="40000", total_assets="80000"),
    )
    assert result.banking.cash_days == D("10.0")
    assert result.banking.debt_repayment_years == D("3.8")
    assert "LOW_CASH_DAYS" in codes(result)
    assert "LONG_REPAYMENT" not in codes(result)
    result = build_dashboard(
        COMPANY, PERIOD, [revenue("1000")], [], [overhead("100")],
        balance_sheet=sheet(financial_debt="45000", total_assets="80000"),
    )
    assert result.banking.debt_repayment_years == D("4.2")
    assert "LONG_REPAYMENT" in codes(result)


@pytest.mark.parametrize(("start", "end", "mode", "expected"), [
    ("2026-01-01", "2026-01-31", ComparisonMode.PREVIOUS, ("2025-12-01", "2025-12-31")),
    ("2026-01-01", "2026-03-31", ComparisonMode.PREVIOUS, ("2025-10-01", "2025-12-31")),
    ("2025-01-01", "2025-12-31", ComparisonMode.PREVIOUS, ("2024-01-01", "2024-12-31")),
    ("2026-03-01", "2026-03-31", ComparisonMode.PREVIOUS, ("2026-02-01", "2026-02-28")),
    ("2026-01-10", "2026-01-19", ComparisonMode.PREVIOUS, ("2025-12-31", "2026-01-09")),
    ("2024-02-01", "2024-02-29", ComparisonMode.YEAR_AGO, ("2023-02-01", "2023-02-28")),
    ("2023-02-01", "2023-02-28", ComparisonMode.YEAR_AGO, ("2022-02-01", "2022-02-28")),
    ("2025-02-01", "2025-02-28", ComparisonMode.YEAR_AGO, ("2024-02-01", "2024-02-29")),
    ("2024-02-29", "2024-03-10", ComparisonMode.YEAR_AGO, ("2023-02-28", "2023-03-10")),
])
def test_comparison_periods(start, end, mode, expected):
    reference = comparison_period(Period(start_date=start, end_date=end), mode)
    assert (reference.start_date.isoformat(), reference.end_date.isoformat()) == expected


def test_comparison_none_and_out_of_range():
    assert comparison_period(PERIOD, ComparisonMode.NONE) is None
    assert comparison_period(Period(start_date="0001-01-01", end_date="0001-01-31"), ComparisonMode.PREVIOUS) is None
    assert comparison_period(Period(start_date="0001-03-01", end_date="0001-03-31"), ComparisonMode.YEAR_AGO) is None


def test_report_compares_previous_period_with_relative_change_only_for_amounts():
    dataset = FinanceDataset(
        company=COMPANY,
        revenues=(revenue("8000", day="2025-12-10"), revenue("10000")),
        expenses=(expense("2000", day="2025-12-10"), expense("3000")),
        overheads=(overhead("1000", active_from="2025-01-01"),),
    )
    report = build_report(dataset, PERIOD)
    comparison = report.comparison
    assert (comparison.mode, comparison.period.start_date, comparison.has_data) == (
        ComparisonMode.PREVIOUS, date(2025, 12, 1), True,
    )
    variations = {item.key: item for item in comparison.variations}
    assert variations["revenue_ht"].model_dump() == {
        "key": "revenue_ht", "current": D("10000.00"), "previous": D("8000.00"),
        "change": D("2000.00"), "change_pct": D("25.00"),
    }
    assert variations["contribution_margin_pct"].change == D("-5.00")
    assert variations["contribution_margin_pct"].change_pct is None
    assert variations["debt_service_coverage"].change is None
    assert "break_even_date" not in variations
    assert report.monthly and build_report(dataset, PERIOD, ComparisonMode.NONE).comparison is None
    year_ago = build_report(dataset, PERIOD, ComparisonMode.YEAR_AGO).comparison
    assert year_ago.has_data is False
    assert {item.key: item for item in year_ago.variations}["revenue_ht"].change_pct is None


def test_dataset_selection_matches_period_rules():
    dataset = FinanceDataset(
        company=COMPANY,
        revenues=(revenue(day="2025-12-31"), revenue(day="2026-01-01"), revenue(day="2026-02-01")),
        cash_balances=(
            CashBalanceIn(company_id="a", date="2025-12-20", amount="5"),
            CashBalanceIn(company_id="a", date="2026-01-02", amount="99"),
        ),
        cash_movements=(
            CashMovementIn(company_id="a", date="2025-12-19", amount="1", label="Ignoré"),
            CashMovementIn(company_id="a", date="2025-12-20", amount="2", label="Repris"),
        ),
        balance_sheets=(sheet(date="2025-12-31"), sheet(date="2026-02-01")),
    )
    selected = dataset.select(PERIOD)
    assert [r.date for r in selected["revenues"]] == [date(2026, 1, 1)]
    assert selected["cash_balance"].amount == D("5")
    assert [m.label for m in selected["cash_movements"]] == ["Repris"]
    assert selected["balance_sheet"].date == date(2025, 12, 31)
    assert build_dashboard(**selected).common.opening_cash == D("7.00")


def test_monthly_series_tracks_cumulative_cash_and_truncates_to_sixty_months():
    period = Period(start_date="2026-01-01", end_date="2026-03-15")
    result = build_dashboard(
        COMPANY, period,
        [revenue("1000", day="2026-01-15"), revenue("2000", day="2026-02-15"), revenue("500", day="2026-03-15")],
        [], [overhead("100")],
        cash_balance=CashBalanceIn(company_id="a", date="2025-12-31", amount="100"),
        cash_movements=[
            CashMovementIn(company_id="a", date="2026-01-20", amount="50", label="Janvier"),
            CashMovementIn(company_id="a", date="2026-03-02", amount="-20", label="Mars"),
        ],
    )
    assert [(p.period.end_date, p.revenue_ht, p.approximate_ebe, p.closing_cash) for p in result.monthly] == [
        (date(2026, 1, 31), D("1000.00"), D("900.00"), D("150.00")),
        (date(2026, 2, 28), D("2000.00"), D("1900.00"), D("150.00")),
        (date(2026, 3, 15), D("500.00"), D("451.61"), D("130.00")),
    ]
    assert result.monthly[-1].closing_cash == result.common.closing_cash
    long_period = Period(start_date="2020-01-01", end_date="2025-01-31")
    assert len(month_periods(long_period)) == 61
    long = build_dashboard(COMPANY, long_period, [], [], [])
    assert len(long.monthly) == 60 and long.monthly[0].period.start_date == date(2020, 2, 1)
    assert "MONTHLY_SERIES_TRUNCATED" in codes(long)


def test_demo_flag_is_disclosed_and_payload_has_no_floats():
    result = reference_case(sheet())
    demo = build_dashboard(COMPANY, PERIOD, [], [], [], demo=True)
    assert demo.demo is True and "DEMO_DATA" in codes(demo)
    assert result.demo is False and "DEMO_DATA" not in codes(result)
    payload = json.loads(result.model_dump_json())
    assert payload["calculation_version"] == "2"
    assert all(value is None or isinstance(value, str) for value in payload["banking"].values())
    assert all(isinstance(value, str) for point in payload["monthly"] for key, value in point.items()
               if key not in {"period", "ebe_margin_pct", "closing_cash", "stock_variation"})
    assert all(point["stock_variation"] is None for point in payload["monthly"])


def test_balance_sheet_validation_and_isolation():
    with pytest.raises(ValidationError):
        sheet(total_assets="1000")
    with pytest.raises(ValidationError):
        sheet(financial_debt="-1")
    with pytest.raises(ValueError, match="plusieurs entreprises mélangées"):
        build_dashboard(COMPANY, PERIOD, [], [], [], balance_sheet=sheet(company_id="b"))
    with pytest.raises(ValueError, match="après la fin de la période"):
        build_dashboard(COMPANY, PERIOD, [], [], [], balance_sheet=sheet(date="2026-02-01"))

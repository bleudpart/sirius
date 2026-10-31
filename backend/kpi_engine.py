"""Calculs déterministes de la finance d'entreprise, sans ORM, HTTP, données de marché ni IA."""
from abc import ABC, abstractmethod
from calendar import monthrange
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, localcontext
from typing import TypedDict, get_args

from pydantic import BaseModel, TypeAdapter

from schemas.finance import (
    Alert, AllocatedOverhead, AllocationEnum, BalanceSheetSnapshotIn, BankingKPIs, CashBalanceIn,
    CashMovementIn, CategorieExpense, CommonKPIs, ComparisonMode, CompanyProfileIn, FINANCE_CONTEXT,
    FinanceDashboard, HUNDRED, InventorySnapshotIn, MetricVariation, MonthlyPoint, OverheadCategory,
    Period, PeriodComparison, ProjectMargin, PurchaseExpenseIn, RecurringOverheadIn, SectorEnum,
    SectorKPIs, TransactionRevenueIn, ZERO, money,
)

SpecificValues = dict[str, Decimal | str | None | list[ProjectMargin]]
VARIABLE_CATEGORIES = {
    CategorieExpense.MATIERE_PREMIERE, CategorieExpense.SOUS_TRAITANCE, CategorieExpense.FOURNITURES,
}
DRY_CATEGORIES = {CategorieExpense.MATIERE_PREMIERE, CategorieExpense.SOUS_TRAITANCE}
EXTERNAL_OVERHEADS = {OverheadCategory.RENT, OverheadCategory.INSURANCE, OverheadCategory.OTHER}
DAYS_QUANTUM = Decimal("0.1")
YEAR_DAYS = Decimal("365")
MAX_MONTHLY_POINTS = 60
STOCK_LABELS = {
    AllocationEnum.FOOD: "aliments", AllocationEnum.BEVERAGE: "boissons", AllocationEnum.MERCHANDISE: "marchandises",
}
SPECIFIC_LABELS = {
    "food_consumed_cost": "Coût des aliments consommés", "beverage_consumed_cost": "Coût des boissons consommées",
    "food_cost_pct": "Food Cost", "beverage_cost_pct": "Beverage Cost", "prime_cost_pct": "Prime Cost",
    "margin_pct": "Taux de marge sur déboursé sec", "goods_consumed_cost": "Coût des marchandises consommées",
    "commercial_margin": "Marge commerciale", "commercial_margin_pct": "Taux de marge commerciale",
    "estimated_stock_turnover": "Rotation estimée des stocks", "average_basket_ht": "Panier moyen HT",
    "average_hourly_rate_ht": "Taux horaire moyen réel", "average_daily_rate_ht": "Taux journalier moyen réel",
    "structure_cost_ratio_pct": "Charges de structure / CA",
}
# Repères bancaires usuels, présentés comme seuils indicatifs dans les alertes et la documentation.
MIN_DEBT_SERVICE_COVERAGE = Decimal("1.2")
MAX_FINANCIAL_EXPENSES_TO_EBE_PCT = Decimal("30")
MAX_DEBT_REPAYMENT_YEARS = Decimal("4")
MAX_GEARING = Decimal("1")
MIN_EQUITY_RATIO_PCT = Decimal("20")
MIN_CASH_DAYS = Decimal("30")
STALE_BALANCE_SHEET_MONTHS = 18
RATE_KEYS = frozenset({
    "debt_service_coverage", "gearing", "estimated_stock_turnover", "cash_days", "working_capital_days",
    "customer_days", "supplier_days", "inventory_days", "debt_repayment_years",
})


def expense_cost(expense: PurchaseExpenseIn) -> Decimal:
    with localcontext(FINANCE_CONTEXT):
        return expense.amount_ttc - expense.deductible_vat


def ratio(
    numerator: Decimal | None, denominator: Decimal, *, percent: bool = True,
    quantum: Decimal = Decimal("0.01"),
) -> Decimal | None:
    if numerator is None or denominator <= ZERO:
        return None
    with localcontext(FINANCE_CONTEXT):
        return (numerator / denominator * (HUNDRED if percent else Decimal("1"))).quantize(quantum)


def month_end(value: date) -> date:
    return date(value.year, value.month, monthrange(value.year, value.month)[1])


def add_months(value: date, months: int) -> date:
    year, month = divmod(value.year * 12 + value.month - 1 + months, 12)
    return date(year, month + 1, min(value.day, monthrange(year, month + 1)[1]))


def period_days(period: Period) -> Decimal:
    return Decimal((period.end_date - period.start_date).days + 1)


def whole_months(period: Period) -> int | None:
    if period.start_date.day != 1 or period.end_date != month_end(period.end_date):
        return None
    return (period.end_date.year - period.start_date.year) * 12 + period.end_date.month - period.start_date.month + 1


def month_periods(period: Period) -> list[Period]:
    result: list[Period] = []
    start = period.start_date
    while start <= period.end_date:
        end = min(month_end(start), period.end_date)
        result.append(Period(start_date=start, end_date=end))
        if end == period.end_date:
            break
        start = end + timedelta(days=1)
    return result


def comparison_period(period: Period, mode: ComparisonMode) -> Period | None:
    """Des mois entiers se comparent à des mois entiers ; les autres périodes, au même nombre de jours."""
    if mode == ComparisonMode.NONE:
        return None
    months = whole_months(period)
    try:
        if mode == ComparisonMode.YEAR_AGO:
            start = add_months(period.start_date, -12)
            end = add_months(period.end_date, -12)
            return Period(start_date=start, end_date=month_end(end) if months else end)
        if months:
            return Period(start_date=add_months(period.start_date, -months), end_date=period.start_date - timedelta(days=1))
        length = timedelta(days=(period.end_date - period.start_date).days + 1)
        return Period(start_date=period.start_date - length, end_date=period.start_date - timedelta(days=1))
    except (OverflowError, ValueError):
        return None


def allocate_overheads(overheads: Sequence[RecurringOverheadIn], period: Period) -> list[AllocatedOverhead]:
    result: list[AllocatedOverhead] = []
    with localcontext(FINANCE_CONTEXT):
        for item in overheads:
            start = max(item.active_from, period.start_date)
            end = min(item.active_to or period.end_date, period.end_date)
            factor = ZERO
            while start <= end:
                days_in_month = monthrange(start.year, start.month)[1]
                last = min(date(start.year, start.month, days_in_month), end)
                factor += Decimal((last - start).days + 1) / Decimal(days_in_month)
                start = last + timedelta(days=1)
            monthly_vat = money(item.monthly_amount_ht * item.vat_rate / HUNDRED)
            deductible = monthly_vat if item.vat_recoverable else ZERO
            operating = item.monthly_amount_ht + item.employer_charges - item.loan_principal + monthly_vat - deductible
            financial = operating if item.category == OverheadCategory.LOAN else ZERO
            result.append(AllocatedOverhead(
                category=item.category,
                committed=money((item.monthly_amount_ht + item.employer_charges + monthly_vat) * factor),
                operating=money((operating - financial) * factor),
                financial=money(financial * factor),
                principal=money(item.loan_principal * factor),
                deductible_vat=money(deductible * factor),
            ))
    return result


class BaseSectorKPIStrategy(ABC):
    def __init__(self, period: Period, inventories: Sequence[InventorySnapshotIn] = ()):
        self.period = period
        self.inventories = tuple(inventories)
        self.alerts: list[Alert] = []

    @abstractmethod
    def compute_specific_kpis(
        self, revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
        overheads: Sequence[AllocatedOverhead],
    ) -> SpecificValues:
        """Renvoie des indicateurs nommés explicitement ; une valeur indisponible vaut None."""

    def warn(self, code: str, message: str) -> None:
        alert = Alert(code=code, severity="warning", message=message)
        if alert not in self.alerts:
            self.alerts.append(alert)

    def stock_pair(self, allocation: AllocationEnum) -> tuple[Decimal, Decimal] | None:
        values = {row.date: row.value for row in self.inventories if row.allocation == allocation}
        start, end = self.period.start_date, self.period.end_date + timedelta(days=1)
        if start not in values or end not in values:
            self.warn(
                f"MISSING_STOCK_{allocation.value}",
                f"Stock de {STOCK_LABELS[allocation]} requis au premier jour de la période et au lendemain de son dernier jour.",
            )
            return None
        return values[start], values[end]

    def consumed_cost(self, allocation: AllocationEnum, expenses: Sequence[PurchaseExpenseIn]) -> Decimal | None:
        pair = self.stock_pair(allocation)
        if any(e.category == CategorieExpense.MATIERE_PREMIERE and e.allocation == AllocationEnum.OTHER for e in expenses):
            self.warn("UNALLOCATED_PURCHASES", "Ventiler tous les achats de matières ou de marchandises avant de calculer les coûts consommés.")
            return None
        if pair is None:
            return None
        consumed = pair[0] + sum((expense_cost(e) for e in expenses if e.allocation == allocation), ZERO) - pair[1]
        if consumed < ZERO:
            self.warn(
                f"INCONSISTENT_STOCK_{allocation.value}",
                f"Stock final de {STOCK_LABELS[allocation]} supérieur au stock initial plus les achats : consommation non calculable.",
            )
            return None
        return consumed


class HospitalityStrategy(BaseSectorKPIStrategy):
    def compute_specific_kpis(
        self, revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
        overheads: Sequence[AllocatedOverhead],
    ) -> SpecificValues:
        with localcontext(FINANCE_CONTEXT):
            food = self.consumed_cost(AllocationEnum.FOOD, expenses)
            beverage = self.consumed_cost(AllocationEnum.BEVERAGE, expenses)
            food_sales = sum((r.amount_ht for r in revenues if r.allocation == AllocationEnum.FOOD), ZERO)
            beverage_sales = sum((r.amount_ht for r in revenues if r.allocation == AllocationEnum.BEVERAGE), ZERO)
            sales = sum((r.amount_ht for r in revenues), ZERO)
            payroll = sum((o.operating for o in overheads if o.category == OverheadCategory.PAYROLL), ZERO)
            food_ratio, beverage_ratio = ratio(food, food_sales), ratio(beverage, beverage_sales)
            if any(r.allocation == AllocationEnum.OTHER for r in revenues):
                self.warn("UNALLOCATED_REVENUES", "Ventilation aliments/boissons incomplète : ratios Food Cost et Beverage Cost indisponibles.")
                food_ratio = beverage_ratio = None
            return {
                "sector": SectorEnum.HOSPITALITY,
                "food_consumed_cost": food, "beverage_consumed_cost": beverage,
                "food_cost_pct": food_ratio, "beverage_cost_pct": beverage_ratio,
                "prime_cost_pct": ratio(food + beverage + payroll, sales) if food is not None and beverage is not None else None,
            }


class ConstructionStrategy(BaseSectorKPIStrategy):
    def compute_specific_kpis(
        self, revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
        overheads: Sequence[AllocatedOverhead],
    ) -> SpecificValues:
        with localcontext(FINANCE_CONTEXT):
            direct = [e for e in expenses if e.category in DRY_CATEGORIES]
            sales = sum((r.amount_ht for r in revenues), ZERO)
            dry = sum((expense_cost(e) for e in direct), ZERO)
            project_sales: dict[str, Decimal] = {}
            project_costs: dict[str, Decimal] = {}
            for row in revenues:
                if row.business_reference:
                    project_sales[row.business_reference] = project_sales.get(row.business_reference, ZERO) + row.amount_ht
            for item in direct:
                if item.business_reference:
                    project_costs[item.business_reference] = project_costs.get(item.business_reference, ZERO) + expense_cost(item)
            projects: list[ProjectMargin] = []
            for reference in sorted(project_sales.keys() | project_costs.keys()):
                revenue, cost = project_sales.get(reference, ZERO), project_costs.get(reference, ZERO)
                projects.append(ProjectMargin(
                    business_reference=reference, revenue_ht=revenue, dry_cost=cost,
                    margin=revenue - cost, margin_pct=ratio(revenue - cost, revenue),
                ))
                if cost > revenue:
                    self.warn("LOSS_MAKING_PROJECT", f"Coûts directs supérieurs au CA reconnu sur la période pour {reference}.")
            missing_sales = sum((r.amount_ht for r in revenues if not r.business_reference), ZERO)
            missing_costs = sum((expense_cost(e) for e in direct if not e.business_reference), ZERO)
            if any(not row.business_reference for row in (*revenues, *direct)):
                self.warn("UNALLOCATED_PROJECTS", "Certaines pièces n’ont pas de référence devis/chantier ; elles restent dans les totaux globaux.")
            return {
                "sector": SectorEnum.CONSTRUCTION, "dry_cost": dry, "margin": sales - dry,
                "margin_pct": ratio(sales - dry, sales), "projects": projects,
                "unallocated_revenue_ht": missing_sales, "unallocated_dry_cost": missing_costs,
            }


class RetailStrategy(BaseSectorKPIStrategy):
    def compute_specific_kpis(
        self, revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
        overheads: Sequence[AllocatedOverhead],
    ) -> SpecificValues:
        with localcontext(FINANCE_CONTEXT):
            sales = sum((r.amount_ht for r in revenues), ZERO)
            consumed = self.consumed_cost(AllocationEnum.MERCHANDISE, expenses)
            pair = self.stock_pair(AllocationEnum.MERCHANDISE)
            average_stock = (pair[0] + pair[1]) / Decimal("2") if pair else ZERO
            tickets = sum((r.ticket_count or 0 for r in revenues), 0)
            basket = ratio(sales, Decimal(tickets), percent=False, quantum=Decimal("0.01"))
            if any(r.ticket_count is None for r in revenues):
                self.warn("MISSING_TICKET_COUNTS", "Nombre de tickets incomplet : panier moyen indisponible.")
                basket = None
            margin = sales - consumed if consumed is not None else None
            return {
                "sector": SectorEnum.RETAIL, "goods_consumed_cost": consumed,
                "commercial_margin": margin, "commercial_margin_pct": ratio(margin, sales),
                "estimated_stock_turnover": ratio(consumed, average_stock, percent=False),
                "average_basket_ht": basket,
            }


class ServicesStrategy(BaseSectorKPIStrategy):
    def compute_specific_kpis(
        self, revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
        overheads: Sequence[AllocatedOverhead],
    ) -> SpecificValues:
        with localcontext(FINANCE_CONTEXT):
            sales = sum((r.amount_ht for r in revenues), ZERO)
            hours = sum((r.hours or ZERO for r in revenues), ZERO)
            days = sum((r.days or ZERO for r in revenues), ZERO)
            hourly = ratio(sales, hours, percent=False, quantum=Decimal("0.01"))
            daily = ratio(sales, days, percent=False, quantum=Decimal("0.01"))
            if any(r.hours is None for r in revenues):
                self.warn("MISSING_HOURS", "Heures réalisées incomplètes : taux horaire réel indisponible.")
                hourly = None
            if any(r.days is None for r in revenues):
                self.warn("MISSING_DAYS", "Jours réalisés incomplets : taux journalier réel indisponible.")
                daily = None
            structure = sum((o.operating for o in overheads), ZERO)
            structure += sum((expense_cost(e) for e in expenses if e.category == CategorieExpense.FRAIS_GENERAUX), ZERO)
            return {
                "sector": SectorEnum.SERVICES,
                "average_hourly_rate_ht": hourly,
                "average_daily_rate_ht": daily,
                "structure_cost_ratio_pct": ratio(structure, sales),
            }


STRATEGIES: dict[SectorEnum, type[BaseSectorKPIStrategy]] = {
    SectorEnum.HOSPITALITY: HospitalityStrategy,
    SectorEnum.CONSTRUCTION: ConstructionStrategy,
    SectorEnum.RETAIL: RetailStrategy,
    SectorEnum.SERVICES: ServicesStrategy,
}


def sector_strategy(
    sector: SectorEnum, period: Period, inventories: Sequence[InventorySnapshotIn] = (),
) -> BaseSectorKPIStrategy:
    return STRATEGIES[sector](period, inventories)


def stock_variation(inventories: Sequence[InventorySnapshotIn], period: Period) -> Decimal | None:
    """Σ (stock initial − stock final) des familles inventoriées au début et au lendemain de la fin de période."""
    start, end = period.start_date, period.end_date + timedelta(days=1)
    values = {(row.allocation, row.date): row.value for row in inventories}
    pairs = [
        (values[(allocation, start)], values[(allocation, end)])
        for allocation in {row.allocation for row in inventories}
        if (allocation, start) in values and (allocation, end) in values
    ]
    if not pairs:
        return None
    with localcontext(FINANCE_CONTEXT):
        return sum((opening - closing for opening, closing in pairs), ZERO)


def compute_common_kpis(
    revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
    overheads: Sequence[AllocatedOverhead], period: Period,
    cash_balance: CashBalanceIn | None = None, cash_movements: Sequence[CashMovementIn] = (),
    *, inventories: Sequence[InventorySnapshotIn] = (),
) -> CommonKPIs:
    variation = stock_variation(inventories, period)
    with localcontext(FINANCE_CONTEXT):
        sales = sum((r.amount_ht for r in revenues), ZERO)
        total_ttc = sum((r.amount_ttc for r in revenues), ZERO)
        variable = sum((expense_cost(e) for e in expenses if e.category in VARIABLE_CATEGORIES), ZERO)
        if variation is not None:
            variable += variation
        fixed = sum((o.operating for o in overheads), ZERO)
        fixed += sum((expense_cost(e) for e in expenses if e.category == CategorieExpense.FRAIS_GENERAUX), ZERO)
        contribution = sales - variable
        collected = total_ttc - sales
        deductible = sum((e.deductible_vat for e in expenses), ZERO) + sum((o.deductible_vat for o in overheads), ZERO)
        in_period = [m for m in cash_movements if period.start_date <= m.date <= period.end_date]
        incoming = sum((m.amount for m in in_period if m.amount > ZERO), ZERO)
        outgoing = -sum((m.amount for m in in_period if m.amount < ZERO), ZERO)
        opening = None
        if cash_balance is not None:
            opening = cash_balance.amount + sum((
                m.amount for m in cash_movements if cash_balance.date <= m.date < period.start_date
            ), ZERO)
        return CommonKPIs(
            revenue_ht=money(sales), revenue_ttc=money(total_ttc),
            variable_costs=money(variable), stock_variation=money(variation) if variation is not None else None,
            fixed_costs=money(fixed),
            recurring_commitments=money(sum((o.committed for o in overheads), ZERO)),
            financial_expenses=money(sum((o.financial for o in overheads), ZERO)),
            operating_expenses=money(variable + fixed),
            contribution_margin_pct=ratio(contribution, sales),
            break_even_revenue_ht=money(fixed * sales / contribution) if sales > ZERO and contribution > ZERO else None,
            approximate_ebe=money(contribution - fixed),
            vat_collected=money(collected), vat_deductible=money(deductible),
            vat_balance_estimate=money(collected - deductible),
            cash_inflows=money(incoming), cash_outflows=money(outgoing),
            cash_net_flow=money(incoming - outgoing),
            opening_cash=money(opening) if opening is not None else None,
            closing_cash=money(opening + incoming - outgoing) if opening is not None else None,
        )


def break_even_date(revenues: Sequence[TransactionRevenueIn], threshold: Decimal | None, period: Period) -> date | None:
    """Premier jour où le CA cumulé réel atteint le seuil de rentabilité de la période."""
    if threshold is None:
        return None
    if threshold <= ZERO:
        return period.start_date
    daily: dict[date, Decimal] = defaultdict(lambda: ZERO)
    with localcontext(FINANCE_CONTEXT):
        for row in revenues:
            daily[row.date] += row.amount_ht
        cumulative = ZERO
        for day in sorted(daily):
            cumulative += daily[day]
            if cumulative >= threshold:
                return day
    return None


def compute_banking_kpis(
    common: CommonKPIs, revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
    allocated: Sequence[AllocatedOverhead], period: Period, balance_sheet: BalanceSheetSnapshotIn | None = None,
) -> BankingKPIs:
    days = period_days(period)
    with localcontext(FINANCE_CONTEXT):
        sales, ebe, financial = common.revenue_ht, common.approximate_ebe, common.financial_expenses
        payroll = sum((o.operating for o in allocated if o.category == OverheadCategory.PAYROLL), ZERO)
        external = common.operating_expenses - payroll
        value_added = sales - external
        caf = ebe - financial
        principal = sum((o.principal for o in allocated), ZERO)
        debt_service = principal + financial
        threshold = common.break_even_revenue_ht
        safety = sales - threshold if threshold is not None else None
        closing = common.closing_cash
        values: dict[str, Decimal | date | None] = {
            "external_charges": money(external), "external_charges_pct": ratio(external, sales),
            "value_added": money(value_added), "value_added_pct": ratio(value_added, sales),
            "payroll_costs": money(payroll), "payroll_costs_pct": ratio(payroll, sales),
            "payroll_to_value_added_pct": ratio(payroll, value_added),
            "ebe_margin_pct": ratio(ebe, sales),
            "financial_expenses_to_revenue_pct": ratio(financial, sales),
            "approximate_caf": money(caf), "caf_margin_pct": ratio(caf, sales),
            "loan_principal_repaid": money(principal), "debt_service": money(debt_service),
            "debt_service_coverage": ratio(ebe, debt_service, percent=False),
            "caf_after_principal": money(caf - principal),
            "financial_expenses_to_ebe_pct": ratio(financial, ebe),
            "safety_margin": money(safety) if safety is not None else None,
            "safety_margin_pct": ratio(safety, sales),
            "break_even_date": break_even_date(revenues, threshold, period),
            "cash_days": ratio(closing * days, common.cash_outflows, percent=False, quantum=DAYS_QUANTUM)
            if closing is not None and closing >= ZERO else None,
            "balance_sheet_date": None, "working_capital_requirement": None, "working_capital_days": None,
            "customer_days": None, "supplier_days": None, "inventory_days": None, "financial_debt": None,
            "net_debt": None, "equity": None, "gearing": None, "equity_ratio_pct": None, "debt_repayment_years": None,
        }
        if balance_sheet is not None:
            sheet = balance_sheet
            requirement = sheet.inventory + sheet.trade_receivables - sheet.trade_payables - sheet.tax_social_payables
            purchases = sum((e.amount_ttc for e in expenses if e.category != CategorieExpense.EQUIPEMENT), ZERO)
            purchases += sum((o.committed for o in allocated if o.category in EXTERNAL_OVERHEADS), ZERO)
            stock_purchases = sum((
                expense_cost(e) for e in expenses if e.category == CategorieExpense.MATIERE_PREMIERE
            ), ZERO) + (common.stock_variation or ZERO)
            net_debt = sheet.financial_debt - sheet.cash
            values.update({
                "balance_sheet_date": sheet.date,
                "working_capital_requirement": money(requirement),
                "working_capital_days": ratio(requirement * days, sales, percent=False, quantum=DAYS_QUANTUM),
                "customer_days": ratio(sheet.trade_receivables * days, common.revenue_ttc, percent=False, quantum=DAYS_QUANTUM),
                "supplier_days": ratio(sheet.trade_payables * days, purchases, percent=False, quantum=DAYS_QUANTUM),
                "inventory_days": ratio(sheet.inventory * days, stock_purchases, percent=False, quantum=DAYS_QUANTUM),
                "financial_debt": sheet.financial_debt, "net_debt": money(net_debt), "equity": sheet.equity,
                "gearing": ratio(net_debt, sheet.equity, percent=False),
                "equity_ratio_pct": ratio(sheet.equity, sheet.total_assets) if sheet.total_assets is not None else None,
                "debt_repayment_years": ratio(
                    sheet.financial_debt * days, caf * YEAR_DAYS, percent=False, quantum=DAYS_QUANTUM,
                ),
            })
    return BankingKPIs.model_validate(values)


def banking_alerts(banking: BankingKPIs, period: Period) -> list[Alert]:
    alerts: list[Alert] = []

    def add(code: str, severity: str, message: str) -> None:
        alerts.append(Alert(code=code, severity=severity, message=message))

    if banking.balance_sheet_date is None:
        add("BALANCE_SHEET_MISSING", "warning",
            "Aucun bilan saisi à la date de fin : BFR, endettement, autonomie financière et capacité de remboursement indisponibles.")
    elif banking.balance_sheet_date < add_months(period.end_date, -STALE_BALANCE_SHEET_MONTHS):
        add("BALANCE_SHEET_STALE", "warning",
            "Le dernier bilan saisi date de plus de 18 mois avant la fin de période : structure financière à actualiser.")
    coverage = banking.debt_service_coverage
    if coverage is not None and coverage < Decimal("1"):
        add("DEBT_SERVICE_NOT_COVERED", "critical",
            "L’EBE ne couvre pas les annuités d’emprunt (capital + intérêts) : la CAF est inférieure au capital remboursé.")
    elif coverage is not None and coverage < MIN_DEBT_SERVICE_COVERAGE:
        add("DEBT_SERVICE_TIGHT", "warning",
            "Couverture des annuités par l’EBE inférieure à 1,2 : marge de sécurité faible pour le service de la dette.")
    if banking.financial_expenses_to_ebe_pct is not None and banking.financial_expenses_to_ebe_pct > MAX_FINANCIAL_EXPENSES_TO_EBE_PCT:
        add("HIGH_FINANCIAL_EXPENSES", "warning", "Les frais financiers absorbent plus de 30 % de l’EBE.")
    if banking.financial_debt is not None and banking.financial_debt > ZERO and banking.approximate_caf <= ZERO:
        add("NO_REPAYMENT_CAPACITY", "critical",
            "Dette financière au bilan sans CAF positive sur la période : capacité de remboursement nulle.")
    elif banking.debt_repayment_years is not None and banking.debt_repayment_years > MAX_DEBT_REPAYMENT_YEARS:
        add("LONG_REPAYMENT", "warning",
            "Plus de 4 années de CAF sont nécessaires pour rembourser la dette financière.")
    if banking.equity is not None and banking.equity < ZERO:
        add("NEGATIVE_EQUITY", "critical", "Capitaux propres négatifs au dernier bilan.")
    elif banking.equity_ratio_pct is not None and banking.equity_ratio_pct < MIN_EQUITY_RATIO_PCT:
        add("LOW_EQUITY_RATIO", "warning", "Autonomie financière inférieure à 20 % du total du bilan.")
    if banking.gearing is not None and banking.gearing > MAX_GEARING:
        add("HIGH_GEARING", "warning", "L’endettement net dépasse les capitaux propres (gearing supérieur à 1).")
    if banking.cash_days is not None and banking.cash_days < MIN_CASH_DAYS:
        add("LOW_CASH_DAYS", "warning", "La trésorerie de clôture couvre moins de 30 jours de décaissements.")
    return alerts


def monthly_series(
    period: Period, revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
    overheads: Sequence[RecurringOverheadIn], opening_cash: Decimal | None, cash_movements: Sequence[CashMovementIn],
    inventories: Sequence[InventorySnapshotIn] = (),
) -> tuple[list[MonthlyPoint], bool]:
    """Mois calendaires bornés à la période ; seuls les 60 derniers sont renvoyés."""
    def bucket(rows: Sequence[TransactionRevenueIn | PurchaseExpenseIn | CashMovementIn]) -> dict[tuple[int, int], list]:
        grouped: dict[tuple[int, int], list] = defaultdict(list)
        for row in rows:
            if period.start_date <= row.date <= period.end_date:
                grouped[(row.date.year, row.date.month)].append(row)
        return grouped

    sales, purchases, movements = bucket(revenues), bucket(expenses), bucket(cash_movements)
    points: list[MonthlyPoint] = []
    closing = opening_cash
    with localcontext(FINANCE_CONTEXT):
        for month in month_periods(period):
            key = (month.start_date.year, month.start_date.month)
            common = compute_common_kpis(
                sales[key], purchases[key], allocate_overheads(overheads, month), month, None, movements[key],
                inventories=inventories,
            )
            closing = closing + common.cash_net_flow if closing is not None else None
            points.append(MonthlyPoint(
                period=month, revenue_ht=common.revenue_ht, stock_variation=common.stock_variation,
                approximate_ebe=common.approximate_ebe,
                ebe_margin_pct=ratio(common.approximate_ebe, common.revenue_ht),
                approximate_caf=money(common.approximate_ebe - common.financial_expenses),
                cash_net_flow=common.cash_net_flow,
                closing_cash=money(closing) if closing is not None else None,
            ))
    return points[-MAX_MONTHLY_POINTS:], len(points) > MAX_MONTHLY_POINTS


def build_dashboard(
    company: CompanyProfileIn, period: Period,
    revenues: Sequence[TransactionRevenueIn], expenses: Sequence[PurchaseExpenseIn],
    overheads: Sequence[RecurringOverheadIn], inventories: Sequence[InventorySnapshotIn] = (),
    cash_balance: CashBalanceIn | None = None, cash_movements: Sequence[CashMovementIn] = (),
    balance_sheet: BalanceSheetSnapshotIn | None = None, *, demo: bool = False, monthly: bool = True,
) -> FinanceDashboard:
    rows = (*revenues, *expenses, *overheads, *inventories, *cash_movements)
    if any(row.company_id != company.id for row in rows) or any(
        snapshot is not None and snapshot.company_id != company.id for snapshot in (cash_balance, balance_sheet)
    ):
        raise ValueError("Données de plusieurs entreprises mélangées : calcul refusé.")
    if any(not period.start_date <= row.date <= period.end_date for row in (*revenues, *expenses)):
        raise ValueError("Vente ou achat hors de la période demandée.")
    if cash_balance and cash_balance.date > period.start_date:
        raise ValueError("Solde de trésorerie d'ouverture postérieur au début de la période.")
    if balance_sheet and balance_sheet.date > period.end_date:
        raise ValueError("Bilan arrêté après la fin de la période.")
    if len({(i.date, i.allocation) for i in inventories}) != len(inventories):
        raise ValueError("Inventaires en double à la même date pour la même famille.")
    allocated = allocate_overheads(overheads, period)
    common = compute_common_kpis(
        revenues, expenses, allocated, period, cash_balance, cash_movements, inventories=inventories,
    )
    banking = compute_banking_kpis(common, revenues, expenses, allocated, period, balance_sheet)
    strategy = sector_strategy(company.sector, period, inventories)
    specific = TypeAdapter(SectorKPIs).validate_python(strategy.compute_specific_kpis(revenues, expenses, allocated))
    alerts = list(strategy.alerts)
    if demo:
        alerts.append(Alert(
            code="DEMO_DATA", severity="info",
            message="Données fictives de démonstration : aucune entreprise réelle, aucun chiffre client.",
        ))
    stock_note = (
        "avec la variation de stocks intégrée pour les familles inventoriées au début et au lendemain de la fin de période"
        if common.stock_variation is not None
        else "hors variation de stocks (inventaires de début et de fin de période non saisis)"
    )
    alerts.append(Alert(
        code="MANAGEMENT_ESTIMATES", severity="info",
        message=f"Indicateurs de gestion sur les pièces saisies : valeur ajoutée, EBE et seuil de rentabilité calculés {stock_note}, "
                "hors amortissements et impôt sur les sociétés ; CAF approchée = EBE − intérêts d’emprunt (avant IS). "
                "TVA théorique sur pièces et charges proratisées, pas une déclaration fiscale. "
                "Ne pas saisir deux fois une charge récurrente sous forme d’achat.",
    ))
    if not revenues:
        alerts.append(Alert(code="NO_REVENUE_DATA", severity="warning", message="Aucune recette saisie sur cette période."))
    if not expenses:
        alerts.append(Alert(code="NO_EXPENSE_DATA", severity="warning", message="Aucun achat saisi sur cette période ; vérifier la complétude du registre."))
    if not overheads:
        alerts.append(Alert(code="NO_OVERHEAD_DATA", severity="warning", message="Aucune charge récurrente saisie ; vérifier la complétude du registre."))
    if common.break_even_revenue_ht is None:
        alerts.append(Alert(code="NO_BREAK_EVEN", severity="warning", message="Seuil non calculable : CA ou marge sur coûts variables non positifs."))
    elif common.revenue_ht < common.break_even_revenue_ht:
        alerts.append(Alert(code="BELOW_BREAK_EVEN", severity="warning", message="Le CA est inférieur au seuil de rentabilité estimé."))
    if common.approximate_ebe < ZERO:
        alerts.append(Alert(code="NEGATIVE_EBE", severity="critical", message="L’EBE approché est négatif."))
    if common.closing_cash is None:
        alerts.append(Alert(code="MISSING_OPENING_CASH", severity="warning", message="Solde initial absent : trésorerie finale indisponible."))
    elif common.closing_cash < ZERO:
        alerts.append(Alert(code="NEGATIVE_CASH", severity="critical", message="La trésorerie finale reconstituée est négative."))
    alerts.extend(banking_alerts(banking, period))
    alerts.append(Alert(
        code="CASH_LEDGER_ONLY", severity="info",
        message="La trésorerie utilise uniquement les mouvements de caisse/banque saisis et un solde initial ; aucune facture n’est supposée payée.",
    ))
    for key, value in specific.model_dump().items():
        if value is None:
            alerts.append(Alert(code=f"UNAVAILABLE_{key.upper()}", severity="warning",
                                message=f"{SPECIFIC_LABELS.get(key, key)} indisponible : données manquantes ou dénominateur non positif."))
    points: list[MonthlyPoint] = []
    if monthly:
        points, truncated = monthly_series(
            period, revenues, expenses, overheads, common.opening_cash, cash_movements, inventories,
        )
        if truncated:
            alerts.append(Alert(code="MONTHLY_SERIES_TRUNCATED", severity="info",
                                message="Évolution mensuelle limitée aux 60 derniers mois de la période."))
    return FinanceDashboard(
        company=company, period=period, demo=demo, common=common, banking=banking,
        specific=specific, monthly=points, alerts=alerts,
    )


def _decimal_fields(model: BaseModel) -> list[str]:
    names: list[str] = []
    for name, info in type(model).model_fields.items():
        kinds = set(get_args(info.annotation)) or {info.annotation}
        if Decimal in kinds and kinds <= {Decimal, type(None)}:
            names.append(name)
    return names


def compare_dashboards(
    current: FinanceDashboard, previous: FinanceDashboard, mode: ComparisonMode, has_data: bool,
) -> PeriodComparison:
    """Les montants reçoivent aussi une variation relative ; taux, jours et multiples, une variation absolue seulement."""
    variations: list[MetricVariation] = []
    with localcontext(FINANCE_CONTEXT):
        for section in ("common", "banking", "specific"):
            now, before = getattr(current, section), getattr(previous, section)
            for key in _decimal_fields(now):
                value, reference = getattr(now, key), getattr(before, key)
                change = value - reference if value is not None and reference is not None else None
                relative = None
                if change is not None and reference > ZERO and not (key.endswith("_pct") or key in RATE_KEYS):
                    relative = (change / reference * HUNDRED).quantize(Decimal("0.01"))
                variations.append(MetricVariation(
                    key=key, current=value, previous=reference, change=change, change_pct=relative,
                ))
    return PeriodComparison(mode=mode, period=previous.period, has_data=has_data, variations=variations)


class DashboardInputs(TypedDict):
    company: CompanyProfileIn
    period: Period
    revenues: list[TransactionRevenueIn]
    expenses: list[PurchaseExpenseIn]
    overheads: list[RecurringOverheadIn]
    inventories: list[InventorySnapshotIn]
    cash_balance: CashBalanceIn | None
    cash_movements: list[CashMovementIn]
    balance_sheet: BalanceSheetSnapshotIn | None


@dataclass(frozen=True)
class FinanceDataset:
    """Toutes les pièces d'une entreprise susceptibles de servir ; select() applique les règles de période du tableau de bord."""
    company: CompanyProfileIn
    revenues: tuple[TransactionRevenueIn, ...] = ()
    expenses: tuple[PurchaseExpenseIn, ...] = ()
    overheads: tuple[RecurringOverheadIn, ...] = ()
    inventories: tuple[InventorySnapshotIn, ...] = ()
    cash_balances: tuple[CashBalanceIn, ...] = ()
    cash_movements: tuple[CashMovementIn, ...] = ()
    balance_sheets: tuple[BalanceSheetSnapshotIn, ...] = ()

    def select(self, period: Period) -> DashboardInputs:
        start, end = period.start_date, period.end_date
        after_end = end + timedelta(days=1)
        balance = max((b for b in self.cash_balances if b.date <= start), key=lambda b: b.date, default=None)
        since = balance.date if balance else start
        return {
            "company": self.company, "period": period,
            "revenues": [r for r in self.revenues if start <= r.date <= end],
            "expenses": [e for e in self.expenses if start <= e.date <= end],
            "overheads": [o for o in self.overheads if o.active_from <= end and (o.active_to is None or o.active_to >= start)],
            # Bornes de la période et débuts de mois intermédiaires (variation de stocks mensuelle).
            "inventories": [i for i in self.inventories if start <= i.date <= after_end],
            "cash_balance": balance,
            "cash_movements": [m for m in self.cash_movements if since <= m.date <= end],
            "balance_sheet": max((s for s in self.balance_sheets if s.date <= end), key=lambda s: s.date, default=None),
        }


def build_report(
    dataset: FinanceDataset, period: Period, comparison: ComparisonMode = ComparisonMode.PREVIOUS,
    *, demo: bool = False,
) -> FinanceDashboard:
    current = build_dashboard(**dataset.select(period), demo=demo)
    reference = comparison_period(period, comparison)
    if reference is None:
        return current
    inputs = dataset.select(reference)
    previous = build_dashboard(**inputs, demo=demo, monthly=False)
    has_data = bool(inputs["revenues"] or inputs["expenses"] or any(
        reference.start_date <= m.date <= reference.end_date for m in inputs["cash_movements"]
    ))
    return current.model_copy(update={"comparison": compare_dashboards(current, previous, comparison, has_data)})

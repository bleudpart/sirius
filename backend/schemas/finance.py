"""Contrats de la finance d'entreprise, indépendants du stockage."""
from datetime import date
from decimal import Context, Decimal, ROUND_HALF_UP, localcontext
from enum import Enum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator

FINANCE_CONTEXT = Context(prec=38, rounding=ROUND_HALF_UP)
ZERO = Decimal("0")
HUNDRED = Decimal("100")


def decimal_value(value: object) -> Decimal:
    if not isinstance(value, (str, int, Decimal)) or isinstance(value, bool):
        raise ValueError("Un entier exact, un Decimal ou une chaîne décimale est requis, jamais un flottant.")
    try:
        result = Decimal(value)
    except ArithmeticError as error:
        raise ValueError("Nombre décimal invalide.") from error
    if not result.is_finite():
        raise ValueError("Le nombre décimal doit être fini.")
    return result


def iso_date(value: object) -> date:
    if type(value) is date:
        return value
    if isinstance(value, str) and len(value) == 10:
        try:
            parsed = date.fromisoformat(value)
            if parsed.isoformat() == value:
                return parsed
        except ValueError:
            pass
    raise ValueError("Date calendaire ISO AAAA-MM-JJ requise, sans heure.")


def money(value: Decimal) -> Decimal:
    with localcontext(FINANCE_CONTEXT):
        return value.quantize(Decimal("0.01"))


Money = Annotated[Decimal, BeforeValidator(decimal_value), Field(
    max_digits=14, decimal_places=2, ge=Decimal("-999999999999.99"), le=Decimal("999999999999.99"),
)]
NonNegativeMoney = Annotated[Money, Field(ge=ZERO)]
Quantity = Annotated[Decimal, BeforeValidator(decimal_value), Field(
    max_digits=13, decimal_places=4, ge=ZERO, le=Decimal("999999999.9999"),
)]
Percent = Annotated[Quantity, Field(le=HUNDRED)]
IsoDate = Annotated[date, BeforeValidator(iso_date)]
CompanyId = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$")]
Reference = Annotated[str, Field(min_length=1, max_length=160)]
SourceTransactionId = Annotated[str, Field(
    min_length=1, max_length=160, pattern=r"^[A-Za-z0-9._:/-]+$",
)]


class SectorEnum(str, Enum):
    HOSPITALITY = "HOSPITALITY"
    CONSTRUCTION = "CONSTRUCTION"
    RETAIL = "RETAIL"
    SERVICES = "SERVICES"


class CategorieExpense(str, Enum):
    MATIERE_PREMIERE = "MATIERE_PREMIERE"
    SOUS_TRAITANCE = "SOUS_TRAITANCE"
    FOURNITURES = "FOURNITURES"
    FRAIS_GENERAUX = "FRAIS_GENERAUX"
    EQUIPEMENT = "EQUIPEMENT"


class AllocationEnum(str, Enum):
    FOOD = "FOOD"
    BEVERAGE = "BEVERAGE"
    MERCHANDISE = "MERCHANDISE"
    OTHER = "OTHER"


class PaymentMethod(str, Enum):
    CASH = "CASH"
    CARD = "CARD"
    TRANSFER = "TRANSFER"
    CHEQUE = "CHEQUE"
    OTHER = "OTHER"


class OverheadCategory(str, Enum):
    RENT = "RENT"
    PAYROLL = "PAYROLL"
    LOAN = "LOAN"
    INSURANCE = "INSURANCE"
    OTHER = "OTHER"


class FinanceIngestionSource(str, Enum):
    POS_WEBHOOK = "pos_webhook"
    BANK_STATEMENT_CSV = "bank_statement_csv"
    BANK_STATEMENT_OFX = "bank_statement_ofx"
    INVOICE_OCR = "invoice_ocr"


class ComparisonMode(str, Enum):
    PREVIOUS = "previous"
    YEAR_AGO = "year_ago"
    NONE = "none"


class StrictModel(BaseModel):
    model_config = ConfigDict(
        strict=True, extra="forbid", from_attributes=True, frozen=True,
        str_strip_whitespace=True, allow_inf_nan=False,
    )


class CompanyProfileIn(StrictModel):
    id: CompanyId
    name: str = Field(min_length=1, max_length=160)
    sector: SectorEnum = Field(strict=False)
    currency: str = Field(default="EUR", pattern=r"^[A-Z]{3}$")


class CompanyRecord(StrictModel):
    company_id: CompanyId


class TransactionRevenueIn(CompanyRecord):
    date: IsoDate
    amount_ht: Money
    amount_ttc: Money
    vat_rate: Percent
    payment_method: PaymentMethod = Field(strict=False)
    business_reference: Reference | None = None
    allocation: AllocationEnum = Field(default=AllocationEnum.OTHER, strict=False)
    ticket_count: int | None = Field(default=None, ge=0)
    hours: Quantity | None = None
    days: Quantity | None = None
    source_transaction_id: SourceTransactionId | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def consistent_vat(self) -> Self:
        with localcontext(FINANCE_CONTEXT):
            expected = self.amount_ht + money(self.amount_ht * self.vat_rate / HUNDRED)
        if self.amount_ttc != expected:
            raise ValueError("Le TTC doit correspondre au HT et au taux de TVA, arrondi au centime.")
        return self


class PurchaseExpenseIn(CompanyRecord):
    date: IsoDate
    supplier: str = Field(min_length=1, max_length=160)
    amount_ht: Money
    amount_vat: Money
    amount_ttc: Money
    deductible_vat: Money
    category: CategorieExpense = Field(strict=False)
    allocation: AllocationEnum = Field(default=AllocationEnum.OTHER, strict=False)
    business_reference: Reference | None = None
    source_transaction_id: SourceTransactionId | None = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def consistent_amounts(self) -> Self:
        with localcontext(FINANCE_CONTEXT):
            if self.amount_ht + self.amount_vat != self.amount_ttc:
                raise ValueError("Le TTC doit être égal au HT plus la TVA.")
            if self.amount_ht * self.amount_vat < ZERO:
                raise ValueError("La TVA doit avoir le même signe que le HT.")
            if self.amount_vat * self.deductible_vat < ZERO or abs(self.deductible_vat) > abs(self.amount_vat):
                raise ValueError("La TVA déductible doit être comprise entre zéro et la TVA de la pièce.")
        if self.allocation != AllocationEnum.OTHER and self.category != CategorieExpense.MATIERE_PREMIERE:
            raise ValueError("Une ventilation de stock concerne uniquement les achats de matières ou de marchandises.")
        return self


class RecurringOverheadIn(CompanyRecord):
    label: str = Field(min_length=1, max_length=160)
    category: OverheadCategory = Field(strict=False)
    monthly_amount_ht: NonNegativeMoney
    vat_rate: Percent = ZERO
    vat_recoverable: bool = False
    employer_charges: NonNegativeMoney = ZERO
    loan_principal: NonNegativeMoney = ZERO
    active_from: IsoDate
    active_to: IsoDate | None = None

    @model_validator(mode="after")
    def coherent_overhead(self) -> Self:
        if self.active_to is not None and self.active_to < self.active_from:
            raise ValueError("La fin de la charge précède son début.")
        if self.category != OverheadCategory.PAYROLL and self.employer_charges != ZERO:
            raise ValueError("Les charges patronales concernent uniquement les salaires.")
        if self.category != OverheadCategory.LOAN and self.loan_principal != ZERO:
            raise ValueError("Le capital remboursé concerne uniquement les emprunts.")
        if self.loan_principal > self.monthly_amount_ht:
            raise ValueError("Le capital remboursé dépasse la mensualité.")
        if self.category in (OverheadCategory.PAYROLL, OverheadCategory.LOAN) and self.vat_rate != ZERO:
            raise ValueError("Les salaires et échéances d’emprunt ne portent pas de TVA.")
        return self


class InventorySnapshotIn(CompanyRecord):
    date: IsoDate
    allocation: AllocationEnum = Field(strict=False)
    value: NonNegativeMoney

    @model_validator(mode="after")
    def stock_allocation(self) -> Self:
        if self.allocation == AllocationEnum.OTHER:
            raise ValueError("Un inventaire porte sur les aliments, les boissons ou les marchandises.")
        return self


class CashBalanceIn(CompanyRecord):
    date: IsoDate
    amount: Money


class CashMovementIn(CompanyRecord):
    date: IsoDate
    amount: Money
    label: str = Field(min_length=1, max_length=160)
    business_reference: Reference | None = None
    source_transaction_id: SourceTransactionId | None = Field(default=None, exclude=True)


class BalanceSheetSnapshotIn(CompanyRecord):
    """Bilan simplifié à une date d'arrêté, tel que lu sur la liasse ou une situation."""
    date: IsoDate
    equity: Money
    financial_debt: NonNegativeMoney
    inventory: NonNegativeMoney = ZERO
    trade_receivables: NonNegativeMoney = ZERO
    trade_payables: NonNegativeMoney = ZERO
    tax_social_payables: NonNegativeMoney = ZERO
    cash: NonNegativeMoney = ZERO
    total_assets: NonNegativeMoney | None = None

    @model_validator(mode="after")
    def balanced_snapshot(self) -> Self:
        if self.total_assets is None:
            return self
        with localcontext(FINANCE_CONTEXT):
            assets = self.inventory + self.trade_receivables + self.cash
            liabilities = self.equity + self.financial_debt + self.trade_payables + self.tax_social_payables
        if assets > self.total_assets:
            raise ValueError("Le total du bilan doit couvrir stocks, créances clients et disponibilités.")
        if liabilities > self.total_assets:
            raise ValueError("Le total du bilan doit couvrir capitaux propres et dettes saisies.")
        return self


class Period(StrictModel):
    start_date: IsoDate
    end_date: IsoDate

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.end_date < self.start_date or self.end_date == date.max:
            raise ValueError("Période inversée ou date de fin non prise en charge.")
        return self


class Alert(StrictModel):
    code: str
    severity: Literal["info", "warning", "critical"]
    message: str


class AllocatedOverhead(StrictModel):
    category: OverheadCategory
    committed: Decimal
    operating: Decimal
    financial: Decimal
    principal: Decimal = ZERO
    deductible_vat: Decimal


class CommonKPIs(StrictModel):
    revenue_ht: Decimal
    revenue_ttc: Decimal
    variable_costs: Decimal
    # Stock initial − stock final des familles inventoriées aux deux bornes ; None si aucun couple complet.
    stock_variation: Decimal | None
    fixed_costs: Decimal
    recurring_commitments: Decimal
    financial_expenses: Decimal
    operating_expenses: Decimal
    contribution_margin_pct: Decimal | None
    break_even_revenue_ht: Decimal | None
    approximate_ebe: Decimal
    vat_collected: Decimal
    vat_deductible: Decimal
    vat_balance_estimate: Decimal
    cash_inflows: Decimal
    cash_outflows: Decimal
    cash_net_flow: Decimal
    opening_cash: Decimal | None
    closing_cash: Decimal | None


class HospitalityKPIs(StrictModel):
    sector: Literal[SectorEnum.HOSPITALITY] = SectorEnum.HOSPITALITY
    food_consumed_cost: Decimal | None
    beverage_consumed_cost: Decimal | None
    food_cost_pct: Decimal | None
    beverage_cost_pct: Decimal | None
    prime_cost_pct: Decimal | None


class ProjectMargin(StrictModel):
    business_reference: str
    revenue_ht: Decimal
    dry_cost: Decimal
    margin: Decimal
    margin_pct: Decimal | None


class ConstructionKPIs(StrictModel):
    sector: Literal[SectorEnum.CONSTRUCTION] = SectorEnum.CONSTRUCTION
    dry_cost: Decimal
    margin: Decimal
    margin_pct: Decimal | None
    projects: list[ProjectMargin]
    unallocated_revenue_ht: Decimal
    unallocated_dry_cost: Decimal


class RetailKPIs(StrictModel):
    sector: Literal[SectorEnum.RETAIL] = SectorEnum.RETAIL
    goods_consumed_cost: Decimal | None
    commercial_margin: Decimal | None
    commercial_margin_pct: Decimal | None
    estimated_stock_turnover: Decimal | None
    average_basket_ht: Decimal | None


class ServicesKPIs(StrictModel):
    sector: Literal[SectorEnum.SERVICES] = SectorEnum.SERVICES
    average_hourly_rate_ht: Decimal | None
    average_daily_rate_ht: Decimal | None
    structure_cost_ratio_pct: Decimal | None


SectorKPIs = Annotated[
    HospitalityKPIs | ConstructionKPIs | RetailKPIs | ServicesKPIs,
    Field(discriminator="sector"),
]


class BankingKPIs(StrictModel):
    """Lecture bancaire : soldes de gestion, dette, point mort, trésorerie et bilan simplifié."""
    external_charges: Decimal
    external_charges_pct: Decimal | None
    value_added: Decimal
    value_added_pct: Decimal | None
    payroll_costs: Decimal
    payroll_costs_pct: Decimal | None
    payroll_to_value_added_pct: Decimal | None
    ebe_margin_pct: Decimal | None
    financial_expenses_to_revenue_pct: Decimal | None
    approximate_caf: Decimal
    caf_margin_pct: Decimal | None
    loan_principal_repaid: Decimal
    debt_service: Decimal
    debt_service_coverage: Decimal | None
    caf_after_principal: Decimal
    financial_expenses_to_ebe_pct: Decimal | None
    safety_margin: Decimal | None
    safety_margin_pct: Decimal | None
    break_even_date: date | None
    cash_days: Decimal | None
    balance_sheet_date: date | None
    working_capital_requirement: Decimal | None
    working_capital_days: Decimal | None
    customer_days: Decimal | None
    supplier_days: Decimal | None
    inventory_days: Decimal | None
    financial_debt: Decimal | None
    net_debt: Decimal | None
    equity: Decimal | None
    gearing: Decimal | None
    equity_ratio_pct: Decimal | None
    debt_repayment_years: Decimal | None


class MetricVariation(StrictModel):
    key: str
    current: Decimal | None
    previous: Decimal | None
    change: Decimal | None
    change_pct: Decimal | None


class PeriodComparison(StrictModel):
    mode: Literal[ComparisonMode.PREVIOUS, ComparisonMode.YEAR_AGO]
    period: Period
    has_data: bool
    variations: list[MetricVariation]


class MonthlyPoint(StrictModel):
    period: Period
    revenue_ht: Decimal
    stock_variation: Decimal | None = None
    approximate_ebe: Decimal
    ebe_margin_pct: Decimal | None
    approximate_caf: Decimal
    cash_net_flow: Decimal
    closing_cash: Decimal | None


class FinanceDashboard(StrictModel):
    company: CompanyProfileIn
    period: Period
    calculation_version: Literal["2"] = "2"
    demo: bool = False
    common: CommonKPIs
    banking: BankingKPIs
    specific: SectorKPIs
    comparison: PeriodComparison | None = None
    monthly: list[MonthlyPoint]
    alerts: list[Alert]


class DemoCompanySummary(StrictModel):
    company: CompanyProfileIn
    description: str


class DemoCatalog(StrictModel):
    """Entreprises fictives proposées en démonstration et fenêtre de dates couverte."""
    period: Period
    notice: str
    companies: list[DemoCompanySummary]

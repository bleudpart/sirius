"""Contrats de saisie manuelle : le serveur calcule TTC/TVA et impose le rattachement à l'entreprise."""
from datetime import datetime
from enum import Enum
from typing import Literal, Self

from pydantic import Field, model_validator

from schemas.finance import (
    AllocationEnum, CategorieExpense, CompanyProfileIn, IsoDate, Money, NonNegativeMoney, OverheadCategory,
    PaymentMethod, Percent, Quantity, Reference, SectorEnum, StrictModel, ZERO,
)


class FinanceEntryKind(str, Enum):
    REVENUES = "revenues"
    EXPENSES = "expenses"
    OVERHEADS = "overheads"
    INVENTORIES = "inventories"
    CASH_BALANCES = "cash_balances"
    CASH_MOVEMENTS = "cash_movements"
    BALANCE_SHEETS = "balance_sheets"


class CompanyProfileUpdate(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    sector: SectorEnum = Field(strict=False)
    currency: str = Field(default="EUR", pattern=r"^[A-Z]{3}$")


class CompanyProfileEnvelope(StrictModel):
    profile: CompanyProfileIn | None


class RevenueEntryIn(StrictModel):
    date: IsoDate
    amount_ht: Money
    vat_rate: Percent
    payment_method: PaymentMethod = Field(strict=False)
    business_reference: Reference | None = None
    allocation: AllocationEnum = Field(default=AllocationEnum.OTHER, strict=False)
    ticket_count: int | None = Field(default=None, ge=0)
    hours: Quantity | None = None
    days: Quantity | None = None


class ExpenseEntryIn(StrictModel):
    date: IsoDate
    supplier: str = Field(min_length=1, max_length=160)
    amount_ht: Money
    vat_rate: Percent | None = None
    amount_vat: Money | None = None
    vat_deductible: bool = True
    category: CategorieExpense = Field(strict=False)
    allocation: AllocationEnum = Field(default=AllocationEnum.OTHER, strict=False)
    business_reference: Reference | None = None

    @model_validator(mode="after")
    def one_vat_input(self) -> Self:
        if (self.vat_rate is None) == (self.amount_vat is None):
            raise ValueError("Renseigner soit le taux de TVA, soit le montant de TVA, pas les deux.")
        return self


class OverheadEntryIn(StrictModel):
    label: str = Field(min_length=1, max_length=160)
    category: OverheadCategory = Field(strict=False)
    monthly_amount_ht: NonNegativeMoney
    vat_rate: Percent = ZERO
    vat_recoverable: bool = False
    employer_charges: NonNegativeMoney = ZERO
    loan_principal: NonNegativeMoney = ZERO
    active_from: IsoDate
    active_to: IsoDate | None = None


class InventoryEntryIn(StrictModel):
    date: IsoDate
    allocation: AllocationEnum = Field(strict=False)
    value: NonNegativeMoney


class CashBalanceEntryIn(StrictModel):
    date: IsoDate
    amount: Money


class CashMovementEntryIn(StrictModel):
    date: IsoDate
    amount: Money
    label: str = Field(min_length=1, max_length=160)
    business_reference: Reference | None = None


class BalanceSheetEntryIn(StrictModel):
    date: IsoDate
    equity: Money
    financial_debt: NonNegativeMoney
    inventory: NonNegativeMoney = ZERO
    trade_receivables: NonNegativeMoney = ZERO
    trade_payables: NonNegativeMoney = ZERO
    tax_social_payables: NonNegativeMoney = ZERO
    cash: NonNegativeMoney = ZERO
    total_assets: NonNegativeMoney | None = None


EntryOrigin = Literal["manual", "pos_webhook", "bank_statement_csv", "bank_statement_ofx", "invoice_ocr", "demo"]
JsonScalar = str | int | bool | None


class FinanceEntry(StrictModel):
    id: int
    kind: FinanceEntryKind
    origin: EntryOrigin
    values: dict[str, JsonScalar]


class FinanceEntryList(StrictModel):
    kind: FinanceEntryKind
    entries: list[FinanceEntry]
    truncated: bool


class FinanceAuditEntry(StrictModel):
    id: int
    actor: str
    action: Literal["create", "delete", "import", "revert", "profile"]
    entry_kind: str
    entry_id: str | None
    summary: str
    created_at: datetime


class FinanceAuditLog(StrictModel):
    events: list[FinanceAuditEntry]

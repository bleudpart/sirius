"""Registre SQLAlchemy de la finance d'entreprise : des entiers à échelle fixe évitent l'affinité NUMERIC flottante de SQLite."""
from datetime import date as DateValue, datetime as DateTimeValue
from decimal import Decimal, localcontext

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Date, DateTime, Enum, ForeignKey, Index, JSON, String, UniqueConstraint
from sqlalchemy.engine import Dialect
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import TypeDecorator

from schemas.finance import (
    AllocationEnum, CategorieExpense, FINANCE_CONTEXT, FinanceIngestionSource, OverheadCategory,
    PaymentMethod, SectorEnum, ZERO,
)


class ScaledDecimal(TypeDecorator[Decimal]):
    impl = BigInteger
    cache_ok = True

    def __init__(self, scale: int = 2):
        super().__init__()
        self.scale = scale

    def process_bind_param(self, value: Decimal | None, dialect: Dialect) -> int | None:
        if value is None:
            return None
        if not isinstance(value, Decimal) or not value.is_finite():
            raise ValueError("Le registre financier exige un Decimal fini, jamais un flottant.")
        with localcontext(FINANCE_CONTEXT):
            scaled = value.scaleb(self.scale)
            if scaled != scaled.to_integral_value() or abs(scaled) > 9_223_372_036_854_775_807:
                raise ValueError("Précision décimale ou capacité de stockage dépassée.")
            return int(scaled)

    def process_result_value(self, value: int | None, dialect: Dialect) -> Decimal | None:
        if value is None:
            return None
        with localcontext(FINANCE_CONTEXT):
            return Decimal(value).scaleb(-self.scale)


class Base(DeclarativeBase):
    pass


class CompanyProfile(Base):
    __tablename__ = "finance_companies"
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    name: Mapped[str] = mapped_column(String(160))
    sector: Mapped[SectorEnum] = mapped_column(Enum(SectorEnum, native_enum=False, create_constraint=True))
    currency: Mapped[str] = mapped_column(String(3), default="EUR")


class CompanyRow:
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[str] = mapped_column(ForeignKey("finance_companies.id", ondelete="RESTRICT"))


class TransactionRevenue(CompanyRow, Base):
    __tablename__ = "finance_revenues"
    __table_args__ = (
        Index("ix_finance_revenue_company_date", "company_id", "date"),
        CheckConstraint("vat_rate >= 0 AND vat_rate <= 1000000"),
        CheckConstraint("ticket_count IS NULL OR ticket_count >= 0"),
        CheckConstraint("hours IS NULL OR hours >= 0"),
        CheckConstraint("days IS NULL OR days >= 0"),
    )
    date: Mapped[DateValue] = mapped_column(Date)
    amount_ht: Mapped[Decimal] = mapped_column(ScaledDecimal())
    amount_ttc: Mapped[Decimal] = mapped_column(ScaledDecimal())
    vat_rate: Mapped[Decimal] = mapped_column(ScaledDecimal(4))
    payment_method: Mapped[PaymentMethod] = mapped_column(Enum(PaymentMethod, native_enum=False, create_constraint=True))
    business_reference: Mapped[str | None] = mapped_column(String(160))
    allocation: Mapped[AllocationEnum] = mapped_column(
        Enum(AllocationEnum, native_enum=False, create_constraint=True), default=AllocationEnum.OTHER,
    )
    ticket_count: Mapped[int | None]
    hours: Mapped[Decimal | None] = mapped_column(ScaledDecimal(4))
    days: Mapped[Decimal | None] = mapped_column(ScaledDecimal(4))


class PurchaseExpense(CompanyRow, Base):
    __tablename__ = "finance_expenses"
    __table_args__ = (
        Index("ix_finance_expense_company_date", "company_id", "date"),
        CheckConstraint("amount_ttc = amount_ht + amount_vat"),
        CheckConstraint("abs(deductible_vat) <= abs(amount_vat)"),
    )
    date: Mapped[DateValue] = mapped_column(Date)
    supplier: Mapped[str] = mapped_column(String(160))
    amount_ht: Mapped[Decimal] = mapped_column(ScaledDecimal())
    amount_vat: Mapped[Decimal] = mapped_column(ScaledDecimal())
    amount_ttc: Mapped[Decimal] = mapped_column(ScaledDecimal())
    deductible_vat: Mapped[Decimal] = mapped_column(ScaledDecimal())
    category: Mapped[CategorieExpense] = mapped_column(Enum(CategorieExpense, native_enum=False, create_constraint=True))
    allocation: Mapped[AllocationEnum] = mapped_column(
        Enum(AllocationEnum, native_enum=False, create_constraint=True), default=AllocationEnum.OTHER,
    )
    business_reference: Mapped[str | None] = mapped_column(String(160))


class RecurringOverhead(CompanyRow, Base):
    __tablename__ = "finance_overheads"
    __table_args__ = (
        Index("ix_finance_overhead_company_start", "company_id", "active_from"),
        CheckConstraint("active_to IS NULL OR active_to >= active_from"),
        CheckConstraint("monthly_amount_ht >= 0 AND employer_charges >= 0 AND loan_principal >= 0"),
        CheckConstraint("loan_principal <= monthly_amount_ht"),
        CheckConstraint("vat_rate >= 0 AND vat_rate <= 1000000"),
    )
    label: Mapped[str] = mapped_column(String(160))
    category: Mapped[OverheadCategory] = mapped_column(Enum(OverheadCategory, native_enum=False, create_constraint=True))
    monthly_amount_ht: Mapped[Decimal] = mapped_column(ScaledDecimal())
    vat_rate: Mapped[Decimal] = mapped_column(ScaledDecimal(4), default=ZERO)
    vat_recoverable: Mapped[bool] = mapped_column(Boolean, default=False)
    employer_charges: Mapped[Decimal] = mapped_column(ScaledDecimal(), default=ZERO)
    loan_principal: Mapped[Decimal] = mapped_column(ScaledDecimal(), default=ZERO)
    active_from: Mapped[DateValue] = mapped_column(Date)
    active_to: Mapped[DateValue | None] = mapped_column(Date)


class InventorySnapshot(CompanyRow, Base):
    __tablename__ = "finance_inventory"
    __table_args__ = (
        UniqueConstraint("company_id", "date", "allocation"),
        CheckConstraint("value >= 0 AND allocation != 'OTHER'"),
    )
    date: Mapped[DateValue] = mapped_column(Date)
    allocation: Mapped[AllocationEnum] = mapped_column(Enum(AllocationEnum, native_enum=False, create_constraint=True))
    value: Mapped[Decimal] = mapped_column(ScaledDecimal())


class CashBalance(CompanyRow, Base):
    __tablename__ = "finance_cash_balances"
    __table_args__ = (UniqueConstraint("company_id", "date"),)
    date: Mapped[DateValue] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(ScaledDecimal())


class CashMovement(CompanyRow, Base):
    __tablename__ = "finance_cash_movements"
    __table_args__ = (Index("ix_finance_cash_company_date", "company_id", "date"),)
    date: Mapped[DateValue] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(ScaledDecimal())
    label: Mapped[str] = mapped_column(String(160))
    business_reference: Mapped[str | None] = mapped_column(String(160))


class BalanceSheetSnapshot(CompanyRow, Base):
    __tablename__ = "finance_balance_sheets"
    __table_args__ = (
        UniqueConstraint("company_id", "date"),
        CheckConstraint(
            "financial_debt >= 0 AND inventory >= 0 AND trade_receivables >= 0 AND trade_payables >= 0 "
            "AND tax_social_payables >= 0 AND cash >= 0 AND (total_assets IS NULL OR total_assets >= 0)",
        ),
    )
    date: Mapped[DateValue] = mapped_column(Date)
    equity: Mapped[Decimal] = mapped_column(ScaledDecimal())
    financial_debt: Mapped[Decimal] = mapped_column(ScaledDecimal())
    inventory: Mapped[Decimal] = mapped_column(ScaledDecimal(), default=ZERO)
    trade_receivables: Mapped[Decimal] = mapped_column(ScaledDecimal(), default=ZERO)
    trade_payables: Mapped[Decimal] = mapped_column(ScaledDecimal(), default=ZERO)
    tax_social_payables: Mapped[Decimal] = mapped_column(ScaledDecimal(), default=ZERO)
    cash: Mapped[Decimal] = mapped_column(ScaledDecimal(), default=ZERO)
    total_assets: Mapped[Decimal | None] = mapped_column(ScaledDecimal())


class FinanceAuditEvent(Base):
    __tablename__ = "finance_audit_events"
    __table_args__ = (Index("ix_finance_audit_company_created", "company_id", "created_at"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[str] = mapped_column(ForeignKey("finance_companies.id", ondelete="RESTRICT"))
    actor: Mapped[str] = mapped_column(String(128))
    action: Mapped[str] = mapped_column(String(32))
    entry_kind: Mapped[str] = mapped_column(String(32))
    entry_id: Mapped[str | None] = mapped_column(String(64))
    summary: Mapped[str] = mapped_column(String(240))
    created_at: Mapped[DateTimeValue] = mapped_column(DateTime(timezone=True))


class FinanceIngestionBatch(Base):
    __tablename__ = "finance_ingestion_batches"
    __table_args__ = (
        UniqueConstraint("company_id", "source", "idempotency_key", name="uq_finance_ingestion_idempotency"),
        Index("ix_finance_ingestion_company_created", "company_id", "created_at"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    company_id: Mapped[str] = mapped_column(ForeignKey("finance_companies.id", ondelete="RESTRICT"))
    source: Mapped[FinanceIngestionSource] = mapped_column(
        Enum(FinanceIngestionSource, native_enum=False, create_constraint=True),
    )
    idempotency_key: Mapped[str] = mapped_column(String(128))
    payload_sha256: Mapped[str] = mapped_column(String(64))
    record_count: Mapped[int]
    duplicate_count: Mapped[int] = mapped_column(default=0)
    notes: Mapped[list[str]] = mapped_column(JSON, default=list)
    review_warnings: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[DateTimeValue] = mapped_column(DateTime(timezone=True))


class FinanceIngestionItem(Base):
    __tablename__ = "finance_ingestion_items"
    __table_args__ = (
        UniqueConstraint(
            "company_id", "source", "source_transaction_id",
            name="uq_finance_ingestion_external_transaction",
        ),
        Index("ix_finance_ingestion_item_batch", "batch_id"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[str] = mapped_column(ForeignKey("finance_ingestion_batches.id", ondelete="RESTRICT"))
    company_id: Mapped[str] = mapped_column(ForeignKey("finance_companies.id", ondelete="RESTRICT"))
    source: Mapped[FinanceIngestionSource] = mapped_column(
        Enum(FinanceIngestionSource, native_enum=False, create_constraint=True),
    )
    source_transaction_id: Mapped[str] = mapped_column(String(160))
    target_kind: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[int]

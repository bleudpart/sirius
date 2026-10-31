"""Saisie manuelle du registre financier : validation stricte, isolation par entreprise et journal d'audit."""
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, localcontext
from enum import Enum
from typing import Any

from pydantic import BaseModel, ValidationError
from pydantic_core import ErrorDetails
from sqlalchemy import delete, exists, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from kpi_engine import FinanceDataset
from models.finance import (
    BalanceSheetSnapshot, CashBalance, CashMovement, CompanyProfile, FinanceAuditEvent, FinanceIngestionItem,
    InventorySnapshot, PurchaseExpense, RecurringOverhead, TransactionRevenue,
)
from schemas.finance import (
    BalanceSheetSnapshotIn, CashBalanceIn, CashMovementIn, CompanyProfileIn, FINANCE_CONTEXT, HUNDRED,
    InventorySnapshotIn, PurchaseExpenseIn, RecurringOverheadIn, SectorEnum, TransactionRevenueIn, ZERO, money,
)
from schemas.finance_entries import (
    BalanceSheetEntryIn, CashBalanceEntryIn, CashMovementEntryIn, CompanyProfileEnvelope, CompanyProfileUpdate,
    ExpenseEntryIn, FinanceAuditEntry, FinanceAuditLog, FinanceEntry, FinanceEntryKind, FinanceEntryList,
    InventoryEntryIn, JsonScalar, OverheadEntryIn, RevenueEntryIn,
)

MAX_AUDIT_EVENTS = 200
MAX_SUMMARY_LENGTH = 240
SERVER_FIELDS = frozenset({"company_id", "source_transaction_id"})
SECTOR_LABELS = {
    SectorEnum.HOSPITALITY: "Restauration / alimentaire", SectorEnum.CONSTRUCTION: "BTP / artisanat",
    SectorEnum.RETAIL: "Commerce / retail", SectorEnum.SERVICES: "Services / prestations",
}
FIELD_LABELS = {
    "date": "Date", "amount_ht": "Montant HT", "amount_ttc": "Montant TTC", "vat_rate": "Taux de TVA",
    "amount_vat": "Montant de TVA", "vat_deductible": "TVA déductible", "deductible_vat": "TVA déductible",
    "payment_method": "Moyen de paiement", "business_reference": "Référence métier", "allocation": "Ventilation",
    "ticket_count": "Nombre de tickets", "hours": "Heures", "days": "Jours", "supplier": "Fournisseur",
    "category": "Catégorie", "label": "Libellé", "monthly_amount_ht": "Montant mensuel HT",
    "vat_recoverable": "TVA récupérable", "employer_charges": "Charges patronales",
    "loan_principal": "Capital remboursé", "active_from": "Début", "active_to": "Fin", "value": "Valeur",
    "amount": "Montant", "equity": "Capitaux propres", "financial_debt": "Dettes financières",
    "inventory": "Stocks", "trade_receivables": "Créances clients", "trade_payables": "Dettes fournisseurs",
    "tax_social_payables": "Dettes fiscales et sociales", "cash": "Disponibilités", "total_assets": "Total du bilan",
    "name": "Raison sociale", "sector": "Secteur", "currency": "Devise", "company_id": "Entreprise",
    "id": "Identifiant", "source_transaction_id": "Référence source",
}
KIND_LABELS = {
    FinanceEntryKind.REVENUES: "Recette", FinanceEntryKind.EXPENSES: "Achat",
    FinanceEntryKind.OVERHEADS: "Charge récurrente", FinanceEntryKind.INVENTORIES: "Inventaire",
    FinanceEntryKind.CASH_BALANCES: "Solde de trésorerie", FinanceEntryKind.CASH_MOVEMENTS: "Mouvement de trésorerie",
    FinanceEntryKind.BALANCE_SHEETS: "Bilan",
}


class EntryValidationError(ValueError):
    """Message en français, directement affichable."""


class EntryNotFoundError(LookupError):
    pass


class EntryConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class EntrySpec:
    model: type[Any]
    record: type[BaseModel]
    entry: type[BaseModel]
    ingestion_kind: str | None
    conflict: str


SPECS: dict[FinanceEntryKind, EntrySpec] = {
    FinanceEntryKind.REVENUES: EntrySpec(
        TransactionRevenue, TransactionRevenueIn, RevenueEntryIn, "revenue", "Recette déjà enregistrée."),
    FinanceEntryKind.EXPENSES: EntrySpec(
        PurchaseExpense, PurchaseExpenseIn, ExpenseEntryIn, "expense", "Achat déjà enregistré."),
    FinanceEntryKind.OVERHEADS: EntrySpec(
        RecurringOverhead, RecurringOverheadIn, OverheadEntryIn, None, "Charge récurrente incohérente avec le registre."),
    FinanceEntryKind.INVENTORIES: EntrySpec(
        InventorySnapshot, InventorySnapshotIn, InventoryEntryIn, None,
        "Un inventaire existe déjà pour cette date et cette ventilation ; supprimez-le avant d’en saisir un autre."),
    FinanceEntryKind.CASH_BALANCES: EntrySpec(
        CashBalance, CashBalanceIn, CashBalanceEntryIn, None,
        "Un solde de trésorerie existe déjà à cette date ; supprimez-le avant d’en saisir un autre."),
    FinanceEntryKind.CASH_MOVEMENTS: EntrySpec(
        CashMovement, CashMovementIn, CashMovementEntryIn, "cash_movement", "Mouvement déjà enregistré."),
    FinanceEntryKind.BALANCE_SHEETS: EntrySpec(
        BalanceSheetSnapshot, BalanceSheetSnapshotIn, BalanceSheetEntryIn, None,
        "Un bilan existe déjà à cette date ; supprimez-le avant d’en saisir un autre."),
}


def _number(value: object) -> str:
    text = str(value)
    match = re.fullmatch(r"Decimal\('([^']*)'\)", text)
    return (match.group(1) if match else text).replace(".", ",")


def _error_message(error: ErrorDetails) -> str:
    kind, ctx = error["type"], error.get("ctx") or {}
    messages: dict[str, str] = {
        "missing": "champ obligatoire",
        "extra_forbidden": "champ non autorisé (calculé ou imposé par le serveur)",
        "greater_than_equal": f"doit être supérieur ou égal à {_number(ctx.get('ge'))}",
        "greater_than": f"doit être supérieur à {_number(ctx.get('gt'))}",
        "less_than_equal": f"doit être inférieur ou égal à {_number(ctx.get('le'))}",
        "less_than": f"doit être inférieur à {_number(ctx.get('lt'))}",
        "decimal_max_places": f"{ctx.get('decimal_places')} décimales au maximum",
        "decimal_max_digits": "montant trop grand",
        "decimal_whole_digits": "montant trop grand",
        "string_too_short": "texte obligatoire",
        "string_too_long": f"{ctx.get('max_length')} caractères au maximum",
        "string_pattern_mismatch": "format invalide",
        "enum": f"valeur non autorisée (attendu : {ctx.get('expected')})",
        "literal_error": f"valeur non autorisée (attendu : {ctx.get('expected')})",
        "bool_type": "oui/non attendu", "bool_parsing": "oui/non attendu",
        "int_type": "nombre entier attendu", "int_parsing": "nombre entier attendu",
        "int_from_float": "nombre entier attendu",
        "string_type": "texte attendu",
        "dict_type": "objet JSON attendu", "model_type": "objet JSON attendu",
    }
    if kind in {"value_error", "assertion_error"}:
        return str(ctx.get("error") or error["msg"]).removeprefix("Value error, ")
    return messages.get(kind, "valeur invalide")


def validation_detail(error: ValidationError, labels: Mapping[str, str] = FIELD_LABELS) -> str:
    details: list[str] = []
    for item in error.errors():
        field = next((part for part in item["loc"] if isinstance(part, str)), None)
        message = _error_message(item)
        text = f"{labels.get(field, field)} : {message}" if field else message
        if text not in details:
            details.append(text)
    return " ; ".join(details) or "Saisie invalide."


def _json_value(value: object) -> JsonScalar:
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Enum):
        return str(value.value)
    raise TypeError(f"Valeur financière non prise en charge : {type(value).__name__}")


def _fmt(value: object) -> str:
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    if isinstance(value, Enum):
        return str(value.value)
    return "—" if value is None else str(value)


SUMMARIES: dict[FinanceEntryKind, Callable[[Mapping[str, object]], str]] = {
    FinanceEntryKind.REVENUES: lambda v: f"{_fmt(v['date'])} · {_fmt(v['amount_ht'])} HT · TVA {_fmt(v['vat_rate'])} %",
    FinanceEntryKind.EXPENSES: lambda v: f"{_fmt(v['date'])} · {_fmt(v['supplier'])} · {_fmt(v['amount_ht'])} HT · {_fmt(v['category'])}",
    FinanceEntryKind.OVERHEADS: lambda v: (
        f"{_fmt(v['label'])} · {_fmt(v['category'])} · {_fmt(v['monthly_amount_ht'])} HT/mois dès le {_fmt(v['active_from'])}"
    ),
    FinanceEntryKind.INVENTORIES: lambda v: f"{_fmt(v['allocation'])} au {_fmt(v['date'])} · {_fmt(v['value'])}",
    FinanceEntryKind.CASH_BALANCES: lambda v: f"au {_fmt(v['date'])} · {_fmt(v['amount'])}",
    FinanceEntryKind.CASH_MOVEMENTS: lambda v: f"{_fmt(v['date'])} · {_fmt(v['label'])} · {_fmt(v['amount'])}",
    FinanceEntryKind.BALANCE_SHEETS: lambda v: (
        f"au {_fmt(v['date'])} · capitaux propres {_fmt(v['equity'])} · dettes financières {_fmt(v['financial_debt'])}"
    ),
}


def describe(kind: FinanceEntryKind, values: Mapping[str, object]) -> str:
    return f"{KIND_LABELS[kind]} {SUMMARIES[kind](values)}"[:MAX_SUMMARY_LENGTH]


def _record_fields(spec: EntrySpec) -> list[str]:
    return [name for name in spec.record.model_fields if name not in SERVER_FIELDS]


def _row_mapping(spec: EntrySpec, row: object) -> dict[str, object]:
    return {name: getattr(row, name) for name in _record_fields(spec)}


def _audit(company_id: str, actor: str, action: str, kind: str, entry_id: str | None, summary: str) -> FinanceAuditEvent:
    return FinanceAuditEvent(
        company_id=company_id, actor=actor[:128], action=action, entry_kind=kind,
        entry_id=entry_id, summary=summary[:MAX_SUMMARY_LENGTH], created_at=datetime.now(timezone.utc),
    )


def parse_entry(kind: FinanceEntryKind, company_id: str, payload: Mapping[str, object]) -> BaseModel:
    """Valide la saisie du client, puis calcule les montants qu'il ne peut pas choisir (TTC, TVA déductible)."""
    spec = SPECS[kind]
    try:
        values = spec.entry.model_validate(payload).model_dump()
        with localcontext(FINANCE_CONTEXT):
            if kind == FinanceEntryKind.REVENUES:
                values["amount_ttc"] = values["amount_ht"] + money(values["amount_ht"] * values["vat_rate"] / HUNDRED)
            elif kind == FinanceEntryKind.EXPENSES:
                rate, vat, deductible = values.pop("vat_rate"), values.pop("amount_vat"), values.pop("vat_deductible")
                vat = vat if vat is not None else money(values["amount_ht"] * rate / HUNDRED)
                values |= {
                    "amount_vat": vat, "amount_ttc": values["amount_ht"] + vat,
                    "deductible_vat": vat if deductible else ZERO,
                }
        return spec.record.model_validate(values | {"company_id": company_id})
    except ValidationError as error:
        raise EntryValidationError(validation_detail(error)) from error


def list_entries(
    session: Session, company_id: str, kind: FinanceEntryKind,
    start_date: date | None = None, end_date: date | None = None, limit: int = 200,
) -> FinanceEntryList:
    spec = SPECS[kind]
    model = spec.model
    query = select(model).where(model.company_id == company_id)
    if kind == FinanceEntryKind.OVERHEADS:
        if start_date is not None:
            query = query.where(or_(model.active_to.is_(None), model.active_to >= start_date))
        if end_date is not None:
            query = query.where(model.active_from <= end_date)
        order = (model.active_from.desc(), model.id.desc())
    else:
        if start_date is not None:
            query = query.where(model.date >= start_date)
        if end_date is not None:
            query = query.where(model.date <= end_date)
        order = (model.date.desc(), model.id.desc())
    rows = session.scalars(query.order_by(*order).limit(limit + 1)).all()
    truncated, rows = len(rows) > limit, rows[:limit]
    origins: dict[int, str] = {}
    if spec.ingestion_kind and rows:
        origins = {target_id: source.value for target_id, source in session.execute(
            select(FinanceIngestionItem.target_id, FinanceIngestionItem.source).where(
                FinanceIngestionItem.company_id == company_id,
                FinanceIngestionItem.target_kind == spec.ingestion_kind,
                FinanceIngestionItem.target_id.in_([row.id for row in rows]),
            ),
        ).all()}
    return FinanceEntryList(kind=kind, truncated=truncated, entries=[
        FinanceEntry(
            id=row.id, kind=kind, origin=origins.get(row.id, "manual"),
            values={name: _json_value(value) for name, value in _row_mapping(spec, row).items()},
        )
        for row in rows
    ])


def list_demo_entries(
    dataset: FinanceDataset, kind: FinanceEntryKind,
    start_date: date | None = None, end_date: date | None = None, limit: int = 200,
) -> FinanceEntryList:
    """Pièces d'une démonstration en lecture seule, filtrées et triées comme le registre réel."""
    spec = SPECS[kind]
    numbered: list[tuple[int, Any]] = list(enumerate(getattr(dataset, kind.value), start=1))
    if kind == FinanceEntryKind.OVERHEADS:
        rows = sorted((
            (number, row) for number, row in numbered
            if (start_date is None or row.active_to is None or row.active_to >= start_date)
            and (end_date is None or row.active_from <= end_date)
        ), key=lambda item: (item[1].active_from, item[0]), reverse=True)
    else:
        rows = sorted((
            (number, row) for number, row in numbered
            if (start_date is None or row.date >= start_date) and (end_date is None or row.date <= end_date)
        ), key=lambda item: (item[1].date, item[0]), reverse=True)
    return FinanceEntryList(kind=kind, truncated=len(rows) > limit, entries=[
        FinanceEntry(
            id=number, kind=kind, origin="demo",
            values={name: _json_value(value) for name, value in _row_mapping(spec, row).items()},
        )
        for number, row in rows[:limit]
    ])


def create_entry(
    session: Session, company_id: str, kind: FinanceEntryKind, payload: Mapping[str, object], actor: str,
) -> FinanceEntry:
    spec = SPECS[kind]
    record = parse_entry(kind, company_id, payload)
    try:
        with session.begin():
            if session.get(CompanyProfile, company_id) is None:
                raise EntryNotFoundError("Profil financier introuvable : créez-le avant de saisir des écritures.")
            row = spec.model(**record.model_dump(mode="python"))
            session.add(row)
            session.flush()
            session.refresh(row)
            session.add(_audit(company_id, actor, "create", kind.value, str(row.id), describe(kind, record.model_dump())))
            values = {name: _json_value(value) for name, value in _row_mapping(spec, row).items()}
            entry = FinanceEntry(id=row.id, kind=kind, origin="manual", values=values)
    except IntegrityError as error:
        raise EntryConflictError(spec.conflict) from error
    return entry


def delete_entry(session: Session, company_id: str, kind: FinanceEntryKind, entry_id: int, actor: str) -> None:
    spec = SPECS[kind]
    with session.begin():
        row = session.scalar(select(spec.model).where(spec.model.id == entry_id, spec.model.company_id == company_id))
        if row is None:
            raise EntryNotFoundError("Écriture introuvable pour cette entreprise.")
        summary = describe(kind, _row_mapping(spec, row))
        if spec.ingestion_kind:
            # Les liens d'import n'ont pas de clé étrangère ; SQLite peut réattribuer l'identifiant à une saisie manuelle ultérieure.
            session.execute(delete(FinanceIngestionItem).where(
                FinanceIngestionItem.company_id == company_id,
                FinanceIngestionItem.target_kind == spec.ingestion_kind,
                FinanceIngestionItem.target_id == entry_id,
            ))
        session.delete(row)
        session.add(_audit(company_id, actor, "delete", kind.value, str(entry_id), summary))


def get_profile(session: Session, company_id: str) -> CompanyProfileEnvelope:
    profile = session.get(CompanyProfile, company_id)
    return CompanyProfileEnvelope(profile=CompanyProfileIn.model_validate(profile) if profile else None)


def _has_entries(session: Session, company_id: str) -> bool:
    return any(
        session.scalar(select(exists().where(spec.model.company_id == company_id)))
        for spec in SPECS.values()
    )


def save_profile(session: Session, company_id: str, payload: Mapping[str, object], actor: str) -> CompanyProfileIn:
    try:
        update = CompanyProfileUpdate.model_validate(payload)
    except ValidationError as error:
        raise EntryValidationError(validation_detail(error)) from error
    with session.begin():
        profile = session.get(CompanyProfile, company_id)
        if profile is None:
            profile = CompanyProfile(id=company_id, **update.model_dump())
            session.add(profile)
            summary = f"Création du profil « {update.name} » · {SECTOR_LABELS[update.sector]} · {update.currency}"
        else:
            if update.currency != profile.currency and _has_entries(session, company_id):
                raise EntryConflictError("Devise verrouillée : des écritures existent déjà dans la devise actuelle.")
            summary = f"Profil mis à jour « {update.name} » · {SECTOR_LABELS[update.sector]} · {update.currency}"
            profile.name, profile.sector, profile.currency = update.name, update.sector, update.currency
        session.flush()
        session.add(_audit(company_id, actor, "profile", "profile", None, summary))
        result = CompanyProfileIn.model_validate(profile)
    return result


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def audit_log(session: Session, company_id: str, limit: int = MAX_AUDIT_EVENTS) -> FinanceAuditLog:
    rows = session.scalars(select(FinanceAuditEvent).where(
        FinanceAuditEvent.company_id == company_id,
    ).order_by(FinanceAuditEvent.created_at.desc(), FinanceAuditEvent.id.desc()).limit(limit)).all()
    return FinanceAuditLog(events=[
        FinanceAuditEntry(
            id=row.id, actor=row.actor, action=row.action, entry_kind=row.entry_kind,
            entry_id=row.entry_id, summary=row.summary, created_at=_utc(row.created_at),
        )
        for row in rows
    ])

"""Finance multi-entreprise authentifiée : tableau de bord, stress test, saisie manuelle, imports et journal d'audit."""
import hashlib
import hmac
import json
import logging
import os
import re
import sqlite3
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Annotated, Protocol, TypeVar

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Query, Request, Response
from pydantic import ValidationError
from pymongo.errors import PyMongoError
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from finance_database import get_db
from finance_connectors import (
    ConnectorValidationError, IngestionConflictError, JSON_TOO_DEEP, MAX_CONNECTOR_PAYLOAD_BYTES,
    json_nesting_exceeds,
)
from finance_demo import DEMO_END, DEMO_START, demo_catalog, demo_company, demo_report
from finance_entries import (
    EntryConflictError, EntryNotFoundError, EntryValidationError, audit_log, create_entry, delete_entry,
    get_profile, list_demo_entries, list_entries, save_profile, validation_detail,
)
from ingestion_service import IngestionBatchNotFoundError, MAX_BATCH_LIST, ingest_payload, list_batches, revert_batch
from kpi_engine import FinanceDataset, build_report, comparison_period
from models.finance import (
    BalanceSheetSnapshot, CashBalance, CashMovement, CompanyProfile, InventorySnapshot, PurchaseExpense,
    RecurringOverhead, TransactionRevenue,
)
from schemas.finance import (
    BalanceSheetSnapshotIn, CashBalanceIn, CashMovementIn, CompanyId, CompanyProfileIn, ComparisonMode, DemoCatalog,
    FinanceDashboard, FinanceIngestionSource, InventorySnapshotIn, IsoDate, Period, PurchaseExpenseIn,
    RecurringOverheadIn, SectorEnum, TransactionRevenueIn,
)
from schemas.finance_entries import (
    CompanyProfileEnvelope, FinanceAuditLog, FinanceEntry, FinanceEntryKind, FinanceEntryList,
)
from schemas.finance_ingestion import FinanceIngestionLog, FinanceIngestionResult
from schemas.finance_simulation import SIMULATION_FIELD_LABELS, SimulationRequest, SimulationResponse
from simulation_service import SimulationError, run_stress_test, snapshot_from_dataset

logger = logging.getLogger(__name__)
SIGNATURE_PATTERN = re.compile(r"^sha256=[a-f0-9]{64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{10}$")
MAX_DASHBOARD_DAYS = 3653
MAX_ENTRY_PAYLOAD_BYTES = 64 * 1024
MAX_ENTRY_LIST = 500
INGESTION_CONTENT_TYPES = {
    FinanceIngestionSource.BANK_STATEMENT_CSV: "text/csv",
    FinanceIngestionSource.BANK_STATEMENT_OFX: "application/x-ofx",
}
T = TypeVar("T")


@dataclass(frozen=True)
class FinanceMember:
    company_id: str
    user_id: str


class JsonRejected(ValueError):
    """Message en français, directement affichable."""


def _reject_constant(name: str) -> object:
    raise JsonRejected(f"Valeur JSON non finie interdite : {name}.")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    value = dict(pairs)
    if len(value) != len(pairs):
        raise JsonRejected("Clé JSON en double.")
    return value


def parse_json_object(raw: bytes) -> dict[str, object]:
    """Les nombres JSON deviennent des Decimal exacts, jamais des flottants."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise HTTPException(400, "Encodage UTF-8 requis.") from error
    if json_nesting_exceeds(text):
        raise HTTPException(400, JSON_TOO_DEEP)
    try:
        value = json.loads(text, parse_float=Decimal, parse_constant=_reject_constant, object_pairs_hook=_unique_object)
    except JsonRejected as error:
        raise HTTPException(400, str(error)) from error
    except json.JSONDecodeError as error:
        raise HTTPException(400, f"JSON invalide (ligne {error.lineno}, colonne {error.colno}).") from error
    except ValueError as error:
        raise HTTPException(400, "JSON invalide : nombre hors limites.") from error
    except RecursionError as error:
        raise HTTPException(400, JSON_TOO_DEEP) from error
    if not isinstance(value, dict):
        raise HTTPException(422, "Un objet JSON est attendu.")
    return value


class MembershipCollection(Protocol):
    async def find_one(self, query: dict[str, object]) -> Mapping[str, object] | None: ...


class MembershipDatabase(Protocol):
    enterprise_members: MembershipCollection


AuthResolver = Callable[[Request, MembershipDatabase], Awaitable[Mapping[str, object]]]


def parse_period(start_date: date, end_date: date) -> Period:
    try:
        period = Period(start_date=start_date, end_date=end_date)
    except ValidationError as error:
        raise HTTPException(422, "Période invalide : dates ISO ordonnées, fin antérieure au 9999-12-31.") from error
    if (period.end_date - period.start_date).days + 1 > MAX_DASHBOARD_DAYS:
        raise HTTPException(422, "Période limitée à 10 ans.")
    return period


def demo_period(start_date: date, end_date: date) -> Period:
    period = parse_period(start_date, end_date)
    if period.start_date < DEMO_START or period.end_date > DEMO_END:
        raise HTTPException(
            422, f"La démonstration couvre les exercices {DEMO_START.year} à {DEMO_END.year} "
                 f"(du {DEMO_START:%d/%m/%Y} au {DEMO_END:%d/%m/%Y}).",
        )
    return period


def load_dataset(session: Session, company_id: str, periods: Sequence[Period]) -> FinanceDataset:
    """Pièces d'une entreprise utiles à chaque période ; FinanceDataset.select() réapplique les règles exactes."""
    company = session.get(CompanyProfile, company_id)
    if company is None:
        # L'interface reconnaît ce préfixe et propose de créer le profil.
        raise HTTPException(404, "Profil financier d’entreprise introuvable : créez-le dans « Saisie & imports ».")
    revenues = session.scalars(select(TransactionRevenue).where(
        TransactionRevenue.company_id == company_id,
        or_(*(TransactionRevenue.date.between(p.start_date, p.end_date) for p in periods)),
    ).order_by(TransactionRevenue.id)).all()
    expenses = session.scalars(select(PurchaseExpense).where(
        PurchaseExpense.company_id == company_id,
        or_(*(PurchaseExpense.date.between(p.start_date, p.end_date) for p in periods)),
    ).order_by(PurchaseExpense.id)).all()
    overheads = session.scalars(select(RecurringOverhead).where(
        RecurringOverhead.company_id == company_id,
        or_(*(and_(
            RecurringOverhead.active_from <= p.end_date,
            or_(RecurringOverhead.active_to.is_(None), RecurringOverhead.active_to >= p.start_date),
        ) for p in periods)),
    ).order_by(RecurringOverhead.id)).all()
    inventories = session.scalars(select(InventorySnapshot).where(
        InventorySnapshot.company_id == company_id,
        or_(*(InventorySnapshot.date.between(p.start_date, p.end_date + timedelta(days=1)) for p in periods)),
    ).order_by(InventorySnapshot.id)).all()
    balances: dict[int, CashBalance] = {}
    sheets: dict[int, BalanceSheetSnapshot] = {}
    movement_ranges = []
    for period in periods:
        balance = session.scalars(select(CashBalance).where(
            CashBalance.company_id == company_id, CashBalance.date <= period.start_date,
        ).order_by(CashBalance.date.desc()).limit(1)).first()
        if balance is not None:
            balances[balance.id] = balance
        movement_ranges.append(CashMovement.date.between(balance.date if balance else period.start_date, period.end_date))
        sheet = session.scalars(select(BalanceSheetSnapshot).where(
            BalanceSheetSnapshot.company_id == company_id, BalanceSheetSnapshot.date <= period.end_date,
        ).order_by(BalanceSheetSnapshot.date.desc()).limit(1)).first()
        if sheet is not None:
            sheets[sheet.id] = sheet
    movements = session.scalars(select(CashMovement).where(
        CashMovement.company_id == company_id, or_(*movement_ranges),
    ).order_by(CashMovement.id)).all()
    return FinanceDataset(
        company=CompanyProfileIn.model_validate(company),
        revenues=tuple(TransactionRevenueIn.model_validate(r) for r in revenues),
        expenses=tuple(PurchaseExpenseIn.model_validate(e) for e in expenses),
        overheads=tuple(RecurringOverheadIn.model_validate(o) for o in overheads),
        inventories=tuple(InventorySnapshotIn.model_validate(i) for i in inventories),
        cash_balances=tuple(CashBalanceIn.model_validate(b) for b in balances.values()),
        cash_movements=tuple(CashMovementIn.model_validate(m) for m in movements),
        balance_sheets=tuple(BalanceSheetSnapshotIn.model_validate(s) for s in sheets.values()),
    )


def load_dashboard(
    session: Session, company_id: str, period: Period, comparison: ComparisonMode = ComparisonMode.PREVIOUS,
) -> FinanceDashboard:
    reference = comparison_period(period, comparison)
    dataset = load_dataset(session, company_id, [period] if reference is None else [period, reference])
    return build_report(dataset, period, comparison)


def simulation_request(payload: Mapping[str, object], company_id: str) -> SimulationRequest:
    try:
        scenario = SimulationRequest.model_validate(payload)
    except ValidationError as error:
        raise HTTPException(422, validation_detail(error, SIMULATION_FIELD_LABELS)) from error
    if scenario.id_entreprise != company_id:
        raise HTTPException(422, "Entreprise : l’identifiant du scénario ne correspond pas à l’entreprise demandée.")
    return scenario


def make_company_finance_router(db: MembershipDatabase, require_user: AuthResolver) -> APIRouter:
    router = APIRouter(prefix="/finance", tags=["finance-entreprise"])

    async def authenticated(request: Request) -> Mapping[str, object]:
        return await require_user(request, db)

    # Démonstration fictive : session requise, aucune donnée d'entreprise réelle lue ni écrite.
    @router.get("/demo/companies", response_model=DemoCatalog)
    def demo_companies(_user: Annotated[Mapping[str, object], Depends(authenticated)]) -> DemoCatalog:
        return demo_catalog()

    @router.get("/demo/{sector}/dashboard", response_model=FinanceDashboard)
    def demo_dashboard(
        sector: SectorEnum,
        start_date: Annotated[IsoDate, Query()],
        end_date: Annotated[IsoDate, Query()],
        _user: Annotated[Mapping[str, object], Depends(authenticated)],
        comparison: Annotated[ComparisonMode, Query()] = ComparisonMode.PREVIOUS,
    ) -> FinanceDashboard:
        period = demo_period(start_date, end_date)
        try:
            return demo_report(sector, period.start_date, period.end_date, comparison)
        except ValueError as error:
            logger.exception("[FINANCE] Démonstration fictive non calculée")
            raise HTTPException(500, "Démonstration indisponible : tableau non calculé.") from error

    @router.get("/demo/{sector}/entries/{kind}", response_model=FinanceEntryList)
    def demo_entries(
        sector: SectorEnum,
        kind: FinanceEntryKind,
        _user: Annotated[Mapping[str, object], Depends(authenticated)],
        start_date: Annotated[IsoDate | None, Query()] = None,
        end_date: Annotated[IsoDate | None, Query()] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_ENTRY_LIST)] = 200,
    ) -> FinanceEntryList:
        if start_date is not None and end_date is not None and end_date < start_date:
            raise HTTPException(422, "La date de fin précède la date de début.")
        return list_demo_entries(demo_company(sector).dataset, kind, start_date, end_date, limit)

    async def membership(request: Request, company_id: str) -> FinanceMember:
        user = await require_user(request, db)
        try:
            member = await db.enterprise_members.find_one({
                "user_id": user["user_id"], "company_id": company_id,
            })
        except (sqlite3.Error, PyMongoError) as error:
            logger.exception("[FINANCE] Vérification des droits entreprise impossible")
            raise HTTPException(503, "Vérification des droits entreprise indisponible.") from error
        if member is None:
            raise HTTPException(404, "Entreprise inaccessible.")
        if member.get("role") not in {"admin", "manager"}:
            raise HTTPException(403, "La finance d’entreprise est réservée aux administrateurs et gestionnaires.")
        return FinanceMember(company_id=company_id, user_id=str(user["user_id"]))

    async def authorize(request: Request, company_id: str) -> str:
        return (await membership(request, company_id)).company_id

    async def read_bounded_body(request: Request, limit: int = MAX_CONNECTOR_PAYLOAD_BYTES) -> bytes:
        content_encoding = request.headers.get("content-encoding", "identity").lower()
        if content_encoding not in {"", "identity"}:
            raise HTTPException(415, "Compression de payload non prise en charge.")
        too_large = f"Charge utile supérieure à {limit // 1024 // 1024} Mio." if limit >= 1024 * 1024 else (
            f"Charge utile supérieure à {limit // 1024} Kio."
        )
        declared_length = request.headers.get("content-length")
        if declared_length is not None:
            try:
                if int(declared_length) > limit:
                    raise HTTPException(413, too_large)
            except ValueError as error:
                raise HTTPException(400, "Content-Length invalide.") from error
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > limit:
                raise HTTPException(413, too_large)
        if not body:
            raise HTTPException(400, "Charge utile vide.")
        return bytes(body)

    async def json_object(request: Request) -> dict[str, object]:
        actual = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if actual != "application/json":
            raise HTTPException(415, "Content-Type requis : application/json.")
        return parse_json_object(await read_bounded_body(request, MAX_ENTRY_PAYLOAD_BYTES))

    def content_type(request: Request, source: FinanceIngestionSource) -> None:
        actual = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        expected = INGESTION_CONTENT_TYPES.get(source, "application/json")
        if actual != expected:
            raise HTTPException(415, f"Content-Type requis : {expected}.")

    def persist_ingestion(
        session: Session, company_id: str, source: FinanceIngestionSource,
        raw_data: bytes, idempotency_key: str | None, actor: str,
    ) -> FinanceIngestionResult:
        try:
            return ingest_payload(
                session, company_id=company_id, source=source,
                raw_data=raw_data, idempotency_key=idempotency_key, actor=actor,
            )
        except ConnectorValidationError as error:
            raise HTTPException(422, str(error)) from error
        except IngestionConflictError as error:
            raise HTTPException(409, str(error)) from error
        except SQLAlchemyError as error:
            logger.exception("[FINANCE] Transaction d'import annulée : stockage indisponible")
            raise HTTPException(503, "Import financier annulé ; stockage indisponible.") from error

    def guarded(operation: Callable[[], T]) -> T:
        try:
            return operation()
        except EntryValidationError as error:
            raise HTTPException(422, str(error)) from error
        except EntryNotFoundError as error:
            raise HTTPException(404, str(error)) from error
        except EntryConflictError as error:
            raise HTTPException(409, str(error)) from error
        except SQLAlchemyError as error:
            logger.exception("[FINANCE] Écriture du registre financier impossible")
            raise HTTPException(503, "Registre financier indisponible ; aucune modification enregistrée.") from error

    @router.get("/{company_id}/dashboard", response_model=FinanceDashboard)
    def dashboard(
        company_id: Annotated[CompanyId, Path()],
        start_date: Annotated[IsoDate, Query()],
        end_date: Annotated[IsoDate, Query()],
        authorized_company: Annotated[str, Depends(authorize)],
        session: Annotated[Session, Depends(get_db)],
        comparison: Annotated[ComparisonMode, Query()] = ComparisonMode.PREVIOUS,
    ) -> FinanceDashboard:
        period = parse_period(start_date, end_date)
        try:
            return load_dashboard(session, authorized_company, period, comparison)
        except SQLAlchemyError as error:
            logger.exception("[FINANCE] Lecture du registre financier impossible")
            raise HTTPException(503, "Le registre financier est indisponible.") from error
        except ValueError as error:
            logger.exception("[FINANCE] Données enregistrées incohérentes : tableau non calculé")
            raise HTTPException(500, "Données financières incohérentes : tableau non calculé.") from error

    # Stress test : la situation de référence est lue, le scénario est appliqué en mémoire, rien n'est écrit.
    @router.post("/demo/{sector}/stress-test", response_model=SimulationResponse)
    def demo_stress_test(
        sector: SectorEnum,
        start_date: Annotated[IsoDate, Query()],
        end_date: Annotated[IsoDate, Query()],
        _user: Annotated[Mapping[str, object], Depends(authenticated)],
        payload: Annotated[dict[str, object], Depends(json_object)],
    ) -> SimulationResponse:
        period = demo_period(start_date, end_date)
        dataset = demo_company(sector).dataset
        scenario = simulation_request(payload, dataset.company.id)
        try:
            return run_stress_test(snapshot_from_dataset(dataset, period, demo=True), scenario)
        except SimulationError as error:
            raise HTTPException(422, str(error)) from error
        except ValueError as error:
            logger.exception("[FINANCE] Simulation de démonstration non calculée")
            raise HTTPException(500, "Démonstration indisponible : simulation non calculée.") from error

    @router.post("/{company_id}/stress-test", response_model=SimulationResponse)
    def stress_test(
        company_id: Annotated[CompanyId, Path()],
        start_date: Annotated[IsoDate, Query()],
        end_date: Annotated[IsoDate, Query()],
        member: Annotated[FinanceMember, Depends(membership)],
        payload: Annotated[dict[str, object], Depends(json_object)],
        session: Annotated[Session, Depends(get_db)],
    ) -> SimulationResponse:
        period = parse_period(start_date, end_date)
        scenario = simulation_request(payload, member.company_id)
        try:
            dataset = load_dataset(session, member.company_id, [period])
            return run_stress_test(snapshot_from_dataset(dataset, period), scenario)
        except SimulationError as error:
            raise HTTPException(422, str(error)) from error
        except SQLAlchemyError as error:
            logger.exception("[FINANCE] Lecture du registre financier impossible")
            raise HTTPException(503, "Le registre financier est indisponible.") from error
        except ValueError as error:
            logger.exception("[FINANCE] Données enregistrées incohérentes : simulation non calculée")
            raise HTTPException(500, "Données financières incohérentes : simulation non calculée.") from error

    @router.post("/{company_id}/ingestions/{source}", response_model=FinanceIngestionResult)
    async def ingest(
        company_id: Annotated[CompanyId, Path()],
        source: FinanceIngestionSource,
        request: Request,
        member: Annotated[FinanceMember, Depends(membership)],
        session: Annotated[Session, Depends(get_db)],
        idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
    ) -> FinanceIngestionResult:
        if idempotency_key is not None and not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", idempotency_key):
            raise HTTPException(422, "Clé d’idempotence invalide.")
        content_type(request, source)
        raw_data = await read_bounded_body(request)
        return persist_ingestion(session, member.company_id, source, raw_data, idempotency_key, member.user_id)

    @router.get("/{company_id}/ingestions", response_model=FinanceIngestionLog)
    def read_ingestions(
        company_id: Annotated[CompanyId, Path()],
        member: Annotated[FinanceMember, Depends(membership)],
        session: Annotated[Session, Depends(get_db)],
        limit: Annotated[int, Query(ge=1, le=MAX_BATCH_LIST)] = 50,
    ) -> FinanceIngestionLog:
        try:
            return list_batches(session, member.company_id, limit)
        except SQLAlchemyError as error:
            logger.exception("[FINANCE] Lecture du journal des imports impossible")
            raise HTTPException(503, "Journal des imports indisponible.") from error

    @router.delete("/{company_id}/ingestions/{batch_id}", status_code=204, response_class=Response)
    def cancel_ingestion(
        company_id: Annotated[CompanyId, Path()],
        batch_id: Annotated[str, Path(pattern=r"^[0-9a-f-]{36}$")],
        member: Annotated[FinanceMember, Depends(membership)],
        session: Annotated[Session, Depends(get_db)],
    ) -> Response:
        try:
            revert_batch(session, member.company_id, batch_id, member.user_id)
        except IngestionBatchNotFoundError as error:
            raise HTTPException(404, str(error)) from error
        except SQLAlchemyError as error:
            logger.exception("[FINANCE] Annulation de l'import impossible")
            raise HTTPException(503, "Annulation impossible : stockage indisponible, rien n’a été supprimé.") from error
        return Response(status_code=204)

    @router.get("/{company_id}/profile", response_model=CompanyProfileEnvelope)
    def read_profile(
        company_id: Annotated[CompanyId, Path()],
        member: Annotated[FinanceMember, Depends(membership)],
        session: Annotated[Session, Depends(get_db)],
    ) -> CompanyProfileEnvelope:
        return guarded(lambda: get_profile(session, member.company_id))

    @router.put("/{company_id}/profile", response_model=CompanyProfileIn)
    def write_profile(
        company_id: Annotated[CompanyId, Path()],
        member: Annotated[FinanceMember, Depends(membership)],
        payload: Annotated[dict[str, object], Depends(json_object)],
        session: Annotated[Session, Depends(get_db)],
    ) -> CompanyProfileIn:
        return guarded(lambda: save_profile(session, member.company_id, payload, member.user_id))

    @router.get("/{company_id}/entries/{kind}", response_model=FinanceEntryList)
    def read_entries(
        company_id: Annotated[CompanyId, Path()],
        kind: FinanceEntryKind,
        member: Annotated[FinanceMember, Depends(membership)],
        session: Annotated[Session, Depends(get_db)],
        start_date: Annotated[IsoDate | None, Query()] = None,
        end_date: Annotated[IsoDate | None, Query()] = None,
        limit: Annotated[int, Query(ge=1, le=MAX_ENTRY_LIST)] = 200,
    ) -> FinanceEntryList:
        if start_date is not None and end_date is not None and end_date < start_date:
            raise HTTPException(422, "La date de fin précède la date de début.")
        return guarded(lambda: list_entries(session, member.company_id, kind, start_date, end_date, limit))

    @router.post("/{company_id}/entries/{kind}", response_model=FinanceEntry, status_code=201)
    def add_entry(
        company_id: Annotated[CompanyId, Path()],
        kind: FinanceEntryKind,
        member: Annotated[FinanceMember, Depends(membership)],
        payload: Annotated[dict[str, object], Depends(json_object)],
        session: Annotated[Session, Depends(get_db)],
    ) -> FinanceEntry:
        return guarded(lambda: create_entry(session, member.company_id, kind, payload, member.user_id))

    @router.delete("/{company_id}/entries/{kind}/{entry_id}", status_code=204, response_class=Response)
    def remove_entry(
        company_id: Annotated[CompanyId, Path()],
        kind: FinanceEntryKind,
        entry_id: Annotated[int, Path(ge=1, le=2**63 - 1)],
        member: Annotated[FinanceMember, Depends(membership)],
        session: Annotated[Session, Depends(get_db)],
    ) -> Response:
        guarded(lambda: delete_entry(session, member.company_id, kind, entry_id, member.user_id))
        return Response(status_code=204)

    @router.get("/{company_id}/audit", response_model=FinanceAuditLog)
    def read_audit(
        company_id: Annotated[CompanyId, Path()],
        member: Annotated[FinanceMember, Depends(membership)],
        session: Annotated[Session, Depends(get_db)],
    ) -> FinanceAuditLog:
        return guarded(lambda: audit_log(session, member.company_id))

    @router.post("/{company_id}/webhooks/pos", response_model=FinanceIngestionResult)
    async def pos_webhook(
        company_id: Annotated[CompanyId, Path()],
        request: Request,
        session: Annotated[Session, Depends(get_db)],
        timestamp: Annotated[str, Header(alias="X-Sirius-Timestamp")],
        signature: Annotated[str, Header(alias="X-Sirius-Signature")],
    ) -> FinanceIngestionResult:
        secret_name = "SIRIUS_FINANCE_POS_SECRET_" + hashlib.sha256(company_id.encode("utf-8")).hexdigest()[:20].upper()
        secret = os.environ.get(secret_name, "")
        if len(secret.encode("utf-8")) < 32:
            logger.error("[FINANCE] Secret du webhook POS non configuré pour la clé d'entreprise %s", secret_name.removeprefix("SIRIUS_FINANCE_POS_SECRET_"))
            raise HTTPException(503, "Webhook POS non configuré.")
        content_type(request, FinanceIngestionSource.POS_WEBHOOK)
        if not TIMESTAMP_PATTERN.fullmatch(timestamp) or not SIGNATURE_PATTERN.fullmatch(signature):
            raise HTTPException(401, "Signature du webhook POS invalide.")
        now = int(time.time())
        if abs(now - int(timestamp)) > 300:
            raise HTTPException(401, "Webhook POS expiré ; fenêtre maximale de cinq minutes.")
        raw_data = await read_bounded_body(request)
        signed = timestamp.encode("ascii") + b"." + raw_data
        expected = "sha256=" + hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise HTTPException(401, "Signature du webhook POS invalide.")
        return persist_ingestion(session, company_id, FinanceIngestionSource.POS_WEBHOOK, raw_data, None, "pos_webhook")

    return router

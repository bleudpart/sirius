"""Enregistrement atomique et idempotent des imports financiers validés."""
import hashlib
import logging
import re
import uuid
from datetime import datetime, timezone
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from finance_connectors import (
    BaseDataConnector, ConnectorValidationError, IngestionConflictError, StandardizedTransaction,
    connector_factory,
)
from models.finance import (
    CashMovement, CompanyProfile, FinanceAuditEvent, FinanceIngestionBatch, FinanceIngestionItem,
    PurchaseExpense, TransactionRevenue,
)
from schemas.finance import (
    CashMovementIn, FinanceIngestionSource, PurchaseExpenseIn, TransactionRevenueIn,
)
from schemas.finance_ingestion import FinanceIngestionBatchView, FinanceIngestionLog, FinanceIngestionResult

logger = logging.getLogger(__name__)
IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
SOURCE_LABELS = {
    FinanceIngestionSource.POS_WEBHOOK: "caisse (webhook)",
    FinanceIngestionSource.BANK_STATEMENT_CSV: "relevé bancaire CSV",
    FinanceIngestionSource.BANK_STATEMENT_OFX: "relevé bancaire OFX",
    FinanceIngestionSource.INVOICE_OCR: "facture OCR",
}
BANK_SOURCES = frozenset({FinanceIngestionSource.BANK_STATEMENT_CSV, FinanceIngestionSource.BANK_STATEMENT_OFX})
WARNING_OCR = (
    "Facture issue d’OCR : vérifier le fournisseur, les lignes, la catégorie et le taux de TVA avant usage comptable. "
    "La TVA déductible est fixée à 0 tant qu’elle n’est pas explicitement confirmée.",
)
WARNING_BANK = (
    "Le relevé crée uniquement des mouvements de trésorerie. Aucun débit/crédit bancaire n’est converti en vente, achat, HT ou TVA.",
    "N’importez pas une même période dans deux formats (CSV et OFX) : les doublons entre formats ne sont pas détectables.",
)


TARGET_MODELS = {"revenue": TransactionRevenue, "expense": PurchaseExpense, "cash_movement": CashMovement}
ID_CHUNK = 500
MAX_BATCH_LIST = 100


class IngestionBatchNotFoundError(LookupError):
    """Lot d'import inexistant pour cette entreprise."""


def _count(value: int, singular: str, plural: str) -> str:
    return f"{value} {singular if value == 1 else plural}"


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _warnings(batch: FinanceIngestionBatch) -> list[str]:
    static = WARNING_OCR if batch.source == FinanceIngestionSource.INVOICE_OCR else (
        WARNING_BANK if batch.source in BANK_SOURCES else ()
    )
    return [*(batch.review_warnings or ()), *static]


def _result(batch: FinanceIngestionBatch, *, replayed: bool) -> FinanceIngestionResult:
    warnings = _warnings(batch)
    return FinanceIngestionResult(
        batch_id=batch.id,
        company_id=batch.company_id,
        source=batch.source,
        record_count=batch.record_count,
        duplicate_count=batch.duplicate_count or 0,
        payload_sha256=batch.payload_sha256,
        replayed=replayed,
        review_required=bool(warnings),
        notes=list(batch.notes or ()),
        warnings=warnings,
    )


def _known_source_ids(
    session: Session, company_id: str, source: FinanceIngestionSource, keys: list[str],
) -> set[str]:
    known: set[str] = set()
    for start in range(0, len(keys), ID_CHUNK):
        known.update(session.scalars(select(FinanceIngestionItem.source_transaction_id).where(
            FinanceIngestionItem.company_id == company_id,
            FinanceIngestionItem.source == source,
            FinanceIngestionItem.source_transaction_id.in_(keys[start:start + ID_CHUNK]),
        )))
    return known


def _existing_batch(
    session: Session, company_id: str, source: FinanceIngestionSource, idempotency_key: str,
) -> FinanceIngestionBatch | None:
    return session.scalar(select(FinanceIngestionBatch).where(
        FinanceIngestionBatch.company_id == company_id,
        FinanceIngestionBatch.source == source,
        FinanceIngestionBatch.idempotency_key == idempotency_key,
    ))


def _target(record: StandardizedTransaction) -> tuple[type, str]:
    for model, kind, schema in (
        (TransactionRevenue, "revenue", TransactionRevenueIn),
        (PurchaseExpense, "expense", PurchaseExpenseIn),
        (CashMovement, "cash_movement", CashMovementIn),
    ):
        if isinstance(record, schema):
            return model, kind
    raise ConnectorValidationError("Type de transaction standardisée inconnu.")


def _check_same_key(batch: FinanceIngestionBatch, payload_sha256: str) -> FinanceIngestionResult:
    if batch.payload_sha256 != payload_sha256:
        raise IngestionConflictError("La clé d’idempotence existe déjà pour un contenu différent.")
    return _result(batch, replayed=True)


def ingest_payload(
    session: Session,
    *,
    company_id: str,
    source: FinanceIngestionSource,
    raw_data: bytes,
    idempotency_key: str | None = None,
    actor: str | None = None,
) -> FinanceIngestionResult:
    if not raw_data or len(raw_data) > 5 * 1024 * 1024:
        raise ConnectorValidationError("Charge utile vide ou supérieure à 5 Mio.")
    payload_sha256 = hashlib.sha256(raw_data).hexdigest()
    connector: BaseDataConnector
    records: list[StandardizedTransaction]
    key = ""
    try:
        with session.begin():
            company = session.get(CompanyProfile, company_id)
            if company is None:
                raise ConnectorValidationError("Profil financier de l’entreprise introuvable.")
            connector = connector_factory(source, company_id, company.currency)
            records = connector.parse_payload(raw_data)
            if not records or len(records) > 5_000:
                raise ConnectorValidationError("Nombre de transactions absent ou supérieur à 5 000.")
            if not connector.validate_checksum_and_totals(records):
                raise ConnectorValidationError("Le checksum ou les totaux de la source ne concordent pas.")
            keys = [record.source_transaction_id for record in records]
            if any(not value for value in keys) or len(set(keys)) != len(keys):
                raise ConnectorValidationError("Chaque ligne doit avoir une référence source unique.")
            key = idempotency_key or connector.idempotency_key or payload_sha256
            if not IDEMPOTENCY_KEY.fullmatch(key):
                raise ConnectorValidationError("Clé d’idempotence invalide.")
            existing = _existing_batch(session, company_id, source, key)
            if existing is not None:
                return _check_same_key(existing, payload_sha256)
            duplicates = 0
            if source in BANK_SOURCES:
                # Des exports bancaires successifs se chevauchent : les lignes déjà importées (même identité stable) sont ignorées.
                known = _known_source_ids(session, company_id, source, keys)
                records = [record for record in records if record.source_transaction_id not in known]
                duplicates = len(keys) - len(records)
                if not records:
                    raise IngestionConflictError(
                        "L’écriture de ce relevé a déjà été importée ; aucune nouvelle écriture." if duplicates == 1
                        else f"Les {duplicates} écritures de ce relevé ont déjà été importées ; aucune nouvelle écriture."
                    )
            notes = list(connector.import_notes)
            if duplicates:
                notes.append(
                    f"{_count(duplicates, 'écriture déjà importée ignorée', 'écritures déjà importées ignorées')} ; "
                    f"{_count(len(records), 'nouvelle écriture enregistrée', 'nouvelles écritures enregistrées')}."
                )

            batch = FinanceIngestionBatch(
                id=str(uuid.uuid4()),
                company_id=company_id,
                source=source,
                idempotency_key=key,
                payload_sha256=payload_sha256,
                record_count=len(records),
                duplicate_count=duplicates,
                notes=notes,
                review_warnings=list(connector.import_warnings),
                created_at=datetime.now(timezone.utc),
            )
            session.add(batch)
            session.flush()
            targets: list[tuple[FinanceIngestionBatch, str, int, str]] = []
            for record in records:
                model, kind = _target(record)
                values = record.model_dump(mode="python", exclude={"source_transaction_id"})
                item = model(**values)
                session.add(item)
                session.flush()
                targets.append((batch, kind, item.id, record.source_transaction_id))
            session.add_all([
                FinanceIngestionItem(
                    batch_id=batch.id,
                    company_id=company_id,
                    source=source,
                    source_transaction_id=external_id,
                    target_kind=kind,
                    target_id=target_id,
                )
                for _, kind, target_id, external_id in targets
            ])
            if actor:
                session.add(FinanceAuditEvent(
                    company_id=company_id, actor=actor[:128], action="import", entry_kind=source.value,
                    entry_id=batch.id, summary=(
                        f"Import {SOURCE_LABELS[source]} : {len(records)} écriture(s)"
                        + (f", {duplicates} doublon(s) ignoré(s)" if duplicates else "") + f", lot {batch.id}"
                    ),
                    created_at=batch.created_at,
                ))
            session.flush()
            result = _result(batch, replayed=False)
        return result
    except IntegrityError as error:
        session.rollback()
        existing = _existing_batch(session, company_id, source, key) if key else None
        if existing is not None:
            return _check_same_key(existing, payload_sha256)
        logger.info("[FINANCE] Import refusé : transaction source déjà importée", exc_info=error)
        raise IngestionConflictError(
            "Une transaction source a déjà été importée ; aucun enregistrement de ce lot n’a été conservé."
        ) from error


def list_batches(session: Session, company_id: str, limit: int = MAX_BATCH_LIST) -> FinanceIngestionLog:
    """Imports les plus récents d'abord, avec le nombre d'écritures encore liées à chaque lot."""
    batches = session.scalars(select(FinanceIngestionBatch).where(
        FinanceIngestionBatch.company_id == company_id,
    ).order_by(FinanceIngestionBatch.created_at.desc(), FinanceIngestionBatch.id.desc()).limit(limit + 1)).all()
    truncated, batches = len(batches) > limit, batches[:limit]
    remaining: dict[str, int] = {}
    if batches:
        remaining = {batch_id: count for batch_id, count in session.execute(
            select(FinanceIngestionItem.batch_id, func.count()).where(
                FinanceIngestionItem.company_id == company_id,
                FinanceIngestionItem.batch_id.in_([batch.id for batch in batches]),
            ).group_by(FinanceIngestionItem.batch_id),
        ).all()}
    return FinanceIngestionLog(truncated=truncated, batches=[
        FinanceIngestionBatchView(
            batch_id=batch.id, source=batch.source, created_at=_utc(batch.created_at),
            record_count=batch.record_count, duplicate_count=batch.duplicate_count or 0,
            remaining_count=remaining.get(batch.id, 0), notes=list(batch.notes or ()), warnings=_warnings(batch),
        )
        for batch in batches
    ])


def revert_batch(session: Session, company_id: str, batch_id: str, actor: str) -> int:
    """Supprime atomiquement les écritures encore liées à un import, ses liens et le lot ; renvoie le nombre d'écritures supprimées."""
    with session.begin():
        batch = session.scalar(select(FinanceIngestionBatch).where(
            FinanceIngestionBatch.id == batch_id, FinanceIngestionBatch.company_id == company_id,
        ))
        if batch is None:
            raise IngestionBatchNotFoundError("Import introuvable pour cette entreprise.")
        targets: dict[str, list[int]] = {}
        for kind, target_id in session.execute(select(FinanceIngestionItem.target_kind, FinanceIngestionItem.target_id).where(
            FinanceIngestionItem.company_id == company_id, FinanceIngestionItem.batch_id == batch.id,
        )).all():
            targets.setdefault(kind, []).append(target_id)
        removed = 0
        for kind, ids in targets.items():
            model = TARGET_MODELS[kind]
            for start in range(0, len(ids), ID_CHUNK):
                removed += session.execute(
                    delete(model).where(model.company_id == company_id, model.id.in_(ids[start:start + ID_CHUNK])),
                    execution_options={"synchronize_session": False},
                ).rowcount
        session.execute(
            delete(FinanceIngestionItem).where(
                FinanceIngestionItem.company_id == company_id, FinanceIngestionItem.batch_id == batch.id,
            ),
            execution_options={"synchronize_session": False},
        )
        session.delete(batch)
        session.add(FinanceAuditEvent(
            company_id=company_id, actor=actor[:128], action="revert", entry_kind=batch.source.value,
            entry_id=batch.id, created_at=datetime.now(timezone.utc),
            summary=f"Annulation de l’import {SOURCE_LABELS[batch.source]} : {removed} écriture(s) supprimée(s), lot {batch.id}",
        ))
    return removed

import hashlib
import hmac
import json
import time
from decimal import Decimal as D
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import URL, select
from sqlalchemy.orm import Session

from finance_connectors import (
    BankStatementCSVAdapter, ConnectorValidationError, IngestionConflictError, InvoiceOCRAdapter,
    InvoiceOCRPayload, POSWebhookAdapter, POSWebhookPayload, _canonical_json,
)
from finance_database import create_finance_engine, get_db
from ingestion_service import ingest_payload
from models.finance import (
    CashMovement, CompanyProfile, FinanceAuditEvent, FinanceIngestionBatch, FinanceIngestionItem,
    PurchaseExpense, TransactionRevenue,
)
from routers.finance import make_company_finance_router
from schemas.finance import CashMovementIn, CompanyProfileIn, FinanceIngestionSource, SectorEnum


def _pos_payload(event_id="event-1", transaction_id="ticket-1"):
    payload = POSWebhookPayload.model_validate({
        "event_id": event_id,
        "currency": "EUR",
        "transactions": [{
            "transaction_id": transaction_id, "date": "2026-03-10",
            "amount_ht": "100.00", "amount_vat": "20.00", "amount_ttc": "120.00",
            "vat_rate": "20", "payment_method": "CARD",
        }],
        "totals": {"amount_ht": "100.00", "amount_vat": "20.00", "amount_ttc": "120.00"},
        "checksum": "0" * 64,
    })
    canonical = payload.model_dump(mode="json", exclude={"checksum"})
    return canonical | {"checksum": hashlib.sha256(_canonical_json(canonical)).hexdigest()}


def _ocr_payload(*, checksum=True):
    payload = InvoiceOCRPayload.model_validate({
        "invoice_id": "invoice-1",
        "supplier": "Fournisseur",
        "date": "2026-03-10",
        "currency": "EUR",
        "lines": [{
            "line_id": "line-1", "amount_ht": "50.00", "amount_vat": "10.00",
            "category": "MATIERE_PREMIERE",
        }],
        "totals": {"amount_ht": "50.00", "amount_vat": "10.00", "amount_ttc": "60.00"},
    })
    canonical = payload.model_dump(mode="json", exclude={"checksum"})
    if checksum:
        canonical["checksum"] = hashlib.sha256(_canonical_json(canonical)).hexdigest()
    return canonical


def _raw(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


@pytest.fixture
def engine(tmp_path):
    engine = create_finance_engine(URL.create("sqlite", database=str(tmp_path / "finance.sqlite3")))
    with Session(engine) as session:
        session.add(CompanyProfile(**CompanyProfileIn(
            id="a", name="Entreprise test", sector=SectorEnum.SERVICES,
        ).model_dump()))
        session.commit()
    yield engine
    engine.dispose()


@pytest.fixture
def api(engine):
    database = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(
        side_effect=lambda query: (
            {"role": "manager"} if query == {"user_id": "u1", "company_id": "a"} else None
        ),
    )))

    async def require_user(request, _database):
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
        yield client


def test_pos_checksum_totals_and_bounded_external_ids():
    payload = _pos_payload(event_id="x" * 160, transaction_id="y" * 160)
    adapter = POSWebhookAdapter("a", "EUR")
    records = adapter.parse_payload(_raw(payload))
    assert adapter.validate_checksum_and_totals(records)
    assert adapter.idempotency_key == "pos-" + hashlib.sha256(("x" * 160).encode()).hexdigest()
    assert len(records[0].source_transaction_id) <= 160
    assert records[0].amount_ht == D("100.00")
    altered = records[0].model_copy(update={"amount_ht": D("101.00")})
    assert not adapter.validate_checksum_and_totals([altered])

    payload["checksum"] = "0" * 64
    with pytest.raises(ConnectorValidationError, match="Checksum POS invalide"):
        POSWebhookAdapter("a", "EUR").parse_payload(_raw(payload))


def test_csv_bom_french_amounts_and_cash_only_semantics():
    csv_data = (
        "\ufeffDate;Libellé;Débit;Crédit;Référence;Devise\r\n"
        "2026-03-10;Fournisseur;1\u202f234,50;;INV-1;EUR\r\n"
        "2026-03-11;Client;;2.000,00;PAY-1;EUR\r\n"
    ).encode("utf-8")
    adapter = BankStatementCSVAdapter("a", "EUR")
    records = adapter.parse_payload(csv_data)
    assert adapter.validate_checksum_and_totals(records)
    assert [row.amount for row in records] == [D("-1234.50"), D("2000.00")]
    assert all(isinstance(row, CashMovementIn) for row in records)


@pytest.mark.parametrize("csv_data", [
    b"Date;Libelle;Debit;Credit\n2026-02-30;A;1,00;\n",
    b'Date;Libelle;Debit;Credit\n2026-03-10;"ligne non fermee;1,00;\n',
])
def test_csv_date_and_syntax_errors_are_explicit(csv_data):
    with pytest.raises(ConnectorValidationError):
        BankStatementCSVAdapter("a", "EUR").parse_payload(csv_data)


def test_invoice_ocr_canonical_checksum_and_optional_checksum():
    for payload in (_ocr_payload(), _ocr_payload(checksum=False)):
        adapter = InvoiceOCRAdapter("a", "EUR")
        records = adapter.parse_payload(_raw(payload))
        assert adapter.validate_checksum_and_totals(records)
        assert adapter.idempotency_key == "ocr-" + hashlib.sha256(b"invoice-1").hexdigest()
        assert records[0].deductible_vat == D("0")
        assert len(records[0].source_transaction_id) <= 160

    invalid = _ocr_payload()
    invalid["checksum"] = "f" * 64
    with pytest.raises(ConnectorValidationError, match="Checksum de facture invalide"):
        InvoiceOCRAdapter("a", "EUR").parse_payload(_raw(invalid))

    mismatch = _ocr_payload()
    mismatch["totals"] = {"amount_ht": "60.00", "amount_vat": "10.00", "amount_ttc": "70.00"}
    canonical = {key: value for key, value in mismatch.items() if key != "checksum"}
    mismatch["checksum"] = hashlib.sha256(_canonical_json(canonical)).hexdigest()
    adapter = InvoiceOCRAdapter("a", "EUR")
    records = adapter.parse_payload(_raw(mismatch))
    assert not adapter.validate_checksum_and_totals(records)


def test_json_duplicate_keys_and_invalid_calendar_dates_are_rejected():
    with pytest.raises(ConnectorValidationError, match="JSON UTF-8 invalide"):
        POSWebhookAdapter("a", "EUR").parse_payload(b'{"event_id":"a","event_id":"b"}')

    payload = _pos_payload()
    payload["transactions"][0]["date"] = "2026-02-30"
    payload["checksum"] = hashlib.sha256(
        _canonical_json({key: value for key, value in payload.items() if key != "checksum"})
    ).hexdigest()
    with pytest.raises(ConnectorValidationError, match="Champs absents ou invalides"):
        POSWebhookAdapter("a", "EUR").parse_payload(_raw(payload))


def test_ingestion_is_atomic_idempotent_and_conflict_safe(engine):
    raw = _raw(_pos_payload())
    with Session(engine) as session:
        first = ingest_payload(
            session, company_id="a", source=FinanceIngestionSource.POS_WEBHOOK,
            raw_data=raw, idempotency_key="manual-key",
        )
        replay = ingest_payload(
            session, company_id="a", source=FinanceIngestionSource.POS_WEBHOOK,
            raw_data=raw, idempotency_key="manual-key",
        )
        assert first.record_count == 1 and not first.replayed
        assert replay.replayed and replay.batch_id == first.batch_id

        with pytest.raises(ValueError, match="idempotence"):
            ingest_payload(
                session, company_id="a", source=FinanceIngestionSource.POS_WEBHOOK,
                raw_data=_raw(_pos_payload(event_id="event-2")),
                idempotency_key="manual-key",
            )
        with pytest.raises(IngestionConflictError, match="transaction source"):
            ingest_payload(
                session, company_id="a", source=FinanceIngestionSource.POS_WEBHOOK,
                raw_data=raw,
            )

        assert len(session.scalars(select(TransactionRevenue)).all()) == 1
        assert len(session.scalars(select(FinanceIngestionBatch)).all()) == 1
        assert len(session.scalars(select(FinanceIngestionItem)).all()) == 1


def test_ingestion_api_authorizes_replays_and_conflicts(api, engine):
    raw = _raw(_pos_payload())
    url = "/api/finance/a/ingestions/pos_webhook"
    assert api.post(url, content=raw, headers={"Content-Type": "application/json"}).status_code == 401
    headers = {
        "x-test-user": "u1", "Content-Type": "application/json",
        "Idempotency-Key": "api-key",
    }
    assert api.post(url, content=raw, headers=headers).status_code == 200
    replay = api.post(url, content=raw, headers=headers)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    conflict = api.post(
        url, content=_raw(_pos_payload(event_id="different-event")),
        headers=headers,
    )
    assert conflict.status_code == 409
    with Session(engine) as session:
        assert len(session.scalars(select(TransactionRevenue)).all()) == 1
        events = session.scalars(select(FinanceAuditEvent)).all()
        assert [(event.action, event.actor, event.entry_kind) for event in events] == [("import", "u1", "pos_webhook")]
        assert events[0].entry_id == session.scalars(select(FinanceIngestionBatch)).one().id


def test_ingestion_persists_bank_movements_and_reviewable_ocr_expenses(engine):
    statement = b"Date;Libelle;Debit;Credit\n2026-03-10;Fournisseur;60,00;\n"
    invoice = _raw(_ocr_payload())
    with Session(engine) as session:
        bank_result = ingest_payload(
            session, company_id="a", source=FinanceIngestionSource.BANK_STATEMENT_CSV,
            raw_data=statement,
        )
        ocr_result = ingest_payload(
            session, company_id="a", source=FinanceIngestionSource.INVOICE_OCR,
            raw_data=invoice,
        )
        assert bank_result.review_required and ocr_result.review_required
        assert bank_result.warnings and ocr_result.warnings
        assert len(session.scalars(select(CashMovement)).all()) == 1
        assert len(session.scalars(select(PurchaseExpense)).all()) == 1
        assert not session.scalars(select(TransactionRevenue)).all()
        expense = session.scalars(select(PurchaseExpense)).one()
        assert expense.amount_ttc == D("60.00")
        assert expense.deductible_vat == D("0")
        assert session.scalars(select(FinanceAuditEvent)).all() == []


def test_signed_pos_webhook_checks_hmac_and_time_window(api, engine, monkeypatch):
    company_hash = hashlib.sha256(b"a").hexdigest()[:20].upper()
    secret_name = f"SIRIUS_FINANCE_POS_SECRET_{company_hash}"
    secret = "s" * 32
    monkeypatch.setenv(secret_name, secret)
    raw = _raw(_pos_payload(event_id="webhook-event"))
    url = "/api/finance/a/webhooks/pos"

    timestamp = str(int(time.time()))
    signature = hmac.new(
        secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256,
    ).hexdigest()
    headers = {
        "Content-Type": "application/json",
        "X-Sirius-Timestamp": timestamp,
        "X-Sirius-Signature": f"sha256={signature}",
    }
    invalid = headers | {"X-Sirius-Signature": "sha256=" + "0" * 64}
    assert api.post(url, content=raw, headers=invalid).status_code == 401
    stale = headers | {"X-Sirius-Timestamp": str(int(time.time()) - 301)}
    assert api.post(url, content=raw, headers=stale).status_code == 401
    accepted = api.post(url, content=raw, headers=headers)
    assert accepted.status_code == 200
    assert accepted.json()["source"] == "pos_webhook"
    replay = api.post(url, content=raw, headers=headers)
    assert replay.status_code == 200 and replay.json()["replayed"] is True
    with Session(engine) as session:
        assert len(session.scalars(select(TransactionRevenue)).all()) == 1
        assert [event.actor for event in session.scalars(select(FinanceAuditEvent))] == ["pos_webhook"]
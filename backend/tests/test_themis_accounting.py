import asyncio
from datetime import datetime
from unittest.mock import AsyncMock

import pymupdf
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth_api
from local_docstore import LocalDocStore
from themis_api import Line, _tax_summary, make_themis_router
from themis_pdf import build_doc_pdf


def _client(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "themis.db")
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value={"user_id": "test-user"}))
    app = FastAPI()
    app.include_router(make_themis_router(db), prefix="/api")
    return TestClient(app), db


def test_tax_calculation_uses_decimal_rounding_and_line_rates():
    ht, vat, ttc, breakdown = _tax_summary([
        Line(label="Taux réduit", qty=1, unit_price=100, vat_rate=5.5),
        Line(label="Taux normal", qty=1, unit_price=100, vat_rate=20),
    ], default_rate=10)
    assert (ht, vat, ttc) == (200.0, 25.5, 225.5)
    assert breakdown == [
        {"rate": 5.5, "base_ht": 100.0, "tva": 5.5},
        {"rate": 20.0, "base_ht": 100.0, "tva": 20.0},
    ]

    ht, vat, ttc, _ = _tax_summary([Line(label="Arrondi", qty=1, unit_price=0.01)], 20)
    assert (ht, vat, ttc) == (0.01, 0.0, 0.01)


def test_pdf_keeps_all_invoice_lines_and_uses_issue_date():
    invoice = {
        "kind": "facture",
        "number": "FAC-2026-0001",
        "issued_at": "2026-03-12T10:00:00+00:00",
        "created_at": "2026-03-10T08:00:00+00:00",
        "status": "envoyé",
        "client_name": "Client test",
        "lines": [{"label": f"Ligne {index}", "qty": 1, "unit_price": 1} for index in range(45)],
        "total_ht": 45,
        "tva": 20,
        "tva_amount": 9,
        "total_ttc": 54,
        "vat_breakdown": [{"rate": 20, "base_ht": 45, "tva": 9}],
    }
    pdf = pymupdf.open(stream=build_doc_pdf(invoice), filetype="pdf")
    text = "\n".join(page.get_text() for page in pdf)
    assert len(pdf) >= 2
    assert "Ligne 44" in text
    assert "2026-03-12" in text


def test_invoice_numbering_immutability_payments_and_tva_lifecycle(tmp_path, monkeypatch):
    client, _db = _client(tmp_path, monkeypatch)
    year = datetime.now().year
    invoice = client.post("/api/themis/docs", json={
        "kind": "facture",
        "client_name": "Client test",
        "lines": [
            {"label": "Taux réduit", "qty": 1, "unit_price": 100, "vat_rate": 5.5},
            {"label": "Taux normal", "qty": 1, "unit_price": 100, "vat_rate": 20},
        ],
        "tva": 10,
    })
    assert invoice.status_code == 200
    draft = invoice.json()["doc"]
    assert "number" not in draft
    assert (draft["total_ht"], draft["tva_amount"], draft["total_ttc"]) == (200, 25.5, 225.5)

    before_issue = client.get(
        f"/api/themis/tva?from_date={year}-01-01&to_date={year}-12-31"
    ).json()
    assert before_issue["ca_ht"] == 0
    issued = client.put(
        f"/api/themis/docs/{draft['id']}/status", json={"status": "envoyé"},
    ).json()["doc"]
    assert issued["number"].startswith(f"FAC-{year}-")
    assert issued["issued_at"]
    retry = client.put(
        f"/api/themis/docs/{draft['id']}/status", json={"status": "envoyé"},
    ).json()["doc"]
    assert retry["number"] == issued["number"]
    assert client.get(
        f"/api/themis/tva?from_date={year}-01-01&to_date={year}-12-31"
    ).json()["ca_ht"] == 200

    assert client.delete(f"/api/themis/docs/{draft['id']}").status_code == 409
    assert client.put(
        f"/api/themis/docs/{draft['id']}/status", json={"status": "payé"},
    ).status_code == 409
    assert client.post("/api/themis/payments", json={
        "doc_id": draft["id"], "amount": 225.51, "method": "test",
    }).status_code == 409
    payment = client.post("/api/themis/payments", json={
        "doc_id": draft["id"], "amount": 225.5, "method": "test",
    })
    assert payment.status_code == 200
    assert client.delete(f"/api/themis/docs/{draft['id']}").status_code == 409


def test_quote_conversion_is_idempotent(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    quote = client.post("/api/themis/docs", json={
        "kind": "devis", "client_name": "Client test",
        "lines": [{"label": "Prestation", "qty": 1, "unit_price": 100}], "tva": 20,
    }).json()["doc"]
    assert client.put(
        f"/api/themis/docs/{quote['id']}/status", json={"status": "envoyé"},
    ).status_code == 200
    first = client.post(f"/api/themis/docs/{quote['id']}/convert").json()["doc"]
    second = client.post(f"/api/themis/docs/{quote['id']}/convert").json()["doc"]
    assert first["id"] == second["id"]
    assert first["number"] == second["number"]
    assert asyncio.run(db.themis_docs.count_documents({
        "user_id": "test-user", "kind": "facture", "source_devis": quote["number"],
    })) == 1

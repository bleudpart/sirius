import asyncio
import io
import os
import runpy
import zipfile
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock

import pymupdf
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth_api
import runtime_paths
import themis_api
from local_docstore import LocalDocStore
from themis_api import Line, _tax_summary, make_themis_router
from themis_pdf import build_doc_pdf


def _client(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "themis.db")
    monkeypatch.setattr(auth_api, "require_user", AsyncMock(return_value={"user_id": "test-user"}))
    app = FastAPI()
    app.include_router(make_themis_router(db), prefix="/api")
    return TestClient(app), db


@pytest.mark.parametrize("configured", [False, True])
def test_files_directory_uses_runtime_root_without_writing_to_installation(
    tmp_path, monkeypatch, configured,
):
    backend_dir = Path(themis_api.__file__).resolve().parent
    source_dir = tmp_path / "source"
    monkeypatch.setattr(runtime_paths, "SOURCE_DIR", source_dir)
    if configured:
        root = tmp_path / "user-data"
        monkeypatch.setenv("SIRIUS_DATA_DIR", str(root))
    else:
        root = source_dir
        monkeypatch.delenv("SIRIUS_DATA_DIR", raising=False)
    makedirs = os.makedirs

    def guarded_makedirs(directory, *args, **kwargs):
        if Path(directory).resolve().is_relative_to(backend_dir):
            raise PermissionError("Read-only installation directory")
        return makedirs(directory, *args, **kwargs)

    monkeypatch.setattr(os, "makedirs", guarded_makedirs)
    module = runpy.run_path(str(backend_dir / "themis_api.py"))

    assert module["FILES_DIR"] == str(root / "themis_files")
    assert (root / "themis_files").is_dir()


@pytest.mark.parametrize("legacy", [False, True])
def test_piece_storage_upload_download_export_and_delete(tmp_path, monkeypatch, legacy):
    files_dir = tmp_path / "user-data" / "themis_files"
    files_dir.mkdir(parents=True)
    legacy_dir = tmp_path / "installation" / "themis_files"
    monkeypatch.setattr(themis_api, "FILES_DIR", str(files_dir))
    monkeypatch.setattr(themis_api, "__file__", str(legacy_dir.parent / "themis_api.py"))
    monkeypatch.setattr(themis_api, "extract_piece", AsyncMock(return_value={}))
    client, db = _client(tmp_path, monkeypatch)
    content = b"test attachment"
    if legacy:
        legacy_dir.mkdir(parents=True)
        piece = {"id": "legacy-piece", "user_id": "test-user", "ext": "png", "filename": "piece.png"}
        (legacy_dir / "legacy-piece.png").write_bytes(content)
        asyncio.run(db.themis_pieces.insert_one(dict(piece)))
    else:
        response = client.post(
            "/api/themis/pieces/upload",
            files={"file": ("piece.png", content, "image/png")},
        )
        assert response.status_code == 200
        piece = response.json()["piece"]
        assert not legacy_dir.exists()
    filename = f"{piece['id']}.png"
    stored_path = (legacy_dir if legacy else files_dir) / filename
    assert stored_path.read_bytes() == content

    response = client.get(f"/api/themis/pieces/{piece['id']}/file")
    assert response.status_code == 200
    assert response.content == content
    response = client.get("/api/themis/export")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read(f"pieces/{piece['id']}-piece.png") == content
    if legacy:
        assert not (files_dir / filename).exists()
        assert stored_path.read_bytes() == content

    assert client.delete(f"/api/themis/pieces/{piece['id']}").status_code == 200
    assert not stored_path.exists()


def test_runtime_piece_has_priority_and_explicit_export_directory_is_isolated(tmp_path, monkeypatch):
    files_dir = tmp_path / "user-data" / "themis_files"
    legacy_dir = tmp_path / "installation" / "themis_files"
    files_dir.mkdir(parents=True)
    legacy_dir.mkdir(parents=True)
    monkeypatch.setattr(themis_api, "FILES_DIR", str(files_dir))
    monkeypatch.setattr(themis_api, "__file__", str(legacy_dir.parent / "themis_api.py"))
    piece = {"id": "piece", "ext": "png", "filename": "piece.png"}
    (files_dir / "piece.png").write_bytes(b"runtime")
    (legacy_dir / "piece.png").write_bytes(b"legacy")

    archive_bytes = themis_api.build_accounting_export_zip([], [], [], [], [piece])
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        assert archive.read("pieces/piece-piece.png") == b"runtime"
    archive_bytes = themis_api.build_accounting_export_zip(
        [], [], [], [], [piece], files_dir=tmp_path / "explicit-export",
    )
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        assert not any(name.startswith("pieces/") for name in archive.namelist())


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

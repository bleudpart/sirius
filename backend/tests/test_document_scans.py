import asyncio
import json
from io import BytesIO

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pypdf import PdfReader

import storage
from local_docstore import LocalDocStore
from routes.document_scans import make_document_scans_router


@pytest.fixture
def scan_api(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "scans.db")
    monkeypatch.setattr(storage, "UPLOADS_DIR", tmp_path / "uploads")
    asyncio.run(db.sirius_work_dossiers.insert_one({"id": "d1", "user_id": "one", "title": "Comptabilité"}))

    async def user(request, database):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(status_code=401, detail="Connexion requise.")
        return {"user_id": uid}

    def validate(ext, content_type, data):
        if not data.startswith(b"\xff\xd8\xff"):
            raise HTTPException(status_code=415, detail="Image invalide.")

    app = FastAPI()
    app.include_router(make_document_scans_router(db, user, validate))
    return TestClient(app), db


def post_scan(client, **changes):
    metadata = {"dossier": "Comptabilité", "work_dossier_id": "d1", "kind": "sale", "reviewed": True,
                "accounting": {"supplier": "COMMERCE", "total_ttc": "12.40", "tva": None,
                               "fiscal_identifiers": "SIRET 12345678900012", "ticket_number": "Ticket n° 0042"},
                "presentation": {"template": "professionnel", "seller": "COMMERCE\nAdresse",
                                 "customer": "Client\nAdresse", "description": "Article relu"},
                "draft": "Document relu, non émis."}
    metadata.update(changes)
    return client.post("/api/document-scans", data={"metadata": json.dumps(metadata)},
                       files={"file": ("ticket.jpg", b"\xff\xd8\xffphoto", "image/jpeg")},
                       headers={"x-test-user": "one"})


def test_scan_is_persistent_and_listed_in_the_selected_dossier(scan_api):
    client, db = scan_api
    response = post_scan(client)
    assert response.status_code == 200, response.text
    record = response.json()
    assert record["scan"]["accounting"]["total_ttc"] == "12.40"
    assert record["scan"]["accounting"]["tva"] is None
    assert record["scan"]["invoice_issued"] is False
    assert "storage_path" not in record
    stored = asyncio.run(db.files.find_one({"id": record["id"]}))
    assert storage.get_object(stored["storage_path"])[0] == b"\xff\xd8\xffphoto"
    listing = client.get("/api/document-scans?work_dossier_id=d1", headers={"x-test-user": "one"})
    assert listing.status_code == 200
    assert listing.json()["items"][0]["id"] == record["id"]


def test_pdf_is_a4_and_preserves_fiscal_identifiers_without_inventing_vat(scan_api):
    client, _ = scan_api
    record = post_scan(client).json()
    response = client.get(f"/api/document-scans/{record['id']}/draft.pdf", headers={"x-test-user": "one"})
    assert response.status_code == 200
    reader = PdfReader(BytesIO(response.content))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "BROUILLON" in text and "NON ÉMIS" in text
    assert "12345678900012" in text and "0042" in text
    assert "12,40 EUR" in text
    assert "Non identifié" in text
    assert "Document préparé par" in text
    assert "danielsirius.pro2026@gmail.com" in text
    assert reader.pages[0].images
    assert float(reader.pages[0].mediabox.width) == pytest.approx(595.276, abs=0.01)
    assert float(reader.pages[0].mediabox.height) == pytest.approx(841.89, abs=0.01)


def test_other_users_cannot_attach_list_or_download_private_scans(scan_api):
    client, _ = scan_api
    record = post_scan(client).json()
    assert client.get("/api/document-scans?work_dossier_id=d1", headers={"x-test-user": "two"}).status_code == 404
    assert client.get(f"/api/document-scans/{record['id']}/draft.pdf", headers={"x-test-user": "two"}).status_code == 404
    assert post_scan(client, work_dossier_id="foreign").status_code == 404
    assert client.get("/api/document-scans?work_dossier_id=d1").status_code == 401


@pytest.mark.parametrize("changes", [
    {"reviewed": False},
    {"reviewed": "true"},
    {"accounting": {"total_ttc": "-1"}},
    {"accounting": {"total_ttc": "1.123"}},
    {"accounting": {"total_ttc": "1.00", "tva": "2.00"}},
    {"accounting": None},
    {"presentation": {"template": "unknown"}},
])
def test_invalid_or_unreviewed_accounting_is_not_saved(scan_api, changes):
    client, db = scan_api
    assert post_scan(client, **changes).status_code == 422
    assert asyncio.run(db.files.count_documents({})) == 0


def test_long_receipts_paginate_without_losing_lines(scan_api):
    client, _ = scan_api
    record = post_scan(client, presentation={"description": "\n".join(f"Article {n}" for n in range(160)),
                                           "template": "classique"}).json()
    response = client.get(f"/api/document-scans/{record['id']}/draft.pdf", headers={"x-test-user": "one"})
    assert response.status_code == 200
    reader = PdfReader(BytesIO(response.content))
    assert len(reader.pages) > 1
    assert "Article 159" in "\n".join(page.extract_text() for page in reader.pages)
    for page in reader.pages:
        assert "Document préparé par" in page.extract_text()
        assert page.images


def test_pdf_signature_reuses_the_account_email_identity(scan_api):
    client, db = scan_api
    asyncio.run(db.users.insert_one({
        "user_id": "one", "name": "Alice", "email": "alice@example.test",
        "preferences": {"signature_name": "Alice Martin", "signature_email": "commerce@example.test"},
    }))
    record = post_scan(client).json()
    response = client.get(f"/api/document-scans/{record['id']}/draft.pdf", headers={"x-test-user": "one"})
    assert response.status_code == 200
    text = PdfReader(BytesIO(response.content)).pages[0].extract_text()
    assert "Alice Martin" in text
    assert "commerce@example.test" in text
    assert "danielsirius.pro2026@gmail.com" not in text

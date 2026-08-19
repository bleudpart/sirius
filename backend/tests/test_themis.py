"""THÉMIS enterprise API CRUD, accounting, inventory, templates, and MYTHOS tests."""
import io
import os
import re
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

import pytest
import requests
from dotenv import dotenv_values
from reportlab.pdfgen import canvas as pdfcanvas

frontend_env = dotenv_values("/app/frontend/.env")
base_url = os.environ.get("REACT_APP_BACKEND_URL") or frontend_env.get("REACT_APP_BACKEND_URL")
if not base_url:
    raise RuntimeError("REACT_APP_BACKEND_URL is missing")
BASE_URL = base_url.rstrip("/")
API = f"{BASE_URL}/api/themis"
YEAR = datetime.now().year


@pytest.fixture(scope="module")
def api():
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json"})
    yield session
    session.close()


@pytest.fixture(scope="module")
def created():
    return {"clients": [], "items": [], "docs": [], "orders": [], "payments": [], "pieces": []}


@pytest.fixture(scope="module", autouse=True)
def cleanup(api, created):
    yield
    for resource in ("pieces", "payments", "orders", "docs", "items", "clients"):
        for resource_id in reversed(created[resource]):
            api.delete(f"{API}/{resource}/{resource_id}", timeout=20)


def assert_ok(response):
    assert response.status_code == 200, response.text
    data = response.json()
    assert data.get("ok") is True
    return data


def list_resource(api, resource):
    response = api.get(f"{API}/{resource}", timeout=20)
    assert response.status_code == 200, response.text
    data = response.json()
    assert isinstance(data.get(resource), list)
    return data[resource]


def make_test_pdf(label="TEST_piece"):
    """Build a small valid PDF upload fixture in memory."""
    buffer = io.BytesIO()
    canvas = pdfcanvas.Canvas(buffer)
    canvas.drawString(72, 760, label)
    canvas.save()
    return buffer.getvalue()


def upload_piece(api, filename, content, content_type):
    """Upload multipart content without the JSON session Content-Type header."""
    return requests.post(
        f"{API}/pieces/upload",
        files={"file": (filename, content, content_type)},
        data={"groq_key": "gsk_TEST_invalid_key"},
        timeout=90,
    )


# Client required-field validation plus create, list, and delete persistence.
class TestThemisClients:
    def test_client_crud_and_required_name(self, api, created):
        missing = api.post(f"{API}/clients", json={"company": "TEST_missing"}, timeout=20)
        assert missing.status_code == 422, missing.text

        name = f"TEST_Client_{uuid.uuid4().hex[:8]}"
        payload = {
            "name": name,
            "company": "TEST_Justice SARL",
            "email": "qa.themis@example.test",
            "phone": "+33102030405",
            "address": "1 rue des Tests",
            "notes": "TEST_created_by_pytest",
        }
        data = assert_ok(api.post(f"{API}/clients", json=payload, timeout=20))
        client = data.get("client")
        assert isinstance(client, dict)
        assert isinstance(client.get("id"), str) and client["id"]
        created["clients"].append(client["id"])
        for key, value in payload.items():
            assert client.get(key) == value
        assert isinstance(client.get("created_at"), str) and client["created_at"]

        clients = list_resource(api, "clients")
        assert any(c.get("id") == client["id"] and c.get("name") == name for c in clients)

        deleted = assert_ok(api.delete(f"{API}/clients/{client['id']}", timeout=20))
        assert deleted == {"ok": True}
        created["clients"].remove(client["id"])
        assert all(c.get("id") != client["id"] for c in list_resource(api, "clients"))

    def test_blank_client_name_is_rejected(self, api):
        response = api.post(f"{API}/clients", json={"name": "   "}, timeout=20)
        if response.status_code == 200:
            client_id = (response.json().get("client") or {}).get("id")
            if client_id:
                api.delete(f"{API}/clients/{client_id}", timeout=20)
        assert response.status_code == 422, response.text


# Inventory create/list, stock floor, increment, and delete persistence.
class TestThemisInventory:
    def test_item_crud_stock_floor_and_alert_data(self, api, created):
        name = f"TEST_Item_{uuid.uuid4().hex[:8]}"
        payload = {"name": name, "ref": "TEST-REF", "price": 12.5, "stock": 1, "alert": 2}
        item = assert_ok(api.post(f"{API}/items", json=payload, timeout=20))["item"]
        created["items"].append(item["id"])
        assert item["name"] == name
        assert item["price"] == 12.5
        assert item["stock"] == 1
        assert item["alert"] == 2
        assert any(i.get("id") == item["id"] for i in list_resource(api, "items"))

        down = assert_ok(api.put(f"{API}/items/{item['id']}/stock", json={"delta": -10}, timeout=20))
        assert down["stock"] == 0
        persisted = next(i for i in list_resource(api, "items") if i.get("id") == item["id"])
        assert persisted["stock"] == 0

        up = assert_ok(api.put(f"{API}/items/{item['id']}/stock", json={"delta": 1}, timeout=20))
        assert up["stock"] == 1

        assert_ok(api.delete(f"{API}/items/{item['id']}", timeout=20))
        created["items"].remove(item["id"])
        assert all(i.get("id") != item["id"] for i in list_resource(api, "items"))


# Quote totals, status persistence, invoice conversion/filtering, and cleanup contracts.
class TestThemisDocuments:
    def test_quote_totals_status_conversion_and_invoice_filter(self, api, created):
        client_name = f"TEST_Doc_Client_{uuid.uuid4().hex[:6]}"
        client = assert_ok(api.post(f"{API}/clients", json={"name": client_name}, timeout=20))["client"]
        created["clients"].append(client["id"])

        payload = {
            "kind": "devis",
            "client_id": client["id"],
            "client_name": client_name,
            "lines": [
                {"label": "TEST_Service", "qty": 2, "unit_price": 100},
                {"label": "TEST_Option", "qty": 1, "unit_price": 50},
            ],
            "tva": 20,
            "template": "antique",
        }
        quote = assert_ok(api.post(f"{API}/docs", json=payload, timeout=20))["doc"]
        created["docs"].append(quote["id"])
        assert re.fullmatch(rf"DEV-{YEAR}-\d{{4}}", quote["number"])
        assert quote["total_ht"] == 250
        assert quote["tva_amount"] == 50
        assert quote["total_ttc"] == 300
        assert quote["paid"] == 0
        assert quote["status"] == "brouillon"

        listed_quote = next(d for d in list_resource(api, "docs") if d.get("id") == quote["id"])
        assert listed_quote["total_ttc"] == 300

        assert_ok(api.put(f"{API}/docs/{quote['id']}/status", json={"status": "envoyé"}, timeout=20))
        status_quote = next(d for d in list_resource(api, "docs") if d.get("id") == quote["id"])
        assert status_quote["status"] == "envoyé"

        invoice = assert_ok(api.post(f"{API}/docs/{quote['id']}/convert", timeout=20))["doc"]
        created["docs"].append(invoice["id"])
        assert re.fullmatch(rf"FAC-{YEAR}-\d{{4}}", invoice["number"])
        assert invoice["kind"] == "facture"
        assert invoice["source_devis"] == quote["number"]
        assert invoice["total_ht"] == 250
        assert invoice["total_ttc"] == 300
        assert invoice["status"] == "envoyé"

        all_docs = list_resource(api, "docs")
        accepted_quote = next(d for d in all_docs if d.get("id") == quote["id"])
        assert accepted_quote["status"] == "accepté"
        filtered = api.get(f"{API}/docs?kind=facture", timeout=20)
        assert filtered.status_code == 200, filtered.text
        invoices = filtered.json().get("docs")
        assert isinstance(invoices, list) and any(d.get("id") == invoice["id"] for d in invoices)
        assert all(d.get("kind") == "facture" for d in invoices)

        created["primary_quote_id"] = quote["id"]
        created["primary_invoice_id"] = invoice["id"]

    def test_malformed_document_line_is_validation_error_not_server_error(self, api):
        response = api.post(
            f"{API}/docs",
            json={"kind": "devis", "client_name": "TEST_Invalid", "lines": [{"label": "x", "qty": "bad", "unit_price": 1}], "tva": 20},
            timeout=20,
        )
        assert response.status_code == 422, response.text


# Order lifecycle from en_attente to livrée with deletion persistence.
class TestThemisOrders:
    def test_order_create_status_and_delete(self, api, created):
        client_id = created["clients"][0]
        order = assert_ok(api.post(
            f"{API}/orders",
            json={
                "client_id": client_id,
                "client_name": "TEST_Order_Client",
                "lines": [{"label": "TEST_Commande", "qty": 2, "unit_price": 10}],
                "notes": "TEST_order",
            },
            timeout=20,
        ))["order"]
        created["orders"].append(order["id"])
        assert re.fullmatch(rf"CMD-{YEAR}-\d{{4}}", order["number"])
        assert order["status"] == "en_attente"
        assert order["total"] == 24
        assert any(o.get("id") == order["id"] for o in list_resource(api, "orders"))

        assert_ok(api.put(f"{API}/orders/{order['id']}/status", json={"status": "livrée"}, timeout=20))
        persisted = next(o for o in list_resource(api, "orders") if o.get("id") == order["id"])
        assert persisted["status"] == "livrée"

        assert_ok(api.delete(f"{API}/orders/{order['id']}", timeout=20))
        created["orders"].remove(order["id"])
        assert all(o.get("id") != order["id"] for o in list_resource(api, "orders"))


# Payment accumulation updates its invoice and deletion removes the payment record.
class TestThemisPayments:
    def test_payment_marks_invoice_paid_and_delete_persists(self, api, created):
        invoice_id = created["primary_invoice_id"]
        payment = assert_ok(api.post(
            f"{API}/payments",
            json={"doc_id": invoice_id, "amount": 300, "method": "virement", "note": "TEST_full_payment"},
            timeout=20,
        ))["payment"]
        created["payments"].append(payment["id"])
        assert payment["doc_id"] == invoice_id
        assert payment["amount"] == 300
        assert payment["method"] == "virement"
        assert any(p.get("id") == payment["id"] for p in list_resource(api, "payments"))

        invoice = next(d for d in list_resource(api, "docs") if d.get("id") == invoice_id)
        assert invoice["paid"] == 300
        assert invoice["status"] == "payé"

        assert_ok(api.delete(f"{API}/payments/{payment['id']}", timeout=20))
        created["payments"].remove(payment["id"])
        assert all(p.get("id") != payment["id"] for p in list_resource(api, "payments"))
        invoice_after_delete = next(d for d in list_resource(api, "docs") if d.get("id") == invoice_id)
        assert invoice_after_delete["paid"] == 0
        assert invoice_after_delete["status"] == "envoyé"

    @pytest.mark.parametrize("amount", [0, -1, -5.25])
    def test_payment_rejects_non_positive_amount(self, api, created, amount):
        response = api.post(
            f"{API}/payments",
            json={"doc_id": created["primary_invoice_id"], "amount": amount, "method": "virement"},
            timeout=20,
        )
        assert response.status_code == 422, response.text
        detail = response.json().get("detail")
        assert isinstance(detail, list) and detail

    def test_payment_rejects_quote_document(self, api, created):
        response = api.post(
            f"{API}/payments",
            json={"doc_id": created["primary_quote_id"], "amount": 1, "method": "carte", "note": "TEST_invalid_quote_payment"},
            timeout=20,
        )
        if response.status_code == 200:
            payment = response.json().get("payment") or {}
            if payment.get("id"):
                created["payments"].append(payment["id"])
        assert response.status_code in {400, 404, 422}, response.text




# Professional PDF generation for quotes/invoices, including not-found behavior.
class TestThemisDocumentPdf:
    @pytest.mark.parametrize("id_key,number_prefix", [
        ("primary_quote_id", "DEV-"),
        ("primary_invoice_id", "FAC-"),
    ])
    def test_document_pdf_is_valid(self, api, created, id_key, number_prefix):
        response = api.get(
            f"{API}/docs/{created[id_key]}/pdf",
            params={"emetteur": "TEST Émetteur QA"},
            timeout=30,
        )
        assert response.status_code == 200, response.text[:300]
        assert response.headers.get("content-type", "").startswith("application/pdf")
        assert response.content.startswith(b"%PDF")
        assert len(response.content) > 1_000
        disposition = response.headers.get("content-disposition", "")
        assert "inline" in disposition and number_prefix in disposition

    def test_document_pdf_unknown_id_returns_404(self, api):
        response = api.get(f"{API}/docs/TEST_unknown/pdf", timeout=20)
        assert response.status_code == 404, response.text
        assert "introuvable" in response.json().get("detail", "").lower()


# Accounting-piece upload formats, graceful AI failure, edit/file/delete, and size validation.
class TestThemisPieces:
    def test_upload_all_formats_and_piece_lifecycle(self, api, created):
        pdf_bytes = make_test_pdf()
        samples = [
            ("TEST_facture.pdf", pdf_bytes, "application/pdf"),
            ("TEST_scan.png", b"\x89PNG\r\n\x1a\nTEST", "image/png"),
            ("TEST_scan.jpg", b"\xff\xd8\xffTEST\xff\xd9", "image/jpeg"),
            ("TEST_scan.webp", b"RIFF\x08\x00\x00\x00WEBPTEST", "image/webp"),
        ]
        uploaded = []
        for filename, content, content_type in samples:
            response = upload_piece(api, filename, content, content_type)
            data = assert_ok(response)
            piece = data.get("piece")
            assert isinstance(piece, dict)
            assert isinstance(piece.get("id"), str) and piece["id"]
            assert piece["filename"] == filename
            assert piece["size"] == len(content)
            assert piece["status"] == "à_payer"
            assert isinstance(piece.get("note"), str) and piece["note"].strip()
            assert "impossible" in piece["note"].lower()
            created["pieces"].append(piece["id"])
            uploaded.append((piece, content, content_type))

        listed = list_resource(api, "pieces")
        assert all(any(row.get("id") == piece["id"] for row in listed) for piece, _, _ in uploaded)

        target, original, content_type = uploaded[0]
        edited = assert_ok(api.put(
            f"{API}/pieces/{target['id']}",
            json={"status": "payé", "fournisseur": "TEST_Fournisseur", "total_ttc": 42.5},
            timeout=20,
        ))
        assert edited == {"ok": True}
        persisted = next(p for p in list_resource(api, "pieces") if p.get("id") == target["id"])
        assert persisted["status"] == "payé"
        assert persisted["fournisseur"] == "TEST_Fournisseur"
        assert persisted["total_ttc"] == 42.5

        invalid_status = api.put(
            f"{API}/pieces/{target['id']}", json={"status": "invalide"}, timeout=20,
        )
        assert invalid_status.status_code == 422, invalid_status.text

        file_response = api.get(f"{API}/pieces/{target['id']}/file", timeout=20)
        assert file_response.status_code == 200, file_response.text[:300]
        assert file_response.headers.get("content-type", "").startswith(content_type)
        assert file_response.content == original
        assert file_response.headers.get("x-content-type-options") == "nosniff"

        assert_ok(api.delete(f"{API}/pieces/{target['id']}", timeout=20))
        created["pieces"].remove(target["id"])
        assert all(p.get("id") != target["id"] for p in list_resource(api, "pieces"))
        assert api.get(f"{API}/pieces/{target['id']}/file", timeout=20).status_code == 404

    def test_upload_rejects_extension_and_oversize(self):
        wrong = upload_piece(requests, "TEST_malware.exe", b"not allowed", "application/octet-stream")
        assert wrong.status_code == 400, wrong.text
        assert "format" in wrong.json().get("detail", "").lower()

        too_large = upload_piece(
            requests,
            "TEST_too_large.pdf",
            b"%PDF" + (b"0" * (15 * 1024 * 1024)),
            "application/pdf",
        )
        assert too_large.status_code == 413, too_large.text
        assert "15" in too_large.json().get("detail", "")


# Financial balance deltas, due-date sorting, supplier liabilities, and French speech.
class TestThemisBilan:
    def test_bilan_financier_and_echeances(self, api, created):
        before_response = api.get(f"{API}/bilan", timeout=20)
        assert before_response.status_code == 200, before_response.text
        before = before_response.json()
        today = datetime.now(timezone.utc).date()
        unique = uuid.uuid4().hex[:8]
        expected = []
        for day_delta, price in [(-2, 100), (5, 200)]:
            due_date = (today + timedelta(days=day_delta)).isoformat()
            invoice = assert_ok(api.post(
                f"{API}/docs",
                json={
                    "kind": "facture",
                    "client_name": f"TEST_Bilan_{unique}",
                    "lines": [{"label": "TEST_Bilan", "qty": 1, "unit_price": price}],
                    "tva": 20,
                    "due_date": due_date,
                },
                timeout=20,
            ))["doc"]
            created["docs"].append(invoice["id"])
            expected.append((invoice, day_delta, due_date))

        piece_response = upload_piece(api, "TEST_bilan_piece.pdf", make_test_pdf("TEST bilan"), "application/pdf")
        piece = assert_ok(piece_response)["piece"]
        created["pieces"].append(piece["id"])
        assert_ok(api.put(
            f"{API}/pieces/{piece['id']}",
            json={"total_ttc": 42.5, "fournisseur": "TEST_Bilan_Fournisseur"},
            timeout=20,
        ))

        response = api.get(f"{API}/bilan", timeout=20)
        assert response.status_code == 200, response.text
        data = response.json()
        for field in (
            "encaisse", "a_encaisser", "factures_impayees", "echeances",
            "pieces_a_payer", "total_pieces_a_payer", "speech",
        ):
            assert field in data
        assert data["encaisse"] == before["encaisse"]
        assert data["a_encaisser"] == pytest.approx(before["a_encaisser"] + 360)
        assert data["factures_impayees"] == before["factures_impayees"] + 2
        assert data["pieces_a_payer"] == before["pieces_a_payer"] + 1
        assert data["total_pieces_a_payer"] == pytest.approx(before["total_pieces_a_payer"] + 42.5)
        assert isinstance(data["echeances"], list)
        assert [entry["days"] for entry in data["echeances"]] == sorted(entry["days"] for entry in data["echeances"])
        by_number = {entry["number"]: entry for entry in data["echeances"]}
        for invoice, day_delta, due_date in expected:
            entry = by_number[invoice["number"]]
            assert entry["days"] == day_delta
            assert entry["due_date"] == due_date
            assert entry["client"] == f"TEST_Bilan_{unique}"
            assert entry["restant"] == invoice["total_ttc"]
        speech = data["speech"]
        assert isinstance(speech, str) and speech.startswith("Bilan financier")
        assert "euros" in speech and "encaisser" in speech
        assert "fournisseur" in speech.lower()

# Dashboard aggregates are checked as isolated deltas from pre-existing shared data.
class TestThemisDashboard:
    def test_stats_deltas_stock_alert_and_recent_docs(self, api, created):
        before_response = api.get(f"{API}/stats", timeout=20)
        assert before_response.status_code == 200, before_response.text
        before = before_response.json()

        suffix = uuid.uuid4().hex[:8]
        client = assert_ok(api.post(f"{API}/clients", json={"name": f"TEST_Stats_Client_{suffix}"}, timeout=20))["client"]
        created["clients"].append(client["id"])
        item = assert_ok(api.post(f"{API}/items", json={"name": f"TEST_Alert_Item_{suffix}", "stock": 2, "alert": 2}, timeout=20))["item"]
        created["items"].append(item["id"])
        quote = assert_ok(api.post(f"{API}/docs", json={"kind": "devis", "client_name": client["name"], "lines": [{"label": "TEST_Q", "qty": 1, "unit_price": 10}], "tva": 20}, timeout=20))["doc"]
        created["docs"].append(quote["id"])
        invoice = assert_ok(api.post(f"{API}/docs", json={"kind": "facture", "client_name": client["name"], "lines": [{"label": "TEST_F", "qty": 1, "unit_price": 100}], "tva": 20}, timeout=20))["doc"]
        created["docs"].append(invoice["id"])
        order = assert_ok(api.post(f"{API}/orders", json={"client_name": client["name"], "lines": [{"label": "TEST_O", "qty": 1, "unit_price": 10}]}, timeout=20))["order"]
        created["orders"].append(order["id"])

        after_response = api.get(f"{API}/stats", timeout=20)
        assert after_response.status_code == 200, after_response.text
        after = after_response.json()
        assert after["nb_clients"] == before["nb_clients"] + 1
        assert after["devis_en_cours"] == before["devis_en_cours"] + 1
        assert after["factures_impayees"] == before["factures_impayees"] + 1
        assert after["commandes_actives"] == before["commandes_actives"] + 1
        assert after["a_encaisser"] == pytest.approx(before["a_encaisser"] + 120)
        assert any(i.get("id") == item["id"] and i.get("stock") <= i.get("alert") for i in after["stock_alerts"])
        assert any(d.get("id") in {quote["id"], invoice["id"]} for d in after["derniers_docs"])
        assert isinstance(after.get("by_method"), dict)
        assert isinstance(after.get("encaisse"), (int, float))


# Static document templates and the tenth THÉMIS MYTHOS character/image.
class TestThemisStaticContracts:
    def test_templates_and_mythos_themis(self, api):
        response = api.get(f"{API}/templates", timeout=20)
        assert response.status_code == 200, response.text
        templates = response.json().get("templates")
        assert isinstance(templates, list) and len(templates) == 3
        assert {t.get("id") for t in templates} == {"antique", "moderne", "minimal"}
        assert all(isinstance(t.get("name"), str) and t["name"] for t in templates)
        assert all(re.fullmatch(r"#[0-9a-fA-F]{6}", t.get("accent", "")) for t in templates)

        characters_response = api.get(f"{BASE_URL}/api/mythos/characters", timeout=20)
        assert characters_response.status_code == 200, characters_response.text
        characters = characters_response.json().get("characters")
        assert isinstance(characters, list) and len(characters) == 10
        themis = next(c for c in characters if c.get("module") == "THÉMIS#")
        assert themis["character"] == "Thémis"
        assert themis["role"] == "Gestion d'entreprise"
        assert themis["image"] == "/api/mythos/img/themis.jpg"

        image = api.get(f"{BASE_URL}{themis['image']}", timeout=20)
        assert image.status_code == 200
        assert image.headers.get("content-type", "").startswith("image/jpeg")
        assert image.content.startswith(b"\xff\xd8") and len(image.content) > 1_000


# SMTP validation/error contracts; no real email is sent.
class TestThemisEmailErrors:
    @staticmethod
    def payload(host="smtp.invalide.local", to="qa.themis@example.test"):
        return {
            "to": to,
            "subject": "TEST Facture",
            "message": "Bonjour, ceci est un test.",
            "emetteur": "TEST QA",
            "smtp": {
                "host": host,
                "port": 587,
                "user": "qa@example.test",
                "password": "TEST_password",
                "from_email": "qa@example.test",
                "from_name": "TEST THÉMIS",
            },
        }

    def test_email_rejects_blank_smtp_host_in_french(self, api, created):
        response = api.post(
            f"{API}/docs/{created['primary_invoice_id']}/email",
            json=self.payload(host="   "),
            timeout=20,
        )
        assert response.status_code == 422, response.text
        detail = response.json().get("detail")
        assert isinstance(detail, list) and detail
        assert "Le serveur SMTP est obligatoire" in detail[0].get("msg", "")

    def test_email_rejects_invalid_recipient_in_french(self, api, created):
        response = api.post(
            f"{API}/docs/{created['primary_invoice_id']}/email",
            json=self.payload(to="destinataire-invalide"),
            timeout=20,
        )
        assert response.status_code == 422, response.text
        detail = response.json().get("detail")
        assert isinstance(detail, list) and detail
        assert "Adresse e-mail du destinataire invalide" in detail[0].get("msg", "")

    def test_email_unreachable_smtp_is_french_400_not_502(self, api, created):
        response = api.post(
            f"{API}/docs/{created['primary_invoice_id']}/email",
            json=self.payload(),
            timeout=40,
        )
        assert response.status_code == 400, response.text
        detail = response.json().get("detail", "")
        assert detail.startswith("Serveur SMTP injoignable"), detail

    def test_email_unknown_document_is_404(self, api):
        response = api.post(
            f"{API}/docs/TEST_unknown_document/email",
            json=self.payload(),
            timeout=20,
        )
        assert response.status_code == 404, response.text
        assert response.json().get("detail") == "Document introuvable"


# Monthly dashboard accounting and one-click ZIP export with CSV/file contents.
class TestThemisMonthlyAndExport:
    def test_monthly_series_and_accounting_export(self, api, created):
        before_response = api.get(f"{API}/stats", timeout=20)
        assert before_response.status_code == 200, before_response.text
        before = before_response.json()
        before_monthly = before.get("monthly")
        assert isinstance(before_monthly, list) and len(before_monthly) == 12
        assert all(set(point) == {"m", "in", "out"} for point in before_monthly)
        assert all(re.fullmatch(r"\d{4}-\d{2}", point["m"]) for point in before_monthly)
        assert all(isinstance(point["in"], (int, float)) and isinstance(point["out"], (int, float)) for point in before_monthly)
        assert [point["m"] for point in before_monthly] == sorted(point["m"] for point in before_monthly)

        suffix = uuid.uuid4().hex[:8]
        client_name = f"TEST_Export_Client_{suffix}"
        client = assert_ok(api.post(
            f"{API}/clients",
            json={"name": client_name, "company": f"TEST_Export_Co_{suffix}", "email": "export@example.test"},
            timeout=20,
        ))["client"]
        created["clients"].append(client["id"])
        invoice = assert_ok(api.post(
            f"{API}/docs",
            json={
                "kind": "facture",
                "client_id": client["id"],
                "client_name": client_name,
                "lines": [{"label": f"TEST_Export_Service_{suffix}", "qty": 1, "unit_price": 100}],
                "tva": 20,
            },
            timeout=20,
        ))["doc"]
        created["docs"].append(invoice["id"])
        payment = assert_ok(api.post(
            f"{API}/payments",
            json={"doc_id": invoice["id"], "amount": 73.21, "method": "carte", "note": f"TEST_Export_Payment_{suffix}"},
            timeout=20,
        ))["payment"]
        created["payments"].append(payment["id"])

        filename = f"TEST_export_piece_{suffix}.pdf"
        piece = assert_ok(upload_piece(api, filename, make_test_pdf(filename), "application/pdf"))["piece"]
        created["pieces"].append(piece["id"])
        current_month = datetime.now(timezone.utc).strftime("%Y-%m")
        supplier = f"TEST_Export_Supplier_{suffix}"
        assert_ok(api.put(
            f"{API}/pieces/{piece['id']}",
            json={
                "fournisseur": supplier,
                "numero": f"TEST-PIECE-{suffix}",
                "date": f"{current_month}-01",
                "total_ht": 40,
                "tva": 8,
                "total_ttc": 48,
            },
            timeout=20,
        ))

        after_response = api.get(f"{API}/stats", timeout=20)
        assert after_response.status_code == 200, after_response.text
        after_monthly = after_response.json().get("monthly")
        assert isinstance(after_monthly, list) and len(after_monthly) == 12
        before_current = next(point for point in before_monthly if point["m"] == current_month)
        after_current = next(point for point in after_monthly if point["m"] == current_month)
        assert after_current["in"] == pytest.approx(before_current["in"] + 73.21)
        assert after_current["out"] == pytest.approx(before_current["out"] + 48)

        exported = api.get(f"{API}/export", timeout=30)
        assert exported.status_code == 200, exported.text[:300]
        assert exported.headers.get("content-type", "").startswith("application/zip")
        disposition = exported.headers.get("content-disposition", "")
        assert "attachment" in disposition and ".zip" in disposition
        assert exported.content.startswith(b"PK")

        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            names = set(archive.namelist())
            csv_names = {
                "clients.csv", "documents.csv", "commandes.csv",
                "paiements.csv", "pieces.csv", "ecritures.csv",
            }
            assert csv_names.issubset(names)
            stored_piece = f"pieces/{piece['id']}-{filename}"
            assert stored_piece in names
            assert archive.read(stored_piece).startswith(b"%PDF")
            csv_text = {}
            for csv_name in csv_names:
                raw = archive.read(csv_name)
                assert raw.startswith(b"\xef\xbb\xbf"), f"Missing UTF-8 BOM: {csv_name}"
                text = raw.decode("utf-8-sig")
                assert ";" in text.splitlines()[0], f"Missing semicolon delimiter: {csv_name}"
                csv_text[csv_name] = text

        assert client_name in csv_text["clients.csv"]
        assert invoice["number"] in csv_text["documents.csv"]
        assert f"TEST_Export_Payment_{suffix}" in csv_text["paiements.csv"]
        assert supplier in csv_text["pieces.csv"]
        assert f"Encaissement {invoice['number']} (carte)" in csv_text["ecritures.csv"]
        assert ";;73.21" in csv_text["ecritures.csv"]
        assert supplier in csv_text["ecritures.csv"]
        assert ";48.00;" in csv_text["ecritures.csv"]


# © 2026 Daniel Partel – ΣIRIUS Assistant. Module THÉMIS# : gestion d'entreprise.
import asyncio
import csv
import io
import os
import re
import sqlite3
import smtplib
import uuid
import zipfile
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from email.message import EmailMessage
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pymongo.errors import DuplicateKeyError
from pydantic import BaseModel, Field, field_validator

from email_signature import (
    WORKSPACE_LOGO,
    add_signature_to_message,
    load_signature_identity,
    signature_image,
    signature_lines,
)
from themis_pdf import build_doc_pdf, extract_piece
from runtime_paths import data_dir

NO_ID = {"_id": 0}
FILES_DIR = str(data_dir() / "themis_files")
os.makedirs(FILES_DIR, exist_ok=True)
PIECE_EXTS = {"pdf", "png", "jpg", "jpeg", "webp"}
PIECE_MIME = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


def _piece_file_path(piece_id, extension, *, files_dir=None):
    filename = f"{piece_id}.{extension}"
    if files_dir is not None:
        return os.path.join(files_dir, filename)
    path = os.path.join(FILES_DIR, filename)
    legacy_path = os.path.join(os.path.dirname(__file__), "themis_files", filename)
    if not os.path.isfile(path) and os.path.isfile(legacy_path):
        return legacy_path
    return path


def now_iso():
    return datetime.now(timezone.utc).isoformat()


TEMPLATES = [
    {"id": "antique", "name": "ANTIQUE OR", "desc": "En-tête doré, colonnes grecques, sceau Σ en filigrane. Pour les documents de prestige.", "accent": "#f5c542"},
    {"id": "moderne", "name": "MODERNE CYAN", "desc": "Épuré, lignes cyan, typographie technique. Pour les clients tech et startups.", "accent": "#22d3ee"},
    {"id": "minimal", "name": "MINIMAL NOIR & OR", "desc": "Sobre et luxueux, filets fins, beaucoup de blanc. Pour le haut de gamme.", "accent": "#d9a940"},
]


class Line(BaseModel):
    label: str = ""
    qty: float = Field(default=1, ge=0)
    unit_price: float = Field(default=0)
    vat_rate: Optional[float] = Field(default=None, ge=0, le=100)

    @field_validator("unit_price")
    @classmethod
    def price_to_cents(cls, value):
        return float(_money(value))


class ClientIn(BaseModel):
    name: str
    company: str = ""
    email: str = ""
    phone: str = ""
    address: str = ""
    notes: str = ""

    @field_validator("name")
    @classmethod
    def name_required(cls, v):
        v = (v or "").strip()
        if not v:
            raise ValueError("Le nom du client est obligatoire.")
        return v


class ItemIn(BaseModel):
    name: str
    ref: str = ""
    price: float = 0
    stock: int = 0
    alert: int = 5


class StockDelta(BaseModel):
    delta: int
    reason: str = "ajustement manuel"


class DocIn(BaseModel):
    kind: str  # devis | facture
    client_id: str = ""
    client_name: str = ""
    lines: List[Line] = []
    tva: float = Field(default=20.0, ge=0, le=100)
    template: str = "antique"
    due_date: str = ""
    notes: str = ""


class StatusIn(BaseModel):
    status: str


class FromDealIn(BaseModel):
    deal_id: str
    kind: str = "devis"


class OrderIn(BaseModel):
    client_id: str = ""
    client_name: str = ""
    lines: List[Line] = []
    notes: str = ""


class PaymentIn(BaseModel):
    doc_id: str = ""
    amount: float
    method: str = "virement"
    note: str = ""

    @field_validator("amount")
    @classmethod
    def amount_positive(cls, v):
        amount = _money(v)
        if amount <= 0:
            raise ValueError("Le montant du paiement doit être supérieur à zéro.")
        return float(amount)


class JournalIn(BaseModel):
    date: str = ""
    libelle: str
    compte: str = "512000"
    type: str = "divers"
    debit: float = 0
    credit: float = 0


class ReconciliationIn(BaseModel):
    date: str
    compte_bancaire: str = ""
    solde_releve: float
    notes: str = ""


class BankStatementLine(BaseModel):
    date: str
    libelle: str = ""
    montant: float
    reference: str = ""


class BankStatementImport(BaseModel):
    rows: List[BankStatementLine]


def parse_statement_date(value: str) -> str:
    value = (value or "").strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError(f"Date bancaire invalide : {value}")


def parse_statement_csv(raw: bytes) -> List[dict]:
    text = raw.decode("utf-8-sig")
    sample = text[:2048]
    dialect = csv.Sniffer().sniff(sample, delimiters=";,\t,")
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        raise ValueError("Le relevé est vide ou ne possède pas d'en-tête.")
    names = {name.strip().lower().replace("é", "e"): name for name in reader.fieldnames if name}
    date_key = names.get("date")
    label_key = names.get("libelle") or names.get("description") or names.get("label")
    amount_key = names.get("montant") or names.get("amount") or names.get("debit")
    ref_key = names.get("reference") or names.get("ref")
    if not date_key or not amount_key:
        raise ValueError("Colonnes obligatoires manquantes : date et montant.")
    rows = []
    for row in reader:
        if not any((value or "").strip() for value in row.values()):
            continue
        amount_text = (row.get(amount_key) or "").strip().replace(" ", "").replace(",", ".")
        try:
            amount = Decimal(amount_text)
            parsed_date = parse_statement_date(row.get(date_key, ""))
        except (ValueError, InvalidOperation) as error:
            raise ValueError(str(error)) from error
        rows.append({"date": parsed_date, "libelle": (row.get(label_key) or "").strip() if label_key else "", "montant": float(_money(amount)), "reference": (row.get(ref_key) or "").strip() if ref_key else ""})
    if not rows:
        raise ValueError("Aucune opération exploitable dans le relevé.")
    return rows


class PieceEdit(BaseModel):
    fournisseur: Optional[str] = None
    numero: Optional[str] = None
    date: Optional[str] = None
    total_ht: Optional[float] = None
    tva: Optional[float] = None
    total_ttc: Optional[float] = None
    status: Optional[str] = None

    @field_validator("status")
    @classmethod
    def status_valid(cls, v):
        if v is not None and v not in ("à_payer", "payé"):
            raise ValueError("Statut de pièce invalide (à_payer ou payé).")
        return v


class SmtpConf(BaseModel):
    host: str
    port: int = 587
    user: str = ""
    password: str = ""
    from_email: str = ""
    from_name: str = "THÉMIS — ΣIRIUS"

    @field_validator("host")
    @classmethod
    def host_required(cls, v):
        v = (v or "").strip()
        if not v:
            raise ValueError("Le serveur SMTP est obligatoire (onglet CLÉS API).")
        return v


class EmailIn(BaseModel):
    to: str
    subject: str = ""
    message: str = ""
    emetteur: str = ""
    mail_type: str = "envoi"  # envoi | relance
    smtp: SmtpConf

    @field_validator("to")
    @classmethod
    def to_valid(cls, v):
        v = (v or "").strip()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Adresse e-mail du destinataire invalide.")
        return v


class BatchRelanceIn(BaseModel):
    days_threshold: int = Field(default=0, ge=0, le=3650)
    confirm: bool = False
    emetteur: str = ""
    smtp: Optional[SmtpConf] = None


def _send_smtp(
    conf: SmtpConf,
    to: str,
    subject: str,
    body: str,
    pdf_bytes: bytes,
    pdf_name: str,
    *,
    signature_name=None,
    signature_email=None,
):
    msg = EmailMessage()
    sender = conf.from_email or conf.user
    msg["From"] = f"{conf.from_name} <{sender}>" if conf.from_name else sender
    msg["To"] = to
    msg["Subject"] = subject
    add_signature_to_message(msg, body, signature_name=signature_name, signature_email=signature_email)
    if pdf_bytes:
        msg.add_attachment(pdf_bytes, maintype="application", subtype="pdf", filename=pdf_name)
    if int(conf.port) == 465:
        with smtplib.SMTP_SSL(conf.host, int(conf.port), timeout=25) as s:
            if conf.user:
                s.login(conf.user, conf.password)
            s.send_message(msg)
    else:
        with smtplib.SMTP(conf.host, int(conf.port), timeout=25) as s:
            try:
                s.starttls()
            except smtplib.SMTPNotSupportedError:
                pass
            if conf.user:
                s.login(conf.user, conf.password)
            s.send_message(msg)


def build_accounting_export_zip(
    clients,
    docs,
    orders,
    payments,
    pieces,
    *,
    files_dir=None,
    signature_name=None,
    signature_email=None,
):
    doc_num = {document["id"]: document.get("number", "") for document in docs}

    def sheet(rows, headers, getters):
        out = io.StringIO()
        writer = csv.writer(out, delimiter=";")
        writer.writerow(headers)
        for row in rows:
            writer.writerow([getter(row) for getter in getters])
        return "\ufeff" + out.getvalue()

    entries = []
    for payment in payments:
        entries.append((
            str(payment.get("created_at", ""))[:10],
            f"Encaissement {doc_num.get(payment.get('doc_id'), 'divers')} ({payment.get('method', '')})",
            "",
            f"{payment.get('amount', 0):.2f}",
        ))
    for piece in pieces:
        entries.append((
            piece.get("date") or str(piece.get("created_at", ""))[:10],
            f"Fournisseur {piece.get('fournisseur') or piece.get('filename', '')} {piece.get('numero', '')} [{piece.get('status', '')}]",
            f"{float(piece.get('total_ttc', 0) or 0):.2f}",
            "",
        ))
    entries.sort(key=lambda entry: entry[0])
    signature_line, email_line, copyright_line, _ = signature_lines(signature_name, signature_email)

    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "LISEZ-MOI.txt",
            "EXPORT COMPTABLE THÉMIS — ΣIRIUS\n"
            f"Préparé le {datetime.now().strftime('%d/%m/%Y à %H:%M')}.\n\n"
            "L'archive contient les tableaux CSV prêts à importer et les pièces jointes disponibles.\n"
            "Les fichiers CSV sont conservés sans ligne de signature afin de préserver leur importabilité.\n\n"
            f"{signature_line} · THÉMIS\n"
            f"{email_line}\n"
            f"{copyright_line}\n",
        )
        brand_image = signature_image(WORKSPACE_LOGO)
        if brand_image:
            archive.writestr("signature-espace-travail.png", brand_image)
        archive.writestr("clients.csv", sheet(clients,
            ["Nom", "Société", "E-mail", "Téléphone", "Adresse", "Créé le"],
            [lambda row: row.get("name", ""), lambda row: row.get("company", ""), lambda row: row.get("email", ""),
             lambda row: row.get("phone", ""), lambda row: row.get("address", ""), lambda row: str(row.get("created_at", ""))[:10]]))
        archive.writestr("documents.csv", sheet(docs,
            ["Numéro", "Type", "Client", "Total HT", "TVA", "Total TTC", "Réglé", "Statut", "Échéance", "Créé le"],
            [lambda row: row.get("number", ""), lambda row: row.get("kind", ""), lambda row: row.get("client_name", ""),
             lambda row: f"{row.get('total_ht', 0):.2f}", lambda row: f"{row.get('tva_amount', 0):.2f}",
             lambda row: f"{row.get('total_ttc', 0):.2f}", lambda row: f"{row.get('paid', 0):.2f}",
             lambda row: row.get("status", ""), lambda row: row.get("due_date", ""), lambda row: str(row.get("created_at", ""))[:10]]))
        archive.writestr("commandes.csv", sheet(orders,
            ["Numéro", "Client", "Total", "Statut", "Créée le"],
            [lambda row: row.get("number", ""), lambda row: row.get("client_name", ""), lambda row: f"{row.get('total', 0):.2f}",
             lambda row: row.get("status", ""), lambda row: str(row.get("created_at", ""))[:10]]))
        archive.writestr("paiements.csv", sheet(payments,
            ["Date", "Montant", "Méthode", "Facture", "Note"],
            [lambda row: str(row.get("created_at", ""))[:10], lambda row: f"{row.get('amount', 0):.2f}",
             lambda row: row.get("method", ""), lambda row: doc_num.get(row.get("doc_id"), ""), lambda row: row.get("note", "")]))
        archive.writestr("pieces.csv", sheet(pieces,
            ["Fournisseur", "Numéro", "Date", "Total HT", "TVA", "Total TTC", "Statut", "Fichier"],
            [lambda row: row.get("fournisseur", ""), lambda row: row.get("numero", ""), lambda row: row.get("date", ""),
             lambda row: f"{float(row.get('total_ht', 0) or 0):.2f}", lambda row: f"{float(row.get('tva', 0) or 0):.2f}",
             lambda row: f"{float(row.get('total_ttc', 0) or 0):.2f}", lambda row: row.get("status", ""), lambda row: row.get("filename", "")]))
        archive.writestr("ecritures.csv", sheet(entries,
            ["Date", "Libellé", "Débit", "Crédit"],
            [lambda entry: entry[0], lambda entry: entry[1], lambda entry: entry[2], lambda entry: entry[3]]))
        for piece in pieces:
            path = _piece_file_path(piece["id"], piece["ext"], files_dir=files_dir)
            if os.path.isfile(path):
                archive.write(path, f"pieces/{piece['id']}-{piece.get('filename') or 'fichier'}")
    return archive_buffer.getvalue()


def _money(value) -> Decimal:
    return Decimal(str(value or 0)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _sum_money(values) -> float:
    return float(_money(sum((_money(value) for value in values), Decimal("0.00"))))


def _remaining(total, paid) -> float:
    return float(max(Decimal("0.00"), _money(total) - _money(paid)))


def _tax_summary(lines, default_rate):
    bases = {}
    for line in lines:
        get = line.get if isinstance(line, dict) else lambda key, fallback=None: getattr(line, key, fallback)
        rate = Decimal(str(get("vat_rate", None) if get("vat_rate", None) is not None else default_rate))
        base = _money(Decimal(str(get("qty", 0) or 0)) * Decimal(str(get("unit_price", 0) or 0)))
        bases[rate] = bases.get(rate, Decimal("0.00")) + base
    breakdown = []
    for rate, base in sorted(bases.items()):
        vat = _money(base * rate / Decimal("100"))
        breakdown.append({"rate": float(rate), "base_ht": float(base), "tva": float(vat)})
    ht = sum((item["base_ht"] for item in breakdown), 0.0)
    vat = sum((item["tva"] for item in breakdown), 0.0)
    ht, vat = float(_money(ht)), float(_money(vat))
    return ht, vat, float(_money(Decimal(str(ht)) + Decimal(str(vat)))), breakdown


def _totals(lines: List[Line], tva: float):
    ht, vat, ttc, _breakdown = _tax_summary(lines, tva)
    return ht, vat, ttc


def make_themis_router(db):
    r = APIRouter(prefix="/themis", tags=["themis"])

    THEMIS_COLLS = ["themis_clients", "themis_items", "themis_docs", "themis_orders", "themis_payments", "themis_pieces"]

    async def _uid(request: Request) -> str:
        from auth_api import require_user
        user = await require_user(request, db)
        uid = user["user_id"]
        if user.get("role") == "admin":
            for coll in THEMIS_COLLS:
                await db[coll].update_many({"user_id": {"$exists": False}}, {"$set": {"user_id": uid}})
        return uid

    async def next_number(prefix, uid):
        year = datetime.now().year
        c = await db.themis_counters.find_one_and_update(
            {"key": f"{prefix}-{year}-{uid}"}, {"$inc": {"seq": 1}}, upsert=True, return_document=True)
        seq = (c or {}).get("seq", 1)
        return f"{prefix}-{year}-{seq:04d}"

    async def issue_invoice(uid: str, did: str):
        async def sync_source_deal(invoice):
            if invoice.get("source_deal_id"):
                await db.agora_deals.update_one(
                    {"id": invoice["source_deal_id"], "user_id": uid},
                    {"$set": {"themis_doc_number": invoice.get("number", ""), "updated_at": now_iso()}},
                )
            return invoice

        try:
            await db.themis_docs.create_index([("user_id", 1), ("number", 1)], unique=True)
        except (DuplicateKeyError, sqlite3.IntegrityError) as error:
            raise HTTPException(
                status_code=409,
                detail="Des numéros de documents existants sont en doublon ; corrigez-les avant d'émettre une facture.",
            ) from error
        existing = await db.themis_docs.find_one({"id": did, "user_id": uid, "kind": "facture"}, NO_ID)
        if not existing:
            raise HTTPException(status_code=404, detail="Facture introuvable")
        if existing.get("status") != "brouillon":
            if existing.get("number") and existing.get("issued_at"):
                return await sync_source_deal(existing)
            raise HTTPException(status_code=409, detail="La facture ne peut plus être émise depuis son statut actuel.")

        # A legacy draft may already hold a number; preserve it rather than creating a gap.
        if existing.get("number"):
            result = await db.themis_docs.update_one(
                {"id": did, "user_id": uid, "kind": "facture", "status": "brouillon"},
                {"$set": {"status": "envoyé", "issued_at": now_iso(), "updated_at": now_iso()}},
            )
            if result.matched_count:
                return await sync_source_deal(await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID))

        year = datetime.now().year
        pattern = rf"^FAC-{year}-(\d+)$"
        for _attempt in range(100):
            issued = await db.themis_docs.find(
                {"user_id": uid, "kind": "facture", "number": {"$regex": rf"^FAC-{year}-\d+$"}},
                NO_ID,
            ).to_list(None)
            highest = max(
                (int(match.group(1)) for document in issued
                 if (match := re.fullmatch(pattern, str(document.get("number", ""))))),
                default=0,
            )
            number = f"FAC-{year}-{highest + 1:04d}"
            issued_at = now_iso()
            try:
                result = await db.themis_docs.update_one(
                    {"id": did, "user_id": uid, "kind": "facture", "status": "brouillon", "number": {"$exists": False}},
                    {"$set": {"number": number, "status": "envoyé", "issued_at": issued_at, "updated_at": issued_at}},
                )
            except (DuplicateKeyError, sqlite3.IntegrityError):
                continue
            if result.matched_count:
                return await sync_source_deal(await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID))
            latest = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
            if latest and latest.get("status") == "envoyé" and latest.get("number"):
                return await sync_source_deal(latest)
            raise HTTPException(status_code=409, detail="Cette facture a été modifiée pendant son émission.")
        raise HTTPException(status_code=503, detail="Impossible d'attribuer un numéro de facture sans collision.")

    # ---------- CLIENTS ----------
    @r.get("/clients")
    async def list_clients(request: Request):
        uid = await _uid(request)
        return {"clients": await db.themis_clients.find({"user_id": uid}, NO_ID).sort("created_at", -1).to_list(500)}

    @r.post("/clients")
    async def add_client(body: ClientIn, request: Request):
        uid = await _uid(request)
        doc = body.dict()
        doc.update({"id": str(uuid.uuid4()), "user_id": uid, "created_at": now_iso()})
        await db.themis_clients.insert_one(dict(doc))
        return {"ok": True, "client": doc}

    @r.put("/clients/{cid}")
    async def edit_client(cid: str, body: ClientIn, request: Request):
        uid = await _uid(request)
        await db.themis_clients.update_one({"id": cid, "user_id": uid}, {"$set": body.dict()})
        return {"ok": True}

    @r.delete("/clients/{cid}")
    async def del_client(cid: str, request: Request):
        uid = await _uid(request)
        await db.themis_clients.delete_one({"id": cid, "user_id": uid})
        return {"ok": True}

    # ---------- STOCKS ----------
    @r.get("/items")
    async def list_items(request: Request):
        uid = await _uid(request)
        return {"items": await db.themis_items.find({"user_id": uid}, NO_ID).sort("name", 1).to_list(500)}

    @r.post("/items")
    async def add_item(body: ItemIn, request: Request):
        uid = await _uid(request)
        doc = body.dict()
        doc.update({"id": str(uuid.uuid4()), "user_id": uid, "created_at": now_iso()})
        await db.themis_items.insert_one(dict(doc))
        await db.themis_stock_movements.insert_one({"id": str(uuid.uuid4()), "item_id": doc["id"], "user_id": uid, "delta": doc["stock"], "before": 0, "after": doc["stock"], "reason": "stock initial", "created_at": now_iso()})
        return {"ok": True, "item": doc}

    @r.put("/items/{iid}/stock")
    async def adjust_stock(iid: str, body: StockDelta, request: Request):
        uid = await _uid(request)
        it = await db.themis_items.find_one({"id": iid, "user_id": uid}, NO_ID)
        if not it:
            raise HTTPException(status_code=404, detail="Article introuvable")
        before = int(it.get("stock", 0))
        ns = max(0, before + body.delta)
        await db.themis_items.update_one({"id": iid, "user_id": uid}, {"$set": {"stock": ns}})
        await db.themis_stock_movements.insert_one({"id": str(uuid.uuid4()), "item_id": iid, "user_id": uid, "delta": body.delta, "before": before, "after": ns, "reason": body.reason.strip()[:160] or "ajustement manuel", "created_at": now_iso()})
        return {"ok": True, "stock": ns}

    @r.get("/items/{iid}/movements")
    async def stock_movements(iid: str, request: Request):
        uid = await _uid(request)
        item = await db.themis_items.find_one({"id": iid, "user_id": uid}, NO_ID)
        if not item:
            raise HTTPException(status_code=404, detail="Article introuvable")
        movements = await db.themis_stock_movements.find({"item_id": iid, "user_id": uid}, NO_ID).sort("created_at", -1).to_list(500)
        return {"item": item, "movements": movements}

    @r.delete("/items/{iid}")
    async def del_item(iid: str, request: Request):
        uid = await _uid(request)
        await db.themis_items.delete_one({"id": iid, "user_id": uid})
        return {"ok": True}

    # ---------- DEVIS & FACTURES ----------
    @r.get("/docs")
    async def list_docs(request: Request, kind: str = ""):
        uid = await _uid(request)
        q = {"user_id": uid}
        if kind:
            q["kind"] = kind
        return {"docs": await db.themis_docs.find(q, NO_ID).sort("created_at", -1).to_list(500)}

    @r.post("/docs")
    async def add_doc(body: DocIn, request: Request):
        uid = await _uid(request)
        if body.kind not in ("devis", "facture"):
            raise HTTPException(status_code=400, detail="kind doit être devis ou facture")
        number = await next_number("DEV", uid) if body.kind == "devis" else None
        ht, tva_amount, ttc, vat_breakdown = _tax_summary(body.lines, body.tva)
        doc = body.model_dump()
        doc.update({
            "id": str(uuid.uuid4()), "user_id": uid, "total_ht": ht,
            "tva_amount": tva_amount, "total_ttc": ttc, "paid": 0.0,
            "vat_breakdown": vat_breakdown, "status": "brouillon", "created_at": now_iso(),
        })
        if number:
            doc["number"] = number
        await db.themis_docs.insert_one(dict(doc))
        return {"ok": True, "doc": doc}

    @r.post("/from-deal")
    async def doc_from_deal(body: FromDealIn, request: Request):
        """Deal gagné HERMÈS AGORA# → devis ou facture Thémis (client créé si besoin)."""
        uid = await _uid(request)
        if body.kind not in ("devis", "facture"):
            raise HTTPException(status_code=400, detail="kind doit être devis ou facture")
        deal = await db.agora_deals.find_one({"id": body.deal_id, "user_id": uid}, NO_ID)
        if not deal:
            raise HTTPException(status_code=404, detail="Deal introuvable")
        if deal.get("themis_doc_id"):
            raise HTTPException(status_code=409, detail=f"Un document Thémis existe déjà pour ce deal ({deal.get('themis_doc_number', '')}).")
        client = await db.themis_clients.find_one({"name": deal["nom"], "user_id": uid}, NO_ID)
        if not client:
            client = {"id": str(uuid.uuid4()), "user_id": uid, "name": deal["nom"], "company": deal.get("entreprise", ""),
                      "email": "", "phone": "", "address": "", "notes": "Client créé depuis le pipeline HERMÈS AGORA#",
                      "created_at": now_iso()}
            await db.themis_clients.insert_one(dict(client))
        label = (deal.get("note") or "").strip() or f"Prestation — {deal['nom']}"
        lines = [Line(label=label[:120], qty=1, unit_price=float(deal.get("valeur", 0)))]
        ht, tva_amount, ttc, vat_breakdown = _tax_summary(lines, 20.0)
        number = await next_number("DEV", uid) if body.kind == "devis" else None
        doc = {
            "kind": body.kind, "client_id": client["id"], "client_name": client["name"],
            "source_deal_id": body.deal_id,
            "lines": [l.dict() for l in lines], "tva": 20.0, "template": "antique",
            "due_date": "", "notes": f"Généré depuis le deal HERMÈS AGORA# ({deal.get('etape', '')})",
            "id": str(uuid.uuid4()), "user_id": uid, "total_ht": ht,
            "tva_amount": tva_amount, "total_ttc": ttc, "vat_breakdown": vat_breakdown, "paid": 0.0,
            "status": "brouillon", "created_at": now_iso(),
        }
        if number:
            doc["number"] = number
        await db.themis_docs.insert_one(dict(doc))
        doc.pop("_id", None)
        await db.agora_deals.update_one({"id": body.deal_id, "user_id": uid}, {"$set": {
            "themis_doc_id": doc["id"], "themis_doc_number": number or "", "themis_doc_kind": body.kind,
            "updated_at": now_iso()}})
        return {"ok": True, "doc": doc, "client": client}

    @r.put("/docs/{did}/status")
    async def doc_status(did: str, body: StatusIn, request: Request):
        uid = await _uid(request)
        doc = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not doc:
            raise HTTPException(status_code=404, detail="Document introuvable")
        if doc.get("kind") == "facture":
            if body.status != "envoyé":
                raise HTTPException(status_code=409, detail="Une facture est émise via son envoi ou sa conversion depuis un devis ; les règlements passent par Paiements.")
            issued = await issue_invoice(uid, did)
            return {"ok": True, "doc": issued}
        allowed = {
            "brouillon": {"envoyé", "refusé"},
            "envoyé": {"accepté", "refusé"},
        }
        if body.status not in allowed.get(doc.get("status"), set()):
            raise HTTPException(status_code=409, detail="Transition de statut du devis interdite.")
        result = await db.themis_docs.update_one(
            {"id": did, "user_id": uid, "status": doc["status"]},
            {"$set": {"status": body.status, "updated_at": now_iso()}},
        )
        if not result.matched_count:
            raise HTTPException(status_code=409, detail="Le document a été modifié simultanément.")
        return {"ok": True}

    @r.post("/docs/{did}/convert")
    async def convert_devis(did: str, request: Request):
        uid = await _uid(request)
        d = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not d or d.get("kind") != "devis":
            raise HTTPException(status_code=404, detail="Devis introuvable")
        try:
            await db.themis_docs.create_index(
                [("user_id", 1), ("source_devis", 1)],
                unique=True,
                partialFilterExpression={"source_devis": {"$exists": True}},
            )
        except (DuplicateKeyError, sqlite3.IntegrityError) as error:
            raise HTTPException(
                status_code=409,
                detail="Plusieurs factures sont déjà liées à ce devis ; vérifiez-les avant toute nouvelle conversion.",
            ) from error
        if d.get("status") not in ("envoyé", "accepté"):
            raise HTTPException(status_code=409, detail="Le devis doit être envoyé avant sa conversion en facture.")
        existing = await db.themis_docs.find_one(
            {"user_id": uid, "kind": "facture", "source_devis": d["number"]}, NO_ID
        )
        if existing:
            if existing.get("status") == "brouillon":
                existing = await issue_invoice(uid, existing["id"])
            await db.themis_docs.update_one(
                {"id": did, "user_id": uid, "status": {"$in": ["envoyé", "accepté"]}},
                {"$set": {"status": "accepté", "updated_at": now_iso()}},
            )
            return {"ok": True, "doc": existing}
        f = dict(d)
        f.update({"id": str(uuid.uuid4()), "kind": "facture",
                  "status": "brouillon", "paid": 0.0, "created_at": now_iso(),
                  "source_devis": d["number"]})
        f.pop("number", None)
        f.pop("issued_at", None)
        try:
            await db.themis_docs.insert_one(dict(f))
        except (DuplicateKeyError, sqlite3.IntegrityError):
            existing = await db.themis_docs.find_one(
                {"user_id": uid, "kind": "facture", "source_devis": d["number"]}, NO_ID
            )
            if not existing:
                raise
            if existing.get("status") == "brouillon":
                existing = await issue_invoice(uid, existing["id"])
            await db.themis_docs.update_one(
                {"id": did, "user_id": uid, "status": {"$in": ["envoyé", "accepté"]}},
                {"$set": {"status": "accepté", "updated_at": now_iso()}},
            )
            return {"ok": True, "doc": existing}
        f = await issue_invoice(uid, f["id"])
        await db.themis_docs.update_one(
            {"id": did, "user_id": uid, "status": {"$in": ["envoyé", "accepté"]}},
            {"$set": {"status": "accepté", "updated_at": now_iso()}},
        )
        return {"ok": True, "doc": f}

    @r.get("/docs/{did}/pdf")
    async def doc_pdf(did: str, request: Request, emetteur: str = ""):
        uid = await _uid(request)
        identity = await load_signature_identity(db, uid)
        d = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not d:
            raise HTTPException(status_code=404, detail="Document introuvable")
        pdf = build_doc_pdf(d, emetteur=emetteur, **identity)
        return Response(content=pdf, media_type="application/pdf",
                        headers={"Content-Disposition": f'inline; filename="{d.get("number") or f"BROUILLON-{did[:8]}"}.pdf"'})

    @r.post("/docs/{did}/email")
    async def email_doc(did: str, body: EmailIn, request: Request):
        uid = await _uid(request)
        identity = await load_signature_identity(db, uid)
        d = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not d:
            raise HTTPException(status_code=404, detail="Document introuvable")
        was_draft_invoice = d.get("kind") == "facture" and d.get("status") == "brouillon"
        if d.get("kind") == "facture" and d.get("status") == "brouillon":
            if body.mail_type == "relance":
                raise HTTPException(status_code=409, detail="Une facture brouillon ne peut pas faire l'objet d'une relance.")
            d = await issue_invoice(uid, did)
        pdf = build_doc_pdf(d, emetteur=body.emetteur, **identity)
        kind = "Facture" if d["kind"] == "facture" else "Devis"
        subject = body.subject.strip() or f"{kind} {d['number']}"
        message = body.message.strip()
        if was_draft_invoice:
            message = message.replace("attribuée lors de l’émission", d["number"])
            if subject.startswith("Facture ") and "attribuée lors de l’émission" in subject:
                subject = f"Facture {d['number']}"
        message = message or (
            f"Bonjour,\n\nVeuillez trouver ci-joint votre {kind.lower()} {d['number']} "
            f"d'un montant de {float(d.get('total_ttc', 0)):.2f} € TTC.\n\nCordialement.")
        try:
            await asyncio.to_thread(
                _send_smtp,
                body.smtp,
                body.to,
                subject,
                message,
                pdf,
                f"{d['number']}.pdf",
                **identity,
            )
        except smtplib.SMTPAuthenticationError:
            raise HTTPException(status_code=400, detail="Authentification SMTP refusée : vérifiez l'identifiant et le mot de passe (pour Gmail, utilisez un mot de passe d'application).")
        except OSError as e:
            raise HTTPException(status_code=400, detail=f"Serveur SMTP injoignable : vérifiez l'adresse et le port dans l'onglet CLÉS API. ({e})")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Envoi impossible : {e}")
        entry = {"to": body.to, "subject": subject, "type": body.mail_type, "date": now_iso()}
        upd = {"$push": {"emails": entry}}
        if d.get("status") == "brouillon":
            upd["$set"] = {"status": "envoyé", "updated_at": now_iso()}
        await db.themis_docs.update_one({"id": did, "user_id": uid}, upd)
        return {"ok": True, "sent_to": body.to}

    @r.post("/relances")
    async def batch_relances(body: BatchRelanceIn, request: Request):
        uid = await _uid(request)
        identity = await load_signature_identity(db, uid)
        today_date = datetime.now(timezone.utc).date()
        docs = await db.themis_docs.find({"user_id": uid, "kind": "facture"}, NO_ID).to_list(2000)
        clients = {c["id"]: c for c in await db.themis_clients.find({"user_id": uid}, NO_ID).to_list(2000)}
        candidates = []
        for doc in docs:
            if doc.get("status") != "envoyé" or not doc.get("due_date"):
                continue
            try:
                due = date.fromisoformat(str(doc["due_date"])[:10])
            except ValueError:
                continue
            days_late = (today_date - due).days
            client = clients.get(doc.get("client_id"), {})
            email = client.get("email") or doc.get("email") or ""
            if days_late < body.days_threshold:
                continue
            candidates.append({"id": doc["id"], "number": doc.get("number", ""), "client": doc.get("client_name") or client.get("name", ""), "email": email, "remaining": _remaining(doc.get("total_ttc"), doc.get("paid")), "days_late": days_late})
        if not body.confirm:
            return {"ok": True, "preview": True, "candidates": candidates}
        if not body.smtp:
            raise HTTPException(status_code=400, detail="Configuration SMTP obligatoire pour envoyer les relances.")
        sent, failed = [], []
        for candidate in candidates:
            if not candidate["email"]:
                failed.append({"id": candidate["id"], "reason": "Adresse e-mail absente."})
                continue
            doc = next(item for item in docs if item["id"] == candidate["id"])
            subject = f"Relance — Facture {candidate['number']}"
            message = f"Bonjour,\n\nSauf erreur de notre part, la facture {candidate['number']} d'un montant restant de {candidate['remaining']:.2f} EUR demeure impayée. Merci de procéder à son règlement.\n\nCordialement,\n{body.emetteur or 'THÉMIS'}"
            try:
                pdf = build_doc_pdf(doc, emetteur=body.emetteur, **identity)
                await asyncio.to_thread(
                    _send_smtp,
                    body.smtp,
                    candidate["email"],
                    subject,
                    message,
                    pdf,
                    f"{candidate['number']}.pdf",
                    **identity,
                )
                await db.themis_docs.update_one({"id": candidate["id"], "user_id": uid}, {"$push": {"emails": {"to": candidate["email"], "subject": subject, "type": "relance", "date": now_iso()}}})
                sent.append(candidate["id"])
            except Exception as error:
                failed.append({"id": candidate["id"], "reason": str(error)[:160]})
        return {"ok": True, "preview": False, "sent": sent, "failed": failed, "sent_count": len(sent), "failed_count": len(failed)}

    @r.delete("/docs/{did}")
    async def del_doc(did: str, request: Request):
        uid = await _uid(request)
        doc = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not doc:
            raise HTTPException(status_code=404, detail="Document introuvable")
        if doc.get("kind") == "facture" and doc.get("status") != "brouillon":
            raise HTTPException(status_code=409, detail="Une facture émise ne peut pas être supprimée ; utilisez une procédure d'avoir.")
        query = {"id": did, "user_id": uid}
        if doc.get("kind") == "facture":
            query["status"] = "brouillon"
        result = await db.themis_docs.delete_one(query)
        if not result.deleted_count:
            raise HTTPException(status_code=409, detail="Le document a été modifié avant sa suppression.")
        return {"ok": True}

    # ---------- COMMANDES ----------
    @r.get("/orders")
    async def list_orders(request: Request):
        uid = await _uid(request)
        return {"orders": await db.themis_orders.find({"user_id": uid}, NO_ID).sort("created_at", -1).to_list(500)}

    @r.post("/orders")
    async def add_order(body: OrderIn, request: Request):
        uid = await _uid(request)
        ht, _, ttc = _totals(body.lines, 20.0)
        doc = body.dict()
        doc.update({"id": str(uuid.uuid4()), "user_id": uid, "number": await next_number("CMD", uid),
                    "total": ttc, "status": "en_attente", "created_at": now_iso()})
        await db.themis_orders.insert_one(dict(doc))
        return {"ok": True, "order": doc}

    @r.put("/orders/{oid}/status")
    async def order_status(oid: str, body: StatusIn, request: Request):
        uid = await _uid(request)
        await db.themis_orders.update_one({"id": oid, "user_id": uid}, {"$set": {"status": body.status}})
        return {"ok": True}

    @r.delete("/orders/{oid}")
    async def del_order(oid: str, request: Request):
        uid = await _uid(request)
        await db.themis_orders.delete_one({"id": oid, "user_id": uid})
        return {"ok": True}

    # ---------- PAIEMENTS & COMPTA ----------
    @r.get("/payments")
    async def list_payments(request: Request):
        uid = await _uid(request)
        return {"payments": await db.themis_payments.find({"user_id": uid}, NO_ID).sort("created_at", -1).to_list(500)}

    @r.post("/payments")
    async def add_payment(body: PaymentIn, request: Request):
        uid = await _uid(request)
        doc = body.model_dump()
        doc.update({"id": str(uuid.uuid4()), "user_id": uid, "created_at": now_iso()})
        if body.doc_id:
            d = await db.themis_docs.find_one({"id": body.doc_id, "user_id": uid}, NO_ID)
            if not d or d.get("kind") != "facture" or d.get("status") not in ("envoyé", "payé"):
                raise HTTPException(status_code=400, detail="Un paiement ne peut être rattaché qu'à une facture émise.")
            previous = _money(d.get("paid", 0))
            amount = _money(body.amount)
            total = _money(d.get("total_ttc", 0))
            paid = previous + amount
            if paid > total:
                raise HTTPException(status_code=409, detail="Le paiement dépasse le solde restant de la facture.")
            update = {"paid": float(paid), "updated_at": now_iso()}
            if paid == total:
                update["status"] = "payé"
            previous_paid_filter = (
                {"paid": d["paid"]} if "paid" in d else {"paid": {"$exists": False}}
            )
            result = await db.themis_docs.update_one(
                {"id": body.doc_id, "user_id": uid, "status": d.get("status"), **previous_paid_filter},
                {"$set": update},
            )
            if not result.matched_count:
                raise HTTPException(status_code=409, detail="La facture a été réglée simultanément ; rechargez-la avant d'enregistrer ce paiement.")
        await db.themis_payments.insert_one(dict(doc))
        return {"ok": True, "payment": doc}

    @r.delete("/payments/{pid}")
    async def del_payment(pid: str, request: Request):
        uid = await _uid(request)
        p = await db.themis_payments.find_one({"id": pid, "user_id": uid}, NO_ID)
        if p and p.get("doc_id"):
            d = await db.themis_docs.find_one({"id": p["doc_id"], "user_id": uid}, NO_ID)
            if d:
                paid = max(0.0, _sum_money([d.get("paid", 0), -_money(p.get("amount", 0))]))
                upd = {"paid": paid}
                if _money(paid) < _money(d.get("total_ttc", 0)) and d.get("status") == "payé":
                    upd["status"] = "envoyé"
                await db.themis_docs.update_one({"id": p["doc_id"], "user_id": uid}, {"$set": upd})
        await db.themis_payments.delete_one({"id": pid, "user_id": uid})
        return {"ok": True}

    # ---------- PIÈCES COMPTABLES (PDF / OCR) ----------
    @r.get("/pieces")
    async def list_pieces(request: Request):
        uid = await _uid(request)
        return {"pieces": await db.themis_pieces.find({"user_id": uid}, NO_ID).sort("created_at", -1).to_list(500)}

    @r.post("/pieces/upload")
    async def upload_piece(request: Request, file: UploadFile = File(...), k3_key: str = Form("")):
        uid = await _uid(request)
        ext = (file.filename or "").rsplit(".", 1)[-1].lower()
        if ext not in PIECE_EXTS:
            raise HTTPException(status_code=400, detail="Format accepté : PDF, PNG, JPG ou WEBP.")
        data = await file.read()
        if len(data) > 15 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Fichier trop volumineux (15 Mo maximum).")
        note, extracted = "", {}
        try:
            extracted = await extract_piece(file.filename, data, k3_key or None)
        except Exception as e:
            note = f"Lecture automatique impossible : {e}"
        pid = str(uuid.uuid4())
        with open(os.path.join(FILES_DIR, f"{pid}.{ext}"), "wb") as fh:
            fh.write(data)
        piece = {
            "id": pid, "user_id": uid, "filename": file.filename, "ext": ext, "size": len(data),
            "fournisseur": extracted.get("fournisseur", ""), "numero": extracted.get("numero", ""),
            "date": extracted.get("date", ""), "total_ht": extracted.get("total_ht", 0.0),
            "tva": extracted.get("tva", 0.0), "total_ttc": extracted.get("total_ttc", 0.0),
            "method": extracted.get("method", ""), "status": "à_payer",
            "note": note, "created_at": now_iso(),
        }
        await db.themis_pieces.insert_one(dict(piece))
        return {"ok": True, "piece": piece}

    @r.put("/pieces/{pid}")
    async def edit_piece(pid: str, body: PieceEdit, request: Request):
        uid = await _uid(request)
        upd = {k: v for k, v in body.dict().items() if v is not None}
        if not upd:
            return {"ok": True}
        res = await db.themis_pieces.update_one({"id": pid, "user_id": uid}, {"$set": upd})
        if not res.matched_count:
            raise HTTPException(status_code=404, detail="Pièce introuvable")
        return {"ok": True}

    @r.get("/pieces/{pid}/file")
    async def piece_file(pid: str, request: Request):
        uid = await _uid(request)
        p = await db.themis_pieces.find_one({"id": pid, "user_id": uid}, NO_ID)
        if not p:
            raise HTTPException(status_code=404, detail="Pièce introuvable")
        path = _piece_file_path(pid, p["ext"])
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="Fichier introuvable sur le disque")
        return FileResponse(path, media_type=PIECE_MIME.get(p["ext"], "application/octet-stream"),
                            headers={"X-Content-Type-Options": "nosniff"})

    @r.delete("/pieces/{pid}")
    async def del_piece(pid: str, request: Request):
        uid = await _uid(request)
        p = await db.themis_pieces.find_one({"id": pid, "user_id": uid}, NO_ID)
        if p:
            try:
                os.remove(_piece_file_path(pid, p["ext"]))
            except OSError:
                pass
        await db.themis_pieces.delete_one({"id": pid, "user_id": uid})
        return {"ok": True}

    # ---------- EXPORT COMPTABLE (ZIP CSV + pièces) ----------
    @r.get("/export")
    async def export_comptable(request: Request):
        uid = await _uid(request)
        identity = await load_signature_identity(db, uid)
        clients = await db.themis_clients.find({"user_id": uid}, NO_ID).to_list(2000)
        docs = await db.themis_docs.find({"user_id": uid}, NO_ID).to_list(2000)
        orders = await db.themis_orders.find({"user_id": uid}, NO_ID).to_list(2000)
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(5000)
        pieces = await db.themis_pieces.find({"user_id": uid}, NO_ID).to_list(2000)
        archive_bytes = build_accounting_export_zip(clients, docs, orders, payments, pieces, **identity)
        name = f"themis-export-comptable-{datetime.now().strftime('%Y%m%d')}.zip"
        return Response(content=archive_bytes, media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    # ---------- BILAN FINANCIER & ÉCHÉANCES (pour Sirius) ----------
    @r.get("/bilan")
    async def bilan(request: Request):
        uid = await _uid(request)
        docs = await db.themis_docs.find({"user_id": uid}, NO_ID).to_list(1000)
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(2000)
        pieces = await db.themis_pieces.find({"user_id": uid}, NO_ID).to_list(1000)
        factures = [d for d in docs if d["kind"] == "facture"]
        encaisse = _sum_money(p["amount"] for p in payments)
        impayees = [d for d in factures if d.get("status") == "envoyé"]
        a_encaisser = _sum_money(_remaining(d.get("total_ttc"), d.get("paid")) for d in impayees)
        today = datetime.now(timezone.utc).date()
        echeances = []
        for d in impayees:
            if not d.get("due_date"):
                continue
            try:
                due = datetime.strptime(d["due_date"][:10], "%Y-%m-%d").date()
            except ValueError:
                continue
            echeances.append({
                "number": d["number"], "client": d.get("client_name", ""),
                "restant": _remaining(d.get("total_ttc"), d.get("paid")),
                "due_date": d["due_date"][:10], "days": (due - today).days,
            })
        echeances.sort(key=lambda e: e["days"])
        a_payer = [p for p in pieces if p.get("status") == "à_payer"]
        total_a_payer = _sum_money(p.get("total_ttc", 0) for p in a_payer)

        phrases = [f"Bilan financier. Tu as encaissé {encaisse:g} euros."]
        if impayees:
            phrases.append(f"Il reste {a_encaisser:g} euros à encaisser sur {len(impayees)} facture{'s' if len(impayees) > 1 else ''}.")
        else:
            phrases.append("Aucune facture client en attente de règlement.")
        if a_payer:
            phrases.append(f"Côté fournisseurs, {len(a_payer)} pièce{'s' if len(a_payer) > 1 else ''} à payer pour {total_a_payer:g} euros.")
        retards = [e for e in echeances if e["days"] < 0]
        proches = [e for e in echeances if 0 <= e["days"] <= 7]
        if retards:
            e = retards[0]
            phrases.append(f"Attention : la facture {e['number']} de {e['client'] or 'un client'} est en retard de {abs(e['days'])} jour{'s' if abs(e['days']) > 1 else ''}.")
        if proches:
            e = proches[0]
            phrases.append(f"La facture {e['number']} arrive à échéance dans {e['days']} jour{'s' if e['days'] > 1 else ''}." if e["days"] > 0 else f"La facture {e['number']} arrive à échéance aujourd'hui.")
        if not retards and not proches:
            phrases.append("Aucune échéance imminente. La situation est sous contrôle.")
        return {
            "encaisse": encaisse, "a_encaisser": a_encaisser,
            "factures_impayees": len(impayees), "echeances": echeances[:12],
            "pieces_a_payer": len(a_payer), "total_pieces_a_payer": total_a_payer,
            "speech": " ".join(phrases),
        }

    # ---------- COMPTABILITE & PREVISIONNEL ----------
    @r.get("/journal")
    async def journal(request: Request, from_date: str = "", to_date: str = ""):
        uid = await _uid(request)
        entries = await db.themis_journal.find({"user_id": uid}, NO_ID).sort("date", -1).to_list(2000)
        if from_date:
            entries = [e for e in entries if str(e.get("date", "")) >= from_date]
        if to_date:
            entries = [e for e in entries if str(e.get("date", "")) <= to_date]
        return {"entries": entries}

    @r.post("/journal")
    async def add_journal_entry(body: JournalIn, request: Request):
        uid = await _uid(request)
        entry = body.dict()
        entry.update({"id": str(uuid.uuid4()), "user_id": uid, "date": entry["date"] or now_iso()[:10], "created_at": now_iso()})
        await db.themis_journal.insert_one(entry)
        entry.pop("_id", None)
        return {"ok": True, "entry": entry}

    @r.get("/tva")
    async def tva_summary(request: Request, from_date: str = "", to_date: str = ""):
        uid = await _uid(request)
        now = datetime.now(timezone.utc)
        from_date = from_date or f"{now.year:04d}-{now.month:02d}-01"
        to_date = to_date or now.strftime("%Y-%m-%d")
        docs = await db.themis_docs.find({"user_id": uid, "kind": "facture"}, NO_ID).to_list(2000)
        pieces = await db.themis_pieces.find({"user_id": uid}, NO_ID).to_list(2000)
        in_period = lambda item, key="created_at": from_date <= str(item.get(key) or item.get("created_at") or "")[:10] <= to_date
        sales = [d for d in docs if in_period(d, "issued_at")]
        purchases = [p for p in pieces if in_period(p, "date")]
        sales = [d for d in sales if d.get("status") in ("envoyé", "payé")]
        ca_ht = float(_money(sum((Decimal(str(d.get("total_ht") or 0)) for d in sales), Decimal("0.00"))))
        collected = float(_money(sum((Decimal(str(d.get("tva_amount") or 0)) for d in sales), Decimal("0.00"))))
        deductible = float(_money(sum((Decimal(str(p.get("tva") or 0)) for p in purchases), Decimal("0.00"))))
        return {"from": from_date, "to": to_date, "ca_ht": ca_ht, "tva_collectee": collected,
                "achats_ht": float(_money(sum((Decimal(str(p.get("total_ht") or 0)) for p in purchases), Decimal("0.00")))),
                "tva_deductible": deductible, "tva_nette": float(_money(Decimal(str(collected)) - Decimal(str(deductible)))),
                "a_payer": float(_money(Decimal(str(collected)) - Decimal(str(deductible))))}

    @r.get("/reconciliations")
    async def list_reconciliations(request: Request):
        uid = await _uid(request)
        return {"items": await db.themis_reconciliations.find({"user_id": uid}, NO_ID).sort("date", -1).to_list(500)}

    @r.post("/reconciliations")
    async def add_reconciliation(body: ReconciliationIn, request: Request):
        uid = await _uid(request)
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(2000)
        solde_comptable = _sum_money(p.get("amount", 0) for p in payments)
        difference = float(_money(Decimal(str(body.solde_releve)) - Decimal(str(solde_comptable))))
        item = {**body.dict(), "id": str(uuid.uuid4()), "user_id": uid, "solde_comptable": solde_comptable,
                "difference": difference, "status": "reconcilie" if abs(difference) < 0.01 else "en_cours", "created_at": now_iso()}
        await db.themis_reconciliations.insert_one(item)
        item.pop("_id", None)
        return {"ok": True, "reconciliation": item}

    @r.post("/bank-statements/preview")
    async def preview_bank_statement(request: Request, file: UploadFile = File(...)):
        uid = await _uid(request)
        del uid
        try:
            rows = parse_statement_csv(await file.read())
        except (UnicodeDecodeError, ValueError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return {"ok": True, "count": len(rows), "total": _sum_money(row["montant"] for row in rows), "rows": rows[:2000]}

    @r.post("/bank-statements/import")
    async def import_bank_statement(body: BankStatementImport, request: Request):
        uid = await _uid(request)
        imported = 0
        matched = 0
        duplicates = 0
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(2000)
        for row in body.rows:
            row_date = parse_statement_date(row.date)
            duplicate_query = {"user_id": uid, "date": row_date, "montant": float(_money(row.montant)), "reference": row.reference}
            if await db.themis_bank_transactions.find_one(duplicate_query):
                duplicates += 1
                continue
            match_id = None
            if row.montant > 0:
                for payment in payments:
                    if _money(payment.get("amount", 0)) == _money(row.montant) and str(payment.get("created_at", ""))[:10] == row_date:
                        match_id = payment.get("id")
                        matched += 1
                        break
            transaction = {"id": str(uuid.uuid4()), "user_id": uid, **row.dict(), "date": row_date, "matched_payment_id": match_id, "created_at": now_iso()}
            await db.themis_bank_transactions.insert_one(transaction)
            imported += 1
        return {"ok": True, "imported": imported, "matched": matched, "duplicates": duplicates}

    @r.get("/bank-statements")
    async def list_bank_statements(request: Request):
        uid = await _uid(request)
        rows = await db.themis_bank_transactions.find({"user_id": uid}, NO_ID).sort("date", -1).to_list(2000)
        return {"rows": rows}

    @r.get("/previsionnel")
    async def previsionnel(request: Request, months: int = 6):
        uid = await _uid(request)
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(2000)
        pieces = await db.themis_pieces.find({"user_id": uid}, NO_ID).to_list(2000)
        docs = await db.themis_docs.find({"user_id": uid, "kind": "facture"}, NO_ID).to_list(2000)
        now = datetime.now(timezone.utc)
        history = []
        for offset in range(3, 0, -1):
            month = now.month - offset
            year = now.year + (month - 1) // 12
            month = (month - 1) % 12 + 1
            key = f"{year:04d}-{month:02d}"
            incoming = _sum_money(p.get("amount", 0) for p in payments if str(p.get("created_at", ""))[:7] == key)
            outgoing = _sum_money(p.get("total_ttc", 0) for p in pieces if (str(p.get("date") or p.get("created_at", ""))[:7] == key))
            history.append((incoming, outgoing))
        avg_in = float(_money(_sum_money(pair[0] for pair in history) / 3))
        avg_out = float(_money(_sum_money(pair[1] for pair in history) / 3))
        outstanding = _sum_money(
            _remaining(d.get("total_ttc"), d.get("paid")) for d in docs if d.get("status") == "envoyé"
        )
        result = []
        for offset in range(1, max(1, min(months, 12)) + 1):
            month = now.month + offset
            year = now.year + (month - 1) // 12
            month = (month - 1) % 12 + 1
            incoming = avg_in + (outstanding if offset == 1 else 0)
            result.append({"month": f"{year:04d}-{month:02d}", "in": float(_money(incoming)), "out": float(_money(avg_out)), "solde": float(_money(Decimal(str(incoming)) - Decimal(str(avg_out))))})
        return {"history": [{"in": float(_money(i)), "out": float(_money(o))} for i, o in history], "projections": result,
                "method": "moyenne des trois derniers mois + créances à encaisser le premier mois"}

    # ---------- TABLEAU DE BORD ----------
    @r.get("/stats")
    async def stats(request: Request):
        uid = await _uid(request)
        docs = await db.themis_docs.find({"user_id": uid}, NO_ID).to_list(1000)
        items = await db.themis_items.find({"user_id": uid}, NO_ID).to_list(1000)
        orders = await db.themis_orders.find({"user_id": uid}, NO_ID).to_list(1000)
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(2000)
        factures = [d for d in docs if d["kind"] == "facture"]
        devis = [d for d in docs if d["kind"] == "devis"]
        encaisse = _sum_money(p["amount"] for p in payments)
        a_encaisser = _sum_money(
            _remaining(d.get("total_ttc"), d.get("paid")) for d in factures if d.get("status") == "envoyé"
        )
        alerts = [i for i in items if int(i.get("stock", 0)) <= int(i.get("alert", 5))]
        by_method = {}
        for p in payments:
            method = p.get("method", "autre")
            by_method[method] = _sum_money([by_method.get(method, 0), p["amount"]])
        pieces = await db.themis_pieces.find({"user_id": uid}, NO_ID).to_list(2000)
        now = datetime.now(timezone.utc)
        keys = []
        for i in range(11, -1, -1):
            mm = now.month - i
            yy = now.year + (mm - 1) // 12
            mm = (mm - 1) % 12 + 1
            keys.append(f"{yy:04d}-{mm:02d}")
        series = {k: {"m": k, "in": 0.0, "out": 0.0} for k in keys}
        for p in payments:
            k = str(p.get("created_at", ""))[:7]
            if k in series:
                series[k]["in"] = _sum_money([series[k]["in"], p.get("amount", 0)])
        for p in pieces:
            k = (str(p.get("date") or "")[:7]) or str(p.get("created_at", ""))[:7]
            if k in series:
                series[k]["out"] = _sum_money([series[k]["out"], p.get("total_ttc", 0)])
        return {
            "encaisse": encaisse, "a_encaisser": a_encaisser,
            "devis_en_cours": len([d for d in devis if d.get("status") in ("brouillon", "envoyé")]),
            "factures_impayees": len([d for d in factures if d.get("status") == "envoyé"]),
            "nb_clients": await db.themis_clients.count_documents({"user_id": uid}),
            "commandes_actives": len([o for o in orders if o.get("status") in ("en_attente", "en_cours", "expédiée")]),
            "stock_alerts": alerts, "by_method": by_method,
            "monthly": [series[k] for k in keys],
            "derniers_docs": sorted(docs, key=lambda d: d["created_at"], reverse=True)[:6],
        }

    @r.get("/templates")
    async def templates():
        return {"templates": TEMPLATES}

    return r

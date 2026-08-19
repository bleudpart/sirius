# © 2026 Daniel Partel – SIRIUS Assistant. Module THÉMIS# : gestion d'entreprise.
import asyncio
import csv
import io
import os
import smtplib
import uuid
import zipfile
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, field_validator

from themis_pdf import build_doc_pdf, extract_piece

NO_ID = {"_id": 0}
FILES_DIR = os.path.join(os.path.dirname(__file__), "themis_files")
os.makedirs(FILES_DIR, exist_ok=True)
PIECE_EXTS = {"pdf", "png", "jpg", "jpeg", "webp"}
PIECE_MIME = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}


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
        if v <= 0:
            raise ValueError("Le montant du paiement doit être supérieur à zéro.")
        return v


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
    from_name: str = "THÉMIS — SIRIUS"

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


def _send_smtp(conf: SmtpConf, to: str, subject: str, body: str, pdf_bytes: bytes, pdf_name: str):
    msg = EmailMessage()
    sender = conf.from_email or conf.user
    msg["From"] = f"{conf.from_name} <{sender}>" if conf.from_name else sender
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
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


def _totals(lines: List[Line], tva: float):
    ht = sum(l.qty * l.unit_price for l in lines)
    tva_amount = ht * float(tva) / 100.0
    return round(ht, 2), round(tva_amount, 2), round(ht + tva_amount, 2)


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

    async def next_number(prefix):
        year = datetime.now().year
        c = await db.themis_counters.find_one_and_update(
            {"key": f"{prefix}-{year}"}, {"$inc": {"seq": 1}}, upsert=True, return_document=True)
        seq = (c or {}).get("seq", 1)
        return f"{prefix}-{year}-{seq:04d}"

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
        return {"ok": True, "item": doc}

    @r.put("/items/{iid}/stock")
    async def adjust_stock(iid: str, body: StockDelta, request: Request):
        uid = await _uid(request)
        it = await db.themis_items.find_one({"id": iid, "user_id": uid}, NO_ID)
        if not it:
            raise HTTPException(status_code=404, detail="Article introuvable")
        ns = max(0, int(it.get("stock", 0)) + body.delta)
        await db.themis_items.update_one({"id": iid, "user_id": uid}, {"$set": {"stock": ns}})
        return {"ok": True, "stock": ns}

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
        ht, tva_amount, ttc = _totals(body.lines, body.tva)
        number = await next_number("DEV" if body.kind == "devis" else "FAC")
        doc = body.dict()
        doc.update({
            "id": str(uuid.uuid4()), "user_id": uid, "number": number, "total_ht": ht,
            "tva_amount": tva_amount, "total_ttc": ttc, "paid": 0.0,
            "status": "brouillon", "created_at": now_iso(),
        })
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
        ht, tva_amount, ttc = _totals(lines, 20.0)
        number = await next_number("DEV" if body.kind == "devis" else "FAC")
        doc = {
            "kind": body.kind, "client_id": client["id"], "client_name": client["name"],
            "lines": [l.dict() for l in lines], "tva": 20.0, "template": "antique",
            "due_date": "", "notes": f"Généré depuis le deal HERMÈS AGORA# ({deal.get('etape', '')})",
            "id": str(uuid.uuid4()), "user_id": uid, "number": number, "total_ht": ht,
            "tva_amount": tva_amount, "total_ttc": ttc, "paid": 0.0,
            "status": "brouillon", "created_at": now_iso(),
        }
        await db.themis_docs.insert_one(dict(doc))
        doc.pop("_id", None)
        await db.agora_deals.update_one({"id": body.deal_id, "user_id": uid}, {"$set": {
            "themis_doc_id": doc["id"], "themis_doc_number": number, "themis_doc_kind": body.kind,
            "updated_at": now_iso()}})
        return {"ok": True, "doc": doc, "client": client}

    @r.put("/docs/{did}/status")
    async def doc_status(did: str, body: StatusIn, request: Request):
        uid = await _uid(request)
        await db.themis_docs.update_one({"id": did, "user_id": uid}, {"$set": {"status": body.status}})
        return {"ok": True}

    @r.post("/docs/{did}/convert")
    async def convert_devis(did: str, request: Request):
        uid = await _uid(request)
        d = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not d or d.get("kind") != "devis":
            raise HTTPException(status_code=404, detail="Devis introuvable")
        number = await next_number("FAC")
        f = dict(d)
        f.update({"id": str(uuid.uuid4()), "kind": "facture", "number": number,
                  "status": "envoyé", "paid": 0.0, "created_at": now_iso(),
                  "source_devis": d["number"]})
        await db.themis_docs.insert_one(dict(f))
        await db.themis_docs.update_one({"id": did, "user_id": uid}, {"$set": {"status": "accepté"}})
        return {"ok": True, "doc": f}

    @r.get("/docs/{did}/pdf")
    async def doc_pdf(did: str, request: Request, emetteur: str = ""):
        uid = await _uid(request)
        d = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not d:
            raise HTTPException(status_code=404, detail="Document introuvable")
        pdf = build_doc_pdf(d, emetteur=emetteur)
        return Response(content=pdf, media_type="application/pdf",
                        headers={"Content-Disposition": f'inline; filename="{d["number"]}.pdf"'})

    @r.post("/docs/{did}/email")
    async def email_doc(did: str, body: EmailIn, request: Request):
        uid = await _uid(request)
        d = await db.themis_docs.find_one({"id": did, "user_id": uid}, NO_ID)
        if not d:
            raise HTTPException(status_code=404, detail="Document introuvable")
        pdf = build_doc_pdf(d, emetteur=body.emetteur)
        kind = "Facture" if d["kind"] == "facture" else "Devis"
        subject = body.subject.strip() or f"{kind} {d['number']}"
        message = body.message.strip() or (
            f"Bonjour,\n\nVeuillez trouver ci-joint votre {kind.lower()} {d['number']} "
            f"d'un montant de {float(d.get('total_ttc', 0)):.2f} € TTC.\n\nCordialement.")
        try:
            await asyncio.to_thread(_send_smtp, body.smtp, body.to, subject, message, pdf, f"{d['number']}.pdf")
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
            upd["$set"] = {"status": "envoyé"}
        await db.themis_docs.update_one({"id": did, "user_id": uid}, upd)
        return {"ok": True, "sent_to": body.to}

    @r.delete("/docs/{did}")
    async def del_doc(did: str, request: Request):
        uid = await _uid(request)
        await db.themis_docs.delete_one({"id": did, "user_id": uid})
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
        doc.update({"id": str(uuid.uuid4()), "user_id": uid, "number": await next_number("CMD"),
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
        doc = body.dict()
        doc.update({"id": str(uuid.uuid4()), "user_id": uid, "created_at": now_iso()})
        if body.doc_id:
            d = await db.themis_docs.find_one({"id": body.doc_id, "user_id": uid}, NO_ID)
            if not d or d.get("kind") != "facture":
                raise HTTPException(status_code=400, detail="Un paiement ne peut être rattaché qu'à une facture.")
            paid = round(float(d.get("paid", 0)) + body.amount, 2)
            upd = {"paid": paid}
            if paid >= float(d.get("total_ttc", 0)) - 0.001:
                upd["status"] = "payé"
            await db.themis_docs.update_one({"id": body.doc_id, "user_id": uid}, {"$set": upd})
        await db.themis_payments.insert_one(dict(doc))
        return {"ok": True, "payment": doc}

    @r.delete("/payments/{pid}")
    async def del_payment(pid: str, request: Request):
        uid = await _uid(request)
        p = await db.themis_payments.find_one({"id": pid, "user_id": uid}, NO_ID)
        if p and p.get("doc_id"):
            d = await db.themis_docs.find_one({"id": p["doc_id"], "user_id": uid}, NO_ID)
            if d:
                paid = max(0.0, round(float(d.get("paid", 0)) - float(p.get("amount", 0)), 2))
                upd = {"paid": paid}
                if paid < float(d.get("total_ttc", 0)) - 0.001 and d.get("status") == "payé":
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
        path = os.path.join(FILES_DIR, f"{pid}.{p['ext']}")
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
                os.remove(os.path.join(FILES_DIR, f"{pid}.{p['ext']}"))
            except OSError:
                pass
        await db.themis_pieces.delete_one({"id": pid, "user_id": uid})
        return {"ok": True}

    # ---------- EXPORT COMPTABLE (ZIP CSV + pièces) ----------
    @r.get("/export")
    async def export_comptable(request: Request):
        uid = await _uid(request)
        clients = await db.themis_clients.find({"user_id": uid}, NO_ID).to_list(2000)
        docs = await db.themis_docs.find({"user_id": uid}, NO_ID).to_list(2000)
        orders = await db.themis_orders.find({"user_id": uid}, NO_ID).to_list(2000)
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(5000)
        pieces = await db.themis_pieces.find({"user_id": uid}, NO_ID).to_list(2000)
        doc_num = {d["id"]: d.get("number", "") for d in docs}

        def sheet(rows, headers, getters):
            out = io.StringIO()
            wr = csv.writer(out, delimiter=";")
            wr.writerow(headers)
            for row in rows:
                wr.writerow([g(row) for g in getters])
            return "\ufeff" + out.getvalue()

        ecritures = []
        for p in payments:
            ecritures.append((str(p.get("created_at", ""))[:10], f"Encaissement {doc_num.get(p.get('doc_id'), 'divers')} ({p.get('method', '')})", "", f"{p.get('amount', 0):.2f}"))
        for p in pieces:
            ecritures.append((p.get("date") or str(p.get("created_at", ""))[:10], f"Fournisseur {p.get('fournisseur') or p.get('filename', '')} {p.get('numero', '')} [{p.get('status', '')}]", f"{float(p.get('total_ttc', 0) or 0):.2f}", ""))
        ecritures.sort(key=lambda e: e[0])

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("clients.csv", sheet(clients,
                ["Nom", "Société", "E-mail", "Téléphone", "Adresse", "Créé le"],
                [lambda c: c.get("name", ""), lambda c: c.get("company", ""), lambda c: c.get("email", ""),
                 lambda c: c.get("phone", ""), lambda c: c.get("address", ""), lambda c: str(c.get("created_at", ""))[:10]]))
            z.writestr("documents.csv", sheet(docs,
                ["Numéro", "Type", "Client", "Total HT", "TVA", "Total TTC", "Réglé", "Statut", "Échéance", "Créé le"],
                [lambda d: d.get("number", ""), lambda d: d.get("kind", ""), lambda d: d.get("client_name", ""),
                 lambda d: f"{d.get('total_ht', 0):.2f}", lambda d: f"{d.get('tva_amount', 0):.2f}",
                 lambda d: f"{d.get('total_ttc', 0):.2f}", lambda d: f"{d.get('paid', 0):.2f}",
                 lambda d: d.get("status", ""), lambda d: d.get("due_date", ""), lambda d: str(d.get("created_at", ""))[:10]]))
            z.writestr("commandes.csv", sheet(orders,
                ["Numéro", "Client", "Total", "Statut", "Créée le"],
                [lambda o: o.get("number", ""), lambda o: o.get("client_name", ""), lambda o: f"{o.get('total', 0):.2f}",
                 lambda o: o.get("status", ""), lambda o: str(o.get("created_at", ""))[:10]]))
            z.writestr("paiements.csv", sheet(payments,
                ["Date", "Montant", "Méthode", "Facture", "Note"],
                [lambda p: str(p.get("created_at", ""))[:10], lambda p: f"{p.get('amount', 0):.2f}",
                 lambda p: p.get("method", ""), lambda p: doc_num.get(p.get("doc_id"), ""), lambda p: p.get("note", "")]))
            z.writestr("pieces.csv", sheet(pieces,
                ["Fournisseur", "Numéro", "Date", "Total HT", "TVA", "Total TTC", "Statut", "Fichier"],
                [lambda p: p.get("fournisseur", ""), lambda p: p.get("numero", ""), lambda p: p.get("date", ""),
                 lambda p: f"{float(p.get('total_ht', 0) or 0):.2f}", lambda p: f"{float(p.get('tva', 0) or 0):.2f}",
                 lambda p: f"{float(p.get('total_ttc', 0) or 0):.2f}", lambda p: p.get("status", ""), lambda p: p.get("filename", "")]))
            z.writestr("ecritures.csv", sheet(ecritures,
                ["Date", "Libellé", "Débit", "Crédit"],
                [lambda e: e[0], lambda e: e[1], lambda e: e[2], lambda e: e[3]]))
            for p in pieces:
                path = os.path.join(FILES_DIR, f"{p['id']}.{p['ext']}")
                if os.path.isfile(path):
                    z.write(path, f"pieces/{p['id']}-{p.get('filename') or 'fichier'}")
        name = f"themis-export-comptable-{datetime.now().strftime('%Y%m%d')}.zip"
        return Response(content=buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    # ---------- BILAN FINANCIER & ÉCHÉANCES (pour Sirius) ----------
    @r.get("/bilan")
    async def bilan(request: Request):
        uid = await _uid(request)
        docs = await db.themis_docs.find({"user_id": uid}, NO_ID).to_list(1000)
        payments = await db.themis_payments.find({"user_id": uid}, NO_ID).to_list(2000)
        pieces = await db.themis_pieces.find({"user_id": uid}, NO_ID).to_list(1000)
        factures = [d for d in docs if d["kind"] == "facture"]
        encaisse = round(sum(p["amount"] for p in payments), 2)
        impayees = [d for d in factures if d.get("status") not in ("payé", "refusé")]
        a_encaisser = round(sum(max(0, d.get("total_ttc", 0) - d.get("paid", 0)) for d in impayees), 2)
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
                "restant": round(max(0, d.get("total_ttc", 0) - d.get("paid", 0)), 2),
                "due_date": d["due_date"][:10], "days": (due - today).days,
            })
        echeances.sort(key=lambda e: e["days"])
        a_payer = [p for p in pieces if p.get("status") == "à_payer"]
        total_a_payer = round(sum(float(p.get("total_ttc", 0) or 0) for p in a_payer), 2)

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
        encaisse = round(sum(p["amount"] for p in payments), 2)
        a_encaisser = round(sum(max(0, d.get("total_ttc", 0) - d.get("paid", 0))
                                for d in factures if d.get("status") not in ("payé", "refusé")), 2)
        alerts = [i for i in items if int(i.get("stock", 0)) <= int(i.get("alert", 5))]
        by_method = {}
        for p in payments:
            by_method[p.get("method", "autre")] = round(by_method.get(p.get("method", "autre"), 0) + p["amount"], 2)
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
                series[k]["in"] = round(series[k]["in"] + float(p.get("amount", 0) or 0), 2)
        for p in pieces:
            k = (str(p.get("date") or "")[:7]) or str(p.get("created_at", ""))[:7]
            if k in series:
                series[k]["out"] = round(series[k]["out"] + float(p.get("total_ttc", 0) or 0), 2)
        return {
            "encaisse": encaisse, "a_encaisser": a_encaisser,
            "devis_en_cours": len([d for d in devis if d.get("status") in ("brouillon", "envoyé")]),
            "factures_impayees": len([d for d in factures if d.get("status") not in ("payé", "refusé")]),
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

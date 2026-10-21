# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Boîtes mail personnelles hors Google/Microsoft (Orange, Free, SFR, Yahoo, iCloud…).

L'utilisateur saisit son adresse et son mot de passe ; les serveurs IMAP/SMTP sont
déduits du domaine (table intégrée, puis base publique Thunderbird). La connexion
est testée avant l'enregistrement et le mot de passe est chiffré au repos."""
import asyncio
import base64
import email
import email.utils
import hashlib
import imaplib
import ipaddress
import logging
import re
import smtplib
import socket
import ssl
import time
import xml.etree.ElementTree as ET
from datetime import timezone
from email.header import decode_header, make_header
from email.message import EmailMessage
from typing import Optional

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

import email_intel
from auth_api import _AUTH_SECRET, resolve_user_id
from email_signature import add_signature_to_message, load_signature_identity

logger = logging.getLogger("sirius.personal_mail")

EMAIL_RE = re.compile(r"^[^@\s]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$")
NETWORK_TIMEOUT = 20
ALLOWED_PORTS = {143, 465, 587, 993}
MAX_FAILURES = 5
FAILURE_WINDOW = 15 * 60
ISPDB_URL = "https://autoconfig.thunderbird.net/v1.1/{domain}"

YAHOO_HELP = (
    "Yahoo demande un mot de passe d'application : sur login.yahoo.com, ouvrez "
    "« Sécurité du compte », puis « Générer un mot de passe d'application ». Collez-le ici."
)
ICLOUD_HELP = (
    "iCloud demande un mot de passe d'application : sur account.apple.com, ouvrez "
    "« Connexion et sécurité », puis « Mots de passe pour app ». Collez-le ici."
)


def _preset(label, imap_host, smtp_host, smtp_port=465, help_text="", app_password=False):
    return {
        "label": label,
        "imap_host": imap_host,
        "imap_port": 993,
        "smtp_host": smtp_host,
        "smtp_port": smtp_port,
        "help": help_text,
        "app_password": app_password,
    }


_ORANGE = _preset("Orange", "imap.orange.fr", "smtp.orange.fr")
_FREE = _preset("Free", "imap.free.fr", "smtp.free.fr")
_SFR = _preset("SFR", "imap.sfr.fr", "smtp.sfr.fr")
_LAPOSTE = _preset("La Poste", "imap.laposte.net", "smtp.laposte.net")
_YAHOO = _preset("Yahoo", "imap.mail.yahoo.com", "smtp.mail.yahoo.com", help_text=YAHOO_HELP, app_password=True)
_ICLOUD = _preset("iCloud", "imap.mail.me.com", "smtp.mail.me.com", 587, ICLOUD_HELP, True)
_GMX = _preset("GMX", "imap.gmx.net", "mail.gmx.net", 587)
_BOUYGUES = _preset("Bbox", "imap4.bbox.fr", "smtp.bbox.fr", 587)

PRESETS = {
    "orange.fr": _ORANGE, "wanadoo.fr": _ORANGE,
    "free.fr": _FREE,
    "sfr.fr": _SFR, "neuf.fr": _SFR, "cegetel.net": _SFR, "club-internet.fr": _SFR,
    "laposte.net": _LAPOSTE,
    "yahoo.fr": _YAHOO, "yahoo.com": _YAHOO, "ymail.com": _YAHOO,
    "icloud.com": _ICLOUD, "me.com": _ICLOUD, "mac.com": _ICLOUD,
    "gmx.fr": _GMX, "gmx.com": _GMX, "gmx.net": _GMX,
    "bbox.fr": _BOUYGUES,
}

OAUTH_DOMAINS = {
    "gmail.com": "google", "googlemail.com": "google",
    "outlook.com": "microsoft", "outlook.fr": "microsoft", "hotmail.com": "microsoft",
    "hotmail.fr": "microsoft", "live.com": "microsoft", "live.fr": "microsoft", "msn.com": "microsoft",
}

_failures: dict[str, list[float]] = {}


class ConnectReq(BaseModel):
    email: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=512)
    imap_host: Optional[str] = Field(default=None, max_length=253)
    imap_port: Optional[int] = None
    smtp_host: Optional[str] = Field(default=None, max_length=253)
    smtp_port: Optional[int] = None


class SendReq(BaseModel):
    to: str = Field(max_length=254)
    subject: str = Field(default="", max_length=998)
    body: str = Field(default="", max_length=100_000)


def _cipher() -> Fernet:
    digest = hashlib.sha256(_AUTH_SECRET + b"|personal-mail").digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_password(value: str) -> str:
    return _cipher().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_password(value: str) -> str:
    return _cipher().decrypt(value.encode("ascii")).decode("utf-8")


def _normalize_email(value: str) -> str:
    address = (value or "").strip().lower()
    if not EMAIL_RE.match(address):
        raise HTTPException(status_code=400, detail="Adresse e-mail invalide.")
    return address


def _valid_host(host: str) -> bool:
    return bool(re.fullmatch(r"(?=.{1,253}$)([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,63}", host or ""))


async def _fetch_ispdb(domain: str) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=False) as client:
            response = await client.get(ISPDB_URL.format(domain=domain))
        if response.status_code != 200:
            return None
        root = ET.fromstring(response.text)
    except (httpx.HTTPError, ET.ParseError):
        return None

    def server(kind: str, preferred: tuple[str, ...]):
        for node in root.iter(f"{'incoming' if kind == 'imap' else 'outgoing'}Server"):
            if node.get("type") != kind:
                continue
            host = (node.findtext("hostname") or "").strip()
            port = int((node.findtext("port") or "0").strip() or 0)
            socket_type = (node.findtext("socketType") or "").strip().upper()
            if _valid_host(host) and port in ALLOWED_PORTS and socket_type in preferred:
                return host, port
        return None

    imap = server("imap", ("SSL",))
    smtp = server("smtp", ("SSL", "STARTTLS"))
    if not imap or not smtp:
        return None
    label = (root.findtext(".//displayShortName") or domain).strip()[:40]
    return {"label": label, "imap_host": imap[0], "imap_port": imap[1], "smtp_host": smtp[0],
            "smtp_port": smtp[1], "help": "", "app_password": False}


async def detect(address: str) -> dict:
    domain = address.rsplit("@", 1)[1]
    if domain in OAUTH_DOMAINS:
        return {"domain": domain, "oauth": OAUTH_DOMAINS[domain], "known": True}
    preset = PRESETS.get(domain) or await _fetch_ispdb(domain)
    if not preset:
        return {"domain": domain, "known": False, "oauth": None}
    return {"domain": domain, "known": True, "oauth": None, **preset}


def _public_host(host: str, port: int) -> None:
    """Refuse les serveurs internes : le Cloud ne doit pas servir de rebond réseau."""
    if not _valid_host(host) or port not in ALLOWED_PORTS:
        raise HTTPException(status_code=400, detail="Serveur ou port de messagerie invalide.")
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise HTTPException(status_code=400, detail=f"Serveur {host} introuvable.") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise HTTPException(status_code=400, detail="Serveur de messagerie non autorisé.")


def _imap_login(cfg: dict, password: str) -> imaplib.IMAP4:
    context = ssl.create_default_context()
    if cfg["imap_port"] == 993:
        client = imaplib.IMAP4_SSL(cfg["imap_host"], 993, ssl_context=context, timeout=NETWORK_TIMEOUT)
    else:
        client = imaplib.IMAP4(cfg["imap_host"], cfg["imap_port"], timeout=NETWORK_TIMEOUT)
        client.starttls(ssl_context=context)
    client.login(cfg["email"], password)
    return client


def _smtp_open(cfg: dict, password: str) -> smtplib.SMTP:
    context = ssl.create_default_context()
    if cfg["smtp_port"] == 465:
        client = smtplib.SMTP_SSL(cfg["smtp_host"], 465, context=context, timeout=NETWORK_TIMEOUT)
    else:
        client = smtplib.SMTP(cfg["smtp_host"], cfg["smtp_port"], timeout=NETWORK_TIMEOUT)
        client.starttls(context=context)
    client.login(cfg["email"], password)
    return client


def _check_login(cfg: dict, password: str) -> None:
    imap = _imap_login(cfg, password)
    try:
        imap.logout()
    except (imaplib.IMAP4.error, OSError):
        pass
    smtp = _smtp_open(cfg, password)
    try:
        smtp.quit()
    except (smtplib.SMTPException, OSError):
        pass


def _decode(value) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(str(value)))).strip()
    except (UnicodeError, LookupError, ValueError):
        return str(value).strip()


def _preview(message: email.message.Message) -> str:
    part = None
    if message.is_multipart():
        for candidate in message.walk():
            if candidate.get_content_type() == "text/plain" and not candidate.get_filename():
                part = candidate
                break
    elif message.get_content_type() == "text/plain":
        part = message
    if part is None:
        return ""
    payload = part.get_payload(decode=True) or b""
    text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    return re.sub(r"\s+", " ", text).strip()[:140]


def _read_inbox(cfg: dict, password: str, top: int) -> list[dict]:
    imap = _imap_login(cfg, password)
    try:
        imap.select("INBOX", readonly=True)
        status, data = imap.uid("search", None, "ALL")
        if status != "OK":
            raise imaplib.IMAP4.error("search")
        uids = (data[0] or b"").split()[-top:][::-1]
        mails = []
        for uid in uids:
            status, parts = imap.uid("fetch", uid, "(FLAGS BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.4000>)")
            if status != "OK" or not parts:
                continue
            flags = b""
            header = b""
            text = b""
            for item in parts:
                if not isinstance(item, tuple):
                    continue
                flags += item[0]
                if b"HEADER" in item[0]:
                    header = item[1]
                elif b"TEXT" in item[0]:
                    text = item[1]
            message = email.message_from_bytes(header + b"\r\n" + text)
            name, address = email.utils.parseaddr(_decode(message.get("From")))
            received = ""
            try:
                parsed = email.utils.parsedate_to_datetime(message.get("Date"))
                if parsed:
                    received = parsed.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M")
            except (TypeError, ValueError, IndexError):
                pass
            mail = {
                "id": uid.decode("ascii"),
                "sujet": _decode(message.get("Subject")) or "(sans objet)",
                "de": name or address,
                "de_email": address.lower(),
                "recu": received,
                "lu": b"\\Seen" in flags,
                "apercu": _preview(message),
                "importance": "normal",
            }
            mails.append({**mail, **email_intel.classify_email(mail)})
        return mails
    finally:
        try:
            imap.logout()
        except (imaplib.IMAP4.error, OSError):
            pass


def _send(cfg: dict, password: str, message: EmailMessage) -> None:
    smtp = _smtp_open(cfg, password)
    try:
        smtp.send_message(message)
    finally:
        try:
            smtp.quit()
        except (smtplib.SMTPException, OSError):
            pass


def _login_error(cfg: dict) -> str:
    message = "Adresse ou mot de passe refusé par votre fournisseur."
    if cfg.get("app_password"):
        return f"{message} {cfg.get('help', '')}".strip()
    return (
        f"{message} Vérifiez le mot de passe, puis que l'accès « IMAP » ou "
        "« logiciels de messagerie » est autorisé dans les réglages de votre webmail."
    )


def _rate_limited(uid: str) -> bool:
    now = time.monotonic()
    recent = [moment for moment in _failures.get(uid, []) if now - moment < FAILURE_WINDOW]
    _failures[uid] = recent
    return len(recent) >= MAX_FAILURES


def make_personal_mail_router(db):
    router = APIRouter()

    async def _account(uid: str) -> tuple[dict, str]:
        doc = await db.personal_mail.find_one({"_id": uid})
        if not doc or not doc.get("password_enc"):
            raise HTTPException(status_code=401, detail="Aucune autre boîte mail connectée.")
        try:
            return doc, decrypt_password(doc["password_enc"])
        except InvalidToken as exc:
            raise HTTPException(status_code=401, detail="Reconnectez votre boîte mail.") from exc

    @router.get("/personal-mail/detect")
    async def personal_mail_detect(request: Request, email: str):
        await resolve_user_id(request, db)
        return await detect(_normalize_email(email))

    @router.get("/personal-mail/status")
    async def personal_mail_status(request: Request):
        doc = await db.personal_mail.find_one({"_id": await resolve_user_id(request, db)})
        if not doc or not doc.get("password_enc"):
            return {"connected": False}
        return {"connected": True, "email": doc.get("email", ""), "label": doc.get("label", "")}

    @router.post("/personal-mail/connect")
    async def personal_mail_connect(request: Request, req: ConnectReq):
        uid = await resolve_user_id(request, db)
        if _rate_limited(uid):
            raise HTTPException(status_code=429, detail="Trop d'essais. Patientez 15 minutes avant de réessayer.")
        address = _normalize_email(req.email)
        found = await detect(address)
        if found.get("oauth"):
            label = "Google" if found["oauth"] == "google" else "Microsoft"
            raise HTTPException(status_code=400, detail=f"Cette adresse se connecte en un clic avec le bouton « Connecter {label} ».")
        cfg = {key: found.get(key) for key in ("label", "imap_host", "imap_port", "smtp_host", "smtp_port", "help", "app_password")}
        if req.imap_host or req.smtp_host:
            cfg.update({
                "label": found.get("label") or found["domain"],
                "imap_host": (req.imap_host or "").strip().lower(), "imap_port": req.imap_port or 993,
                "smtp_host": (req.smtp_host or "").strip().lower(), "smtp_port": req.smtp_port or 465,
            })
        if not cfg.get("imap_host") or not cfg.get("smtp_host"):
            raise HTTPException(status_code=422, detail="Fournisseur non reconnu : ouvrez « Réglages avancés » et indiquez les serveurs fournis par votre messagerie.")
        cfg["email"] = address
        cfg["label"] = cfg.get("label") or found["domain"]
        await asyncio.to_thread(_public_host, cfg["imap_host"], cfg["imap_port"])
        await asyncio.to_thread(_public_host, cfg["smtp_host"], cfg["smtp_port"])
        try:
            await asyncio.to_thread(_check_login, cfg, req.password)
        except (imaplib.IMAP4.error, smtplib.SMTPAuthenticationError) as exc:
            _failures.setdefault(uid, []).append(time.monotonic())
            logger.info("[MAIL PERSO] identifiants refusés pour %s", found["domain"])
            raise HTTPException(status_code=400, detail=_login_error(cfg)) from exc
        except (OSError, smtplib.SMTPException, ssl.SSLError) as exc:
            logger.warning("[MAIL PERSO] serveur injoignable pour %s : %s", found["domain"], type(exc).__name__)
            raise HTTPException(status_code=502, detail=f"Impossible de joindre les serveurs {cfg['label']}. Vérifiez la connexion internet et réessayez.") from exc
        _failures.pop(uid, None)
        stored = {key: cfg[key] for key in ("email", "label", "imap_host", "imap_port", "smtp_host", "smtp_port")}
        await db.personal_mail.update_one({"_id": uid}, {"$set": {**stored, "password_enc": encrypt_password(req.password)}}, upsert=True)
        return {"connected": True, "email": address, "label": cfg["label"]}

    @router.post("/personal-mail/disconnect")
    async def personal_mail_disconnect(request: Request):
        await db.personal_mail.delete_one({"_id": await resolve_user_id(request, db)})
        return {"connected": False}

    @router.get("/personal-mail/messages")
    async def personal_mail_messages(request: Request, top: int = 25):
        doc, password = await _account(await resolve_user_id(request, db))
        try:
            mails = await asyncio.to_thread(_read_inbox, doc, password, max(1, min(top, 25)))
        except imaplib.IMAP4.error as exc:
            raise HTTPException(status_code=401, detail="Votre fournisseur refuse la connexion : reconnectez la boîte dans le Centre des connexions.") from exc
        except (OSError, ssl.SSLError) as exc:
            raise HTTPException(status_code=502, detail=f"{doc.get('label') or 'La messagerie'} ne répond pas. Réessayez.") from exc
        return {"non_lus": sum(1 for mail in mails if not mail["lu"]), "mails": mails, "total": len(mails)}

    @router.post("/personal-mail/send")
    async def personal_mail_send(request: Request, req: SendReq):
        uid = await resolve_user_id(request, db)
        doc, password = await _account(uid)
        to = (req.to or "").strip()
        if not EMAIL_RE.match(to):
            raise HTTPException(status_code=400, detail="Destinataire invalide.")
        message = EmailMessage()
        add_signature_to_message(message, req.body, **await load_signature_identity(db, uid))
        message["From"] = doc["email"]
        message["To"] = to
        message["Subject"] = req.subject
        message["Date"] = email.utils.formatdate(localtime=True)
        message["Message-ID"] = email.utils.make_msgid(domain=doc["email"].rsplit("@", 1)[1])
        try:
            await asyncio.to_thread(_send, doc, password, message)
        except smtplib.SMTPAuthenticationError as exc:
            raise HTTPException(status_code=401, detail="Votre fournisseur refuse l'envoi : reconnectez la boîte.") from exc
        except smtplib.SMTPRecipientsRefused as exc:
            raise HTTPException(status_code=400, detail="Destinataire refusé par votre fournisseur.") from exc
        except (OSError, smtplib.SMTPException, ssl.SSLError) as exc:
            raise HTTPException(status_code=502, detail="Envoi impossible pour le moment.") from exc
        return {"ok": True}

    return router

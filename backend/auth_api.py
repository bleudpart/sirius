"""Authenticated multi-user session boundary for SIRIUS."""

import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import smtplib
import ssl
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Optional

import bcrypt
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

LEGACY_UID = "daniel@sirius.local"
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}
_FORWARDED_HEADERS = {"forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"}
_ACCESS_TTL_SECONDS = 12 * 60 * 60
_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60
_LOCK_SECONDS = 15 * 60
_RESET_TTL_SECONDS = 10 * 60


def _load_or_create_secret() -> bytes:
    env_secret = os.getenv("SIRIUS_AUTH_SECRET")
    if env_secret:
        return env_secret.encode("utf-8")
    try:
        from runtime_paths import data_dir

        secret_path = data_dir() / ".auth_secret"
        if secret_path.exists():
            stored = secret_path.read_text(encoding="utf-8").strip()
            if stored:
                return stored.encode("utf-8")
        generated = secrets.token_urlsafe(48)
        secret_path.write_text(generated, encoding="utf-8")
        try:
            os.chmod(secret_path, 0o600)
        except OSError:
            pass
        return generated.encode("utf-8")
    except Exception:
        return secrets.token_urlsafe(48).encode("utf-8")


_AUTH_SECRET = _load_or_create_secret()


class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(LoginRequest):
    name: str = ""


class PasswordResetRequest(BaseModel):
    email: str


class PasswordResetConfirm(BaseModel):
    email: str
    code: str
    password: str


def _normalize_email(value: str) -> str:
    email = (value or "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise HTTPException(status_code=400, detail="Adresse email invalide.")
    return email


def _password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def _password_valid(password: str, encoded: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), encoded.encode("ascii"))
    except (ValueError, TypeError):
        return False


def is_direct_local_request(request: Request) -> bool:
    if any(header in request.headers for header in _FORWARDED_HEADERS):
        return False
    if not request.client:
        return False
    if request.client.host in _LOCAL_HOSTS:
        return True
    if request.client.host == "testclient":
        return "PYTEST_CURRENT_TEST" in os.environ
    if os.getenv("SIRIUS_ALLOW_LAN_AUTH", "").strip() == "1":
        try:
            return ipaddress.ip_address(request.client.host).is_private
        except ValueError:
            return False
    return False


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _token(user_id: str, email: str, role: str, ttl: int, token_type: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "type": token_type,
        "exp": int(time.time()) + ttl,
        "nonce": secrets.token_hex(8),
    }
    encoded = _b64encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64encode(hmac.new(_AUTH_SECRET, encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def _decode_token(token: str, expected_type: str = "access") -> dict:
    try:
        encoded, signature = token.split(".", 1)
        expected = _b64encode(hmac.new(_AUTH_SECRET, encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        payload = json.loads(_b64decode(encoded))
    except (ValueError, TypeError, UnicodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=401, detail="Session invalide.") from error
    if payload.get("type") != expected_type or int(payload.get("exp") or 0) <= int(time.time()):
        raise HTTPException(status_code=401, detail="Session expirée.")
    return payload


def create_access_token(user_id, email: str | None = None, role: str = "user") -> str:
    if isinstance(user_id, dict):
        data = user_id
        user_id = data.get("user_id") or data.get("sub") or data.get("email") or LEGACY_UID
        email = data.get("email") or email or str(user_id)
        role = data.get("role") or role
    return _token(str(user_id), email or str(user_id), role, _ACCESS_TTL_SECONDS, "access")


def create_refresh_token(user_id, email: str | None = None, role: str = "user") -> str:
    if isinstance(user_id, dict):
        data = user_id
        user_id = data.get("user_id") or data.get("sub") or data.get("email") or LEGACY_UID
        email = data.get("email") or email or str(user_id)
        role = data.get("role") or role
    return _token(str(user_id), email or str(user_id), role, _REFRESH_TTL_SECONDS, "refresh")


def _public_user(document: dict) -> dict:
    email = document.get("email") or LEGACY_UID
    return {
        "email": email,
        "user_id": document.get("user_id") or email,
        "name": document.get("name") or email.split("@", 1)[0],
        "role": document.get("role") or "user",
        "provider": document.get("provider") or "email",
        "preferences": document.get("preferences") if isinstance(document.get("preferences"), dict) else {},
        "disabled": bool(document.get("disabled")),
    }


def _set_cookies(response: Response, access_token: str, refresh_token: Optional[str] = None):
    options = {"httponly": True, "secure": True, "samesite": "none", "path": "/"}
    response.set_cookie("access_token", access_token, max_age=_ACCESS_TTL_SECONDS, **options)
    if refresh_token:
        response.set_cookie("refresh_token", refresh_token, max_age=_REFRESH_TTL_SECONDS, **options)


def _issue_session(response: Response, user: dict) -> dict:
    access = create_access_token(user)
    refresh = create_refresh_token(user)
    _set_cookies(response, access, refresh)
    return {**_public_user(user), "access_token": access}


async def require_user(request: Request, db=None) -> dict:
    token = request.cookies.get("access_token") or ""
    if not token:
        authorization = request.headers.get("authorization") or ""
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Authentification requise.")
    payload = _decode_token(token)
    user = {"user_id": payload.get("sub"), "email": payload.get("email"), "role": payload.get("role") or "user"}
    if db is not None:
        stored = await db.users.find_one({"user_id": user["user_id"]})
        if not stored or stored.get("disabled"):
            raise HTTPException(status_code=401, detail="Compte indisponible.")
        return _public_user(stored)
    return _public_user(user)


async def resolve_user_id(request: Request, db=None) -> str:
    return (await require_user(request, db))["user_id"]


async def seed_admin_and_indexes(db):
    await db.users.create_index("email", unique=True)
    await db.users.create_index("user_id", unique=True)
    await db.login_attempts.create_index("expires_at", expireAfterSeconds=0)
    await db.password_reset_codes.create_index("expires_at", expireAfterSeconds=0)
    admin_email = (os.getenv("ADMIN_EMAIL") or os.getenv("SIRIUS_LOCAL_EMAIL") or "").strip().lower()
    admin_password = (os.getenv("ADMIN_PASSWORD") or os.getenv("SIRIUS_LOCAL_PASSWORD") or "").strip()
    if not admin_email or not admin_password:
        return
    existing = await db.users.find_one({"email": admin_email})
    now = datetime.now(timezone.utc)
    if existing:
        updates = {"role": "admin", "name": existing.get("name") or "Daniel", "updated_at": now}
        if not _password_valid(admin_password, existing.get("password_hash") or ""):
            updates["password_hash"] = _password_hash(admin_password)
        await db.users.update_one({"email": admin_email}, {"$set": updates})
        return
    await db.users.insert_one({
        "user_id": f"user_{secrets.token_hex(12)}",
        "email": admin_email,
        "password_hash": _password_hash(admin_password),
        "name": "Daniel",
        "role": "admin",
        "provider": "email",
        "preferences": {},
        "disabled": False,
        "created_at": now,
        "updated_at": now,
    })


async def _send_reset_email(email: str, code: str):
    host = (os.getenv("SIRIUS_SMTP_HOST") or "").strip()
    sender = (os.getenv("SIRIUS_SMTP_FROM") or os.getenv("SIRIUS_SMTP_USER") or "").strip()
    if not host or not sender:
        raise HTTPException(status_code=503, detail="Service email temporairement indisponible.")
    port = int(os.getenv("SIRIUS_SMTP_PORT") or "587")
    username = (os.getenv("SIRIUS_SMTP_USER") or "").strip()
    password = os.getenv("SIRIUS_SMTP_PASSWORD") or ""
    use_ssl = os.getenv("SIRIUS_SMTP_SSL", "").strip() == "1"
    message = EmailMessage()
    message["From"] = sender
    message["To"] = email
    message["Subject"] = "Votre code de récupération SIRIUS"
    message.set_content(
        f"Votre code de récupération SIRIUS est : {code}\n\n"
        "Ce code expire dans 10 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message."
    )

    def send():
        if use_ssl:
            client = smtplib.SMTP_SSL(host, port, timeout=20, context=ssl.create_default_context())
        else:
            client = smtplib.SMTP(host, port, timeout=20)
        with client:
            if not use_ssl:
                client.starttls(context=ssl.create_default_context())
            if username:
                client.login(username, password)
            client.send_message(message)

    try:
        await asyncio.to_thread(send)
    except (OSError, smtplib.SMTPException) as error:
        raise HTTPException(status_code=503, detail="Envoi du code impossible pour le moment.") from error


def make_auth_router(db):
    router = APIRouter(prefix="/auth", tags=["auth"])

    @router.post("/local-session")
    async def local_session(request: Request, response: Response):
        if not is_direct_local_request(request):
            raise HTTPException(status_code=403, detail="Session automatique réservée à la machine locale.")
        email = (os.getenv("ADMIN_EMAIL") or os.getenv("SIRIUS_LOCAL_EMAIL") or "").strip().lower()
        user = await db.users.find_one({"email": email}) if email else None
        if not user:
            raise HTTPException(status_code=503, detail="Compte administrateur non configuré.")
        return _issue_session(response, user)

    @router.post("/register")
    async def register(data: RegisterRequest, response: Response):
        email = _normalize_email(data.email)
        password = data.password.strip()
        if len(password) < 6:
            raise HTTPException(status_code=400, detail="Le mot de passe doit contenir au moins 6 caractères.")
        if await db.users.find_one({"email": email}):
            raise HTTPException(status_code=409, detail="Un compte existe déjà avec cette adresse.")
        now = datetime.now(timezone.utc)
        user = {
            "user_id": f"user_{secrets.token_hex(12)}",
            "email": email,
            "password_hash": _password_hash(password),
            "name": data.name.strip()[:120] or email.split("@", 1)[0],
            "role": "user",
            "provider": "email",
            "preferences": {},
            "disabled": False,
            "created_at": now,
            "updated_at": now,
        }
        await db.users.insert_one(user)
        return _issue_session(response, user)

    @router.post("/login")
    async def login(data: LoginRequest, response: Response):
        email = _normalize_email(data.email)
        identifier = f"login:{email}"
        now = datetime.now(timezone.utc)
        attempt = await db.login_attempts.find_one({"identifier": identifier})
        if attempt and attempt.get("count", 0) >= 5 and attempt.get("expires_at", now) > now:
            raise HTTPException(status_code=429, detail="Trop de tentatives. Réessayez dans 15 minutes.")
        user = await db.users.find_one({"email": email})
        if not user or user.get("disabled") or not _password_valid(data.password, user.get("password_hash") or ""):
            count = int((attempt or {}).get("count") or 0) + 1
            await db.login_attempts.update_one(
                {"identifier": identifier},
                {"$set": {"count": count, "expires_at": now + timedelta(seconds=_LOCK_SECONDS)}},
                upsert=True,
            )
            raise HTTPException(status_code=401, detail="Email ou mot de passe incorrect.")
        await db.login_attempts.delete_one({"identifier": identifier})
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"last_activity": now}})
        return _issue_session(response, user)

    @router.post("/password-reset/request")
    async def password_reset_request(data: PasswordResetRequest):
        email = _normalize_email(data.email)
        now = datetime.now(timezone.utc)
        existing = await db.password_reset_codes.find_one({"email": email})
        if existing and existing.get("requested_at", now) > now - timedelta(seconds=60):
            raise HTTPException(status_code=429, detail="Veuillez attendre une minute avant de redemander un code.")
        user = await db.users.find_one({"email": email, "disabled": {"$ne": True}})
        if user:
            code = f"{secrets.randbelow(1_000_000):06d}"
            code_hash = hmac.new(_AUTH_SECRET, f"{email}:{code}".encode("utf-8"), hashlib.sha256).hexdigest()
            await db.password_reset_codes.update_one(
                {"email": email},
                {"$set": {
                    "email": email,
                    "code_hash": code_hash,
                    "attempts": 0,
                    "requested_at": now,
                    "expires_at": now + timedelta(seconds=_RESET_TTL_SECONDS),
                }},
                upsert=True,
            )
            await _send_reset_email(email, code)
        return {"ok": True, "message": "Si ce compte existe, un code vient d'être envoyé."}

    @router.post("/password-reset/confirm")
    async def password_reset_confirm(data: PasswordResetConfirm):
        email = _normalize_email(data.email)
        password = data.password.strip()
        if len(password) < 8:
            raise HTTPException(status_code=400, detail="Le mot de passe doit contenir au moins 8 caractères.")
        record = await db.password_reset_codes.find_one({"email": email})
        now = datetime.now(timezone.utc)
        if not record or record.get("expires_at", now) <= now or int(record.get("attempts") or 0) >= 5:
            raise HTTPException(status_code=400, detail="Code invalide ou expiré.")
        expected = hmac.new(_AUTH_SECRET, f"{email}:{data.code.strip()}".encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, record.get("code_hash") or ""):
            await db.password_reset_codes.update_one({"email": email}, {"$inc": {"attempts": 1}})
            raise HTTPException(status_code=400, detail="Code invalide ou expiré.")
        result = await db.users.update_one(
            {"email": email, "disabled": {"$ne": True}},
            {"$set": {"password_hash": _password_hash(password), "updated_at": now}},
        )
        await db.password_reset_codes.delete_one({"email": email})
        await db.login_attempts.delete_one({"identifier": f"login:{email}"})
        if not result.modified_count:
            raise HTTPException(status_code=400, detail="Code invalide ou expiré.")
        return {"ok": True}

    @router.get("/me")
    async def current_user(request: Request):
        return await require_user(request, db)

    @router.post("/logout")
    async def logout(response: Response):
        response.delete_cookie("access_token", path="/")
        response.delete_cookie("refresh_token", path="/")
        return {"ok": True}

    @router.put("/profile")
    async def update_profile(data: dict, request: Request):
        user = await require_user(request, db)
        updates = {"updated_at": datetime.now(timezone.utc)}
        if isinstance(data.get("name"), str):
            updates["name"] = data["name"].strip()[:120]
        if isinstance(data.get("preferences"), dict):
            updates["preferences"] = data["preferences"]
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": updates})
        stored = await db.users.find_one({"user_id": user["user_id"]})
        return _public_user(stored)

    return router


def make_admin_router(db):
    router = APIRouter(prefix="/admin", tags=["admin"])

    async def require_admin(request: Request):
        user = await require_user(request, db)
        if user["role"] != "admin":
            raise HTTPException(status_code=403, detail="Accès administrateur requis.")
        return user

    @router.get("/users")
    async def list_users(request: Request):
        await require_admin(request)
        users = []
        async for document in db.users.find({}):
            user = _public_user(document)
            uid = user["user_id"]
            last_activity = document.get("last_activity") or document.get("created_at") or datetime.now(timezone.utc)
            user["activity"] = {
                "messages": await db.sirius_chats.count_documents({"user_id": uid}),
                "last_activity": int(last_activity.timestamp()),
                "facts": await db.local_memory.count_documents({"user_id": uid}),
                "deals": await db.agora_deals.count_documents({"user_id": uid}),
                "transactions": await db.payment_transactions.count_documents({"user_id": uid}),
                "themis_docs": await db.themis_docs.count_documents({"user_id": uid}),
                "themis_clients": await db.themis_clients.count_documents({"user_id": uid}),
            }
            users.append(user)
        return {"users": users, "total": len(users)}

    @router.put("/users/{user_id}/disable")
    async def disable_user(user_id: str, request: Request):
        await require_admin(request)
        stored = await db.users.find_one({"user_id": user_id})
        if not stored:
            raise HTTPException(status_code=404, detail="Compte introuvable.")
        await db.users.update_one({"user_id": user_id}, {"$set": {"disabled": not bool(stored.get("disabled"))}})
        return {"ok": True}

    @router.delete("/users/{user_id}")
    async def delete_user(user_id: str, request: Request):
        admin = await require_admin(request)
        if user_id == admin["user_id"]:
            raise HTTPException(status_code=400, detail="Le compte administrateur actif ne peut pas être supprimé.")
        result = await db.users.delete_one({"user_id": user_id})
        if not result.deleted_count:
            raise HTTPException(status_code=404, detail="Compte introuvable.")
        return {"ok": True}

    return router

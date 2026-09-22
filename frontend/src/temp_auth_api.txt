"""Local-first authenticated session boundary for ΣIRIUS."""

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel


router = APIRouter(prefix="/auth", tags=["auth"])
LEGACY_UID = "daniel@sirius.local"
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}
_FORWARDED_HEADERS = {"forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"}
_ACCESS_TTL_SECONDS = 12 * 60 * 60
_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60


def _load_or_create_secret() -> bytes:
    """Secret HMAC stable : env prioritaire, sinon persisté dans le dossier de données.

    Sans persistance, un secret aléatoire par process invaliderait toutes les sessions
    à chaque redémarrage du backend.
    """
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
        # Dernier recours : secret éphémère (sessions invalidées au redémarrage).
        return secrets.token_urlsafe(48).encode("utf-8")


_AUTH_SECRET = _load_or_create_secret()
_LOCAL_EMAIL = (os.getenv("SIRIUS_LOCAL_EMAIL") or LEGACY_UID).strip().lower()
_LOCAL_PASSWORD = (os.getenv("SIRIUS_LOCAL_PASSWORD") or "").strip()


class LoginRequest(BaseModel):
    email: str
    password: Optional[str] = None


class PasswordResetRequest(BaseModel):
    email: str
    password: str


def _password_override_path():
    try:
        from runtime_paths import data_dir

        return data_dir() / ".local_password_hash"
    except Exception:
        return None


def _password_matches(password: str) -> bool:
    override_path = _password_override_path()
    if override_path and override_path.exists():
        try:
            salt, expected = override_path.read_text(encoding="utf-8").strip().split(":", 1)
            derived = hashlib.scrypt(password.encode("utf-8"), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
            return hmac.compare_digest(derived.hex(), expected)
        except (OSError, ValueError):
            return False
    return not _LOCAL_PASSWORD or hmac.compare_digest(password, _LOCAL_PASSWORD)


def _store_password(password: str):
    path = _password_override_path()
    if path is None:
        raise HTTPException(status_code=500, detail="Stockage local indisponible.")
    salt = secrets.token_bytes(16)
    derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{salt.hex()}:{derived.hex()}", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


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


def _user(payload: dict) -> dict:
    email = payload.get("email") or LEGACY_UID
    return {
        "email": email,
        "user_id": payload.get("sub") or email,
        "name": "Daniel" if email == LEGACY_UID else email.split("@", 1)[0],
        "role": payload.get("role") or "user",
        "provider": "local",
        "preferences": {},
    }


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


def _set_cookies(response: Response, access_token: str, refresh_token: Optional[str] = None):
    cookie_options = {
        "httponly": True,
        "secure": os.getenv("SIRIUS_COOKIE_SECURE", "").strip() == "1",
        "samesite": "strict",
        "path": "/",
    }
    response.set_cookie("access_token", access_token, max_age=_ACCESS_TTL_SECONDS, **cookie_options)
    if refresh_token:
        response.set_cookie("refresh_token", refresh_token, max_age=_REFRESH_TTL_SECONDS, **cookie_options)


async def require_user(request: Request, db=None) -> dict:
    del db
    # Cookie d'abord ; fallback Authorization: Bearer quand le cookie SameSite
    # n'est pas rejoué (page localhost:3000 → API 127.0.0.1:8001 = cross-site).
    token = request.cookies.get("access_token") or ""
    if not token:
        auth_header = request.headers.get("authorization") or ""
        if auth_header.lower().startswith("bearer "):
            token = auth_header[7:].strip()
    return _user(_decode_token(token))


async def resolve_user_id(request: Request, db=None) -> str:
    return (await require_user(request, db))["user_id"]


@router.post("/local-session")
async def local_session(request: Request, response: Response):
    if not is_direct_local_request(request):
        raise HTTPException(status_code=403, detail="Session automatique réservée à la machine locale.")
    access = create_access_token(_LOCAL_EMAIL, _LOCAL_EMAIL, "admin")
    refresh = create_refresh_token(_LOCAL_EMAIL, _LOCAL_EMAIL, "admin")
    _set_cookies(response, access, refresh)
    return {**_user({"sub": _LOCAL_EMAIL, "email": _LOCAL_EMAIL, "role": "admin"}), "access_token": access}


@router.post("/login")
async def login(data: LoginRequest, request: Request, response: Response):
    if not is_direct_local_request(request):
        raise HTTPException(status_code=403, detail="Connexion locale refusée depuis cette machine.")
    if data.email.strip().lower() != _LOCAL_EMAIL:
        raise HTTPException(status_code=401, detail="Identifiants invalides.")
    if not _password_matches(data.password or ""):
        raise HTTPException(status_code=401, detail="Identifiants invalides.")
    access = create_access_token(_LOCAL_EMAIL, _LOCAL_EMAIL, "admin")
    refresh = create_refresh_token(_LOCAL_EMAIL, _LOCAL_EMAIL, "admin")
    _set_cookies(response, access, refresh)
    return {**_user({"sub": _LOCAL_EMAIL, "email": _LOCAL_EMAIL, "role": "admin"}), "access_token": access}


@router.post("/reset-password")
async def reset_password(data: PasswordResetRequest, request: Request):
    if not is_direct_local_request(request):
        raise HTTPException(status_code=403, detail="Réinitialisation réservée à la machine locale.")
    email = data.email.strip().lower()
    password = data.password.strip()
    if email != _LOCAL_EMAIL:
        raise HTTPException(status_code=400, detail="Adresse email incorrecte.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Le mot de passe doit contenir au moins 8 caractères.")
    _store_password(password)
    return {"status": "password_updated"}


@router.get("/me")
async def get_current_user(request: Request):
    return await require_user(request)


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"status": "logged_out"}


@router.put("/profile")
async def update_profile(data: dict, request: Request):
    user = await require_user(request)
    return {
        **user,
        "name": str(data.get("name") or user["name"])[:120],
        "preferences": data.get("preferences") if isinstance(data.get("preferences"), dict) else {},
    }


def make_auth_router(*args, **kwargs):
    return router


def make_admin_router(*args, **kwargs):
    return router


async def seed_admin_and_indexes(*args, **kwargs):
    return None

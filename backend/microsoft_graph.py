# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
"""Microsoft Entra ID (connexion) + Microsoft Graph (Outlook, Calendrier) pour SIRIUS."""
import base64
import hashlib
import logging
import os
import secrets
import uuid
from datetime import datetime, timezone, timedelta
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse

from auth_api import create_access_token, create_refresh_token, _set_cookies, require_user, resolve_user_id, LEGACY_UID

logger = logging.getLogger("sirius.microsoft")

AUTHORITY = "https://login.microsoftonline.com/common"
AUTHORIZE_URL = f"{AUTHORITY}/oauth2/v2.0/authorize"
TOKEN_URL = f"{AUTHORITY}/oauth2/v2.0/token"
GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = "openid profile email offline_access User.Read Mail.Read Calendars.Read"


def _conf():
    cid = os.environ.get("MICROSOFT_CLIENT_ID", "")
    secret = os.environ.get("MICROSOFT_CLIENT_SECRET", "")
    redirect = os.environ.get("MICROSOFT_REDIRECT_URI", "")
    if not cid or not secret or not redirect:
        raise HTTPException(status_code=503, detail="Microsoft non configuré (variables MICROSOFT_* manquantes).")
    return cid, secret, redirect


def _fernet() -> Fernet:
    return Fernet(os.environ["MS_TOKEN_KEY"].encode())


def _enc(v: str) -> str:
    return _fernet().encrypt(v.encode()).decode()


def _dec(v: str) -> str:
    return _fernet().decrypt(v.encode()).decode()


def _pkce():
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


async def _save_tokens(db, user_id: str, token: dict, email: str):
    now = datetime.now(timezone.utc)
    doc = {
        "access_token": _enc(token["ac" + "cess_" + "token"]),
        "expires_at": (now + timedelta(seconds=int(token.get("expires_in", 3600)))).isoformat(),
        "email": email,
        "updated_at": now.isoformat(),
    }
    if token.get("refresh_token"):
        doc["refresh_token"] = _enc(token["refresh_token"])
    await db.microsoft_oauth.update_one({"_id": user_id}, {"$set": doc}, upsert=True)


async def _access_token(db, user_id: str) -> str:
    doc = await db.microsoft_oauth.find_one({"_id": user_id})
    if not doc:
        raise HTTPException(status_code=409, detail="Compte Microsoft non connecté.")
    now = datetime.now(timezone.utc)
    if datetime.fromisoformat(doc["expires_at"]) > now + timedelta(minutes=2):
        return _dec(doc["access_token"])
    if not doc.get("refresh_token"):
        raise HTTPException(status_code=401, detail="Session Microsoft expirée — reconnecte ton compte.")
    cid, secret, _ = _conf()
    async with httpx.AsyncClient(timeout=15) as cx:
        r = await cx.post(TOKEN_URL, data={
            "client_id": cid, "client_secret": secret, "grant_type": "refresh_token",
            "refresh_token": _dec(doc["refresh_token"]), "scope": SCOPES,
        })
    data = r.json()
    if r.is_error or "access_token" not in data:
        if data.get("error") == "invalid_grant":
            await db.microsoft_oauth.delete_one({"_id": user_id})
        logger.error("[MICROSOFT] refresh échoué: %s", data.get("error"))
        raise HTTPException(status_code=401, detail="Jeton Microsoft expiré — reconnecte ton compte.")
    await _save_tokens(db, user_id, data, doc.get("email", ""))
    return data["ac" + "cess_" + "token"]


async def _graph_get(db, user_id: str, path: str, params=None, headers=None):
    token = await _access_token(db, user_id)
    h = {"Authorization": "Bearer " + token}
    if headers:
        h.update(headers)
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.get(f"{GRAPH}{path}", headers=h, params=params)
    if r.status_code == 401:
        raise HTTPException(status_code=401, detail="Autorisation Microsoft expirée — reconnecte ton compte.")
    r.raise_for_status()
    return r.json()


async def ms_today_events(db, user_id: str, tz_name: str = "Europe/Paris"):
    """Événements du jour (calendrier Microsoft) — pour le briefing."""
    from zoneinfo import ZoneInfo
    now_local = datetime.now(ZoneInfo(tz_name))
    start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    data = await _graph_get(db, user_id, "/me/calendar/calendarView", {
        "startDateTime": start.isoformat(), "endDateTime": end.isoformat(),
        "$select": "subject,start,end,location,isAllDay",
        "$orderby": "start/dateTime", "$top": "20",
    }, {"Prefer": f'outlook.timezone="{tz_name}"'})
    events = []
    for e in data.get("value", []):
        events.append({
            "titre": e.get("subject", "(sans titre)"),
            "debut": (e.get("start") or {}).get("dateTime", "")[:16],
            "fin": (e.get("end") or {}).get("dateTime", "")[:16],
            "lieu": ((e.get("location") or {}).get("displayName")) or "",
            "journee": bool(e.get("isAllDay")),
        })
    return events


async def ms_recent_mail(db, user_id: str, top: int = 10):
    """Derniers mails Outlook (boîte de réception)."""
    data = await _graph_get(db, user_id, "/me/mailFolders/inbox/messages", {
        "$select": "subject,from,receivedDateTime,isRead,bodyPreview",
        "$orderby": "receivedDateTime DESC", "$top": str(top),
    })
    mails = []
    for m in data.get("value", []):
        sender = ((m.get("from") or {}).get("emailAddress") or {})
        mails.append({
            "sujet": m.get("subject", "(sans objet)"),
            "de": sender.get("name") or sender.get("address", ""),
            "recu": (m.get("receivedDateTime") or "")[:16],
            "lu": bool(m.get("isRead")),
            "apercu": (m.get("bodyPreview") or "")[:140],
        })
    return mails


def make_microsoft_router(db):
    router = APIRouter()

    @router.get("/auth/microsoft/login")
    async def microsoft_login(request: Request):
        cid, _, redirect = _conf()
        state = secrets.token_urlsafe(32)
        verifier, challenge = _pkce()
        uid = await resolve_user_id(request, db)
        await db.oauth_states.insert_one({
            "_id": state, "code_verifier": verifier,
            "uid": uid if uid != LEGACY_UID else None,
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        })
        params = urlencode({
            "client_id": cid, "response_type": "code", "redirect_uri": redirect,
            "response_mode": "query", "scope": SCOPES, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256",
            "prompt": "select_account",
        })
        return RedirectResponse(f"{AUTHORIZE_URL}?{params}", status_code=302)

    @router.get("/auth/callback/microsoft-entra-id")
    async def microsoft_callback(response: Response, code: str = "", state: str = "", error: str = ""):
        if error or not code or not state:
            logger.error("[MICROSOFT] callback refusé: %s", error)
            return RedirectResponse("/?ms=error", status_code=302)
        st = await db.oauth_states.find_one_and_delete({"_id": state})
        if not st or datetime.fromisoformat(st["expires_at"]) < datetime.now(timezone.utc):
            return RedirectResponse("/?ms=state", status_code=302)
        cid, secret, redirect = _conf()
        async with httpx.AsyncClient(timeout=20) as cx:
            r = await cx.post(TOKEN_URL, data={
                "client_id": cid, "client_secret": secret, "grant_type": "authorization_code",
                "code": code, "redirect_uri": redirect, "scope": SCOPES,
                "code_verifier": st["code_verifier"],
            })
            token = r.json()
            if r.is_error or "access_token" not in token:
                logger.error("[MICROSOFT] échange de code échoué: %s", token.get("error_description", "")[:200])
                return RedirectResponse("/?ms=token", status_code=302)
            p = await cx.get(f"{GRAPH}/me", headers={"Authorization": "Bearer " + token["ac" + "cess_" + "token"]}, params={"$select": "id,displayName,mail,userPrincipalName"})
            if p.is_error:
                return RedirectResponse("/?ms=profile", status_code=302)
            profile = p.json()

        email = (profile.get("mail") or profile.get("userPrincipalName") or "").lower()
        ms_id = profile.get("id", "")
        user = None
        if st.get("uid"):
            user = await db.users.find_one({"user_id": st["uid"]})
        if not user and ms_id:
            user = await db.users.find_one({"microsoft_id": ms_id})
        if not user and email:
            user = await db.users.find_one({"email": email})
        if not user:
            user = {"user_id": f"user_{uuid.uuid4().hex[:12]}", "email": email,
                    "name": profile.get("displayName") or (email.split("@")[0] if email else "Invité Microsoft"),
                    "provider": "microsoft", "microsoft_id": ms_id, "preferences": {},
                    "created_at": datetime.now(timezone.utc).isoformat()}
            await db.users.insert_one(dict(user))
        else:
            await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"microsoft_id": ms_id}})

        await _save_tokens(db, user["user_id"], token, email)
        resp = RedirectResponse("/?ms=connected", status_code=302)
        _set_cookies(resp, create_access_token(user["user_id"], user.get("email", email)),
                     create_refresh_token(user["user_id"]))
        logger.info("[MICROSOFT] %s connecté", email or ms_id)
        return resp

    @router.get("/microsoft/status")
    async def microsoft_status(request: Request):
        user = await require_user(request, db)
        doc = await db.microsoft_oauth.find_one({"_id": user["user_id"]})
        return {"connected": bool(doc), "email": (doc or {}).get("email", "")} 

    @router.get("/microsoft/mail")
    async def microsoft_mail(request: Request, top: int = 10):
        user = await require_user(request, db)
        return {"mails": await ms_recent_mail(db, user["user_id"], top=min(top, 25))}

    @router.get("/microsoft/calendar/today")
    async def microsoft_calendar_today(request: Request):
        user = await require_user(request, db)
        return {"events": await ms_today_events(db, user["user_id"])}

    @router.post("/microsoft/disconnect")
    async def microsoft_disconnect(request: Request):
        user = await require_user(request, db)
        await db.microsoft_oauth.delete_one({"_id": user["user_id"]})
        return {"ok": True}

    return router

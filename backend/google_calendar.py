# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
"""Intégration Google Calendar : OAuth2 + lecture/création d'événements (httpx, sans SDK)."""
import os
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

TOKEN_URL = "https://oauth2.googleapis.com/token"
AUTH_URL = "https://accounts.google.com/o/oauth2/auth"
CAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
SCOPE = "https://www.googleapis.com/auth/calendar"
DOC_ID = "default"

# Le SPA (localhost:3000 en dev) et l'API sont deux serveurs distincts : une redirection
# relative "/?gcal=..." émise par l'API se résout par rapport à l'API elle-même (un ancien
# build React figé), pas l'application réellement utilisée. On redirige donc explicitement
# vers l'origine du SPA — voir le même correctif dans microsoft_graph.py.
FRONTEND_URL = (os.environ.get("FRONTEND_URL") or "http://localhost:3000").rstrip("/")


def _client_conf():
    cid = os.environ.get("GOOGLE_CLIENT_ID")
    csec = os.environ.get("GOOGLE_CLIENT_SECRET")
    if not cid or not csec:
        raise HTTPException(status_code=503, detail="Google Calendar non configuré (GOOGLE_CLIENT_ID/SECRET manquants).")
    return cid, csec


def _redirect_uri(request: Request) -> str:
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    proto = request.headers.get("x-forwarded-proto", "https")
    return f"{proto}://{host}/api/oauth/calendar/callback"


class EventIn(BaseModel):
    title: str
    start: str
    end: str = ""
    description: str = ""


def make_gcal_router(db):
    router = APIRouter()

    async def _uid(request: Request) -> str:
        from auth_api import resolve_user_id
        return await resolve_user_id(request, db)

    async def _get_token(uid: str) -> str:
        doc = await db.google_calendar.find_one({"_id": uid})
        if not doc or not doc.get("tokens"):
            raise HTTPException(status_code=401, detail="Google Calendar non connecté.")
        tokens = doc["tokens"]
        exp = doc.get("expires_at")
        if exp and datetime.fromisoformat(exp) > datetime.now(timezone.utc) + timedelta(seconds=60):
            return tokens["access_token"]
        refresh = tokens.get("refresh_token")
        if not refresh:
            raise HTTPException(status_code=401, detail="Session Google expirée, reconnectez-vous.")
        cid, csec = _client_conf()
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.post(
                TOKEN_URL,
                data={
                    "client_id": cid,
                    "client_secret": csec,
                    "refresh_token": refresh,
                    "grant_type": "refresh_token",
                },
            )
        if r.status_code != 200:
            raise HTTPException(status_code=401, detail="Rafraîchissement du jeton Google refusé, reconnectez-vous.")
        new = r.json()
        tokens["access_token"] = new["access_token"]
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=new.get("expires_in", 3500))).isoformat()
        await db.google_calendar.update_one({"_id": uid}, {"$set": {"tokens": tokens, "expires_at": expires_at}}, upsert=True)
        return tokens["access_token"]

    @router.get("/oauth/calendar/login")
    async def gcal_login(request: Request):
        cid, _ = _client_conf()
        uid = await _uid(request)
        from urllib.parse import urlencode

        params = urlencode({
            "client_id": cid,
            "redirect_uri": _redirect_uri(request),
            "response_type": "code",
            "scope": SCOPE + " https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly",
            "access_type": "offline",
            "prompt": "consent",
            "state": uid,
        })
        return {"authorization_url": f"{AUTH_URL}?{params}"}

    @router.get("/oauth/calendar/callback")
    async def gcal_callback(request: Request, code: str = "", error: str = "", state: str = ""):
        if error or not code:
            return RedirectResponse(f"{FRONTEND_URL}/?gcal=error")
        cid, csec = _client_conf()
        async with httpx.AsyncClient(timeout=20) as cx:
            r = await cx.post(
                TOKEN_URL,
                data={
                    "code": code,
                    "client_id": cid,
                    "client_secret": csec,
                    "redirect_uri": _redirect_uri(request),
                    "grant_type": "authorization_code",
                },
            )
            if r.status_code != 200:
                return RedirectResponse(f"{FRONTEND_URL}/?gcal=error")
            tokens = r.json()
            u = await cx.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": "Bearer " + tokens["ac" + "cess_" + "token"]},
            )
            email = u.json().get("email", "") if u.status_code == 200 else ""
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3500))).isoformat()
        await db.google_calendar.update_one(
            {"_id": state or DOC_ID},
            {"$set": {"tokens": tokens, "email": email, "expires_at": expires_at, "connected_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
        return RedirectResponse(f"{FRONTEND_URL}/?gcal=connected")

    @router.get("/calendar/status")
    async def gcal_status(request: Request):
        doc = await db.google_calendar.find_one({"_id": await _uid(request)})
        if not doc or not doc.get("tokens"):
            return {"connected": False}
        return {"connected": True, "email": doc.get("email", "")}

    @router.get("/calendar/events")
    async def gcal_events(request: Request, max_results: int = 10):
        token = await _get_token(await _uid(request))
        now = datetime.now(timezone.utc).isoformat()
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.get(
                CAL_API,
                params={
                    "timeMin": now,
                    "maxResults": max(1, min(max_results, 25)),
                    "singleEvents": "true",
                    "orderBy": "startTime",
                },
                headers={"Authorization": "Bearer " + token},
            )
        if r.status_code == 401:
            raise HTTPException(status_code=401, detail="Session Google expirée, reconnectez-vous.")
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Google Calendar a répondu {r.status_code}.")
        items = r.json().get("items", [])
        events = []
        for ev in items:
            start = ev.get("start", {})
            events.append({
                "id": ev.get("id"),
                "title": ev.get("summary", "(sans titre)"),
                "start": start.get("dateTime") or start.get("date", ""),
                "end": (ev.get("end") or {}).get("dateTime") or (ev.get("end") or {}).get("date", ""),
                "allDay": "date" in start,
                "location": ev.get("location", ""),
                "link": ev.get("htmlLink", ""),
            })
        return {"events": events}

    @router.post("/calendar/events")
    async def gcal_create(body: EventIn, request: Request):
        token = await _get_token(await _uid(request))
        if not body.title.strip() or not body.start.strip():
            raise HTTPException(status_code=400, detail="Titre et date de début requis.")
        start = body.start.strip()
        end = body.end.strip()
        if "T" in start:
            if not end:
                end = (datetime.fromisoformat(start.replace("Z", "+00:00")) + timedelta(hours=1)).isoformat()
            payload = {"summary": body.title.strip(), "description": body.description, "start": {"dateTime": start}, "end": {"dateTime": end}}
        else:
            payload = {"summary": body.title.strip(), "description": body.description, "start": {"date": start}, "end": {"date": end or start}}
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.post(CAL_API, json=payload, headers={"Authorization": "Bearer " + token})
        if r.status_code not in (200, 201):
            raise HTTPException(status_code=502, detail=f"Création refusée par Google ({r.status_code}).")
        ev = r.json()
        return {"ok": True, "id": ev.get("id"), "link": ev.get("htmlLink", "")}

    @router.delete("/calendar/events/{event_id}")
    async def gcal_delete(event_id: str, request: Request):
        token = await _get_token(await _uid(request))
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.delete(f"{CAL_API}/{event_id}", headers={"Authorization": "Bearer " + token})
        if r.status_code not in (200, 204):
            raise HTTPException(status_code=502, detail=f"Suppression refusée par Google ({r.status_code}).")
        return {"ok": True}

    return router

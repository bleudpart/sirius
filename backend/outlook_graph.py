# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import os
import time
import httpx
from urllib.parse import urlencode
from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse, HTMLResponse
from pydantic import BaseModel

MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0"
GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = "offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite"

_PAGE = """<body style="background:#03060c;color:#67e8f9;font-family:'Segoe UI',sans-serif;display:grid;place-items:center;height:100vh;text-align:center">
<div><h2 style="letter-spacing:.12em">SIRIUS</h2><p style="color:#cdeefb">{msg}</p>
<p style="font-size:13px;color:#67a8c4">Vous pouvez fermer cet onglet et revenir au HUD.</p></div></body>"""


class SendMailReq(BaseModel):
    to: str
    subject: str = "Message envoyé par SIRIUS"
    body: str


class CreateEventReq(BaseModel):
    titre: str
    start: str
    end: str
    tz: str = "UTC"


def make_outlook_router(db):
    router = APIRouter()
    cid = os.environ.get("MS_CLIENT_ID")
    secret = os.environ.get("MS_CLIENT_SECRET")
    redirect_uri = os.environ.get("MS_REDIRECT_URI")

    async def get_token():
        doc = await db.ms_tokens.find_one({"id": "default"}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=401, detail="Outlook non connecté — dites « connecte Outlook »")
        if time.time() < doc.get("expires_at", 0) - 60:
            return doc["access_token"]
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.post(f"{MS_AUTH}/token", data={
                "client_id": cid, "client_secret": secret,
                "grant_type": "refresh_token",
                "refresh_token": doc.get("refresh_token", ""),
                "scope": SCOPES,
            })
        t = r.json()
        if "access_token" not in t:
            raise HTTPException(status_code=401, detail="Session Outlook expirée — dites « connecte Outlook »")
        await db.ms_tokens.update_one({"id": "default"}, {"$set": {
            "access_token": t["access_token"],
            "refresh_token": t.get("refresh_token", doc.get("refresh_token")),
            "expires_at": time.time() + int(t.get("expires_in", 3600)),
        }})
        return t["access_token"]

    @router.get("/oauth/outlook/login")
    async def login():
        if not cid or not secret:
            raise HTTPException(status_code=500, detail="Identifiants Microsoft absents du serveur")
        q = urlencode({
            "client_id": cid, "response_type": "code", "redirect_uri": redirect_uri,
            "response_mode": "query", "scope": SCOPES, "prompt": "consent",
        })
        return RedirectResponse(f"{MS_AUTH}/authorize?{q}")

    @router.get("/oauth/outlook/callback")
    async def callback(code: str = "", error: str = "", error_description: str = ""):
        if error or not code:
            return HTMLResponse(_PAGE.format(msg=f"Connexion refusée : {error_description or error or 'code absent'}"))
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.post(f"{MS_AUTH}/token", data={
                "client_id": cid, "client_secret": secret,
                "grant_type": "authorization_code", "code": code,
                "redirect_uri": redirect_uri, "scope": SCOPES,
            })
            t = r.json()
            if "access_token" not in t:
                return HTMLResponse(_PAGE.format(msg=f"Échec d'authentification : {t.get('error_description', 'jetons non délivrés')[:300]}"))
            me = (await cx.get(f"{GRAPH}/me", headers={"Authorization": f"Bearer {t['access_token']}"})).json()
        email = me.get("mail") or me.get("userPrincipalName") or ""
        await db.ms_tokens.update_one({"id": "default"}, {"$set": {
            "id": "default", "email": email,
            "access_token": t["access_token"],
            "refresh_token": t.get("refresh_token", ""),
            "expires_at": time.time() + int(t.get("expires_in", 3600)),
        }}, upsert=True)
        return HTMLResponse(_PAGE.format(msg=f"Outlook connecté : {email}. SIRIUS a désormais accès à vos emails et votre calendrier."))

    @router.get("/outlook/status")
    async def status():
        doc = await db.ms_tokens.find_one({"id": "default"}, {"_id": 0, "email": 1})
        return {"connecte": bool(doc), "email": (doc or {}).get("email", "")}

    @router.get("/outlook/emails")
    async def emails():
        tok = await get_token()
        h = {"Authorization": f"Bearer {tok}"}
        async with httpx.AsyncClient(timeout=25) as cx:
            inbox = (await cx.get(f"{GRAPH}/me/mailFolders/Inbox", headers=h)).json()
            r = await cx.get(
                f"{GRAPH}/me/mailFolders/Inbox/messages"
                "?$select=from,subject,receivedDateTime,isRead,bodyPreview&$top=12&$orderby=receivedDateTime DESC",
                headers=h)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Lecture des emails impossible")
        msgs = [{
            "de": ((m.get("from") or {}).get("emailAddress") or {}).get("name") or ((m.get("from") or {}).get("emailAddress") or {}).get("address", "?"),
            "sujet": m.get("subject") or "(sans objet)",
            "date": (m.get("receivedDateTime") or "")[:16].replace("T", " "),
            "lu": bool(m.get("isRead")),
            "apercu": (m.get("bodyPreview") or "")[:120],
        } for m in r.json().get("value", [])]
        return {"non_lus": inbox.get("unreadItemCount", 0), "messages": msgs}

    @router.post("/outlook/send")
    async def send_mail(req: SendMailReq):
        tok = await get_token()
        payload = {"message": {
            "subject": req.subject,
            "body": {"contentType": "Text", "content": req.body},
            "toRecipients": [{"emailAddress": {"address": req.to}}],
        }, "saveToSentItems": "true"}
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.post(f"{GRAPH}/me/sendMail", json=payload, headers={"Authorization": f"Bearer {tok}"})
        if r.status_code not in (200, 202):
            raise HTTPException(status_code=502, detail="Envoi impossible")
        return {"ok": True}

    @router.get("/outlook/events")
    async def events(tz: str = "UTC"):
        tok = await get_token()
        from datetime import datetime, timedelta, timezone as _tz
        now = datetime.now(_tz.utc)
        url = (f"{GRAPH}/me/calendarView?startDateTime={now.isoformat()}"
               f"&endDateTime={(now + timedelta(days=14)).isoformat()}"
               "&$orderby=start/dateTime&$top=15&$select=subject,start,end,location")
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.get(url, headers={"Authorization": f"Bearer {tok}", "Prefer": f'outlook.timezone="{tz}"'})
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Lecture du calendrier impossible")
        evts = [{
            "titre": e.get("subject") or "(sans titre)",
            "debut": ((e.get("start") or {}).get("dateTime") or "")[:16].replace("T", " "),
            "fin": ((e.get("end") or {}).get("dateTime") or "")[:16].replace("T", " "),
            "lieu": ((e.get("location") or {}).get("displayName") or ""),
        } for e in r.json().get("value", [])]
        return {"evenements": evts}

    @router.post("/outlook/events")
    async def create_event(req: CreateEventReq):
        tok = await get_token()
        payload = {
            "subject": req.titre,
            "start": {"dateTime": req.start, "timeZone": req.tz},
            "end": {"dateTime": req.end, "timeZone": req.tz},
        }
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.post(f"{GRAPH}/me/calendar/events", json=payload, headers={"Authorization": f"Bearer {tok}"})
        if r.status_code != 201:
            raise HTTPException(status_code=502, detail="Création du rendez-vous impossible")
        return {"ok": True}

    return router

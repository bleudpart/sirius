# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import os
import re
import secrets
import time
import httpx
from urllib.parse import urlencode
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, HTMLResponse
from pydantic import BaseModel

from email_signature import append_signature_text
from auth_api import resolve_user_id, LEGACY_UID, is_direct_local_request

MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0"
GRAPH = "https://graph.microsoft.com/v1.0"
SCOPES = "offline_access User.Read Mail.Read Mail.Send Calendars.ReadWrite"

_PAGE = """<body style="background:#03060c;color:#67e8f9;font-family:'Segoe UI',sans-serif;display:grid;place-items:center;height:100vh;text-align:center">
<div><h2 style="letter-spacing:.12em">ΣIRIUS</h2><p style="color:#cdeefb">{msg}</p>
<p style="font-size:13px;color:#67a8c4">Vous pouvez fermer cet onglet et revenir au HUD.</p></div></body>"""


class SendMailReq(BaseModel):
    to: str
    subject: str = "Message envoyé par ΣIRIUS"
    body: str


class CreateEventReq(BaseModel):
    titre: str
    start: str
    end: str
    tz: str


class IntentReq(BaseModel):
    text: str
    keys: dict = {}


class IntentExecuteReq(BaseModel):
    intent: str
    parameters: dict = {}
    actionToken: str | None = None


# Actions sensibles (irréversibles) : nécessitent une confirmation vocale explicite avant
# exécution. Un jeton à usage unique est émis lors de l'analyse, puis exigé par /intent/execute.
_SENSITIVE_INTENTS = {"outlook.delete_email"}
_pending_actions: dict[str, dict] = {}


def _parse_outlook_intent(text: str) -> dict:
    """Analyse locale (regex, sans LLM) d'une commande Outlook en intent structuré.
    Reprend les mêmes formulations déjà reconnues côté frontend (App.js) pour rester cohérent."""
    low = (text or "").lower().strip()

    m = re.search(r"envoie (?:un )?(?:e-?mail|mail|courriel|message) [àa]\s+(\S+@\S+)(?:\s*(?:,|:)?\s*(?:objet|sujet)\s*[:\-]?\s*(.+?))?(?:\s*(?:,|:)?\s*(?:message|corps|texte)\s*[:\-]?\s*(.+))?$", low)
    if m:
        return {
            "intent": "outlook.send_email",
            "parameters": {
                "to": m.group(1).strip(),
                "subject": (m.group(2) or "Message envoyé par ΣIRIUS").strip(),
                "body": (m.group(3) or "").strip() or "Message envoyé depuis ΣIRIUS HUD.",
            },
        }

    if re.search(r"(?:supprime|efface|d[ée]truis)\w*\s+(?:le\s|ce\s|la\s)?(?:dernier\s)?(?:e-?mail|mail|courriel)", low):
        return {"intent": "outlook.delete_email", "parameters": {}}

    if re.search(r"(?:cherche|recherche|trouve)\w*\s+(?:les\s|des\s|mes\s)?(?:e-?mails?|mails?|courriels?)", low):
        query = re.sub(r"(?:cherche|recherche|trouve)\w*\s+(?:les\s|des\s|mes\s)?(?:e-?mails?|mails?|courriels?)\s*(?:de|d'|sur|concernant)?\s*", "", low).strip()
        return {"intent": "outlook.search_email", "parameters": {"query": query}}

    m = re.search(r"(?:lis|ouvre|affiche|montre)\w*(?:[- ]moi)?\s+(?:le\s|ce\s)?(?:dernier\s)?(?:e-?mail|mail|courriel)\s+(?:de|d')\s*(.+)", low)
    if m:
        return {"intent": "outlook.read_email", "parameters": {"from": m.group(1).strip()}}

    if re.search(r"(?:liste|affiche|montre)\w*(?:[- ]moi)?\s+(?:mes\s|les\s)?dossiers", low):
        return {"intent": "outlook.list_folders", "parameters": {}}

    return {"intent": "outlook.search_email", "parameters": {"query": text}}


def make_outlook_router(db):
    router = APIRouter()
    cid = os.environ.get("MS_CLIENT_ID")
    secret = os.environ.get("MS_CLIENT_SECRET")
    redirect_uri = os.environ.get("MS_REDIRECT_URI")

    async def get_token(user_id: str):
        doc = await db.ms_tokens.find_one({"id": user_id}, {"_id": 0})
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
        await db.ms_tokens.update_one({"id": user_id}, {"$set": {
            "access_token": t["access_token"],
            "refresh_token": t.get("refresh_token", doc.get("refresh_token")),
            "expires_at": time.time() + int(t.get("expires_in", 3600)),
        }})
        return t["access_token"]

    @router.get("/oauth/outlook/login")
    async def login(request: Request):
        if not cid or not secret:
            raise HTTPException(status_code=500, detail="Identifiants Microsoft absents du serveur")
        try:
            uid = await resolve_user_id(request, db)
        except HTTPException:
            if not is_direct_local_request(request):
                raise
            uid = LEGACY_UID
        state = secrets.token_urlsafe(24)
        await db.oauth_states.insert_one({
            "_id": f"outlook_legacy:{state}", "uid": uid,
            "expires_at": time.time() + 600,
        })
        q = urlencode({
            "client_id": cid, "response_type": "code", "redirect_uri": redirect_uri,
            "response_mode": "query", "scope": SCOPES, "prompt": "consent", "state": state,
        })
        return RedirectResponse(f"{MS_AUTH}/authorize?{q}")

    @router.get("/oauth/outlook/callback")
    async def callback(code: str = "", error: str = "", error_description: str = "", state: str = ""):
        if error or not code:
            return HTMLResponse(_PAGE.format(msg=f"Connexion refusée : {error_description or error or 'code absent'}"))
        st = await db.oauth_states.find_one_and_delete({"_id": f"outlook_legacy:{state}"})
        if not st or st.get("expires_at", 0) < time.time():
            return HTMLResponse(_PAGE.format(msg="Session de connexion expirée, réessayez « connecte Outlook »."))
        uid = st["uid"]
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
        await db.ms_tokens.update_one({"id": uid}, {"$set": {
            "id": uid, "email": email,
            "access_token": t["access_token"],
            "refresh_token": t.get("refresh_token", ""),
            "expires_at": time.time() + int(t.get("expires_in", 3600)),
        }}, upsert=True)
        return HTMLResponse(_PAGE.format(msg=f"Outlook connecté : {email}. ΣIRIUS a désormais accès à vos emails et votre calendrier."))

    @router.get("/outlook/status")
    async def status(request: Request):
        uid = await resolve_user_id(request, db)
        doc = await db.ms_tokens.find_one({"id": uid}, {"_id": 0, "email": 1})
        return {"connecte": bool(doc), "email": (doc or {}).get("email", "")}

    @router.get("/outlook/emails")
    async def emails(request: Request):
        uid = await resolve_user_id(request, db)
        tok = await get_token(uid)
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
    async def send_mail(req: SendMailReq, request: Request):
        uid = await resolve_user_id(request, db)
        tok = await get_token(uid)
        payload = {"message": {
            "subject": req.subject,
            "body": {"contentType": "Text", "content": append_signature_text(req.body)},
            "toRecipients": [{"emailAddress": {"address": req.to}}],
        }, "saveToSentItems": "true"}
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.post(f"{GRAPH}/me/sendMail", json=payload, headers={"Authorization": f"Bearer {tok}"})
        if r.status_code not in (200, 202):
            raise HTTPException(status_code=502, detail="Envoi impossible")
        return {"ok": True}

    @router.get("/outlook/events")
    async def events(request: Request, tz: str):
        uid = await resolve_user_id(request, db)
        tok = await get_token(uid)
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
    async def create_event(req: CreateEventReq, request: Request):
        uid = await resolve_user_id(request, db)
        tok = await get_token(uid)
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

    async def _do_send_email(uid: str, parameters: dict) -> dict:
        tok = await get_token(uid)
        to = (parameters.get("to") or "").strip()
        if not to:
            raise HTTPException(status_code=400, detail="Destinataire manquant")
        subject = parameters.get("subject") or "Message envoyé par ΣIRIUS"
        body = parameters.get("body") or ""
        payload = {"message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": append_signature_text(body)},
            "toRecipients": [{"emailAddress": {"address": to}}],
        }, "saveToSentItems": "true"}
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.post(f"{GRAPH}/me/sendMail", json=payload, headers={"Authorization": f"******"})
        if r.status_code not in (200, 202):
            raise HTTPException(status_code=502, detail="Envoi impossible")
        return {"responseText": f"E-mail envoyé à {to}.", "result": {}}

    async def _do_delete_email(uid: str, parameters: dict) -> dict:
        tok = await get_token(uid)
        h = {"Authorization": f"******"}
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.get(
                f"{GRAPH}/me/mailFolders/Inbox/messages?$select=id,subject&$top=1&$orderby=receivedDateTime DESC",
                headers=h)
            msgs = r.json().get("value", []) if r.status_code == 200 else []
            if not msgs:
                return {"responseText": "Aucun e-mail à supprimer.", "result": {}}
            msg_id = msgs[0]["id"]
            sujet = msgs[0].get("subject") or "(sans objet)"
            dr = await cx.delete(f"{GRAPH}/me/messages/{msg_id}", headers=h)
        if dr.status_code not in (200, 202, 204):
            raise HTTPException(status_code=502, detail="Suppression impossible")
        return {"responseText": f"E-mail « {sujet} » supprimé.", "result": {}}

    async def _do_search_email(uid: str, parameters: dict) -> dict:
        tok = await get_token(uid)
        h = {"Authorization": f"******"}
        query = (parameters.get("query") or parameters.get("from") or "").strip()
        params = "?$select=from,subject,receivedDateTime,isRead,bodyPreview&$top=10&$orderby=receivedDateTime DESC"
        if query:
            params += f"&$search=\"{query}\""
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.get(f"{GRAPH}/me/messages{params}", headers={**h, "ConsistencyLevel": "eventual"})
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Recherche impossible")
        msgs = [{
            "de": ((m.get("from") or {}).get("emailAddress") or {}).get("name") or ((m.get("from") or {}).get("emailAddress") or {}).get("address", "?"),
            "sujet": m.get("subject") or "(sans objet)",
            "date": (m.get("receivedDateTime") or "")[:16].replace("T", " "),
            "lu": bool(m.get("isRead")),
            "apercu": (m.get("bodyPreview") or "")[:120],
        } for m in r.json().get("value", [])]
        texte = f"{len(msgs)} résultat(s) pour « {query} »." if query else f"{len(msgs)} e-mail(s) récent(s)."
        return {"responseText": texte, "result": {"messages": msgs}}

    async def _do_read_email(uid: str, parameters: dict) -> dict:
        tok = await get_token(uid)
        h = {"Authorization": f"******"}
        sender = (parameters.get("from") or "").strip()
        params = "?$select=from,subject,receivedDateTime,body&$top=1&$orderby=receivedDateTime DESC"
        if sender:
            params += f"&$search=\"from:{sender}\""
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.get(f"{GRAPH}/me/messages{params}", headers={**h, "ConsistencyLevel": "eventual"})
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Lecture impossible")
        msgs = r.json().get("value", [])
        if not msgs:
            return {"responseText": f"Aucun e-mail trouvé de {sender}." if sender else "Aucun e-mail trouvé.", "result": {}}
        m = msgs[0]
        de = ((m.get("from") or {}).get("emailAddress") or {}).get("name") or ((m.get("from") or {}).get("emailAddress") or {}).get("address", "?")
        sujet = m.get("subject") or "(sans objet)"
        corps = (m.get("body") or {}).get("content") or ""
        corps = re.sub(r"<[^>]+>", " ", corps)
        corps = re.sub(r"\s+", " ", corps).strip()[:1500]
        return {
            "responseText": f"E-mail de {de}, sujet : {sujet}.",
            "result": {"de": de, "sujet": sujet, "date": (m.get("receivedDateTime") or "")[:16].replace("T", " "), "corps": corps},
        }

    async def _do_list_folders(uid: str, parameters: dict) -> dict:
        tok = await get_token(uid)
        h = {"Authorization": f"******"}
        async with httpx.AsyncClient(timeout=25) as cx:
            r = await cx.get(f"{GRAPH}/me/mailFolders?$top=20&$select=displayName,unreadItemCount,totalItemCount", headers=h)
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail="Lecture des dossiers impossible")
        dossiers = [{
            "nom": f.get("displayName") or "?",
            "non_lus": f.get("unreadItemCount", 0),
            "total": f.get("totalItemCount", 0),
        } for f in r.json().get("value", [])]
        return {"responseText": f"{len(dossiers)} dossier(s) trouvé(s).", "result": {"dossiers": dossiers}}

    _INTENT_HANDLERS = {
        "outlook.send_email": _do_send_email,
        "outlook.delete_email": _do_delete_email,
        "outlook.search_email": _do_search_email,
        "outlook.read_email": _do_read_email,
        "outlook.list_folders": _do_list_folders,
    }

    @router.post("/outlook/intent")
    async def intent(req: IntentReq, request: Request):
        """Analyse une commande Outlook en langage naturel et retourne l'intent structuré.
        Les actions sensibles (suppression) exigent une confirmation avant exécution réelle."""
        uid = await resolve_user_id(request, db)
        parsed = _parse_outlook_intent(req.text)
        intent_name = parsed["intent"]
        parameters = parsed["parameters"]
        if intent_name in _SENSITIVE_INTENTS:
            token = secrets.token_urlsafe(16)
            _pending_actions[token] = {
                "intent": intent_name, "parameters": parameters, "expires": time.time() + 300, "uid": uid,
            }
            return {
                "intent": intent_name,
                "parameters": parameters,
                "requiresConfirmation": True,
                "actionToken": token,
                "responseText": "Cette action est irréversible, confirmez-vous ?",
            }
        return {"intent": intent_name, "parameters": parameters, "requiresConfirmation": False}

    @router.post("/outlook/intent/execute")
    async def intent_execute(req: IntentExecuteReq, request: Request):
        """Exécute réellement l'intent Outlook préalablement analysé par /outlook/intent.
        Pour les actions sensibles, exige un actionToken valide émis lors de l'analyse, lié
        au même utilisateur authentifié que celui qui l'a demandé (pas de rejeu par un tiers)."""
        uid = await resolve_user_id(request, db)
        handler = _INTENT_HANDLERS.get(req.intent)
        if not handler:
            raise HTTPException(status_code=400, detail=f"Intent Outlook inconnu : {req.intent}")
        if req.intent in _SENSITIVE_INTENTS:
            pending = _pending_actions.pop(req.actionToken or "", None)
            if (not pending or pending["intent"] != req.intent or pending["expires"] < time.time()
                    or pending.get("uid") != uid):
                raise HTTPException(status_code=403, detail="Confirmation manquante ou expirée pour cette action sensible.")
        result = await handler(uid, req.parameters)
        return result

    return router

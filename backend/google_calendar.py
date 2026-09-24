# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Intégration Google Calendar + Gmail : OAuth2 + lecture/création d'événements et lecture
des e-mails Gmail (httpx, sans SDK). Le même jeton Google (scope gmail.readonly demandé lors
de la connexion à l'Agenda) sert aussi à lire la boîte de réception Gmail."""
import os
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel

import email_intel
import contacts_cache
from auth_api import resolve_user_id, LEGACY_UID, is_direct_local_request
from email_signature import append_signature_text

TOKEN_URL = "https://oauth2.googleapis.com/token"
AUTH_URL = "https://accounts.google.com/o/oauth2/auth"
CAL_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"
PEOPLE_API = "https://people.googleapis.com/v1/people/me/connections"
SCOPE = "https://www.googleapis.com/auth/calendar"
MAX_GOOGLE_CONTACTS = 2000
DOC_ID = "default"

logger = logging.getLogger("sirius.google")

# Le SPA (localhost:3000 en dev) et l'API sont deux serveurs distincts : une redirection
# relative "/?gcal=..." émise par l'API se résout par rapport à l'API elle-même (un ancien
# build React figé), pas l'application réellement utilisée. On redirige donc explicitement
# vers l'origine du SPA — voir le même correctif dans microsoft_graph.py.
FRONTEND_URL = (os.environ.get("FRONTEND_URL") or "http://localhost:3000").rstrip("/")


def _external_oauth_result(ok: bool, provider: str) -> HTMLResponse:
    title = f"{provider} connecté" if ok else f"Connexion {provider} interrompue"
    message = "Vous pouvez revenir dans ΣIRIUS." if ok else "Revenez dans ΣIRIUS pour réessayer."
    color = "#91e6f2" if ok else "#f2d99a"
    return HTMLResponse(
        "<html><body style='margin:0;background:#030a13;color:#d5f6ff;font-family:sans-serif;"
        "display:grid;place-items:center;min-height:100vh;text-align:center'>"
        f"<main><h2 style='color:{color}'>{title}</h2><p>{message}</p></main></body></html>"
    )


def _client_conf():
    cid = os.environ.get("GOOGLE_CLIENT_ID")
    csec = os.environ.get("GOOGLE_CLIENT_SECRET")
    if not cid or not csec:
        raise HTTPException(status_code=503, detail="Google Calendar non configuré (GOOGLE_CLIENT_ID/SECRET manquants).")
    return cid, csec


def _redirect_uri(request: Request) -> str:
    """URI de retour OAuth, identique à l'aller et au retour (exigence Google).
    GOOGLE_REDIRECT_URI prime : Google n'accepte qu'une URI enregistrée au caractère près."""
    explicit = (os.environ.get("GOOGLE_REDIRECT_URI") or "").strip()
    if explicit:
        return explicit
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    # Sans en-tête de proxy, le schéma réel de la requête fait foi : en local c'est http,
    # et forcer https renverrait l'utilisateur vers une adresse que le backend ne sert pas.
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return f"{proto}://{host}/api/oauth/calendar/callback"


class EventIn(BaseModel):
    title: str
    start: str
    end: str = ""
    description: str = ""


class GmailSendReq(BaseModel):
    to: str
    subject: str = "Message envoyé par ΣIRIUS"
    body: str = ""


class GmailReplyReq(BaseModel):
    body: str = ""


def make_gcal_router(db):
    router = APIRouter()

    async def _uid(request: Request) -> str:
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
            await db.google_calendar.update_one(
                {"_id": uid},
                {"$set": {"tokens": None, "expires_at": None}},
            )
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
                try:
                    error_data = r.json()
                except ValueError:
                    error_data = {}
                if error_data.get("error") == "invalid_grant":
                    await db.google_calendar.update_one(
                        {"_id": uid},
                        {"$set": {"tokens": None, "expires_at": None}},
                    )
                    logger.warning("[GOOGLE] refresh token expiré ou révoqué pour %s", uid)
                    raise HTTPException(
                        status_code=401,
                        detail="Jeton Google expiré ou révoqué. Reconnecte ton compte Google.",
                    )
                logger.warning("[GOOGLE] échec du rafraîchissement (%s): %s", r.status_code, error_data.get("error", "réponse inconnue"))
                raise HTTPException(status_code=401, detail="Rafraîchissement du jeton Google refusé, reconnectez-vous.")
        new = r.json()
        tokens["access_token"] = new["access_token"]
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=new.get("expires_in", 3500))).isoformat()
        await db.google_calendar.update_one({"_id": uid}, {"$set": {"tokens": tokens, "expires_at": expires_at}}, upsert=True)
        return tokens["access_token"]

    @router.get("/oauth/calendar/login")
    async def gcal_login(request: Request, external: bool = False):
        cid, _ = _client_conf()
        # Comme pour Microsoft (microsoft_graph.py) : le "state" doit être un jeton opaque
        # généré côté serveur et lié à l'utilisateur résolu ICI, jamais l'uid brut envoyé
        # tel quel — sinon un attaquant peut forger son propre code OAuth et l'associer au
        # compte d'une victime via un lien piégé (CSRF de liaison de compte).
        try:
            uid = await resolve_user_id(request, db)
        except HTTPException:
            if not is_direct_local_request(request):
                raise
            uid = LEGACY_UID
        state = secrets.token_urlsafe(32)
        await db.oauth_states.insert_one({
            "_id": f"gcal:{state}", "uid": uid,
            "external": external,
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        })
        from urllib.parse import urlencode

        params = urlencode({
            "client_id": cid,
            "redirect_uri": _redirect_uri(request),
            "response_type": "code",
            "scope": SCOPE + " https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/contacts.readonly",
            "access_type": "offline",
            "prompt": "consent",
            "state": state,
        })
        return {"authorization_url": f"{AUTH_URL}?{params}"}

    @router.get("/oauth/calendar/callback")
    async def gcal_callback(request: Request, code: str = "", error: str = "", state: str = ""):
        st = await db.oauth_states.find_one_and_delete({"_id": f"gcal:{state}"}) if state else None
        external = bool((st or {}).get("external"))
        if error or not code:
            return _external_oauth_result(False, "Google") if external else RedirectResponse(f"{FRONTEND_URL}/?gcal=error")
        if not st or datetime.fromisoformat(st["expires_at"]) < datetime.now(timezone.utc):
            return _external_oauth_result(False, "Google") if external else RedirectResponse(f"{FRONTEND_URL}/?gcal=error")
        uid = st["uid"]
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
                return _external_oauth_result(False, "Google") if external else RedirectResponse(f"{FRONTEND_URL}/?gcal=error")
            tokens = r.json()
            u = await cx.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": "Bearer " + tokens["ac" + "cess_" + "token"]},
            )
            email = u.json().get("email", "") if u.status_code == 200 else ""
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3500))).isoformat()
        await db.google_calendar.update_one(
            {"_id": uid},
            {"$set": {"tokens": tokens, "email": email, "expires_at": expires_at, "connected_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True,
        )
        return _external_oauth_result(True, "Google") if external else RedirectResponse(f"{FRONTEND_URL}/?gcal=connected")

    @router.get("/calendar/status")
    async def gcal_status(request: Request):
        doc = await db.google_calendar.find_one({"_id": await _uid(request)})
        if not doc or not doc.get("tokens"):
            return {"connected": False}
        # Google retire silencieusement les champs non déclarés sur l'écran de consentement :
        # un compte « connecté » peut donc n'avoir que l'agenda. Le HUD doit pouvoir le savoir.
        granted = (doc.get("tokens") or {}).get("scope") or ""
        return {
            "connected": True,
            "email": doc.get("email", ""),
            "scopes": granted,
            "gmail": "gmail.readonly" in granted,
            "gmail_send": "gmail.send" in granted,
            "contacts": "contacts.readonly" in granted,
        }

    @router.post("/calendar/refresh")
    async def gcal_refresh(request: Request):
        """Attempt silent token refresh (no user interaction required)."""
        uid = await _uid(request)
        try:
            # This will refresh the token if needed via _get_token logic
            await _get_token(uid)
            return {"ok": True, "refreshed": True}
        except Exception as e:
            logger.warning("[GOOGLE] silent refresh failed for %s: %s", uid, str(e))
            return {"ok": False, "error": "token_refresh_failed"}

    @router.post("/calendar/disconnect")
    async def gcal_disconnect(request: Request):
        await db.google_calendar.delete_one({"_id": await _uid(request)})
        return {"ok": True}

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

    def _header(headers: list, name: str) -> str:
        for h in headers or []:
            if (h.get("name") or "").lower() == name.lower():
                return h.get("value") or ""
        return ""

    @router.get("/google/contacts")
    async def google_contacts(request: Request, top: int = 50, query: str = "", refresh: bool = False):
        """Carnet d'adresses Google (People API), normalisé comme les contacts Outlook
        et servi depuis le cache local tant qu'il est frais."""
        from microsoft_graph import filter_contacts

        uid = await _uid(request)
        cached = None if refresh else contacts_cache.read(uid, "google")
        if cached is not None:
            found = filter_contacts(cached, query)
            logger.info("[GOOGLE] contacts (cache) : %d lus, %d correspondent à %r", len(cached), len(found), query)
            return {"contacts": found[:max(1, min(top, MAX_GOOGLE_CONTACTS))], "query": query.strip()}

        token = await _get_token(uid)
        people: list = []
        page = ""
        async with httpx.AsyncClient(timeout=20) as cx:
            while len(people) < MAX_GOOGLE_CONTACTS:
                params = {
                    "personFields": "names,emailAddresses,phoneNumbers,organizations",
                    "pageSize": 200,
                    "sortOrder": "FIRST_NAME_ASCENDING",
                }
                if page:
                    params["pageToken"] = page
                r = await cx.get(PEOPLE_API, params=params, headers={"Authorization": "Bearer " + token})
                if r.status_code == 401:
                    raise HTTPException(status_code=401, detail="Session Google expirée, reconnectez-vous.")
                if r.status_code == 403:
                    # Deux causes distinctes : API non activée dans le projet, ou champ non accordé.
                    reason = ((r.json().get("error") or {}).get("message") or "")[:300]
                    logger.warning("[GOOGLE] contacts refusés: %s", reason)
                    detail = ("API Google People non activée dans ton projet Google Cloud."
                              if "has not been used" in reason or "disabled" in reason
                              else "Accès aux contacts Google non autorisé — reconnecte ton compte Google.")
                    raise HTTPException(status_code=403, detail=detail)
                if r.status_code != 200:
                    raise HTTPException(status_code=502, detail=f"Google Contacts a répondu {r.status_code}.")
                data = r.json()
                people.extend(data.get("connections", []))
                page = data.get("nextPageToken") or ""
                if not page:
                    break

        contacts = []
        for p in people[:MAX_GOOGLE_CONTACTS]:
            name = (p.get("names") or [{}])[0]
            org = (p.get("organizations") or [{}])[0]
            emails = [e.get("value", "").strip().lower() for e in (p.get("emailAddresses") or []) if e.get("value")]
            phones = [t.get("value", "").strip() for t in (p.get("phoneNumbers") or []) if t.get("value")]
            contacts.append({
                "id": p.get("resourceName", ""),
                "nom": name.get("displayName") or (emails[0] if emails else "Contact sans nom"),
                "prenom": name.get("givenName") or "",
                "nom_famille": name.get("familyName") or "",
                "emails": emails,
                "email": emails[0] if emails else "",
                "telephones": phones,
                "telephone": phones[0] if phones else "",
                "entreprise": org.get("name") or "",
                "poste": org.get("title") or "",
                "source": "gmail",
            })
        contacts_cache.write(uid, "google", contacts)
        found = filter_contacts(contacts, query)
        logger.info("[GOOGLE] contacts (Google) : %d lus, %d correspondent à %r", len(contacts), len(found), query)
        return {"contacts": found[:max(1, min(top, MAX_GOOGLE_CONTACTS))], "query": query.strip()}

    @router.get("/gmail/messages")
    async def gmail_messages(request: Request, top: int = 10):
        """Derniers mails Gmail (boîte de réception), classés par importance comme pour
        Outlook (email_intel) afin d'alimenter les cases stylisées du display et signaler
        les messages urgents pour l'alerte vocale."""
        uid = await _uid(request)
        token = await _get_token(uid)
        top = max(1, min(top, 25))
        async with httpx.AsyncClient(timeout=15) as cx:
            r = await cx.get(
                f"{GMAIL_API}/messages",
                params={"maxResults": top, "labelIds": "INBOX", "q": "in:inbox"},
                headers={"Authorization": "Bearer " + token},
            )
            if r.status_code == 401:
                raise HTTPException(status_code=401, detail="Session Gmail expirée, reconnectez-vous.")
            if r.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Gmail a répondu {r.status_code}.")
            ids = [m["id"] for m in r.json().get("messages", [])]
            mails = []
            non_lus = 0
            for mid in ids:
                mr = await cx.get(
                    f"{GMAIL_API}/messages/{mid}",
                    params={"format": "metadata", "metadataHeaders": ["From", "Subject"]},
                    headers={"Authorization": "Bearer " + token},
                )
                if mr.status_code != 200:
                    continue
                m = mr.json()
                headers = (m.get("payload") or {}).get("headers") or []
                from_raw = _header(headers, "From")
                de_email = from_raw.split("<")[-1].replace(">", "").strip().lower() if "<" in from_raw else from_raw.strip().lower()
                de_nom = from_raw.split("<")[0].strip().strip('"') if "<" in from_raw else from_raw
                lu = "UNREAD" not in (m.get("labelIds") or [])
                if not lu:
                    non_lus += 1
                recu_ms = int(m.get("internalDate") or 0)
                recu = datetime.fromtimestamp(recu_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M") if recu_ms else ""
                mail = {
                    "id": mid,
                    "sujet": _header(headers, "Subject") or "(sans objet)",
                    "de": de_nom or de_email,
                    "de_email": de_email,
                    "recu": recu,
                    "lu": lu,
                    "apercu": (m.get("snippet") or "")[:140],
                    "importance": "normal",
                }
                verdict = email_intel.classify_email(mail)
                mails.append({**mail, **verdict})
            return {"non_lus": non_lus, "mails": mails, "total": len(mails)}

    def _build_raw_message(to: str, subject: str, body: str, in_reply_to: str = "", references: str = "") -> str:
        """Construit un message RFC 2822 encodé en base64url, comme exigé par
        l'API Gmail (users.messages.send attend un champ "raw")."""
        import base64
        from email.mime.text import MIMEText

        msg = MIMEText(body, "plain", "utf-8")
        msg["to"] = to
        msg["subject"] = subject
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = references or in_reply_to
        return base64.urlsafe_b64encode(msg.as_bytes()).decode()

    @router.post("/gmail/send")
    async def gmail_send(request: Request, req: GmailSendReq):
        """Envoie un nouvel e-mail Gmail, avec la signature ΣIRIUS HUD ajoutée automatiquement."""
        uid = await _uid(request)
        token = await _get_token(uid)
        to = (req.to or "").strip()
        if not to:
            raise HTTPException(status_code=400, detail="Destinataire manquant")
        raw = _build_raw_message(to, req.subject, append_signature_text(req.body))
        async with httpx.AsyncClient(timeout=20) as cx:
            r = await cx.post(
                f"{GMAIL_API}/messages/send",
                json={"raw": raw},
                headers={"Authorization": "Bearer " + token},
            )
        if r.status_code not in (200, 202):
            raise HTTPException(status_code=502, detail="Envoi Gmail impossible")
        return {"ok": True}

    @router.post("/gmail/messages/{message_id}/reply")
    async def gmail_reply(request: Request, message_id: str, req: GmailReplyReq):
        """Répond à un e-mail Gmail existant (même fil de discussion), signature ΣIRIUS HUD incluse."""
        uid = await _uid(request)
        token = await _get_token(uid)
        async with httpx.AsyncClient(timeout=20) as cx:
            mr = await cx.get(
                f"{GMAIL_API}/messages/{message_id}",
                params={"format": "metadata", "metadataHeaders": ["From", "Subject", "Message-ID", "References"]},
                headers={"Authorization": "Bearer " + token},
            )
            if mr.status_code == 401:
                raise HTTPException(status_code=401, detail="Session Gmail expirée, reconnectez-vous.")
            if mr.status_code != 200:
                raise HTTPException(status_code=404, detail="E-mail introuvable")
            m = mr.json()
            headers = (m.get("payload") or {}).get("headers") or []
            to = _header(headers, "From")
            subject = _header(headers, "Subject") or ""
            if not subject.lower().startswith("re:"):
                subject = f"Re: {subject}"
            message_id_hdr = _header(headers, "Message-ID")
            references = _header(headers, "References")
            thread_id = m.get("threadId")
            raw = _build_raw_message(to, subject, append_signature_text(req.body), message_id_hdr, references)
            payload = {"raw": raw}
            if thread_id:
                payload["threadId"] = thread_id
            r = await cx.post(
                f"{GMAIL_API}/messages/send",
                json=payload,
                headers={"Authorization": "Bearer " + token},
            )
        if r.status_code not in (200, 202):
            raise HTTPException(status_code=502, detail="Réponse Gmail impossible")
        return {"ok": True}

    return router

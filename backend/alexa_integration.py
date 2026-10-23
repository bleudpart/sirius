"""Separate Alexa OAuth clients; no normal session token leaves SIRIUS."""

import base64
import hashlib
import hmac
import html
import json
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, unquote_plus, urlencode, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import Field, StrictBool

from action_registry import ActionInputs
from work_draft_recordings import insert_once
from workspace_channels import active_account, bounded_body

SCOPES = {"dossiers:read", "meetings:read"}
HOME_SCOPES = {"home:read", "home:control"}


def stamp(seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


def configuration(client_id=None):
    home = client_id is not None and client_id == os.getenv("SIRIUS_ALEXA_HOME_CLIENT_ID", "")
    prefix = "SIRIUS_ALEXA_HOME" if home else "SIRIUS_ALEXA"
    client = os.getenv(prefix + "_CLIENT_ID", "")
    secret = os.getenv(prefix + "_CLIENT_SECRET", "")
    origin = os.getenv("SIRIUS_ALEXA_PUBLIC_ORIGIN", "")
    redirects = [item.strip() for item in os.getenv(prefix + "_REDIRECT_URIS", "").split(",") if item.strip()]
    parsed = urlsplit(origin)
    if (not client or len(secret) < 32 or not redirects or parsed.scheme != "https" or not parsed.hostname
            or parsed.path or parsed.username or parsed.password or parsed.query or parsed.fragment
            or "\\" in origin or (client_id is not None and client_id != client)
            or os.getenv("SIRIUS_ALEXA_CLIENT_ID") == os.getenv("SIRIUS_ALEXA_HOME_CLIENT_ID") == client):
        raise HTTPException(503, "Liaison Alexa non configurée.")
    for value in redirects:
        uri = urlsplit(value)
        if (uri.scheme != "https" or not uri.hostname or uri.username or uri.password or uri.fragment
                or uri.query or "\\" in value):
            raise HTTPException(503, "URI de retour Alexa invalide.")
    return client, secret, origin, redirects


def oauth_error(code, status=400):
    return JSONResponse({"error": code}, status_code=status,
                        headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


class Consent(ActionInputs):
    ticket: str = Field(min_length=43, max_length=43)
    approve: StrictBool


class AlexaIntegration:
    def __init__(self, db):
        self.db = db

    async def authorize(self, params):
        client, _, _, redirects = configuration(params.get("client_id"))
        if params.get("client_id") != client or params.get("redirect_uri") not in redirects:
            raise HTTPException(400, "Client ou URI de retour non autorisé.")
        scopes = set(params.get("scope", "").split())
        allowed = HOME_SCOPES if client == os.getenv("SIRIUS_ALEXA_HOME_CLIENT_ID") else SCOPES
        if (params.get("response_type") != "code" or not scopes or not scopes <= allowed
                or not 1 <= len(params.get("state", "")) <= 2000):
            raise HTTPException(400, "Demande OAuth non conforme.")
        challenge = params.get("code_challenge", "")
        if challenge and (params.get("code_challenge_method") != "S256"
                          or len(challenge) != 43 or any(char not in
                          "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in challenge)):
            raise HTTPException(400, "PKCE S256 requis lorsqu'une preuve est fournie.")
        if params.get("code_challenge_method") and not challenge:
            raise HTTPException(400, "Preuve PKCE manquante.")
        await self.db.sirius_alexa_codes.delete_many({"expires_at": {"$lt": stamp()}})
        if await self.db.sirius_alexa_codes.count_documents({}) >= 1000:
            raise HTTPException(429, "Trop de demandes de liaison ; réessayer plus tard.")
        ticket = secrets.token_urlsafe(32)
        await self.db.sirius_alexa_codes.insert_one({
            "id": hashed(ticket), "state": "CONSENT", "client_id": client,
            "redirect_uri": params["redirect_uri"], "oauth_state": params["state"],
            "scopes": sorted(scopes), "challenge": challenge, "expires_at": stamp(600),
        })
        return ticket, sorted(scopes)

    async def consent(self, uid, body):
        await active_account(self.db, uid)
        row = await self.db.sirius_alexa_codes.find_one({
            "id": hashed(body.ticket), "state": "CONSENT", "expires_at": {"$gt": stamp()},
        })
        if not row:
            raise HTTPException(409, "Demande expirée ou déjà traitée ; recommencer dans Alexa.")
        code = secrets.token_urlsafe(32)
        result = await self.db.sirius_alexa_codes.update_one(
            {"id": row["id"], "state": "CONSENT", "expires_at": {"$gt": stamp()}},
            {"$set": {"state": "CODE" if body.approve else "DENIED", "user_id": uid,
                      "code_hash": hashed(code), "expires_at": stamp(120)}})
        if not result.modified_count:
            raise HTTPException(409, "Demande déjà traitée.")
        values = {"state": row["oauth_state"], **({"code": code} if body.approve else {"error": "access_denied"})}
        return {"redirect": row["redirect_uri"] + "?" + urlencode(values)}

    async def mint(self, uid, scopes, client, family=None, current=None):
        await self.db.sirius_alexa_refreshes.delete_many({"expires_at": {"$lt": stamp()}})
        if not family and await self.db.sirius_alexa_connections.count_documents({
                "user_id": uid, "client_id": client, "active": True, "expires_at": {"$gt": stamp()}}) >= 5:
            raise HTTPException(409, "Révoquer une ancienne liaison Alexa avant d'en créer une autre.")
        access, refresh = "saa_" + secrets.token_urlsafe(32), "sar_" + secrets.token_urlsafe(32)
        identity = family or str(uuid.uuid4())
        await insert_once(self.db, "sirius_alexa_refreshes", {
            "user_id": uid, "id": hashed(refresh), "family": identity, "created_at": stamp(),
            "expires_at": stamp(30 * 86400),
        })
        values = {"access_hash": hashed(access), "refresh_hash": hashed(refresh), "access_expires": stamp(600),
                  "updated_at": stamp()}
        if family:
            changed = await self.db.sirius_alexa_connections.update_one(
                {"user_id": uid, "id": family, "client_id": client, "active": True, "refresh_hash": current,
                 "expires_at": {"$gt": stamp()}}, {"$set": values})
            if not changed.modified_count:
                await self.db.sirius_alexa_connections.update_one(
                    {"user_id": uid, "id": family}, {"$set": {"active": False}})
                raise HTTPException(400, "invalid_grant")
        else:
            await self.db.sirius_alexa_connections.insert_one({
                "user_id": uid, "id": identity, "client_id": client, "active": True, "scopes": scopes,
                "created_at": stamp(), "expires_at": stamp(30 * 86400), **values,
            })
        return {"access_token": access, "refresh_token": refresh, "token_type": "Bearer",
                "expires_in": 600, "scope": " ".join(scopes)}

    async def exchange(self, form, client_id=None):
        client, _, _, redirects = configuration(client_id)
        if form.get("grant_type") == "authorization_code":
            row = await self.db.sirius_alexa_codes.find_one({
                "code_hash": hashed(form.get("code", "")), "state": "CODE",
                "client_id": client, "expires_at": {"$gt": stamp()},
            })
            if not row or form.get("redirect_uri") != row["redirect_uri"] or row["redirect_uri"] not in redirects:
                raise HTTPException(400, "invalid_grant")
            if row["challenge"]:
                verifier = form.get("code_verifier", "")
                proof = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
                if not 43 <= len(verifier) <= 128 or not hmac.compare_digest(proof, row["challenge"]):
                    raise HTTPException(400, "invalid_grant")
            await active_account(self.db, row["user_id"])
            consumed = await self.db.sirius_alexa_codes.update_one(
                {"id": row["id"], "state": "CODE", "expires_at": {"$gt": stamp()}},
                {"$set": {"state": "USED"}, "$unset": {"oauth_state": "", "code_hash": ""}})
            if not consumed.modified_count:
                raise HTTPException(400, "invalid_grant")
            return await self.mint(row["user_id"], row["scopes"], client)
        if form.get("grant_type") == "refresh_token":
            previous = await self.db.sirius_alexa_refreshes.find_one({"id": hashed(form.get("refresh_token", ""))})
            if not previous:
                raise HTTPException(400, "invalid_grant")
            row = await self.db.sirius_alexa_connections.find_one({
                "id": previous["family"], "user_id": previous["user_id"], "client_id": client, "active": True,
                "expires_at": {"$gt": stamp()},
            })
            if not row:
                raise HTTPException(400, "invalid_grant")
            if row["refresh_hash"] != previous["id"]:
                await self.db.sirius_alexa_connections.update_one(
                    {"id": row["id"], "user_id": row["user_id"]}, {"$set": {"active": False}})
                raise HTTPException(400, "invalid_grant")
            await active_account(self.db, row["user_id"])
            return await self.mint(row["user_id"], row["scopes"], client, row["id"], previous["id"])
        raise HTTPException(400, "unsupported_grant_type")

    async def identity(self, request, scope):
        header = request.headers.get("authorization", "")
        token = header[7:] if header.startswith("Bearer ") else ""
        if not token.startswith("saa_") or len(token) > 100:
            raise HTTPException(401, "Lier votre compte dans Alexa.")
        row = await self.db.sirius_alexa_connections.find_one({
            "access_hash": hashed(token), "active": True, "access_expires": {"$gt": stamp()},
            "expires_at": {"$gt": stamp()},
        })
        if not row:
            raise HTTPException(401, "Liaison Alexa expirée ou révoquée.")
        configuration(row["client_id"])
        if scope and scope not in row["scopes"]:
            raise HTTPException(403, "Droit Alexa manquant.")
        await active_account(self.db, row["user_id"])
        minute = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M")
        await insert_once(self.db, "sirius_alexa_limits", {
            "user_id": row["user_id"], "id": row["id"], "minute": minute, "count": 0,
        })
        await self.db.sirius_alexa_limits.update_one(
            {"user_id": row["user_id"], "id": row["id"], "minute": {"$ne": minute}},
            {"$set": {"minute": minute, "count": 0}})
        admitted = await self.db.sirius_alexa_limits.update_one(
            {"user_id": row["user_id"], "id": row["id"], "minute": minute, "count": {"$lt": 30}},
            {"$inc": {"count": 1}})
        if not admitted.modified_count:
            raise HTTPException(429, "Trente requêtes Alexa par minute maximum.", headers={"Retry-After": "60"})
        return row


def consent_page(ticket, origin, scopes):
    # Script data contains only a server-generated URL-safe ticket, never a caller-supplied URL.
    return """<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Lier Alexa à SIRIUS</title>
<h1>Lier Alexa à SIRIUS</h1>
<p>""" + html.escape(
        "Alexa pourra consulter et commander les lumières et prises Smart Life que vous autorisez dans SIRIUS."
        " Les commandes vocales seront exécutées sans confirmation supplémentaire ; une enceinte peut être partagée."
        if set(scopes) & HOME_SCOPES else
        "Alexa pourra lire les titres de vos dossiers et vos synthèses de réunion selon les droits demandés."
        " Ces données peuvent être entendues par les personnes proches de votre enceinte. Aucun envoi ni action externe."
    ) + """</p><p>Droits demandés : """ + html.escape(", ".join(scopes)) + """</p>
<p>Connectez-vous d'abord à SIRIUS dans ce même navigateur, puis revenez ici. Aucun mot de passe n'est demandé sur cette page.</p>
<a href='""" + html.escape(origin, quote=True) + """' target="_blank" rel="noopener">Ouvrir SIRIUS pour se connecter</a>
<p id="status" role="status">Vérifiez le compte avant de confirmer.</p>
<button id="check">Vérifier mon compte</button>
<button id="approve" disabled>Autoriser ces droits à Alexa</button><button id="deny">Refuser</button>
<script>
const ticket = """ + json.dumps(ticket) + """;
const status = document.getElementById("status");
async function submit(approve) {
  document.querySelectorAll("button").forEach(b => b.disabled = true);
  try {
    const response = await fetch("/api/integrations/alexa/oauth/consent", {
      method: "POST", credentials: "same-origin", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ticket, approve})
    });
    if (!response.ok) throw new Error("Confirmation refusée ou session expirée. Recommencez depuis Alexa.");
    const result = await response.json(); location.assign(result.redirect);
  } catch (error) { status.textContent = error.message; document.getElementById("check").disabled = false; }
}
document.getElementById("check").onclick = async () => {
  try {
    const response = await fetch("/api/auth/me", {credentials:"same-origin"});
    if (!response.ok) throw new Error("Connectez-vous à SIRIUS dans ce navigateur puis réessayez.");
    const user = await response.json();
    status.textContent = "Compte : " + (user.email || user.user_id);
    document.getElementById("approve").disabled = false; document.getElementById("deny").disabled = false;
  } catch (error) { status.textContent = error.message; }
};
document.getElementById("approve").onclick = () => submit(true);
document.getElementById("deny").onclick = () => submit(false);
</script></html>"""


def make_alexa_router(service, require_user):
    router = APIRouter(prefix="/integrations/alexa", tags=["alexa"])
    db = service.db

    @router.get("/oauth/authorize")
    async def authorize(request: Request):
        values = dict(request.query_params)
        if any(len(request.query_params.getlist(key)) != 1 for key in values):
            raise HTTPException(400, "Paramètres OAuth dupliqués.")
        ticket, scopes = await service.authorize(values)
        origin = configuration(values["client_id"])[2]
        return HTMLResponse(consent_page(ticket, origin, scopes), headers={
            "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        })

    @router.post("/oauth/consent")
    async def consent(body: Consent, request: Request):
        if request.headers.get("origin") != os.getenv("SIRIUS_ALEXA_PUBLIC_ORIGIN"):
            raise HTTPException(403, "Origine de consentement refusée.")
        user = await require_user(request, db)
        return JSONResponse(await service.consent(user["user_id"], body), headers={"Cache-Control": "no-store"})

    @router.post("/oauth/token")
    async def token(request: Request):
        header = request.headers.get("authorization", "")
        try:
            credentials = [unquote_plus(item) for item in
                           base64.b64decode(header[6:], validate=True).decode().split(":", 1)] if header.startswith("Basic ") else []
            if len(credentials) != 2 or credentials[0] not in {
                    os.getenv("SIRIUS_ALEXA_CLIENT_ID"), os.getenv("SIRIUS_ALEXA_HOME_CLIENT_ID")}:
                return oauth_error("invalid_client", 401)
            client, secret, _, _ = configuration(credentials[0])
            if (not hmac.compare_digest(credentials[0].encode(), client.encode())
                    or not hmac.compare_digest(credentials[1].encode(), secret.encode())):
                return oauth_error("invalid_client", 401)
            if not request.headers.get("content-type", "").startswith("application/x-www-form-urlencoded"):
                return oauth_error("invalid_request")
            values = parse_qs((await bounded_body(request, 8192)).decode(), keep_blank_values=True)
            if any(len(items) != 1 for items in values.values()):
                return oauth_error("invalid_request")
            result = await service.exchange({key: items[0] for key, items in values.items()}, client)
            return JSONResponse(result, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})
        except (ValueError, UnicodeError):
            return oauth_error("invalid_request")
        except HTTPException as exc:
            if exc.detail in ("invalid_grant", "unsupported_grant_type"):
                return oauth_error(exc.detail)
            if exc.status_code in (401, 402):
                return oauth_error("invalid_grant")
            raise

    @router.get("/connections")
    async def connections(request: Request):
        user = await require_user(request, db)
        return {"connections": await db.sirius_alexa_connections.find({"user_id": user["user_id"]}, {
            "_id": 0, "access_hash": 0, "refresh_hash": 0,
        }).sort("created_at", -1).to_list(50)}

    @router.delete("/connections/{identity}")
    async def revoke(identity: str, request: Request):
        user = await require_user(request, db)
        result = await db.sirius_alexa_connections.update_one(
            {"user_id": user["user_id"], "id": identity}, {"$set": {"active": False}})
        if not result.matched_count:
            raise HTTPException(404, "Liaison introuvable.")
        return {"revoked": True}

    @router.get("/dossiers")
    async def dossiers(request: Request, title: str = ""):
        row = await service.identity(request, "dossiers:read")
        if len(title) > 200:
            raise HTTPException(422, "Titre trop long.")
        query = {"user_id": row["user_id"], **({"title": title.strip()} if title.strip() else {})}
        return {"items": await db.sirius_work_dossiers.find(query, {
            "_id": 0, "id": 1, "title": 1,
        }).sort("created_at", -1).to_list(3)}

    @router.get("/meetings")
    async def meetings(request: Request):
        row = await service.identity(request, "meetings:read")
        rows = await db.sirius_meetings.find({"user_id": row["user_id"], "state": "READY"},
                                            {"_id": 0}).sort("ready_at", -1).to_list(1)
        return {"items": [{"id": item["id"], "title": item["title"],
                          "summary": item["result"]["summary"][:1800],
                          "capture_complete": item.get("capture_complete", False)} for item in rows]}

    return router

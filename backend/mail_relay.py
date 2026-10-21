# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Messagerie sans configuration pour les PC clients.

Un PC installé n'a ni application OAuth Google ni application Microsoft : sans ce relais,
« Connecter Google » répondait « GOOGLE_CLIENT_ID manquant ». Quand le serveur local n'a
pas sa propre configuration, les routes Gmail/Agenda/Outlook sont transmises à ΣIRIUS Cloud
avec la session du compte relié ; la connexion se fait alors en un clic, comme sur mobile.
Un PC qui possède ses propres identifiants (développement, entreprise) reste en local.
"""

import logging
import os

from fastapi import HTTPException

import cloud_link

logger = logging.getLogger("sirius.mail_relay")

GOOGLE_PREFIXES = ("/api/oauth/calendar/login", "/api/calendar/", "/api/gmail/", "/api/google/")
MICROSOFT_PREFIXES = (
    "/api/auth/microsoft/authorize",
    "/api/auth/microsoft/status",
    "/api/microsoft/",
    "/api/email/preferences",
)
_FORWARDED_HEADERS = ("content-type", "accept", "accept-language")
_RETURNED_HEADERS = ("content-type", "content-disposition", "cache-control")
_MAX_BODY = 5 * 1024 * 1024


def _env(*names: str) -> bool:
    return all((os.getenv(name) or "").strip() for name in names)


def google_local() -> bool:
    return _env("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")


def microsoft_local() -> bool:
    return _env("MICROSOFT_CLIENT_ID", "MICROSOFT_REDIRECT_URI", "MS_TOKEN_KEY")


def relay_enabled() -> bool:
    flag = (os.getenv("SIRIUS_MAIL_RELAY") or "").strip().lower()
    if flag in {"0", "off", "false"}:
        return False
    return cloud_link.relay_allowed()


def provider_for(path: str) -> str:
    if path.startswith(GOOGLE_PREFIXES):
        return "google"
    if path.startswith(MICROSOFT_PREFIXES):
        return "microsoft"
    return ""


def should_relay(path: str) -> bool:
    provider = provider_for(path)
    if not provider or not relay_enabled():
        return False
    return not (google_local() if provider == "google" else microsoft_local())


def status() -> dict:
    enabled = relay_enabled()
    return {
        "google": "cloud" if enabled and not google_local() else ("local" if google_local() else "absent"),
        "microsoft": "cloud" if enabled and not microsoft_local() else ("local" if microsoft_local() else "absent"),
        "linked": cloud_link.linked(),
    }


async def _read_body(receive) -> bytes:
    chunks, size = [], 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > _MAX_BODY:
            raise HTTPException(status_code=413, detail="Requête de messagerie trop volumineuse.")
        chunks.append(chunk)
        if not message.get("more_body"):
            break
    return b"".join(chunks)


class MailRelayMiddleware:
    """Transmet à ΣIRIUS Cloud les routes de messagerie que ce PC ne sait pas servir."""

    def __init__(self, app, is_direct_local_request):
        self.app = app
        self.is_local = is_direct_local_request

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope["type"] != "http" or scope.get("method") == "OPTIONS" or not should_relay(path):
            return await self.app(scope, receive, send)
        from starlette.requests import Request
        from starlette.responses import JSONResponse, Response

        request = Request(scope, receive)
        if not self.is_local(request):
            return await JSONResponse({"detail": "Messagerie réservée à cet ordinateur."}, status_code=403)(scope, receive, send)
        if not cloud_link.linked():
            detail = "Reliez d'abord votre compte ΣIRIUS pour connecter votre messagerie."
            return await JSONResponse({"detail": detail}, status_code=401)(scope, receive, send)
        try:
            body = await _read_body(receive)
            headers = {name: request.headers[name] for name in _FORWARDED_HEADERS if name in request.headers}
            query = scope.get("query_string", b"").decode("latin-1")
            target = path + (f"?{query}" if query else "")
            response = await cloud_link._send(scope["method"], target, content=body or None, headers=headers)
        except HTTPException as error:
            return await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
        if response.status_code == 401:
            logger.info("[MAIL RELAY] %s refusé par le Cloud (401)", path)
        returned = {name: response.headers[name] for name in _RETURNED_HEADERS if name in response.headers}
        return await Response(response.content, status_code=response.status_code, headers=returned)(scope, receive, send)

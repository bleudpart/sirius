"""Opt-in Google snapshots and verified change notifications; never executes mail content."""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote, urlsplit

import httpx
import jwt
from fastapi import HTTPException

from access_gate import access_status
from google_calendar import CAL_API, GMAIL_API, _client_conf
from google_connection import get_google_token

logger = logging.getLogger(__name__)
SCOPES = {
    "calendar": "https://www.googleapis.com/auth/calendar.events.readonly",
    "gmail": "https://www.googleapis.com/auth/gmail.readonly",
}
_jwks = jwt.PyJWKClient("https://www.googleapis.com/oauth2/v3/certs", timeout=5)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def provider_items(data, name):
    items = data.get(name, [])
    if not isinstance(items, list) or any(not isinstance(item, dict) or not isinstance(item.get("id"), str)
                                          or not item["id"] for item in items):
        raise HTTPException(502, "Liste Google non conforme.")
    return items


def calendar_item(event):
    if not isinstance(event.get("start", {}), dict) or not isinstance(event.get("end", {}), dict):
        raise HTTPException(502, "Dates Calendar non conformes.")
    return {"id": event["id"], "title": event.get("summary", ""),
            "start": event.get("start", {}), "end": event.get("end", {}), "status": event.get("status", "")}


def gmail_item(detail, mid):
    payload = detail.get("payload") or {}
    if not isinstance(payload, dict) or not isinstance(payload.get("headers", []), list):
        raise HTTPException(502, "Métadonnées Gmail non conformes.")
    headers = []
    for header in payload.get("headers", []):
        if not isinstance(header, dict) or not isinstance(header.get("name"), str) or not isinstance(header.get("value"), str):
            raise HTTPException(502, "En-tête Gmail non conforme.")
        if header["name"].lower() in ("from", "subject", "date"):
            headers.append({"name": header["name"], "value": header["value"][:2000]})
    return {"id": mid, "thread_id": detail.get("threadId"), "headers": headers,
            "labels": detail.get("labelIds", []), "internal_date": detail.get("internalDate")}


async def bounded_body(request, maximum=262144):
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > maximum:
            raise HTTPException(413, "Notification trop volumineuse.")
    return bytes(data)


def public_callback(name):
    value = os.getenv(name, "")
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment):
        raise HTTPException(503, "URL de notification HTTPS fixe non configurée.")
    return value


async def active_account(db, uid):
    user = await db.users.find_one({"user_id": uid})
    if not user or user.get("disabled"):
        raise HTTPException(401, "Compte indisponible.")
    status = await access_status(db, user)
    if not status.get("allowed"):
        raise HTTPException(402, status.get("detail") or "Accès SIRIUS indisponible.")


async def verify_pubsub(request):
    audience = public_callback("SIRIUS_GMAIL_PUSH_AUDIENCE")
    expected_email = os.getenv("SIRIUS_GMAIL_PUSH_SERVICE_ACCOUNT", "")
    if not expected_email:
        raise HTTPException(503, "Identité Pub/Sub non configurée.")
    bearer = request.headers.get("authorization", "")
    if not bearer.startswith("Bearer ") or len(bearer) > 16000:
        raise HTTPException(401, "Jeton Pub/Sub requis.")
    token = bearer[7:]
    def verify():
        signing = _jwks.get_signing_key_from_jwt(token)
        return jwt.decode(token, signing.key, algorithms=["RS256"], audience=audience,
                          options={"require": ["exp", "iat", "iss", "aud", "email", "email_verified"]})
    try:
        claims = await asyncio.to_thread(verify)
    except (jwt.PyJWTError, jwt.PyJWKClientError, ValueError) as exc:
        raise HTTPException(401, "Identité Pub/Sub refusée.") from exc
    if (claims["iss"] not in ("https://accounts.google.com", "accounts.google.com")
            or claims["email"] != expected_email or claims["email_verified"] is not True):
        raise HTTPException(401, "Identité Pub/Sub refusée.")


class WorkspaceChannels:
    def __init__(self, db, transport=None):
        self.db, self.transport = db, transport

    async def connection(self, uid):
        row = await self.db.google_calendar.find_one({"_id": uid})
        if not row or not row.get("connected_at") or not row.get("email"):
            raise HTTPException(401, "Reconnecter Google avant d'activer Workspace.")
        return row

    async def call(self, uid, method, url, scope, **kwargs):
        await active_account(self.db, uid)
        token = await get_google_token(self.db, uid, _client_conf, self.transport, scope)
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False, transport=self.transport) as client:
                response = await client.request(method, url, headers={"Authorization": "Bearer " + token}, **kwargs)
        except httpx.RequestError as exc:
            raise HTTPException(503, "Google injoignable ; résultat distant non confirmé.") from exc
        if response.status_code >= 300:
            raise HTTPException(401 if response.status_code == 401 else 502,
                                f"Google a refusé la demande ({response.status_code}).")
        try:
            result = response.json()
        except ValueError as exc:
            raise HTTPException(502, "Réponse Google illisible.") from exc
        if not isinstance(result, dict):
            raise HTTPException(502, "Réponse Google non conforme.")
        return result

    async def sync(self, uid, kind):
        connection = await self.connection(uid)
        if kind == "calendar":
            data = await self.call(uid, "GET", CAL_API, SCOPES[kind], params={
                "timeMin": stamp(), "timeMax": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
                "singleEvents": "true", "orderBy": "startTime", "maxResults": 50,
            })
            candidates = provider_items(data, "items")
            items = [calendar_item(event) for event in candidates[:50]]
            truncated = bool(data.get("nextPageToken")) or len(candidates) > 50
        else:
            data = await self.call(uid, "GET", GMAIL_API + "/messages", SCOPES[kind],
                                   params={"maxResults": 20, "labelIds": "INBOX"})
            items = []
            candidates = provider_items(data, "messages")
            for message in candidates[:20]:
                mid = str(message["id"])
                detail = await self.call(uid, "GET", GMAIL_API + "/messages/" + quote(mid, safe=""),
                                         SCOPES[kind], params={
                                             "format": "metadata", "metadataHeaders": ["From", "Subject", "Date"],
                                         })
                items.append(gmail_item(detail, mid))
            truncated = bool(data.get("nextPageToken")) or len(candidates) > 20
        current = await self.connection(uid)
        if current["connected_at"] != connection["connected_at"]:
            raise HTTPException(409, "Connexion Google modifiée pendant la synchronisation.")
        snapshot = {"user_id": uid, "id": kind, "items": items, "truncated": truncated,
                    "synced_at": stamp(), "connection_at": connection["connected_at"]}
        await self.db.sirius_workspace_snapshots.update_one({"user_id": uid, "id": kind},
                                                          {"$set": snapshot}, upsert=True)
        return snapshot

    async def watch(self, uid, kind):
        await active_account(self.db, uid)
        connection = await self.connection(uid)
        identity = str(uuid.uuid4())
        secret = secrets.token_urlsafe(32)
        existing = await self.db.sirius_workspace_watches.find_one(
            {"user_id": uid, "kind": kind, "state": {"$in": ["STARTING", "ACTIVE", "UNCERTAIN"]}})
        if existing:
            raise HTTPException(409, "Watch existant ; consulter son état puis le désactiver avant renouvellement.")
        if kind == "calendar":
            url = public_callback("SIRIUS_CALENDAR_PUSH_URL")
            payload = {"id": identity, "type": "web_hook", "address": url, "token": secret,
                       "expiration": str(int((datetime.now(timezone.utc) + timedelta(days=1)).timestamp() * 1000))}
            endpoint = CAL_API + "/watch"
        else:
            public_callback("SIRIUS_GMAIL_PUSH_AUDIENCE")
            if not os.getenv("SIRIUS_GMAIL_PUSH_SERVICE_ACCOUNT"):
                raise HTTPException(503, "Identité Pub/Sub non configurée.")
            topic = os.getenv("SIRIUS_GMAIL_PUBSUB_TOPIC", "")
            if not topic.startswith("projects/") or "/topics/" not in topic:
                raise HTTPException(503, "Topic Gmail Pub/Sub non configuré.")
            payload = {"topicName": topic, "labelIds": ["INBOX"], "labelFilterBehavior": "INCLUDE"}
            endpoint = GMAIL_API + "/watch"
        row = {"user_id": uid, "id": identity, "kind": kind, "state": "STARTING",
               "secret_hash": hashlib.sha256(secret.encode()).hexdigest(), "email": connection["email"].lower(),
               "connection_at": connection["connected_at"], "created_at": stamp(), "dirty": True,
               "revision": 0, "failures": 0, "next_at": stamp(),
               "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()}
        await self.db.sirius_workspace_watches.insert_one(dict(row))
        try:
            result = await self.call(uid, "POST", endpoint, SCOPES[kind], json=payload)
            expiration = datetime.fromtimestamp(int(result["expiration"]) / 1000, timezone.utc).isoformat()
            if kind == "calendar" and (result.get("id") != identity or not result.get("resourceId")):
                raise ValueError("Invalid channel")
            if kind == "gmail" and not result.get("historyId"):
                raise ValueError("Missing history")
        except (HTTPException, ValueError, KeyError, TypeError, OverflowError) as exc:
            await self.db.sirius_workspace_watches.update_one({"user_id": uid, "id": identity},
                {"$set": {"state": "UNCERTAIN", "error": "Watch distant non confirmé ; vérifier avant renouvellement."}})
            if isinstance(exc, HTTPException):
                raise
            raise HTTPException(502, "Watch Google non confirmé.") from exc
        updated = await self.db.sirius_workspace_watches.update_one({"user_id": uid, "id": identity, "state": "STARTING"},
            {"$set": {"state": "ACTIVE", "expires_at": expiration,
                      "resource_id": result.get("resourceId"), "history_id": result.get("historyId")}})
        if not updated.modified_count:
            raise HTTPException(409, "Watch local désactivé pendant la création ; vérifier le canal distant.")
        return {"id": identity, "state": "ACTIVE", "expires_at": expiration}

    async def calendar_push(self, request):
        identity = request.headers.get("x-goog-channel-id", "")
        row = await self.db.sirius_workspace_watches.find_one({"id": identity, "kind": "calendar"})
        token = request.headers.get("x-goog-channel-token", "")
        if (not row or row["state"] not in ("STARTING", "ACTIVE") or row["expires_at"] <= stamp()
                or not token or not hmac.compare_digest(hashlib.sha256(token.encode()).hexdigest(), row["secret_hash"])
                or not request.headers.get("x-goog-resource-id")
                or (row.get("resource_id") and row["resource_id"] != request.headers.get("x-goog-resource-id"))):
            raise HTTPException(401, "Canal Calendar invalide.")
        if request.headers.get("x-goog-resource-state") not in ("sync", "exists", "not_exists"):
            raise HTTPException(422, "Notification Calendar non conforme.")
        await self.db.sirius_workspace_watches.update_one({"id": identity, "user_id": row["user_id"]},
            {"$set": {"dirty": True, "next_at": stamp(), "failures": 0}, "$inc": {"revision": 1}})

    async def gmail_push(self, request, body):
        await verify_pubsub(request)
        try:
            envelope = json.loads(body)
            subscription = os.getenv("SIRIUS_GMAIL_PUBSUB_SUBSCRIPTION", "")
            if not subscription or envelope.get("subscription") != subscription:
                raise ValueError("Wrong subscription")
            message = envelope["message"]
            value = json.loads(base64.b64decode(message["data"], validate=True))
            email = value["emailAddress"].lower()
            if not str(value["historyId"]).isdigit() or not isinstance(email, str):
                raise ValueError("Invalid notification")
        except (ValueError, KeyError, TypeError, AttributeError) as exc:
            raise HTTPException(422, "Notification Gmail non conforme.") from exc
        await self.db.sirius_workspace_watches.update_many({
            "kind": "gmail", "email": email, "state": {"$in": ["STARTING", "ACTIVE"]},
            "expires_at": {"$gt": stamp()},
        }, {"$set": {"dirty": True, "next_at": stamp(), "failures": 0}, "$inc": {"revision": 1}})

    async def tick(self):
        rows = await self.db.sirius_workspace_watches.find({
            "state": "ACTIVE", "dirty": True, "next_at": {"$lte": stamp()},
        }).to_list(50)
        for row in rows:
            query = {"user_id": row["user_id"], "id": row["id"], "revision": row["revision"], "state": "ACTIVE"}
            try:
                if row["expires_at"] <= stamp():
                    await self.db.sirius_workspace_watches.update_one(query, {"$set": {"state": "EXPIRED"}})
                    continue
                connection = await self.connection(row["user_id"])
                if connection["connected_at"] != row["connection_at"]:
                    raise HTTPException(409, "Compte Google reconnecté ; recréer les watches.")
                await self.sync(row["user_id"], row["kind"])
                await self.db.sirius_workspace_watches.update_one(query, {"$set": {
                    "dirty": False, "failures": 0, "error": None, "last_sync": stamp(),
                }})
            except HTTPException as exc:
                failures = row["failures"] + 1
                await self.db.sirius_workspace_watches.update_one(query, {"$set": {
                    "failures": failures, "error": exc.detail,
                    "state": "FAILED" if failures >= 3 else "ACTIVE",
                    "next_at": (datetime.now(timezone.utc) + timedelta(minutes=failures)).isoformat(),
                }})
                logger.warning("Workspace sync rejected (%s), attempt %s", exc.status_code, failures)

    async def loop(self):
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("Workspace read-sync loop failed; no external write retried")
            await asyncio.sleep(30)

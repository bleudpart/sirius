"""Shared Google OAuth credential storage and refresh for account-owned clients."""

import base64
import hashlib
import json
from datetime import datetime, timedelta, timezone

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from auth_api import _AUTH_SECRET

TOKEN_URL = "https://oauth2.googleapis.com/token"


def cipher():
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(_AUTH_SECRET + b"|google-oauth").digest()))


def stored_tokens(tokens):
    return {"tokens": None, "tokens_enc": cipher().encrypt(json.dumps(tokens).encode()).decode()}


def read_tokens(document):
    if not document:
        return {}
    if document.get("tokens_enc"):
        try:
            return json.loads(cipher().decrypt(document["tokens_enc"].encode()))
        except (InvalidToken, ValueError) as exc:
            raise HTTPException(503, "Jetons Google illisibles ; reconnecter ce compte.") from exc
    return dict(document.get("tokens") or {})


async def get_google_token(db, uid, client_conf, transport=None, scope=None):
    document = await db.google_calendar.find_one({"_id": uid})
    tokens = read_tokens(document)
    if not tokens:
        raise HTTPException(401, "Google non connecté.")
    credential_query = ({"tokens_enc": document["tokens_enc"]} if document.get("tokens_enc")
                        else {"tokens": document.get("tokens")})
    granted = set((tokens.get("scope") or "").split())
    calendar_covered = (
        scope in {"https://www.googleapis.com/auth/calendar.events",
                  "https://www.googleapis.com/auth/calendar.events.readonly"}
        and "https://www.googleapis.com/auth/calendar" in granted
    ) or (scope == "https://www.googleapis.com/auth/calendar.events.readonly"
          and "https://www.googleapis.com/auth/calendar.events" in granted)
    if scope and scope not in granted and not calendar_covered:
        raise HTTPException(403, "Autorisation Google manquante ; reconnecter avec les droits requis.")
    exp = document.get("expires_at")
    if exp and datetime.fromisoformat(exp) > datetime.now(timezone.utc) + timedelta(seconds=60):
        if not document.get("tokens_enc"):
            await db.google_calendar.update_one({"_id": uid, "tokens": document.get("tokens")},
                                               {"$set": stored_tokens(tokens)})
        return tokens["access_token"]
    refresh = tokens.get("refresh_token")
    if not refresh:
        raise HTTPException(401, "Session Google expirée, reconnecter ce compte.")
    cid, secret = client_conf()
    try:
        async with httpx.AsyncClient(timeout=15, follow_redirects=False, transport=transport) as client:
            response = await client.post(TOKEN_URL, data={
                "client_id": cid, "client_secret": secret, "refresh_token": refresh,
                "grant_type": "refresh_token",
            })
    except httpx.RequestError as exc:
        raise HTTPException(503, "Renouvellement Google indisponible.") from exc
    if response.status_code != 200:
        try:
            error = response.json()
        except ValueError as exc:
            raise HTTPException(502, "Réponse de renouvellement Google illisible.") from exc
        if isinstance(error, dict) and error.get("error") == "invalid_grant":
            await db.google_calendar.update_one({"_id": uid, **credential_query},
                {"$set": {"tokens": None, "tokens_enc": None, "expires_at": None}})
            raise HTTPException(401, "Jeton Google révoqué ou expiré ; reconnecter ce compte.")
        raise HTTPException(502, "Renouvellement Google refusé ; vérifier puis reconnecter le compte.")
    try:
        renewed = response.json()
        if not isinstance(renewed.get("access_token"), str) or not renewed["access_token"]:
            raise ValueError("Missing access token")
        tokens.update(renewed)
        expires = (datetime.now(timezone.utc) + timedelta(seconds=int(renewed.get("expires_in", 3500)))).isoformat()
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(502, "Réponse OAuth Google non conforme.") from exc
    query = {"_id": uid, **credential_query}
    if document.get("connected_at"):
        query["connected_at"] = document["connected_at"]
    result = await db.google_calendar.update_one(query, {"$set": {**stored_tokens(tokens), "expires_at": expires}})
    if not result.matched_count:
        raise HTTPException(409, "Connexion Google modifiée ; aucune ancienne session restaurée.")
    return tokens["access_token"]

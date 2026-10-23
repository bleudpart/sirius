"""Verified WhatsApp inbox and account-confirmed, single-attempt external actions."""

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import Field, StrictBool, field_validator
from pymongo.errors import DuplicateKeyError

from action_registry import ActionInputs
from email_signature import append_signature_text, load_signature_identity
from google_calendar import CAL_API, GMAIL_API, _client_conf
from google_connection import get_google_token
from work_draft_recordings import digest, insert_once
from workspace_channels import active_account, bounded_body, stamp

logger = logging.getLogger(__name__)
Kind = Literal["gmail", "calendar"]


class WhatsAppReply(ActionInputs):
    request_id: uuid.UUID
    message_id: str = Field(min_length=1, max_length=300)
    text: str = Field(min_length=1, max_length=4000)


class GmailDraft(ActionInputs):
    request_id: uuid.UUID
    to: str = Field(min_length=3, max_length=254)
    subject: str = Field(default="", max_length=200)
    body: str = Field(min_length=1, max_length=10000)

    @field_validator("to")
    @classmethod
    def address(cls, value):
        if not re.fullmatch(r"[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+", value):
            raise ValueError("Une adresse e-mail simple requise.")
        return value

    @field_validator("subject")
    @classmethod
    def subject_header(cls, value):
        if "\r" in value or "\n" in value:
            raise ValueError("Objet sur une seule ligne requis.")
        return value


class CalendarDraft(ActionInputs):
    request_id: uuid.UUID
    title: str = Field(min_length=1, max_length=200)
    start: datetime
    end: datetime
    description: str = Field(default="", max_length=4000)


class Confirm(ActionInputs):
    confirm: StrictBool
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")


def wa_configuration():
    values = {name: os.getenv(name, "") for name in (
        "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN", "META_WABA_ID",
        "META_PHONE_NUMBER_ID", "META_ACCESS_TOKEN", "META_GRAPH_VERSION")}
    if (os.getenv("SIRIUS_WHATSAPP_ENABLED") != "1" or not all(values.values())
            or len(values["META_APP_SECRET"]) < 32 or len(values["META_WEBHOOK_VERIFY_TOKEN"]) < 32
            or not re.fullmatch(r"v[0-9]{2}\.0", values["META_GRAPH_VERSION"])
            or not values["META_PHONE_NUMBER_ID"].isdigit() or not values["META_WABA_ID"].isdigit()):
        raise HTTPException(503, "WhatsApp Cloud API non activée ou configuration incomplète.")
    return values


class MessagingIntegrations:
    def __init__(self, db, workspace, transport=None):
        self.db, self.workspace, self.transport = db, workspace, transport

    async def link_code(self, uid):
        wa_configuration()
        await active_account(self.db, uid)
        if await self.db.sirius_whatsapp_bindings.count_documents({"user_id": uid}) >= 5:
            raise HTTPException(409, "Cinq numéros liés maximum ; déconnecter avant une nouvelle liaison.")
        code = secrets.token_hex(24)
        await self.db.sirius_whatsapp_challenges.update_one({"user_id": uid, "id": "link"}, {"$set": {
            "user_id": uid, "id": "link", "code_hash": hashlib.sha256(code.encode()).hexdigest(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat(),
        }}, upsert=True)
        return {"command": "SIRIUS LINK " + code, "expires_in_seconds": 300,
                "instruction": "Envoyer ce texte depuis votre WhatsApp au numéro professionnel configuré."}

    async def incoming(self, body, signature):
        config = wa_configuration()
        expected = "sha256=" + hmac.new(config["META_APP_SECRET"].encode(), body, hashlib.sha256).hexdigest()
        if not re.fullmatch(r"sha256=[0-9a-f]{64}", signature) or not hmac.compare_digest(expected, signature):
            raise HTTPException(401, "Signature Meta invalide.")
        try:
            payload = json.loads(body)
            if payload["object"] != "whatsapp_business_account" or not isinstance(payload["entry"], list):
                raise ValueError("Invalid object")
            for entry in payload["entry"]:
                if str(entry["id"]) != config["META_WABA_ID"]:
                    continue
                for change in entry["changes"]:
                    value = change["value"]
                    if (change.get("field") != "messages"
                            or value.get("messaging_product") != "whatsapp"
                            or str(value.get("metadata", {}).get("phone_number_id")) != config["META_PHONE_NUMBER_ID"]):
                        continue
                    for message in value.get("messages", []):
                        await self.message(message)
        except (ValueError, KeyError, TypeError, AttributeError, OverflowError) as exc:
            raise HTTPException(422, "Notification Meta non conforme.") from exc

    async def message(self, message):
        sender, mid = message["from"], message["id"]
        sent = datetime.fromtimestamp(int(message["timestamp"]), timezone.utc)
        if (not isinstance(sender, str) or not re.fullmatch(r"[1-9][0-9]{7,14}", sender)
                or not isinstance(mid, str) or not 1 <= len(mid) <= 300
                or sent > datetime.now(timezone.utc) + timedelta(minutes=2)):
            raise ValueError("Invalid message identity")
        text = (message.get("text") or {}).get("body", "") if message.get("type") == "text" else ""
        if not isinstance(text, str) or len(text) > 4000:
            raise ValueError("Invalid text")
        routing_id = hashlib.sha256(sender.encode()).hexdigest()
        if text.startswith("SIRIUS LINK "):
            code = text[len("SIRIUS LINK "):]
            if not re.fullmatch(r"[0-9a-f]{48}", code):
                return
            challenge = await self.db.sirius_whatsapp_challenges.find_one({
                "code_hash": hashlib.sha256(code.encode()).hexdigest(), "expires_at": {"$gt": stamp()},
            })
            if not challenge:
                return
            uid = challenge["user_id"]
            await active_account(self.db, uid)
            existing = await self.db.sirius_whatsapp_bindings.find_one({"_id": routing_id})
            if existing and existing["user_id"] != uid:
                logger.warning("WhatsApp link rejected: sender already bound")
                return
            consumed = await self.db.sirius_whatsapp_challenges.find_one_and_delete({
                "user_id": uid, "id": "link", "code_hash": challenge["code_hash"], "expires_at": {"$gt": stamp()},
            })
            if not consumed:
                return
            if not existing:
                try:
                    await self.db.sirius_whatsapp_bindings.insert_one({
                        "_id": routing_id, "user_id": uid, "sender": sender, "created_at": stamp(),
                        "generation": str(uuid.uuid4()),
                    })
                except DuplicateKeyError:
                    logger.warning("WhatsApp link raced with another admission; no reassignment")
            return
        binding = await self.db.sirius_whatsapp_bindings.find_one({"_id": routing_id})
        if not binding or sent.isoformat() < binding["created_at"]:
            return
        user = await self.db.users.find_one({"user_id": binding["user_id"]})
        if not user or user.get("disabled"):
            return
        await insert_once(self.db, "sirius_whatsapp_messages", {
            "user_id": binding["user_id"], "id": mid, "sender": sender,
            "generation": binding["generation"], "received_at": stamp(), "sent_at": sent.isoformat(),
            "text": text, "type": message.get("type"), "supported": message.get("type") == "text",
        })

    async def stage(self, uid, identity, kind, payload, context):
        await active_account(self.db, uid)
        saved, _ = await insert_once(self.db, "sirius_integration_actions", {
            "user_id": uid, "id": str(identity), "kind": kind, "payload": payload, "context": context,
            "fingerprint": digest([kind, payload, context]), "state": "PREVIEW",
            "created_at": stamp(), "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
        })
        if saved["fingerprint"] != digest([kind, payload, context]):
            raise HTTPException(409, "Référence déjà utilisée avec un contenu différent.")
        return self.public_action(saved)

    @staticmethod
    def public_action(row):
        return {key: row[key] for key in ("id", "kind", "payload", "fingerprint", "state", "created_at", "expires_at")} | {
            "result": row.get("result"), "error": row.get("error"),
            "account": ({"email": row["context"]["email"]} if row["kind"] != "whatsapp"
                        else {"phone_number_id": row["context"]["phone_id"]})}

    async def stage_reply(self, uid, body):
        wa_configuration()
        message = await self.db.sirius_whatsapp_messages.find_one({"user_id": uid, "id": body.message_id})
        if not message or not message["supported"]:
            raise HTTPException(404, "Message texte introuvable.")
        await self.reply_context(uid, message["sender"], message["generation"])
        if not body.text.strip():
            raise HTTPException(422, "Réponse vide.")
        return await self.stage(uid, body.request_id, "whatsapp", {
            "to": message["sender"], "text": body.text, "in_reply_to": message["id"],
        }, {"generation": message["generation"], "phone_id": wa_configuration()["META_PHONE_NUMBER_ID"]})

    async def reply_context(self, uid, sender, generation):
        binding = await self.db.sirius_whatsapp_bindings.find_one({
            "user_id": uid, "sender": sender, "generation": generation})
        latest = await self.db.sirius_whatsapp_messages.find({
            "user_id": uid, "sender": sender, "generation": generation,
        }).sort("sent_at", -1).to_list(1)
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        if not binding or not latest or latest[0]["sent_at"] <= cutoff:
            raise HTTPException(409, "Liaison absente ou fenêtre WhatsApp de 24 h expirée ; aucun modèle envoyé.")

    async def stage_gmail(self, uid, body):
        if not body.body.strip():
            raise HTTPException(422, "Message vide.")
        connection = await self.workspace.connection(uid)
        identity = await load_signature_identity(self.db, uid)
        return await self.stage(uid, body.request_id, "gmail", {
            "to": body.to, "subject": body.subject,
            "body": append_signature_text(body.body, **identity),
        }, {"connection_at": connection["connected_at"], "email": connection["email"]})

    async def stage_calendar(self, uid, body):
        if (not body.title.strip() or body.start.utcoffset() is None or body.end.utcoffset() is None
                or body.end <= body.start or body.end - body.start > timedelta(days=7)):
            raise HTTPException(422, "Titre et dates avec fuseau requis ; durée positive de sept jours maximum.")
        connection = await self.workspace.connection(uid)
        return await self.stage(uid, body.request_id, "calendar", {
            "summary": body.title, "description": body.description,
            "start": {"dateTime": body.start.isoformat()}, "end": {"dateTime": body.end.isoformat()},
        }, {"connection_at": connection["connected_at"], "email": connection["email"]})

    async def execute(self, uid, identity, body):
        await active_account(self.db, uid)
        query = {"user_id": uid, "id": identity}
        row = await self.db.sirius_integration_actions.find_one(query)
        if not row:
            raise HTTPException(404, "Préparation introuvable.")
        if not body.confirm or body.fingerprint != row["fingerprint"]:
            raise HTTPException(409, "Confirmation explicite du contenu exact requise.")
        if row["state"] == "SUCCEEDED":
            return self.public_action(row)
        if row["state"] != "PREVIEW" or row["expires_at"] <= stamp():
            raise HTTPException(409, "Préparation expirée, déjà engagée ou incertaine ; aucune répétition.")
        payload = row["payload"]
        if row["fingerprint"] != digest([row["kind"], payload, row["context"]]):
            raise HTTPException(409, "Préparation altérée ; aucune exécution.")
        if row["kind"] == "whatsapp":
            config = wa_configuration()
            if config["META_PHONE_NUMBER_ID"] != row["context"]["phone_id"]:
                raise HTTPException(409, "Ligne WhatsApp modifiée ; refaire l'aperçu.")
            await self.reply_context(uid, payload["to"], row["context"]["generation"])
            endpoint = f"https://graph.facebook.com/{config['META_GRAPH_VERSION']}/{config['META_PHONE_NUMBER_ID']}/messages"
            token = config["META_ACCESS_TOKEN"]
            outgoing = {"messaging_product": "whatsapp", "recipient_type": "individual", "to": payload["to"],
                        "type": "text", "text": {"body": payload["text"], "preview_url": False},
                        "context": {"message_id": payload["in_reply_to"]}}
        else:
            connection = await self.workspace.connection(uid)
            if (connection["connected_at"] != row["context"]["connection_at"]
                    or connection["email"] != row["context"]["email"]):
                raise HTTPException(409, "Compte Google modifié ; refaire l'aperçu.")
            scope = ("https://www.googleapis.com/auth/gmail.send" if row["kind"] == "gmail"
                     else "https://www.googleapis.com/auth/calendar.events")
            token = await get_google_token(self.db, uid, _client_conf, self.transport, scope)
            if row["kind"] == "gmail":
                message = EmailMessage()
                message["To"], message["Subject"] = payload["to"], payload["subject"]
                message.set_content(payload["body"])
                endpoint = GMAIL_API + "/messages/send"
                outgoing = {"raw": base64.urlsafe_b64encode(message.as_bytes()).decode()}
            else:
                endpoint = CAL_API
                outgoing = {**payload, "id": hashlib.sha256((uid + identity).encode()).hexdigest()}
        claimed = await self.db.sirius_integration_actions.update_one(
            {**query, "state": "PREVIEW", "expires_at": {"$gt": stamp()}},
            {"$set": {"state": "EXECUTING", "started_at": stamp()}})
        if not claimed.modified_count:
            raise HTTPException(409, "Exécution déjà engagée ; ne pas répéter.")
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=False, transport=self.transport) as client:
                response = await client.post(endpoint, json=outgoing, headers={"Authorization": "Bearer " + token},
                                             params={"sendUpdates": "none"} if row["kind"] == "calendar" else None)
            if response.status_code >= 300:
                raise HTTPException(502, f"Fournisseur HTTP {response.status_code} ; vérifier avant toute nouvelle action.")
            result = response.json()
            provider_id = (result.get("messages") or [{}])[0].get("id") if row["kind"] == "whatsapp" else result.get("id")
            if not isinstance(provider_id, str) or not provider_id:
                raise ValueError("Missing provider ID")
        except (httpx.RequestError, HTTPException, ValueError, TypeError, AttributeError, KeyError) as exc:
            await self.db.sirius_integration_actions.update_one({**query, "state": "EXECUTING"}, {"$set": {
                "state": "UNCERTAIN", "error": "Résultat distant non confirmé ; vérifier chez le fournisseur, aucune relance automatique.",
            }})
            logger.warning("Integration action uncertain (%s)", type(exc).__name__)
            raise HTTPException(502, "Résultat distant incertain ; ne pas répéter sans vérification.") from exc
        await self.db.sirius_integration_actions.update_one({**query, "state": "EXECUTING"},
            {"$set": {"state": "SUCCEEDED", "result": {"provider_id": provider_id}, "finished_at": stamp()}})
        return self.public_action(await self.db.sirius_integration_actions.find_one(query))


def make_messaging_router(service, require_user):
    router = APIRouter(prefix="/integrations", tags=["whatsapp-workspace"])
    db, workspace = service.db, service.workspace

    async def uid(request):
        return (await require_user(request, db))["user_id"]

    @router.get("/whatsapp/webhook")
    async def verify(request: Request):
        config = wa_configuration()
        params = request.query_params
        if (params.get("hub.mode") != "subscribe"
                or not hmac.compare_digest(params.get("hub.verify_token", "").encode(),
                                           config["META_WEBHOOK_VERIFY_TOKEN"].encode())):
            raise HTTPException(403, "Vérification Meta refusée.")
        return Response(params.get("hub.challenge", ""), media_type="text/plain")

    @router.post("/whatsapp/webhook")
    async def receive(request: Request):
        await service.incoming(await bounded_body(request), request.headers.get("x-hub-signature-256", ""))
        return {"received": True}

    @router.post("/whatsapp/link")
    async def link(request: Request):
        return await service.link_code(await uid(request))

    @router.get("/whatsapp/inbox")
    async def inbox(request: Request):
        user_id = await uid(request)
        return {"bindings": await db.sirius_whatsapp_bindings.find({"user_id": user_id}, {"_id": 0}).to_list(10),
                "messages": await db.sirius_whatsapp_messages.find({"user_id": user_id}, {"_id": 0}).sort(
                    "sent_at", -1).to_list(50)}

    @router.delete("/whatsapp/link")
    async def unlink(request: Request):
        user_id = await uid(request)
        await db.sirius_whatsapp_challenges.delete_many({"user_id": user_id})
        await db.sirius_whatsapp_bindings.delete_many({"user_id": user_id})
        return {"disconnected": True}

    @router.post("/whatsapp/replies/preview")
    async def reply(body: WhatsAppReply, request: Request):
        return await service.stage_reply(await uid(request), body)

    @router.post("/workspace/gmail/preview")
    async def gmail(body: GmailDraft, request: Request):
        return await service.stage_gmail(await uid(request), body)

    @router.post("/workspace/calendar/preview")
    async def calendar(body: CalendarDraft, request: Request):
        return await service.stage_calendar(await uid(request), body)

    @router.get("/actions")
    async def actions(request: Request):
        user_id = await uid(request)
        rows = await db.sirius_integration_actions.find({"user_id": user_id}).sort("created_at", -1).to_list(50)
        return {"actions": [service.public_action(row) for row in rows]}

    @router.post("/actions/{identity}/confirm")
    async def confirm(identity: str, body: Confirm, request: Request):
        return await service.execute(await uid(request), identity, body)

    @router.post("/workspace/{kind}/sync")
    async def sync(kind: Kind, request: Request):
        return await workspace.sync(await uid(request), kind)

    @router.get("/workspace/{kind}/snapshot")
    async def snapshot(kind: Kind, request: Request):
        user_id = await uid(request)
        connection = await workspace.connection(user_id)
        row = await db.sirius_workspace_snapshots.find_one({
            "user_id": user_id, "id": kind, "connection_at": connection["connected_at"]}, {"_id": 0})
        if not row:
            raise HTTPException(404, "Aucune synchronisation pour cette connexion.")
        return row

    @router.post("/workspace/{kind}/watch")
    async def watch(kind: Kind, request: Request):
        return await workspace.watch(await uid(request), kind)

    @router.get("/workspace/watches")
    async def watches(request: Request):
        return {"watches": await db.sirius_workspace_watches.find({"user_id": await uid(request)},
            {"_id": 0, "secret_hash": 0}).sort("created_at", -1).to_list(50)}

    @router.delete("/workspace/watches/{identity}")
    async def stop(identity: str, request: Request):
        user_id = await uid(request)
        result = await db.sirius_workspace_watches.update_one({"user_id": user_id, "id": identity},
            {"$set": {"state": "DISABLED", "dirty": False}})
        if not result.matched_count:
            raise HTTPException(404, "Watch introuvable.")
        return {"disabled_locally": True, "remote_stop": False}

    @router.post("/workspace/calendar/webhook")
    async def calendar_push(request: Request):
        await bounded_body(request, 4096)
        await workspace.calendar_push(request)
        return Response(status_code=204)

    @router.post("/workspace/gmail/webhook")
    async def gmail_push(request: Request):
        await workspace.gmail_push(request, await bounded_body(request))
        return Response(status_code=204)

    return router

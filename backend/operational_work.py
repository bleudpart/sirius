"""Confirmed invoice follow-up, durable reminders and a connected work inbox."""

import asyncio
import logging
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import Field, JsonValue, ValidationError, field_validator
from pymongo.errors import PyMongoError

from action_registry import ActionDefinition, ActionInputs, ActionOutput, ActionSource
from action_runs import ConfirmIn, RunIn, now_iso
from email_signature import append_signature_text, graph_signature, signature_identity
from microsoft_graph import GRAPH, _access_token, microsoft_connection
from work_conversation import normalized
from work_draft_recordings import digest, insert_once

logger = logging.getLogger(__name__)


class FollowupIn(ActionInputs):
    dossier_id: str = Field(min_length=1, max_length=120)
    invoice_id: str = Field(min_length=1, max_length=120)
    followup_at: datetime

    @field_validator("followup_at")
    @classmethod
    def aware(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Date avec décalage UTC obligatoire.")
        return value.astimezone(timezone.utc)


class StartFollowup(FollowupIn):
    request_id: uuid.UUID


class ApplyFollowup(ActionInputs):
    preview: dict[str, JsonValue]


class ReminderIn(ActionInputs):
    text: str = Field(min_length=1, max_length=300)
    due_at: datetime

    @field_validator("text")
    @classmethod
    def meaningful_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Précisez le texte du rappel.")
        return value

    @field_validator("due_at")
    @classmethod
    def aware(cls, value):
        return FollowupIn.aware(value)


class ReminderRequest(ReminderIn):
    request_id: uuid.UUID


class ReminderRef(ActionInputs):
    reminder_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class OperationalWork:
    def __init__(self, db, runs, conversation, *, sender=None, token_reader=None):
        self.db, self.runs, self.conversation = db, runs, conversation
        self.sender = sender or self.send_graph
        self.token_reader = token_reader or _access_token

    def register(self):
        for definition in (
            ActionDefinition("work.invoice_preview", "THÉMIS / MNÉMOSYNE", "Préparer une relance Outlook et son suivi",
                             "1", FollowupIn, ActionOutput, self.preview_action, kind="prepare"),
            ActionDefinition("work.invoice_send", "OUTLOOK / NÉMÉSIS / CHRONOS",
                             "Envoyer la relance relue et programmer son suivi", "1", ApplyFollowup, ActionOutput,
                             self.send_action, kind="mutation", risk="sensitive",
                             sources=(ActionSource("preview", "work.invoice_preview", ("data",)),)),
            ActionDefinition("work.reminder", "CHRONOS", "Créer un rappel persistant", "1",
                             ReminderIn, ActionOutput, self.reminder_action, kind="mutation", risk="sensitive"),
            ActionDefinition("work.reminder_cancel", "CHRONOS", "Suspendre un rappel", "1",
                             ReminderRef, ActionOutput, self.cancel_reminder_action, kind="mutation", risk="sensitive"),
        ):
            self.runs.registry.register(definition)

    async def user(self, uid):
        user = await self.db.users.find_one({"user_id": uid}, {"_id": 0})
        if not user or user.get("disabled"):
            raise HTTPException(401, "Compte indisponible.")
        return user

    async def dossier(self, uid, dossier_id):
        item = await self.db.sirius_work_dossiers.find_one({"user_id": uid, "id": dossier_id}, {"_id": 0})
        if not item:
            raise HTTPException(404, "Dossier introuvable.")
        return item

    @staticmethod
    def future(stamp):
        now = datetime.now(timezone.utc)
        if not now < stamp <= now + timedelta(days=366):
            raise HTTPException(422, "Échéance future avec fuseau, dans les 366 jours, obligatoire.")

    async def preview_action(self, context, inputs):
        self.future(inputs.followup_at)
        user = await self.user(context.user_id)
        dossier = await self.dossier(context.user_id, inputs.dossier_id)
        reader = self.conversation.operational_invoice_preview
        if reader is None:
            raise HTTPException(503, "Lecteur de facture non configuré.")
        invoice = await reader(context.user_id, inputs.dossier_id, inputs.invoice_id)
        content = invoice["content"]
        if not isinstance(content["to"], str) or not re.fullmatch(r"[^@\s<>;,]+@[^@\s<>;,]+\.[^@\s<>;,]+", content["to"]):
            raise HTTPException(422, "Adresse du client absente ou invalide ; corrigez-la dans THÉMIS.")
        connection = await microsoft_connection(self.db, context.user_id)
        if not connection or not connection.get("email"):
            raise HTTPException(409, "Connectez Outlook / Microsoft 365 avant de préparer l'envoi.")
        identity = signature_identity(user)
        signed_body, attachments = graph_signature(content["message"], **identity)
        message = {"subject": content["subject"], "body": signed_body,
                   "toRecipients": [{"emailAddress": {"address": content["to"]}}]}
        if attachments:
            message["attachments"] = attachments
        return ActionOutput(data={
            **inputs.model_dump(mode="json"), "dossier_title": dossier["title"],
            "invoice": invoice, "sender": connection["email"], "channel": "Microsoft Graph",
            "message": message, "prepared_at": now_iso(),
            "readable_message": append_signature_text(content["message"], **identity),
            "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
            "notice": "Accord pour ce message exact et un rappel interne. Acceptation Microsoft ne signifie pas livraison. Aucun paiement ni facture modifié.",
        })

    async def start(self, uid, body):
        await self.user(uid)
        return await self.runs.create(uid, RunIn(
            request_id=body.request_id, objective="Relancer une facture et suivre la suite",
            steps=[
                {"id": "apercu", "action": "work.invoice_preview",
                 "inputs": body.model_dump(mode="json", exclude={"request_id"})},
                {"id": "envoi", "action": "work.invoice_send", "depends_on": ["apercu"],
                 "bindings": {"preview": {"step": "apercu", "path": ["data"]}}},
            ],
        ))

    async def send_graph(self, token, payload):
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(f"{GRAPH}/me/sendMail",
                                         headers={"Authorization": "Bearer " + token}, json=payload)
        return response.status_code, response.headers.get("request-id")

    async def send_action(self, context, inputs):
        uid, preview = context.user_id, inputs.preview
        await self.user(uid)
        await self.dossier(uid, preview["dossier_id"])
        identity = digest([uid, "invoice-send", preview["invoice"]["source"]["id"],
                           preview["invoice"]["fingerprint"], preview["message"]])[:32]
        receipt = await self.db.sirius_work_receipts.find_one({"user_id": uid, "id": identity}, {"_id": 0})
        reused = receipt is not None
        if not receipt:
            if preview["expires_at"] <= now_iso():
                raise HTTPException(409, "Aperçu expiré. Préparez de nouveau la relance.")
            token = await self.token_reader(self.db, uid)
            if preview["expires_at"] <= now_iso():
                raise HTTPException(409, "Aperçu expiré pendant la connexion Outlook. Préparez de nouveau la relance.")
            reader = self.conversation.operational_invoice_preview
            if reader is None:
                raise HTTPException(503, "Lecteur de facture non configuré.")
            fresh = await reader(uid, preview["dossier_id"], preview["invoice_id"])
            if digest(fresh) != digest(preview["invoice"]):
                raise HTTPException(409, "Facture ou coordonnées modifiées ; aucun envoi. Préparez un nouvel aperçu.")
            connection = await microsoft_connection(self.db, uid)
            if not connection or connection.get("email") != preview["sender"]:
                raise HTTPException(409, "Le compte Outlook a changé ; préparez un nouvel aperçu.")
            self.future(datetime.fromisoformat(preview["followup_at"]))
            _, claimed = await insert_once(self.db, "sirius_work_dispatches", {
                "id": identity, "user_id": uid, "run_id": context.run_id, "step": context.step_id,
                "claimed_at": now_iso(), "recipient": preview["invoice"]["content"]["to"],
            })
            if claimed:
                # The durable claim is never released: sendMail has no idempotency key.
                try:
                    code, request_id = await self.sender(token, {"message": preview["message"], "saveToSentItems": True})
                    state = "ACCEPTED" if code == 202 else "REJECTED" if 400 <= code < 500 else "UNKNOWN"
                    reason = ("Accepté par Microsoft ; livraison non attestée." if state == "ACCEPTED" else
                              f"Réponse Microsoft {code}. Aucun renvoi automatique ; vérifiez Outlook.")
                except httpx.TransportError:
                    logger.warning("Invoice dispatch response unavailable; automatic resend prohibited")
                    state, request_id = "UNKNOWN", None
                    reason = "Réponse réseau perdue. L'envoi peut avoir eu lieu ; vérifiez Outlook, aucun renvoi automatique."
                receipt, _ = await insert_once(self.db, "sirius_work_receipts", {
                    "id": identity, "user_id": uid, "state": state, "request_id": request_id,
                    "reason": reason, "recorded_at": now_iso(), "run_id": context.run_id,
                    "recipient": preview["invoice"]["content"]["to"], "invoice_id": preview["invoice_id"],
                })
            else:
                reused = True
                receipt = await self.db.sirius_work_receipts.find_one({"user_id": uid, "id": identity}, {"_id": 0})
                if not receipt:
                    return ActionOutput(data={"dispatch_id": identity, "state": "UNKNOWN", "dispatch_reused": True}, completion="PARTIAL",
                                        issues=["Envoi déjà engagé sans réponse persistée. Vérifiez Outlook ; aucun renvoi automatique."])
        if receipt["state"] != "ACCEPTED":
            return ActionOutput(data={"receipt": receipt, "dispatch_reused": reused}, completion="PARTIAL", issues=[receipt["reason"]])
        reminder, _ = await insert_once(self.db, "sirius_work_reminders", {
            "id": identity, "user_id": uid, "text": f"Vérifier le règlement après relance : {preview['invoice_id']}",
            "due_at": preview["followup_at"], "created_at": now_iso(), "dossier_id": preview["dossier_id"],
            "invoice_id": preview["invoice_id"], "run_id": context.run_id, "trigger": "invoice_unpaid",
        })
        await insert_once(self.db, "sirius_work_entries", {
            "id": "dispatch:" + identity, "user_id": uid, "dossier_id": preview["dossier_id"],
            "kind": "invoice_dispatch", "status": "confirmed", "created_at": receipt["recorded_at"],
            "content": {"event_type": "exchange", "text": receipt["reason"], "subject": preview["invoice"]["content"]["subject"],
                        "dispatch_id": identity, "recipient": receipt["recipient"], "request_id": receipt["request_id"]},
            "sources": [preview["invoice"]["source"]], "source_snapshots": [{
                key: preview["invoice"][key] for key in ("source", "data", "fingerprint")
            }],
            "confirmation_required": False, "execution": "provider_accepted",
        })
        if reminder["due_at"] != preview["followup_at"]:
            return ActionOutput(data={"receipt": receipt, "reminder": reminder, "dispatch_reused": reused}, completion="PARTIAL",
                                issues=[f"Relance identique déjà acceptée ; aucun nouvel envoi. "
                                        f"Le suivi initial reste au {reminder['due_at']}, pas au nouvel horaire demandé. "
                                        "Créez un rappel distinct si nécessaire."])
        return ActionOutput(data={"receipt": receipt, "reminder": reminder, "dispatch_reused": reused,
                                  "notice": "Relance acceptée et suivi enregistré ; livraison et règlement non attestés."})

    async def reminder_action(self, context, inputs):
        await self.user(context.user_id)
        identity = digest([context.user_id, context.idempotency_key])[:32]
        saved = await self.db.sirius_work_reminders.find_one({"user_id": context.user_id, "id": identity}, {"_id": 0})
        if not saved:
            self.future(inputs.due_at)
            saved, _ = await insert_once(self.db, "sirius_work_reminders", {
                "id": identity, "user_id": context.user_id, **inputs.model_dump(mode="json"),
                "due_at": inputs.due_at.isoformat(), "created_at": now_iso(), "trigger": "once",
                "run_id": context.run_id,
            })
        return ActionOutput(data=saved)

    async def cancel_reminder_action(self, context, inputs):
        await self.user(context.user_id)
        reminder = await self.db.sirius_work_reminders.find_one({"user_id": context.user_id, "id": inputs.reminder_id})
        if not reminder:
            raise HTTPException(404, "Rappel introuvable.")
        saved, _ = await insert_once(self.db, "sirius_work_reminder_controls", {
            "id": inputs.reminder_id, "user_id": context.user_id, "cancelled_at": now_iso(),
        })
        return ActionOutput(data=saved)

    async def start_reminder(self, uid, body):
        self.future(body.due_at)
        return await self.runs.create(uid, RunIn(request_id=body.request_id, objective="Créer un rappel",
            steps=[{"id": "rappel", "action": "work.reminder",
                    "inputs": body.model_dump(mode="json", exclude={"request_id"})}]))

    async def tick(self):
        rows = await self.db.sirius_work_reminders.find(
            {"due_at": {"$lte": now_iso()}, "processed": {"$ne": True}}, {"_id": 0},
        ).sort("due_at", 1).to_list(100)
        handled = 0
        for reminder in rows:
            uid, identity = reminder["user_id"], reminder["id"]
            if await self.db.sirius_work_reminder_outcomes.find_one({"user_id": uid, "id": identity}):
                await self.db.sirius_work_reminders.update_one({"user_id": uid, "id": identity}, {"$set": {"processed": True}})
                continue
            if await self.db.sirius_work_reminder_controls.find_one({"user_id": uid, "id": identity}):
                outcome, evidence = "CANCELLED", {"reason": "Rappel suspendu par l'utilisateur."}
            else:
                user = await self.db.users.find_one({"user_id": uid})
                if not user or user.get("disabled"):
                    await insert_once(self.db, "sirius_work_reminder_outcomes", {
                        "id": identity, "user_id": uid, "state": "ACCOUNT_UNAVAILABLE",
                        "evidence": {"reason": "Compte indisponible à l'échéance ; aucune notification externe."},
                        "checked_at": now_iso(),
                    })
                    await self.db.sirius_work_reminders.update_one({"user_id": uid, "id": identity}, {"$set": {"processed": True}})
                    continue
                outcome, evidence = "DUE", {"condition": "Échéance atteinte", "due_at": reminder["due_at"]}
                if reminder["trigger"] == "invoice_unpaid":
                    reader = self.conversation.operational_invoice_preview
                    if reader is None:
                        raise HTTPException(503, "Lecteur de facture non configuré.")
                    invoice = await self.db.themis_docs.find_one({"user_id": uid, "id": reminder["invoice_id"], "kind": "facture"}, {"_id": 0})
                    if not invoice:
                        outcome, evidence = "UNAVAILABLE", {"reason": "Facture supprimée ou inaccessible ; règlement non vérifiable."}
                    else:
                        from routes.work_dossiers import _number
                        total, paid = _number(invoice.get("total_ttc")), _number(invoice.get("paid"))
                        if total is None or paid is None or total < 0 or paid < 0:
                            outcome, evidence = "UNAVAILABLE", {"reason": "Montants invalides ; vérifiez THÉMIS."}
                        elif paid >= total or invoice.get("status") in ("payé", "refusé"):
                            outcome, evidence = "RESOLVED", {"reason": "Facture soldée ou refusée dans THÉMIS ; aucune relance suggérée."}
                        else:
                            evidence = {"condition": "Échéance atteinte et solde enregistré positif",
                                        "remaining": round(total - paid, 2), "invoice_id": reminder["invoice_id"],
                                        "verified_at": now_iso(), "notice": "Paiements hors THÉMIS non connus."}
                if outcome in ("DUE", "UNAVAILABLE"):
                    await insert_once(self.db, "sirius_work_notifications", {
                        "id": identity, "user_id": uid, "text": reminder["text"], "evidence": evidence,
                        "created_at": now_iso(), "state": outcome, "run_id": reminder["run_id"],
                    })
            await insert_once(self.db, "sirius_work_reminder_outcomes", {
                "id": identity, "user_id": uid, "state": outcome, "evidence": evidence, "checked_at": now_iso(),
            })
            await self.db.sirius_work_reminders.update_one({"user_id": uid, "id": identity}, {"$set": {"processed": True}})
            handled += 1
            if handled >= 100:
                break

    async def loop(self):
        while True:
            try:
                await self.tick()
            except (sqlite3.Error, PyMongoError, HTTPException):
                logger.exception("Work reminder tick unavailable; retained reminders will be retried")
            await asyncio.sleep(30)

    async def inbox(self, uid):
        await self.user(uid)
        workspace, _ = await insert_once(self.db, "sirius_work_hubs", {
            "id": "workspace", "user_id": uid, "workspace_id": uuid.uuid4().hex, "created_at": now_iso(),
        })
        rows = await self.db.sirius_action_runs.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(101)
        runs = await asyncio.gather(*(self.runs.status(uid, item["id"]) for item in rows[:100]))
        reminders = await self.db.sirius_work_reminders.find({"user_id": uid}, {"_id": 0}).sort("due_at", -1).to_list(101)
        for reminder in reminders[:100]:
            control = await self.db.sirius_work_reminder_controls.find_one({"user_id": uid, "id": reminder["id"]}, {"_id": 0})
            outcome = await self.db.sirius_work_reminder_outcomes.find_one({"user_id": uid, "id": reminder["id"]}, {"_id": 0})
            reminder["state"] = "CANCELLED" if control else outcome["state"] if outcome else "SCHEDULED"
            reminder["evidence"] = outcome["evidence"] if outcome else None
        notices = await self.db.sirius_work_notifications.find({"user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(101)
        accepted = await self.db.sirius_work_receipts.count_documents({"user_id": uid, "state": "ACCEPTED"})
        unknown = await self.db.sirius_work_receipts.count_documents({"user_id": uid, "state": "UNKNOWN"})
        unknown += max(0, await self.db.sirius_work_dispatches.count_documents({"user_id": uid})
                       - await self.db.sirius_work_receipts.count_documents({"user_id": uid}))
        completed = sum(item["state"] == "COMPLETED" for item in runs)
        metric = {
            "scope": "cent derniers parcours communs, pas toutes les demandes de conversation",
            "examined": len(runs), "completed": completed,
            "completion_rate_pct": round(100 * completed / len(runs), 1) if runs else None,
            "waiting": sum(item["state"] == "WAITING_CONFIRMATION" for item in runs),
            "blocked": sum(item["state"] == "BLOCKED" for item in runs),
            "cancelled": sum(item["state"] == "CANCELLED" for item in runs),
            "expired": sum(item["state"] == "EXPIRED" for item in runs),
            "provider_accepted_all_time": accepted, "provider_unknown_all_time": unknown,
            "human_confirmations": sum(bool(step["approval"]) for item in runs for step in item["steps"]),
            "recovered_steps": sum(step["state"] == "COMPLETED" and step["attempts"] > 1
                                   for item in runs for step in item["steps"]),
            "send_reuse_steps": sum((step["output"] or {}).get("data", {}).get("dispatch_reused") is True
                                   for item in runs for step in item["steps"]),
            "measured_duration_ms": sum(step["duration_ms"] or 0 for item in runs for step in item["steps"]),
            "time_saved_minutes": None, "delivery_confirmed": None,
        }
        summaries = []
        for item in runs:
            steps = []
            for step in item["steps"]:
                prepared = step["prepared"] if step["state"] == "WAITING_CONFIRMATION" else None
                if prepared and step["action"] == "work.invoice_send":
                    preview = prepared["inputs"]["preview"]
                    prepared = {"fingerprint": prepared["fingerprint"], "inputs": {
                        "sender": preview["sender"], "channel": preview["channel"],
                        **preview["invoice"]["content"], "followup_at": preview["followup_at"],
                        "readable_message": preview["readable_message"],
                        "source": preview["invoice"]["source"], "source_fingerprint": preview["invoice"]["fingerprint"],
                        "expires_at": preview["expires_at"], "notice": preview["notice"],
                        "signed_body": preview["message"]["body"],
                        "attachments": [{"name": file["name"], "isInline": file.get("isInline", False)}
                                        for file in preview["message"].get("attachments", [])],
                    }}
                steps.append({key: step[key] for key in ("id", "action", "state", "reason", "attempts", "attempt_limit")} | {
                    "prepared": prepared, "approval": step["approval"],
                    "receipt": (step["output"] or {}).get("data", {}).get("receipt"),
                })
            summaries.append({"id": item["id"], "objective": item["plan"]["objective"],
                              "state": item["state"], "summary": item["summary"], "steps": steps,
                              "created_at": item["created_at"], "expires_at": item["expires_at"]})
        return {"workspace_id": workspace["workspace_id"], "storage": "service connecté",
                "continuity": "Même compte et même service sur PC/téléphone : mêmes parcours, validations et rappels. Aucun rapprochement automatique de deux serveurs distincts.",
                "checked_at": now_iso(), "runs": summaries, "runs_truncated": len(rows) > 100,
                "reminders": reminders[:100], "reminders_truncated": len(reminders) > 100,
                "notifications": notices[:100], "notifications_truncated": len(notices) > 100,
                "metrics": metric,
                "notification_limits": "Notifications internes persistantes. Serveur allumé requis ; échéances rattrapées au redémarrage. Pas de push natif hors application."}

    async def connected_inbox(self, uid, request):
        readers = self.conversation.readers
        if readers is None:
            raise HTTPException(503, "Lecteurs de journée et validations non configurés.")
        hub, day, queue = await asyncio.gather(
            self.inbox(uid), readers.day(request), readers.queue(request),
        )
        return {**hub, "business": {"proposals": day["proposals"], "commitments": day["commitments"],
                                  "queue": queue["items"], "dossiers": day["dossiers"],
                                  "truncated": day["truncated"] or queue["truncated"],
                                  "missing_info": day["missing_info"]}}

    async def handle(self, req, user):
        text = normalized(req.text)
        uid = user["user_id"]
        base = {"executed": False, "work_sources": [], "work_suggestions": []}
        reminder_match = re.fullmatch(r"rappelle[- ]moi dans (\d{1,4}) (minutes?|heures?|jours?) de (.+)", text)
        if reminder_match:
            amount = int(reminder_match[1])
            multiplier = 60 if reminder_match[2].startswith("minute") else 3600 if reminder_match[2].startswith("heure") else 86400
            if not 1 <= amount * multiplier <= 366 * 86400:
                return {**base, "state": "NEEDS_CLARIFICATION", "answer": "Indiquez un délai positif inférieur à 367 jours."}
            original_text = re.split(r"\s+de\s+", req.text, maxsplit=1, flags=re.IGNORECASE)[-1].strip()
            if len(original_text) > 300:
                return {**base, "state": "NEEDS_CLARIFICATION", "answer": "Limitez le texte du rappel à 300 caractères."}
            result = await self.start_reminder(uid, ReminderRequest(
                request_id=uuid.uuid4(), text=original_text,
                due_at=datetime.now(timezone.utc) + timedelta(seconds=amount * multiplier),
            ))
            return {**base, "state": result["state"], "answer": self.report(result)}
        if re.match(r"rappelle[- ]moi\b", text):
            return {**base, "state": "NEEDS_CLARIFICATION", "answer":
                    "Précisez un délai, par exemple « Rappelle-moi dans 3 jours de vérifier ce dossier ». "
                    "Le rappel et son horaire seront à valider. Les récurrences générales ne sont pas encore prises en charge."}
        if re.fullmatch(r"(?:montre |affiche )?(?:mes resultats de travail|mes parcours a traiter|mes rappels sirius)[.!?]*", text):
            inbox = await self.inbox(uid)
            metric = inbox["metrics"]
            lines = [f"Sur les {metric['examined']} derniers parcours : {metric['completed']} terminés, "
                     f"{metric['waiting']} en attente d'accord, {metric['blocked']} bloqués."]
            if "rappels" in text:
                lines.extend(f"{item['text']} — {item['due_at']} — {item['state']}."
                             for item in inbox["reminders"][:10])
                if not inbox["reminders"]:
                    lines.append("Aucun rappel enregistré dans cet espace.")
            elif "parcours" in text:
                lines.extend(f"{item['objective']} — {item['state']} — Suivi parcours {item['id']}"
                             for item in inbox["runs"][:10])
            lines.append("Périmètre : cent derniers parcours communs ; dix éléments détaillés au maximum. "
                         "Temps économisé et livraison non mesurés. Ouvrez À traiter pour les preuves.")
            return {**base, "state": "READ_ONLY", "answer": "\n".join(lines)}
        relative = re.fullmatch(
            r"prepare la relance de (?:la facture (\S+)|cette facture) avec un suivi dans "
            r"(\d{1,3}|un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|quinze) jours?[.!?]*", text)
        if relative:
            dossier_id = (req.environment or {}).get("work_dossier_id")
            if not isinstance(dossier_id, str) or not 1 <= len(dossier_id) <= 120:
                return {**base, "state": "NEEDS_CLARIFICATION", "answer": "Choisissez d'abord le dossier de cette facture."}
            dossier = await self.dossier(uid, dossier_id)
            if relative[1]:
                invoice_id = req.text.split()[6]
            else:
                invoices = [item["id"] for item in dossier.get("sources", []) if item["kind"] == "facture"]
                if len(invoices) != 1:
                    return {**base, "state": "NEEDS_CLARIFICATION", "answer":
                            "Ce dossier ne désigne pas une facture unique. Précisez « la facture » puis sa référence exacte."}
                invoice_id = invoices[0]
            days = int(relative[2]) if relative[2].isdigit() else {
                "un": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "six": 6, "sept": 7,
                "huit": 8, "neuf": 9, "dix": 10, "quinze": 15,
            }[relative[2]]
            if not 1 <= days <= 366 or len(invoice_id) > 120:
                return {**base, "state": "NEEDS_CLARIFICATION", "answer":
                        "Précisez une référence de facture valide et un suivi entre un et 366 jours."}
            result = await self.start(uid, StartFollowup(request_id=uuid.uuid4(), dossier_id=dossier_id,
                invoice_id=invoice_id, followup_at=datetime.now(timezone.utc) + timedelta(days=days)))
            return {**base, "state": result["state"], "answer": self.report(result)}
        if "relance" in text and "avec un suivi" in text:
            return {**base, "state": "NEEDS_CLARIFICATION", "answer":
                    "Précisez par exemple « Prépare la relance de cette facture avec un suivi dans trois jours ». "
                    "Le dossier doit être sélectionné ; l'envoi et la date exacte restent à valider."}
        match = re.fullmatch(r"(suivi|reprends|arrete) parcours ([a-f0-9]{32})[.!?]*", text)
        if match:
            verb, identity = match.groups()
            result = await (self.runs.status(uid, identity) if verb == "suivi" else
                            self.runs.execute(uid, identity) if verb == "reprends" else self.runs.cancel(uid, identity))
            return {**base, "state": result["state"], "answer": self.report(result)}
        match = re.fullmatch(r"confirme parcours ([a-f0-9]{32}) etape ([a-z][a-z0-9_-]{0,39}) empreinte ([a-f0-9]{64})[.!?]*", text)
        if match:
            result = await self.runs.confirm(uid, match[1], match[2], ConfirmIn(fingerprint=match[3], confirm=True))
            return {**base, "state": result["state"], "executed": result["state"] == "COMPLETED", "answer": self.report(result)}
        match = re.fullmatch(r"prepare le parcours de relance de la facture (\S+) suivi le (\S+)", text)
        if match:
            environment = req.environment or {}
            dossier_id = environment.get("work_dossier_id")
            if not dossier_id:
                return {**base, "state": "NEEDS_CLARIFICATION", "answer": "Choisissez le dossier contenant cette facture avant de préparer son parcours."}
            try:
                body = StartFollowup(request_id=uuid.uuid4(), dossier_id=dossier_id,
                                     invoice_id=req.text.split()[-4],
                                     followup_at=req.text.split()[-1].replace("z", "Z"))
            except ValidationError:
                return {**base, "state": "NEEDS_CLARIFICATION",
                        "answer": "Date de suivi invalide. Précisez une date ISO avec décalage UTC, par exemple 2026-11-02T09:00:00+01:00."}
            result = await self.start(uid, body)
            return {**base, "state": result["state"], "answer": self.report(result)}
        if text.startswith(("prepare le parcours de relance", "confirme parcours")):
            return {**base, "state": "NEEDS_CLARIFICATION", "answer":
                    "Précisez le dossier affiché, la référence exacte de facture et « suivi le » avec une date ISO et décalage UTC. "
                    "Pour valider, utilisez le bouton À traiter ou la référence complète parcours, étape et empreinte. Un oui seul n'envoie rien."}
        return None

    @staticmethod
    def report(result):
        lines = [f"Parcours {result['id']} : {result['state']}.",
                 "Le suivi utilise le même moteur ARIANE que l'écran À traiter."]
        for step in result["steps"]:
            lines.append(f"{step['id']} : {step['state']}" + (f" — {step['reason']}" if step["reason"] else ""))
            if step["state"] == "WAITING_CONFIRMATION":
                import json
                inputs = step["prepared"]["inputs"]
                if step["action"] == "work.invoice_send":
                    preview = inputs["preview"]
                    lines.extend([f"Depuis {preview['sender']} vers {preview['invoice']['content']['to']}.",
                                  preview["invoice"]["content"]["subject"], preview["readable_message"],
                                  f"Suivi interne le {preview['followup_at']}.", preview["notice"]])
                else:
                    lines.append(json.dumps(inputs, ensure_ascii=False, indent=2))
                lines.append(f"Confirme parcours {result['id']} etape {step['id']} empreinte {step['prepared']['fingerprint']}")
            if step["output"] and step["output"].get("data", {}).get("receipt"):
                receipt = step["output"]["data"]["receipt"]
                lines.append(receipt["reason"])
        lines.append("Un accord général ne suffit pas. Aucune livraison n'est attestée ; les preuves sont dans À traiter.")
        return "\n".join(lines)


def make_operational_router(service, require_user):
    router = APIRouter(prefix="/work-hub", tags=["work-hub"])

    async def call(request, operation, *args):
        user = await require_user(request, service.db)
        try:
            return await operation(user["user_id"], *args)
        except (sqlite3.Error, PyMongoError) as exc:
            logger.exception("Work hub persistence failure")
            raise HTTPException(503, "Suivi indisponible. Une action peut être engagée ; consultez la même référence, ne recréez pas l'envoi.") from exc

    @router.get("")
    async def inbox(request: Request):
        return await call(request, service.connected_inbox, request)

    @router.post("/invoice-followup")
    async def start(body: StartFollowup, request: Request):
        return await call(request, service.start, body)

    @router.post("/reminders")
    async def reminder(body: ReminderRequest, request: Request):
        return await call(request, service.start_reminder, body)

    @router.post("/reminders/{identity}/cancel-preview")
    async def cancel(identity: str, request: Request):
        uid = (await require_user(request, service.db))["user_id"]
        if not await service.db.sirius_work_reminders.find_one({"user_id": uid, "id": identity}):
            raise HTTPException(404, "Rappel introuvable.")
        return await call(request, service.runs.create, RunIn(
            request_id=uuid.uuid5(uuid.NAMESPACE_URL, f"{uid}:cancel-reminder:{identity}"),
            objective="Suspendre un rappel", steps=[{"id": "suspension", "action": "work.reminder_cancel",
                                                     "inputs": {"reminder_id": identity}}],
        ))

    return router

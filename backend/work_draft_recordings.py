"""Recoverable, explicitly confirmed draft recording; never sends messages."""

import hashlib
import json
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from local_docstore import LocalCollection


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


async def insert_once(db, collection_name, document):
    collection = db[collection_name]
    identity = {"user_id": document["user_id"], "id": document["id"]}
    if isinstance(collection, LocalCollection):
        return await collection.insert_once(document, identity)
    try:
        await collection.insert_one({**document, "_id": digest([collection_name, identity])})
        return document, True
    except DuplicateKeyError:
        existing = await collection.find_one(identity, {"_id": 0})
        if existing is None:
            raise
        return existing, False


class DraftRecordings:
    def __init__(self, db, preview_invoice, dossier_for):
        self.db = db
        self.preview_invoice = preview_invoice
        self.dossier_for = dossier_for

    async def stage(self, uid, session, dossier_id, request):
        await self.dossier_for(dossier_id, uid)
        context = await self.db.sirius_work_contexts.find_one({
            "user_id": uid, "session_id": session, "expires_at": {"$gt": now_iso()},
        })
        preview = (context or {}).get("recording_preview")
        if not preview:
            raise HTTPException(409, "Aucune prévisualisation récente à enregistrer dans cette session. Préparez de nouveau la relance.")
        if preview.get("dossier_id") and preview["dossier_id"] != dossier_id:
            raise HTTPException(409, "Le dossier choisi diffère de celui de la prévisualisation. Préparez de nouveau la relance dans ce dossier.")
        items = preview.get("items", [])
        eligible, blocked = [], []
        for item in items:
            try:
                current = await self.preview_invoice(dossier_id, item["source"]["id"], request)
                if current["fingerprint"] != item["fingerprint"] or current["content"] != item["content"]:
                    raise HTTPException(409, "La source ou le texte a changé ; préparez de nouveau la relance.")
                if not current["content"].get("to", "").strip():
                    raise HTTPException(409, "Destinataire manquant ; complétez la fiche client puis préparez de nouveau.")
            except HTTPException as exc:
                if exc.status_code not in (404, 409, 422):
                    raise
                blocked.append({"source": item["source"], "reason": exc.detail})
                continue
            eligible.append(item)
        if not eligible:
            raise HTTPException(409, {
                "message": "Aucune préparation ne peut être enregistrée dans ce dossier. Rien enregistré ni envoyé.",
                "blocked": blocked,
            })
        operation_id = digest([uid, session, dossier_id, preview])[:32]
        created = datetime.now(timezone.utc)
        operation, _ = await insert_once(self.db, "sirius_work_recordings", {
            "id": operation_id, "user_id": uid, "session_id": session,
            "dossier_id": dossier_id, "kind": "recording",
            "items": eligible, "blocked": blocked, "created_at": created.isoformat(),
            "expires_at": (created + timedelta(hours=24)).isoformat(),
        })
        return await self.status(uid, operation["id"], request)

    async def operation(self, uid, operation_id):
        operation = await self.db.sirius_work_recordings.find_one({
            "user_id": uid, "id": operation_id, "kind": "recording",
        }, {"_id": 0})
        if not operation:
            raise HTTPException(404, "Préparation d'enregistrement introuvable.")
        await self.dossier_for(operation["dossier_id"], uid)
        return operation

    async def listing(self, uid):
        operations = await self.db.sirius_work_recordings.find(
            {"user_id": uid, "kind": "recording"}, {"_id": 0},
        ).sort("created_at", -1).to_list(21)
        items = []
        for operation in operations[:20]:
            try:
                dossier = await self.dossier_for(operation["dossier_id"], uid)
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                continue
            count = await self.db.sirius_work_entries.count_documents({
                "user_id": uid, "recording_id": operation["id"],
            })
            items.append({
                "id": operation["id"], "dossier_id": operation["dossier_id"],
                "dossier_title": dossier["title"], "created_at": operation["created_at"],
                "expires_at": operation["expires_at"], "recorded": count,
                "total": len(operation["items"]), "excluded": len(operation["blocked"]), "sent": False,
            })
        return {"items": items, "truncated": len(operations) > 20, "limit": 20, "executed": False}

    def entry_id(self, operation, item):
        return "recording-" + digest([operation["id"], item["source"]])

    async def status(self, uid, operation_id, request):
        operation = await self.operation(uid, operation_id)
        approval = await self.db.sirius_work_recordings.find_one({
            "user_id": uid, "id": "approval-" + operation_id, "kind": "approval",
        })
        results = []
        for item in operation["items"]:
            entry_id = self.entry_id(operation, item)
            entry = await self.db.sirius_work_entries.find_one({"id": entry_id, "user_id": uid})
            try:
                current = await self.preview_invoice(operation["dossier_id"], item["source"]["id"], request)
            except HTTPException as exc:
                if exc.status_code not in (404, 409, 422):
                    raise
                # Do not disclose old content or contacts when authorization is lost.
                results.append({"source": item["source"], "state": "recorded" if entry else "blocked",
                                "entry_id": entry_id if entry else None, "content": None,
                                "reason": "Brouillon déjà enregistré ; source à revérifier, contenu masqué."
                                if entry else "Source non disponible pour cette préparation ; nouvelle vérification nécessaire."})
                continue
            changed = current["fingerprint"] != item["fingerprint"] or current["content"] != item["content"]
            results.append({
                "source": item["source"], "entry_id": entry_id if entry else None,
                "state": "recorded" if entry else "blocked" if changed else "pending",
                "content": None if changed else item["content"],
                "reason": "Brouillon déjà enregistré, source modifiée depuis : relecture nécessaire."
                if entry and changed else "Brouillon enregistré, non envoyé." if entry
                else "Source modifiée ; nouvelle prévisualisation nécessaire." if changed
                else "En attente d'enregistrement confirmé.",
            })
        recorded = sum(item["state"] == "recorded" for item in results)
        expired = operation["expires_at"] <= now_iso()
        state = ("RECORDED" if recorded == len(results) and not operation["blocked"] else "PARTIAL" if recorded
                 else "EXPIRED" if expired else "BLOCKED" if all(item["state"] == "blocked" for item in results)
                 else "APPROVED" if approval else "AWAITING_CONFIRMATION")
        return {
            "id": operation_id, "dossier_id": operation["dossier_id"], "state": state,
            "items": results, "blocked_at_preparation": operation["blocked"],
            "recorded": recorded, "total": len(results), "approved": bool(approval),
            "created_at": operation["created_at"], "expires_at": operation["expires_at"],
            "persisted": True, "executed": False, "sent": False,
        }

    async def confirm(self, uid, operation_id, request):
        operation = await self.operation(uid, operation_id)
        if operation["expires_at"] <= now_iso():
            return await self.status(uid, operation_id, request)
        approval, _ = await insert_once(self.db, "sirius_work_recordings", {
            "id": "approval-" + operation_id, "user_id": uid, "kind": "approval",
            "operation_id": operation_id, "created_at": now_iso(),
        })
        for item in operation["items"]:
            entry_id = self.entry_id(operation, item)
            if await self.db.sirius_work_entries.find_one({"id": entry_id, "user_id": uid}):
                continue
            try:
                current = await self.preview_invoice(operation["dossier_id"], item["source"]["id"], request)
            except HTTPException as exc:
                if exc.status_code not in (404, 409, 422):
                    raise
                continue
            if current["fingerprint"] != item["fingerprint"] or current["content"] != item["content"]:
                continue
            # Stable identities and atomic insertion cover a lost response or a concurrent retry.
            await insert_once(self.db, "sirius_work_entries", {
                "id": entry_id, "user_id": uid, "dossier_id": operation["dossier_id"],
                "kind": "draft", "content": item["content"], "sources": [item["source"]],
                "source_snapshots": [{"source": item["source"], "fingerprint": item["fingerprint"],
                                      "data": item["data"]}],
                "status": "proposed", "confirmation_required": True, "execution": "manual_only",
                "recording_id": operation_id, "recording_approved_at": approval["created_at"],
                "created_at": now_iso(),
            })
        return await self.status(uid, operation_id, request)


def recording_report(result):
    lines = [
        f"Enregistrement {result['id']} · dossier {result['dossier_id']}.",
        f"{result['recorded']} brouillon(s) enregistré(s) sur {result['total']} préparation(s) retenue(s).",
    ]
    for item in result["items"]:
        lines.append(f"- {item['source']['id']} : {item['reason']}")
        if item["content"] and not item["entry_id"]:
            lines.extend([f"Destinataire : {item['content']['to']}.",
                          f"Objet : {item['content']['subject']}", item["content"]["message"]])
    if result["blocked_at_preparation"]:
        lines.append(f"{len(result['blocked_at_preparation'])} autre(s) préparation(s) exclue(s) : "
                     "source modifiée, non suivie dans ce dossier ou informations manquantes. "
                     "Consultez le résultat de préparation pour les détails.")
        for item in result["blocked_at_preparation"]:
            lines.append(f"- {item['source']['id']} : {item['reason']}")
    if result["expires_at"] <= now_iso() and result["recorded"] < result["total"]:
        lines.append("Demande expirée : les brouillons déjà enregistrés sont conservés. Préparez de nouveau les autres.")
    elif result["recorded"] < result["total"]:
        lines.append("Après relecture, dites « Confirme l'enregistrement des brouillons » dans cette conversation, "
                     f"ou « Confirme l'enregistrement {result['id']} » avec la référence exacte "
                     "pour enregistrer uniquement les préparations toujours valides. "
                     "Cette commande peut être répétée après une coupure sans dupliquer les brouillons.")
    lines.append("L'accord porte uniquement sur l'enregistrement de brouillons proposés dans le dossier, "
                 "pas sur leur validation métier ni sur un envoi. Aucun message envoyé.")
    return "\n".join(lines)

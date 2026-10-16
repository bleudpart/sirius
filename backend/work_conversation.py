"""Fast, source-grounded work conversations using the existing authorized readers."""

import asyncio
import logging
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException, Request

from local_docstore import DatabaseRouter, LocalDocStore
from work_briefing import work_briefing_text
from work_invoice_batch import batch_days, batch_report

logger = logging.getLogger(__name__)
Reader = Callable[..., Awaitable[dict]]
CONTEXT_TTL = timedelta(minutes=30)
READ_TIMEOUT = 12
PREVIEW_REPLY = re.compile(r"^(?:oui(?:[, ]+je confirme)?|je confirme|confirme|vas-y|envoie(?:-la|-les| tout| les relances)?|non|annule|laisse tomber)[\s.!?]*$")


def normalized(text: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", text.casefold())
        if not unicodedata.combining(char)
    ).replace("’", "'").strip()


def work_intent(text: str) -> str | None:
    value = normalized(text)
    if re.fullmatch(r"(?:confirme|annule) la previsualisation de relance[\s.!?]*", value):
        return "preview_reply"
    if re.fullmatch(r"(?:oublie|efface) (?:le contexte de |le contexte du )?(?:ce dossier|dossier courant)[.!?]*", value):
        return "clear"
    if re.search(r"\b(?:ouvre|ouvrir|ferme|fermer)\b", value):
        return None
    if re.search(r"\b(?:prepare|preparer)\b.*\brelances\b.*\bfactures\b", value):
        return "invoice_batch"
    if re.search(r"\b(?:prepare|preparer)\s+(?:la|une)\s+relance\b", value):
        return "dossier"
    if re.search(r"\b(?:ou en (?:est|sont)|resume|resumer|compare|comparer|fais le point|prepare|preparer|retrouve|rechercher|cherche|explique|pourquoi|envoie|envoyer|supprime|supprimer|cree|creer|transforme|surveille|planifie|relance)\b.*\b(?:dossiers?|clients?|factures?|devis|propositions?)\b", value):
        return "dossier"
    if re.search(r"\b(?:qu'est[- ]ce qui|ce qui|quels changements|montre les changements)\b.*\b(?:change|visite|dossier)\b", value):
        return "dossier"
    if re.search(r"\b(?:ce dossier|ce client|cette facture|ce devis|le dernier devis|ces propositions)\b", value):
        return "dossier"
    if re.search(r"\b(?:mes|les|quels|liste|affiche|montre)\b.*\bdossiers\b", value):
        return "list"
    if re.search(r"\b(?:a traiter|dois[- ]je traiter|dois traiter|mes priorites|mes validations|en attente de validation)\b", value):
        return "day"
    return None


@dataclass(frozen=True)
class WorkReaders:
    day: Reader
    dossiers: Reader
    thread: Reader
    queue: Reader


def dossier_summary(thread: dict) -> str:
    dossier = thread["dossier"]
    entries = thread["entries"]
    lines = [
        f"Dossier « {dossier['title']} ».",
        "Sources : dossier privé et sources métier autorisées, relus à cette demande.",
        f"{len(thread['sources'])} source(s) accessible(s), {len(entries)} entrée(s) visible(s).",
    ]
    for note in dossier.get("notes", [])[-5:]:
        lines.append(f"Note saisie : {note['text']}")
    for snapshot in thread["sources"][:10]:
        data = snapshot["data"]
        source = snapshot["source"]
        label = data.get("number") or data.get("name") or data.get("produit") or data.get("nom") or source["id"]
        lines.append(f"Source {source['kind']} : {label} (référence {source['id']}).")
        if source["kind"] == "facture":
            lines.append(f"  Total enregistré : {data.get('total_ttc', 'non renseigné')} ; payé enregistré : {data.get('paid', 'non renseigné')} ; échéance : {data.get('due_date') or 'non renseignée'}.")
        elif source["kind"] == "stock":
            lines.append(f"  Stock : {data.get('stock')} ; seuil : {data.get('alert')}.")
    if len(thread["sources"]) > 10:
        lines.append("Les dix premières sources sont détaillées ici ; consultez le dossier pour les autres.")
    for entry in sorted(entries, key=lambda item: item["created_at"])[-8:]:
        content = entry["content"]
        title = content.get("title") or content.get("text") or content.get("subject") or content.get("objective") or entry["kind"]
        lines.append(f"- {entry['created_at'][:10]} : {title} — état : {entry['status']}.")
        if entry.get("source_changed"):
            lines.append("  Attention : la source a changé depuis cette entrée ; nouvelle vérification nécessaire.")
    if not entries:
        lines.append("Aucune décision, tâche ou préparation enregistrée dans ce dossier.")
    changes = thread["what_changed"]["changes"]
    lines.append(
        f"{len(changes)} source(s) ajoutée(s) ou modifiée(s) depuis le point de comparaison."
        if thread["what_changed"]["baseline_id"]
        else "Aucun point de comparaison enregistré : impossible d'affirmer ce qui a changé depuis votre visite."
    )
    if thread["what_changed"]["baseline_id"]:
        for change in changes[:5]:
            fields = ", ".join(
                f"{key} : {values['before']} → {values['after']}"
                for key, values in list(change["fields"].items())[:5]
            )
            lines.append(f"- Source {change['source']['kind']} {change['source']['id']} : {fields}.")
    if thread["unavailable_sources"]:
        lines.append(f"{thread['unavailable_sources']} source(s) ne sont plus accessibles et ne sont pas restituées.")
    if thread["truncated"]:
        lines.append("Lecture partielle : seules les 500 dernières entrées sont prises en compte.")
    lines.append("Aucun courriel envoyé, aucune opération métier exécutée.")
    return "\n".join(lines)


class WorkConversation:
    def __init__(self, db):
        self.db = db
        self.readers: WorkReaders | None = None
        self.preview_invoice: Reader | None = None
        self.preview_invoice_batch: Reader | None = None
        self._indexes_ready = False
        self._index_lock = asyncio.Lock()

    async def _ensure_indexes(self):
        if self._indexes_ready:
            return
        async with self._index_lock:
            if not self._indexes_ready:
                await self.db.sirius_work_contexts.create_index(
                    [("user_id", 1), ("session_id", 1)],
                    unique=True, name="work_context_account_session",
                )
                self._indexes_ready = True

    async def _read(self, reader: Reader, *args, **kwargs) -> dict:
        if isinstance(self.db, LocalDocStore) or (
            isinstance(self.db, DatabaseRouter) and self.db.backend_name == "sqlite"
        ):
            def local_read():
                return asyncio.run(reader(*args, **kwargs))
            return await asyncio.to_thread(local_read)
        return await reader(*args, **kwargs)

    async def handle(self, req, user: dict, request: Request) -> dict | None:
        intent = work_intent(req.text)
        possible_reply = PREVIEW_REPLY.fullmatch(normalized(req.text))
        if intent is None and not possible_reply:
            return None
        if self.readers is None:
            logger.error("Work conversation readers are not configured")
            raise HTTPException(503, "Le service de conversation métier n'est pas configuré.")
        try:
            async with asyncio.timeout(READ_TIMEOUT):
                await self._ensure_indexes()
                if intent is None:
                    pending = await self.db.sirius_work_contexts.find_one({
                        "user_id": user["user_id"], "session_id": req.session_id or "default",
                        "preview_pending": True, "expires_at": {"$gt": datetime.now(timezone.utc).isoformat()},
                    })
                    if not pending or (req.environment or {}).get("work_context_clear"):
                        return None
                    intent = "preview_reply"
                return await self._answer(req, user, request, intent)
        except TimeoutError as exc:
            logger.warning("Work conversation authorized read timed out")
            raise HTTPException(503, "Lecture métier trop longue. Aucune action effectuée ; réessayez après vérification de la connexion.") from exc

    async def _answer(self, req, user: dict, request: Request, intent: str) -> dict:
        readers = self.readers
        assert readers is not None
        uid = user["user_id"]
        session = req.session_id or "default"
        now = datetime.now(timezone.utc)
        environment = req.environment or {}
        await self.db.sirius_work_contexts.delete_many({
            "user_id": uid, "expires_at": {"$lte": now.isoformat()},
        })
        if environment.get("work_context_clear"):
            await self.db.sirius_work_contexts.delete_many({"user_id": uid, "session_id": session})
        if intent == "clear":
            await self.db.sirius_work_contexts.delete_many({"user_id": uid, "session_id": session})
            return {"answer": "Le contexte temporaire du dossier est effacé. Le dossier et ses données sont conservés.",
                    "state": "READ_ONLY", "executed": False, "verified_at": now.isoformat(), "work_context": None,
                    "work_context_cleared": True, "work_sources": [], "work_suggestions": []}
        if intent == "preview_reply":
            await self.db.sirius_work_contexts.update_one(
                {"user_id": uid, "session_id": session},
                {"$unset": {"preview_pending": ""}},
            )
            cancelled = bool(re.match(r"^(?:non|annule|laisse tomber)\b", normalized(req.text)))
            return {
                "answer": "Prévisualisation abandonnée. Aucun brouillon enregistré ni message envoyé."
                if cancelled else "Cette prévisualisation n'autorise aucun envoi ni enregistrement. "
                                 "Utilisez le parcours Brouillon du dossier pour relire et enregistrer une proposition. "
                                 "Aucun message envoyé ; aucune action métier exécutée.",
                "state": "READ_ONLY" if cancelled else "NOT_EXECUTED",
                "executed": False, "persisted": False, "work_context": None,
                "verified_at": now.isoformat(), "work_sources": [], "work_suggestions": [],
            }
        zone_name = environment.get("timezone") or "Europe/Paris"
        try:
            today = now.astimezone(ZoneInfo(zone_name)).date()
        except (ZoneInfoNotFoundError, ValueError, TypeError) as exc:
            raise HTTPException(422, "Fuseau horaire invalide pour la journée de travail.") from exc
        base = {
            "state": "READ_ONLY", "executed": False,
            "verified_at": now.isoformat(), "work_context": None,
            "work_sources": [], "work_suggestions": [],
        }

        async def clarify(message):
            await self.db.sirius_work_contexts.delete_many({"user_id": uid, "session_id": session})
            return {**base, "state": "NEEDS_CLARIFICATION", "answer": message,
                    "work_context_cleared": True, "work_suggestions": ["Liste mes dossiers"]}

        if intent == "invoice_batch":
            days = batch_days(normalized(req.text))
            if days is None:
                return await clarify(
                    "Précisez un lot de votre compte et un seuil en jours, par exemple : "
                    "« Prépare les relances de mes factures en retard de plus de 15 jours ». "
                    "Les filtres par client ou dossier et les autres conditions ne sont pas encore pris en charge pour les lots. "
                    "Aucun brouillon enregistré ni envoyé."
                )
            if self.preview_invoice_batch is None:
                logger.error("Work invoice batch preview is not configured")
                raise HTTPException(503, "La préparation des relances en lot est indisponible. Aucun message envoyé.")
            batch = await self._read(self.preview_invoice_batch, days, zone_name, request)
            await self.db.sirius_work_contexts.update_one(
                {"user_id": uid, "session_id": session},
                {"$set": {"preview_pending": True,
                          "expires_at": (now + CONTEXT_TTL).isoformat()}},
                upsert=True,
            )
            return {
                **base, "state": "PREPARED" if batch["counts"]["prepared"] else "READ_ONLY",
                "answer": batch_report(batch), "persisted": False,
                "work_batch": batch,
                "work_sources": [item["source"] for item in batch["items"] if item["source"]],
            }

        if intent == "day":
            day, queue = await asyncio.gather(
                self._read(readers.day, request, on=today), self._read(readers.queue, request),
            )
            pending = sum(item["stage"] == "to_confirm" for item in queue["items"])
            answer = work_briefing_text(day) + f"\nValidations de dossier à examiner : {pending}."
            if queue["truncated"]:
                answer += "\nLa file de validations est partielle (limite de 500 entrées)."
            return {**base, "answer": answer,
                    "work_sources": [{"module": "work-dossiers", "kind": "proposal", "id": item["id"]}
                                     for item in day["proposals"][:20]],
                    "work_suggestions": ["Liste mes dossiers", "Où en est ce dossier ?"]}

        result = await self._read(readers.dossiers, request)
        dossiers = result["dossiers"]
        if intent == "list":
            names = "\n".join(f"- {item['title']}" for item in dossiers)
            answer = "Vos dossiers accessibles :\n" + names if dossiers else "Aucun dossier privé enregistré."
            if len(dossiers) >= 200:
                answer += "\nListe limitée à 200 dossiers ; elle peut être incomplète."
            return {**base, "answer": answer, "work_suggestions": ["Où en est le dossier « nom du dossier » ?"]}

        text = normalized(req.text)
        named = [item for item in dossiers if normalized(item["title"])
                 and re.search(r"(?<!\w)" + re.escape(normalized(item["title"])) + r"(?!\w)", text)]
        # Longer titles disambiguate a title that is a substring of another.
        named = [item for item in named if not any(
            len(other["title"]) > len(item["title"])
            and normalized(item["title"]) in normalized(other["title"])
            for other in named
        )]
        explicit = environment.get("work_dossier_id")
        if explicit is not None and (not isinstance(explicit, str) or len(explicit) > 120):
            raise HTTPException(422, "Référence de dossier invalide.")
        selected_id = None
        unknown_named_dossier = (
            not named and not re.search(r"\b(?:ce|mon|notre) dossier\b", text)
            and re.search(r"\bdossier\s+(?!(?:courant|actuel|selectionne|en cours)\b)[a-z0-9«\"]", text)
        )
        if unknown_named_dossier:
            return await clarify("Je ne retrouve pas ce nom de dossier dans les dossiers accessibles. Donnez son titre exact ou sélectionnez-le dans Mes dossiers ; le contexte précédent n'est pas utilisé à sa place.")
        if len(named) == 1:
            selected_id = named[0]["id"]
        elif len(named) > 1:
            return await clarify("Plusieurs dossiers correspondent. Précisez lequel : " + ", ".join(item["title"] for item in named) + ". Rien n'a été exécuté.")
        elif explicit:
            selected_id = explicit
        elif not environment.get("work_context_clear"):
            saved = await self.db.sirius_work_contexts.find_one({
                "user_id": uid, "session_id": session, "expires_at": {"$gt": now.isoformat()},
            })
            if saved:
                selected_id = saved.get("dossier_id")
        if not selected_id:
            return await clarify("De quel dossier parlez-vous ? Sélectionnez-le dans Mes dossiers ou indiquez son nom. Je ne déduis pas « ce client » ou « le dernier devis » sans référence vérifiée.")

        # A stored context is only a reference: permissions and sources are read again.
        try:
            thread = await self._read(readers.thread, selected_id, request)
        except HTTPException as exc:
            if exc.status_code == 404:
                await self.db.sirius_work_contexts.delete_many({"user_id": uid, "session_id": session})
            raise
        context = {"dossier_id": selected_id, "title": thread["dossier"]["title"],
                   "expires_at": (now + CONTEXT_TTL).isoformat()}
        await self.db.sirius_work_contexts.update_one(
            {"user_id": uid, "session_id": session},
            {"$set": context, "$unset": {"preview_pending": ""}}, upsert=True,
        )
        base["work_context"] = context
        action_request = bool(re.search(r"\b(?:prepare|preparer|envoie|envoyer|supprime|supprimer|cree|creer|transforme|surveille|planifie|relance)\b", text))
        prepare_followup = (
            re.search(r"\b(?:prepare|preparer)\b", text) and re.search(r"\brelance\b", text)
            and not re.search(r"\b(?:envoie|envoyer|supprime|supprimer|cree|creer|transforme|surveille|planifie)\b", text)
        )
        if prepare_followup:
            candidates = [item for item in thread["sources"] if item["source"]["kind"] == "facture"]
            named_invoices = [item for item in candidates if any(
                re.search(r"\b(?:facture|reference|relance)\s+[«\"#]?"
                          + re.escape(normalized(str(reference))) + r"(?!\w)", text)
                for reference in (item["source"]["id"], item["data"].get("number")) if reference
            )]
            bulk_or_condition = re.search(
                r"\b(?:tous|toutes|chaque|factures|jours?|semaines?|mois|si|sauf|uniquement|seulement|plus de|moins de|et|puis)\b", text,
            )
            if len(named_invoices) != 1 or bulk_or_condition:
                labels = "; ".join(
                    f"{item['data'].get('number') or 'sans numéro'} (référence {item['source']['id']})"
                    for item in candidates[:10]
                )
                return {**base, "state": "NEEDS_CLARIFICATION",
                        "answer": "Cette préparation traite une facture explicitement référencée, sans lot ni condition supplémentaire. "
                                  "Précisez sa référence et retirez les conditions non prises en charge. Aucun brouillon enregistré ni envoyé."
                                  + (f"\nFactures suivies accessibles : {labels}." if labels else "\nAucune facture suivie accessible dans ce dossier."),
                        "work_suggestions": ["Où en est ce dossier ?"]}
            if self.preview_invoice is None:
                logger.error("Work invoice preview is not configured")
                raise HTTPException(503, "La préparation de relance n'est pas configurée. Aucun brouillon enregistré ni envoyé.")
            preview = await self._read(
                self.preview_invoice, selected_id, named_invoices[0]["source"]["id"], request,
            )
            content = preview["content"]
            missing_labels = {
                "number": "numéro de facture", "due_date": "échéance",
                "total_ttc": "montant total", "paid": "montant déjà réglé",
                "recipient": "adresse du destinataire", "valid_due_date": "échéance valide",
                "payment_evidence_not_available_in_source": "preuve de règlement récente non disponible dans la source",
            }
            missing = ", ".join(missing_labels.get(key, key) for key in content["missing_info"])
            answer = (
                f"Prévisualisation de relance — dossier « {thread['dossier']['title']} ».\n"
                f"Facture : {preview['source']['id']}. Solde enregistré : {content['remaining']:.2f} €.\n"
                f"Destinataire à vérifier : {content['to'] or 'non renseigné — envoi impossible sans adresse vérifiée'}.\n"
                f"Objet : {content['subject']}\n\n{content['message']}\n\n"
                f"À vérifier : {missing}.\n"
                "Brouillon temporaire non enregistré. Aucun message envoyé. "
                "Relisez les paiements récents, le destinataire et le texte avant d'utiliser le parcours Brouillon du dossier ; "
                "la validation dans le dossier n'effectue pas d'envoi."
            )
            base.update(state="PREPARED", work_preview=preview, persisted=False)
            await self.db.sirius_work_contexts.update_one(
                {"user_id": uid, "session_id": session}, {"$set": {"preview_pending": True}},
            )
        elif action_request:
            answer = (
                f"Dossier identifié : « {thread['dossier']['title']} ». "
                "Cette première interface conversationnelle peut lire le dossier et ses sources, mais pas encore exécuter ce parcours. "
                "Utilisez les préparations et confirmations du dossier pour cette action. Aucun brouillon enregistré, aucun envoi et aucune surveillance activée.\n\n"
            ) + dossier_summary(thread)
            base["state"] = "NOT_EXECUTED"
        else:
            answer = dossier_summary(thread)
        if re.search(r"\b(?:pourquoi|explique)\b", text):
            if thread["suggestions"]:
                answer += "\nPourquoi ces propositions :\n" + "\n".join(
                    f"- {item['kind']} : {item['why_suggested']['rule']}"
                    for item in thread["suggestions"][:10]
                )
            else:
                answer += "\nAucune proposition disponible à expliquer."
        if "dernier devis" in text or "ce devis" in text or "ce client" in text or "cette facture" in text:
            answer += "\nLa sélection du dossier ne désigne pas à elle seule un client, une facture ou un devis : précisez la référence exacte avant une action."
        return {
            **base, "answer": answer, "work_context": context,
            "work_sources": [item["source"] for item in thread["sources"]],
            "work_suggestions": ["Où en est ce dossier ?", "Qu'ai-je à traiter aujourd'hui ?"],
        }

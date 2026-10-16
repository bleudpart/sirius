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

from local_docstore import LocalDocStore
from work_briefing import work_briefing_text

logger = logging.getLogger(__name__)
Reader = Callable[..., Awaitable[dict]]
CONTEXT_TTL = timedelta(minutes=30)
READ_TIMEOUT = 12


def normalized(text: str) -> str:
    return "".join(
        char for char in unicodedata.normalize("NFD", text.casefold())
        if not unicodedata.combining(char)
    ).replace("’", "'").strip()


def work_intent(text: str) -> str | None:
    value = normalized(text)
    if re.fullmatch(r"(?:oublie|efface) (?:le contexte de |le contexte du )?(?:ce dossier|dossier courant)[.!?]*", value):
        return "clear"
    if re.search(r"\b(?:ouvre|ouvrir|ferme|fermer)\b", value):
        return None
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
        if isinstance(self.db, LocalDocStore):
            def local_read():
                return asyncio.run(reader(*args, **kwargs))
            return await asyncio.to_thread(local_read)
        return await reader(*args, **kwargs)

    async def handle(self, req, user: dict, request: Request) -> dict | None:
        intent = work_intent(req.text)
        if intent is None:
            return None
        if self.readers is None:
            logger.error("Work conversation readers are not configured")
            raise HTTPException(503, "Le service de conversation métier n'est pas configuré.")
        try:
            async with asyncio.timeout(READ_TIMEOUT):
                await self._ensure_indexes()
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
                selected_id = saved["dossier_id"]
        if not selected_id:
            return await clarify("De quel dossier parlez-vous ? Sélectionnez-le dans Mes dossiers ou indiquez son nom. Je ne déduis pas « ce client » ou « le dernier devis » sans référence vérifiée.")

        # A stored context is only a reference: permissions and sources are read again.
        try:
            thread = await self._read(readers.thread, selected_id, request)
        except HTTPException as exc:
            if exc.status_code == 404:
                await self.db.sirius_work_contexts.delete_many({"user_id": uid, "session_id": session})
            raise
        action_request = bool(re.search(r"\b(?:prepare|preparer|envoie|envoyer|supprime|supprimer|cree|creer|transforme|surveille|planifie|relance)\b", text))
        if action_request:
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
        context = {"dossier_id": selected_id, "title": thread["dossier"]["title"],
                   "expires_at": (now + CONTEXT_TTL).isoformat()}
        await self.db.sirius_work_contexts.update_one(
            {"user_id": uid, "session_id": session},
            {"$set": context},
            upsert=True,
        )
        return {
            **base, "answer": answer, "work_context": context,
            "work_sources": [item["source"] for item in thread["sources"]],
            "work_suggestions": ["Où en est ce dossier ?", "Qu'ai-je à traiter aujourd'hui ?"],
        }

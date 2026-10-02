"""Private, local-first work threads under /work-dossiers.

GET /{id}/thread returns source-linked memory, suggestions and a live diff against
the last POST /{id}/snapshots checkpoint. POST decisions, commitments, meetings
and handoffs append memory; POST drafts prepares schema-grounded content.
POST /{id}/entries/{entry_id}/confirm only records human review, never executes
an external action. PATCH the same entry updates local commitment/task status.
POST /{id}/simulations is a read-only, explicit-assumption stock/payment preview.
Inputs reject unknown fields. Text is bounded to 2,000 characters, meetings to
30 tasks and handoffs to 20 sources. Threads expose the latest 500 entries with
an explicit truncation flag. Draft prices/results may be unknown, never guessed.

Sources are reauthorized on every read/write. Missing or revoked sources hide
linked memory, including previously captured business values. Meetings accept
explicit task proposals, not inferred promises. Handoffs are private briefs for
manual transfer, not cross-user sharing. No mail, order, task API or HACCP write.
"""

import hashlib
import json
import uuid
from datetime import date, datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StringConstraints

from enterprise import effective_permissions
from haccp import doc_status, trace_status


class DossierIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    category: Literal["general", "commerce", "chantier", "gestion", "haccp", "redaction"] = "general"


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2000)]
SourceKind = Literal["stock", "facture", "haccp_trace", "haccp_nonconformity", "haccp_document"]


class WorkInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceIn(WorkInput):
    kind: SourceKind
    id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class DecisionIn(WorkInput):
    outcome: Literal["accepted", "rejected", "deferred"]
    rationale: Text
    next_step: Text | None = None
    source: SourceIn | None = None


class CommitmentIn(WorkInput):
    text: Text
    owner: Text
    due_date: date | None = None
    source: SourceIn | None = None


class MeetingIn(WorkInput):
    title: Text
    notes: Text
    tasks: list[CommitmentIn] = Field(default_factory=list, max_length=30)


class DraftIn(WorkInput):
    source: SourceIn
    quantity: int | None = Field(default=None, ge=1, le=1000000)


class ConfirmIn(WorkInput):
    confirmed: StrictBool


class EntryStatusIn(WorkInput):
    status: Literal["completed", "cancelled"]


class HandoffIn(WorkInput):
    target: Literal["themis", "haccp", "general"]
    objective: Text
    sources: list[SourceIn] = Field(min_length=1, max_length=20)


class SimulationIn(WorkInput):
    source: SourceIn
    quantity_delta: int | None = Field(default=None, ge=-1000000, le=1000000)
    payment: float | None = Field(default=None, ge=0, le=1000000000, allow_inf_nan=False)


SOURCE_FIELDS = {
    "stock": ("name", "ref", "stock", "alert", "price"),
    "facture": ("number", "client_id", "client_name", "due_date", "total_ttc", "paid", "status"),
    "haccp_trace": ("produit", "lot", "fournisseur", "dlc", "quantite"),
    "haccp_nonconformity": ("type", "description", "gravite", "statut", "action_corrective"),
    "haccp_document": ("nom", "date_expiration"),
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _source_ref(source):
    kind = source.kind
    return {"kind": kind, "id": source.id, "module": "themis" if kind in ("stock", "facture") else "haccp"}


def _public(doc):
    return {key: value for key, value in doc.items() if key not in ("_id", "user_id")}


def _proposal(kind, doc, state, title, reason, label, module="themis", action_label=None):
    source_id = str(doc["id"])
    fingerprint = hashlib.sha256(f"{kind}:{source_id}:{state}".encode()).hexdigest()[:24]
    return {
        "id": fingerprint, "title": title, "reason": reason,
        "source": {"module": module, "kind": kind, "id": source_id, "label": label},
        "proposed_action": {
            "module": module,
            "label": action_label or ("Ouvrir THÉMIS pour vérifier" if module == "themis" else "Examiner dans HACCP"),
        },
        "confirmation_required": True,
    }


async def _proposals(db, uid, haccp_scope):
    items = await db.themis_items.find({"user_id": uid}, {"_id": 0}).to_list(500)
    docs = await db.themis_docs.find({"user_id": uid, "kind": "facture"}, {"_id": 0}).to_list(500)
    today = date.today()
    result = []
    for item in items:
        stock, threshold = int(item.get("stock", 0)), int(item.get("alert", 5))
        if stock <= threshold:
            label = item.get("name") or item.get("ref") or "Article"
            result.append(_proposal(
                "stock", item, f"{stock}:{threshold}", f"Stock bas : {label}",
                f"{stock} unité(s) en stock, seuil configuré à {threshold}. Vérifier avant de préparer un réapprovisionnement.",
                label,
            ))
    for doc in docs:
        if doc.get("status") in ("payé", "refusé") or not doc.get("due_date"):
            continue
        try:
            due = date.fromisoformat(str(doc["due_date"])[:10])
        except ValueError:
            continue
        remaining = round(float(doc.get("total_ttc") or 0) - float(doc.get("paid") or 0), 2)
        if due < today and remaining > 0:
            number = doc.get("number") or "Facture"
            result.append(_proposal(
                "facture", doc, f"{due}:{remaining}:{doc.get('status')}",
                f"Courrier à préparer : facture {number} échue",
                f"Échéance {due.isoformat()}, montant restant {remaining:.2f} €. Vérifier le paiement, le destinataire et le contenu dans THÉMIS ; aucun e-mail ne sera envoyé sans votre validation.",
                number,
                action_label="Préparer la relance dans THÉMIS",
            ))

    if haccp_scope is not None:
        traces = await db.haccp_trace.find(haccp_scope, {"_id": 0}).to_list(300)
        for trace in traces:
            status = trace_status(trace)
            if status not in ("expire", "bientot"):
                continue
            label = trace.get("produit") or "Produit tracé"
            due = trace.get("dlc") or "date inconnue"
            result.append(_proposal(
                "haccp_trace", trace, f"{status}:{due}",
                f"DLC {('dépassée' if status == 'expire' else 'proche')} : {label}",
                f"Lot {trace.get('lot') or 'non renseigné'}, DLC {due}. Vérifier le produit et appliquer votre procédure HACCP.",
                label, module="haccp",
            ))

        nonconformities = await db.haccp_nc.find(haccp_scope, {"_id": 0}).to_list(300)
        for nonconformity in nonconformities:
            if nonconformity.get("statut", "ouverte") != "ouverte":
                continue
            label = nonconformity.get("type") or "Non-conformité"
            description = nonconformity.get("description") or "Description absente"
            result.append(_proposal(
                "haccp_nonconformity", nonconformity,
                f"{label}:{description}:{nonconformity.get('gravite', '')}",
                f"Non-conformité HACCP ouverte : {label}",
                f"{description} Examiner le registre et valider toute action corrective dans HACCP.",
                label, module="haccp", action_label="Examiner dans HACCP",
            ))

        haccp_docs = await db.haccp_docs.find(haccp_scope, {"_id": 0}).to_list(300)
        for document in haccp_docs:
            status = doc_status(document)
            if status not in ("expire", "bientot"):
                continue
            label = document.get("nom") or "Document HACCP"
            due = document.get("date_expiration") or "date inconnue"
            result.append(_proposal(
                "haccp_document", document, f"{status}:{due}",
                f"Document HACCP {('expiré' if status == 'expire' else 'à échéance')} : {label}",
                f"Échéance {due}. Vérifier et mettre à jour le document dans le module HACCP.",
                label, module="haccp",
            ))
    return result


def make_work_dossiers_router(db, require_user):
    router = APIRouter(prefix="/work-dossiers", tags=["work-dossiers"])

    async def context(request):
        user = await require_user(request, db)
        uid = user["user_id"]
        if user.get("company_id"):
            membership = await db.enterprise_members.find_one(
                {"company_id": user["company_id"], "user_id": uid}, {"_id": 0}
            )
            haccp_scope = (
                {"company_id": user["company_id"]}
                if membership and "haccp" in effective_permissions(membership)
                else None
            )
            haccp_reason = (
                "Accès HACCP indisponible : votre compte n'a pas la permission entreprise « haccp »."
                if haccp_scope is None
                else ""
            )
        else:
            haccp_scope = {"user_id": uid}
            haccp_reason = ""
        return uid, haccp_scope, haccp_reason

    async def dossier_for(dossier_id, uid):
        dossier = await db.sirius_work_dossiers.find_one({"id": dossier_id, "user_id": uid})
        if not dossier:
            raise HTTPException(status_code=404, detail="Dossier introuvable.")
        return dossier

    async def capture(source, uid, haccp_scope):
        kind = source["kind"]
        collection = {
            "stock": db.themis_items, "facture": db.themis_docs,
            "haccp_trace": db.haccp_trace, "haccp_nonconformity": db.haccp_nc,
            "haccp_document": db.haccp_docs,
        }.get(kind)
        scope = {"user_id": uid} if kind in ("stock", "facture") else haccp_scope
        if collection is None or scope is None:
            return None
        query = {**scope, "id": source["id"]}
        if kind == "facture":
            query["kind"] = "facture"
        doc = await collection.find_one(query, {"_id": 0})
        if not doc:
            return None
        data = {key: doc.get(key) for key in SOURCE_FIELDS[kind]}
        if kind == "facture":
            client = await db.themis_clients.find_one(
                {"id": data["client_id"], "user_id": uid}, {"_id": 0}
            ) if data["client_id"] else None
            data["recipient"] = client.get("email", "") if client else ""
        ref = {"kind": kind, "id": source["id"], "module": "themis" if kind in ("stock", "facture") else "haccp"}
        return {"source": ref, "data": data, "fingerprint": _fingerprint(data)}

    async def required_capture(source, uid, haccp_scope):
        snapshot = await capture(source, uid, haccp_scope)
        if snapshot is None:
            raise HTTPException(status_code=404, detail="Source introuvable ou non autorisée.")
        return snapshot

    async def save_entry(dossier_id, uid, haccp_scope, kind, content, sources=(), snapshots=None):
        await dossier_for(dossier_id, uid)
        if snapshots is None:
            snapshots = [await required_capture(source, uid, haccp_scope) for source in sources]
        entry = {
            "id": str(uuid.uuid4()), "dossier_id": dossier_id, "user_id": uid,
            "kind": kind, "content": content, "sources": [item["source"] for item in snapshots],
            "source_snapshots": snapshots, "status": "proposed",
            "confirmation_required": True, "execution": "manual_only", "created_at": _now(),
        }
        await db.sirius_work_entries.insert_one(dict(entry))
        if snapshots:
            await db.sirius_work_dossiers.update_one(
                {"id": dossier_id, "user_id": uid},
                {"$addToSet": {"sources": {"$each": entry["sources"]}}},
            )
        return _public(entry)

    async def visible_entry(entry, uid, haccp_scope):
        return all([
            await capture(source, uid, haccp_scope) is not None
            for source in entry.get("sources", [])
        ])

    @router.get("")
    async def list_dossiers(request: Request):
        uid, haccp_scope, _ = await context(request)
        dossiers = await db.sirius_work_dossiers.find({"user_id": uid}, {"_id": 0, "user_id": 0}).to_list(200)
        for dossier in dossiers:
            dossier["sources"] = [
                source for source in dossier.get("sources", [])
                if await capture(source, uid, haccp_scope) is not None
            ]
        return {"dossiers": dossiers}

    @router.post("", status_code=201)
    async def create_dossier(body: DossierIn, request: Request):
        uid, _, _ = await context(request)
        doc = {
            "id": str(uuid.uuid4()), "user_id": uid, "title": body.title.strip(),
            "category": body.category, "notes": [], "sources": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if not doc["title"]:
            raise HTTPException(status_code=422, detail="Le titre est obligatoire.")
        await db.sirius_work_dossiers.insert_one(dict(doc))
        return {"dossier": _public(doc)}

    @router.post("/{dossier_id}/notes", status_code=201)
    async def add_note(dossier_id: str, body: NoteIn, request: Request):
        uid, _, _ = await context(request)
        if not await db.sirius_work_dossiers.find_one({"id": dossier_id, "user_id": uid}):
            raise HTTPException(status_code=404, detail="Dossier introuvable.")
        text = body.text.strip()
        if not text:
            raise HTTPException(status_code=422, detail="La note est vide.")
        note = {"id": str(uuid.uuid4()), "text": text, "created_at": datetime.now(timezone.utc).isoformat()}
        await db.sirius_work_dossiers.update_one(
            {"id": dossier_id, "user_id": uid}, {"$push": {"notes": note}}
        )
        return {"note": note}

    @router.get("/proposals")
    async def list_proposals(request: Request):
        uid, haccp_scope, haccp_reason = await context(request)
        candidates = await _proposals(db, uid, haccp_scope)
        decisions = await db.sirius_work_proposal_mutes.find(
            {"user_id": uid}, {"_id": 0, "proposal_id": 1}
        ).to_list(2000)
        muted = {row["proposal_id"] for row in decisions}
        integrations = [
            {
                "module": "themis",
                "label": "Commerce et courrier professionnel",
                "available": True,
                "detail": "Stocks et factures THÉMIS. Une relance reste à vérifier et à envoyer manuellement.",
            },
            {
                "module": "haccp",
                "label": "HACCP",
                "available": haccp_scope is not None,
                "detail": haccp_reason or "Lots, non-conformités et échéances documentaires du registre autorisé.",
            },
            {
                "module": "outlook",
                "label": "Boîte Outlook",
                "available": False,
                "detail": "Les messages entrants Outlook ne sont pas encore analysés ; les propositions de courrier proviennent des factures THÉMIS.",
            },
        ]
        return {
            "proposals": [candidate for candidate in candidates if candidate["id"] not in muted],
            "integrations": integrations,
        }

    @router.post("/proposals/{proposal_id}/dismiss")
    async def dismiss_proposal(proposal_id: str, request: Request):
        uid, haccp_scope, _ = await context(request)
        if not any(item["id"] == proposal_id for item in await _proposals(db, uid, haccp_scope)):
            raise HTTPException(status_code=404, detail="Proposition introuvable.")
        await db.sirius_work_proposal_mutes.update_one(
            {"user_id": uid, "proposal_id": proposal_id},
            {"$set": {"user_id": uid, "proposal_id": proposal_id}},
            upsert=True,
        )
        return {"dismissed": True}

    @router.post("/{dossier_id}/proposals/{proposal_id}")
    async def attach_proposal(dossier_id: str, proposal_id: str, request: Request):
        uid, haccp_scope, _ = await context(request)
        dossier = await db.sirius_work_dossiers.find_one({"id": dossier_id, "user_id": uid})
        if not dossier:
            raise HTTPException(status_code=404, detail="Dossier introuvable.")
        proposal = next((p for p in await _proposals(db, uid, haccp_scope) if p["id"] == proposal_id), None)
        if not proposal:
            raise HTTPException(status_code=404, detail="Proposition introuvable.")
        source = proposal["source"]
        await db.sirius_work_dossiers.update_one(
            {"id": dossier_id, "user_id": uid}, {"$addToSet": {"sources": source}}
        )
        return {"source": source}

    @router.post("/{dossier_id}/decisions", status_code=201)
    async def add_decision(dossier_id: str, body: DecisionIn, request: Request):
        uid, scope, _ = await context(request)
        content = body.model_dump(exclude={"source"})
        actor = await require_user(request, db)
        if actor["user_id"] != uid:
            raise HTTPException(status_code=401, detail="Le compte connecté a changé.")
        name = actor.get("name")
        content["decided_by"] = {
            "name": name.strip()[:120] if isinstance(name, str) and name.strip() else "Compte connecté",
            "identity": "authenticated_user",
        }
        entry = await save_entry(
            dossier_id, uid, scope, "decision", content,
            [_source_ref(body.source)] if body.source else [],
        )
        return {"entry": entry}

    @router.post("/{dossier_id}/commitments", status_code=201)
    async def add_commitment(dossier_id: str, body: CommitmentIn, request: Request):
        uid, scope, _ = await context(request)
        return {"entry": await save_entry(
            dossier_id, uid, scope, "commitment", body.model_dump(mode="json", exclude={"source"}),
            [_source_ref(body.source)] if body.source else [],
        )}

    @router.post("/{dossier_id}/meetings", status_code=201)
    async def add_meeting(dossier_id: str, body: MeetingIn, request: Request):
        uid, scope, _ = await context(request)
        sources = [_source_ref(task.source) for task in body.tasks if task.source]
        content = {
            "title": body.title, "notes": body.notes,
            "tasks": [
                {"id": str(uuid.uuid4()), **task.model_dump(mode="json"), "status": "proposed"}
                for task in body.tasks
            ],
        }
        return {"entry": await save_entry(dossier_id, uid, scope, "meeting", content, sources)}

    @router.post("/{dossier_id}/handoffs", status_code=201)
    async def add_handoff(dossier_id: str, body: HandoffIn, request: Request):
        uid, scope, _ = await context(request)
        return {"entry": await save_entry(
            dossier_id, uid, scope, "handoff",
            {"target": body.target, "objective": body.objective, "delivery": "manual"},
            [_source_ref(source) for source in body.sources],
        )}

    @router.post("/{dossier_id}/drafts", status_code=201)
    async def create_draft(dossier_id: str, body: DraftIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        source = _source_ref(body.source)
        snapshot = await required_capture(source, uid, scope)
        data = snapshot["data"]
        if body.source.kind == "facture":
            if body.quantity is not None:
                raise HTTPException(status_code=422, detail="La quantité concerne uniquement le stock.")
            remaining = round(float(data["total_ttc"] or 0) - float(data["paid"] or 0), 2)
            if remaining <= 0 or data["status"] in ("payé", "refusé"):
                raise HTTPException(status_code=409, detail="Cette facture ne nécessite pas de relance.")
            content = {
                "type": "invoice_followup",
                "to": data["recipient"],
                "subject": f"Relance facture {data['number'] or body.source.id}",
                "message": (
                    f"Bonjour {data['client_name'] or ''},\n"
                    f"Sauf erreur, la facture {data['number'] or body.source.id}, "
                    f"échéance {data['due_date'] or 'à vérifier'}, présente un solde "
                    f"de {remaining:.2f} €. Merci de vérifier le règlement."
                ),
                "mail_type": "relance", "remaining": remaining,
                "checks": ["Vérifier le paiement, le destinataire et le texte avant envoi manuel."],
            }
        elif body.source.kind == "stock":
            quantity = body.quantity if body.quantity is not None else max(
                1, int(data["alert"] if data["alert"] is not None else 5) + 1 - int(data["stock"] or 0)
            )
            content = {
                "type": "stock_reorder", "item_id": body.source.id,
                "lines": [{"label": data["name"] or data["ref"] or body.source.id,
                           "qty": quantity, "unit_price": None}],
                "notes": "Réapprovisionnement à vérifier ; fournisseur et prix d'achat non connus.",
                "checks": ["Choisir le fournisseur et vérifier quantité et prix avant commande manuelle."],
            }
        else:
            if body.quantity is not None:
                raise HTTPException(status_code=422, detail="La quantité concerne uniquement le stock.")
            content = {
                "type": "haccp_control", "control_type": "contrôle général",
                "objet": data.get("produit") or data.get("nom") or data.get("type") or body.source.id,
                "resultat": None, "anomalie": data.get("description") or "",
                "action_corrective": "",
                "checks": ["Effectuer le contrôle réel et renseigner le résultat dans HACCP."],
            }
        entry = await save_entry(dossier_id, uid, scope, "draft", content, snapshots=[snapshot])
        return {"entry": entry}

    @router.post("/{dossier_id}/entries/{entry_id}/confirm")
    async def confirm_entry(dossier_id: str, entry_id: str, body: ConfirmIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        if body.confirmed is not True:
            raise HTTPException(status_code=422, detail="Une confirmation humaine explicite est requise.")
        query = {"id": entry_id, "dossier_id": dossier_id, "user_id": uid}
        entry = await db.sirius_work_entries.find_one(query)
        if not entry:
            raise HTTPException(status_code=404, detail="Élément introuvable.")
        for previous in entry["source_snapshots"]:
            current = await required_capture(previous["source"], uid, scope)
            if current["fingerprint"] != previous["fingerprint"]:
                raise HTTPException(status_code=409, detail="La source a changé ; préparer une nouvelle proposition.")
        if entry["status"] == "confirmed":
            return {"entry": _public(entry), "executed": False}
        if entry["status"] != "proposed":
            raise HTTPException(status_code=409, detail="Cet élément ne peut plus être confirmé.")
        updates = {"status": "confirmed", "confirmed_at": _now()}
        if entry["kind"] == "meeting":
            content = entry["content"]
            for task in content["tasks"]:
                task["status"] = "confirmed"
            updates["content"] = content
        confirmed = await db.sirius_work_entries.find_one_and_update(
            {**query, "status": "proposed"},
            {"$set": updates}, return_document=True,
        )
        if not confirmed:
            raise HTTPException(status_code=409, detail="L'état a changé ; recharger le fil.")
        return {"entry": _public(confirmed), "executed": False}

    @router.patch("/{dossier_id}/entries/{entry_id}")
    async def update_entry(dossier_id: str, entry_id: str, body: EntryStatusIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        query = {"id": entry_id, "dossier_id": dossier_id, "user_id": uid}
        entry = await db.sirius_work_entries.find_one(query)
        if not entry or not await visible_entry(entry, uid, scope):
            raise HTTPException(status_code=404, detail="Élément introuvable.")
        if entry["kind"] != "commitment":
            raise HTTPException(status_code=409, detail="Seuls les engagements locaux ont un suivi d'exécution.")
        if entry["status"] == body.status:
            return {"entry": _public(entry)}
        if entry["status"] != "confirmed":
            raise HTTPException(status_code=409, detail="Confirmer l'engagement avant son suivi.")
        updated = await db.sirius_work_entries.find_one_and_update(
            {**query, "status": "confirmed"},
            {"$set": {"status": body.status, "updated_at": _now()}}, return_document=True,
        )
        if not updated:
            raise HTTPException(status_code=409, detail="L'état a changé ; recharger le fil.")
        return {"entry": _public(updated)}

    async def current_sources(dossier, uid, scope):
        snapshots = []
        seen = set()
        for source in dossier.get("sources", []):
            key = (source["kind"], source["id"])
            if key not in seen:
                seen.add(key)
                snapshot = await capture(source, uid, scope)
                if snapshot:
                    snapshots.append(snapshot)
        return snapshots

    @router.post("/{dossier_id}/snapshots", status_code=201)
    async def checkpoint(dossier_id: str, request: Request):
        uid, scope, _ = await context(request)
        dossier = await dossier_for(dossier_id, uid)
        snapshot = {
            "id": str(uuid.uuid4()), "user_id": uid, "dossier_id": dossier_id,
            "created_at": _now(), "sources": await current_sources(dossier, uid, scope),
        }
        await db.sirius_work_snapshots.insert_one(dict(snapshot))
        return {"snapshot": _public(snapshot)}

    @router.get("/{dossier_id}/thread")
    async def thread(dossier_id: str, request: Request):
        uid, scope, reason = await context(request)
        dossier = await dossier_for(dossier_id, uid)
        current = await current_sources(dossier, uid, scope)
        unavailable_sources = len({
            (source["kind"], source["id"]) for source in dossier.get("sources", [])
        }) - len(current)
        dossier["sources"] = [item["source"] for item in current]
        entries = await db.sirius_work_entries.find(
            {"user_id": uid, "dossier_id": dossier_id}, {"_id": 0}
        ).sort("created_at", -1).to_list(501)
        truncated = len(entries) > 500
        visible = [_public(entry) for entry in entries[:500] if await visible_entry(entry, uid, scope)]
        versions = {
            (item["source"]["kind"], item["source"]["id"]): item["fingerprint"]
            for item in current
        }
        for entry in visible:
            entry["source_changed"] = any(
                versions.get((item["source"]["kind"], item["source"]["id"])) != item["fingerprint"]
                for item in entry["source_snapshots"]
            )
        baseline = await db.sirius_work_snapshots.find(
            {"user_id": uid, "dossier_id": dossier_id}, {"_id": 0}
        ).sort("created_at", -1).to_list(1)
        old = {
            (item["source"]["kind"], item["source"]["id"]): item["data"]
            for item in baseline[0]["sources"]
        } if baseline else {}
        changes = []
        for item in current:
            previous = old.get((item["source"]["kind"], item["source"]["id"]))
            fields = {
                key: {"before": previous.get(key) if previous else None, "after": value}
                for key, value in item["data"].items()
                if previous is None or previous.get(key) != value
            }
            if fields:
                changes.append({"source": item["source"], "change": "added" if previous is None else "changed", "fields": fields})
        suggestions = []
        if not visible:
            suggestions.append({"kind": "record_decision", "reason": "Préciser l'objectif et la prochaine étape."})
        for entry in visible:
            if entry["status"] == "proposed":
                suggestions.append({"kind": "human_confirmation", "entry_id": entry["id"]})
            if entry["kind"] == "decision" and not entry["content"].get("next_step"):
                suggestions.append({"kind": "missing_next_step", "entry_id": entry["id"]})
            elif entry["kind"] == "commitment" and entry["status"] == "confirmed":
                due = entry["content"].get("due_date")
                suggestions.append({
                    "kind": "overdue_commitment" if due and due < date.today().isoformat() else "follow_commitment",
                    "entry_id": entry["id"],
                })
            if entry["status"] == "confirmed":
                if entry["kind"] in ("draft", "handoff"):
                    suggestions.append({
                        "kind": "manual_execution" if entry["kind"] == "draft" else "manual_handoff",
                        "entry_id": entry["id"],
                    })
                elif entry["kind"] == "meeting":
                    for task in entry["content"]["tasks"]:
                        suggestions.append({"kind": "task_proposal", "entry_id": entry["id"], "task_id": task["id"]})
            if entry["source_changed"]:
                suggestions.append({"kind": "review_changed_source", "entry_id": entry["id"]})
        for item in current:
            linked = [entry for entry in visible if item["source"] in entry["sources"]]
            if not linked:
                suggestions.append({"kind": "review_source", "source": item["source"]})
        return {
            "dossier": _public(dossier), "entries": visible, "sources": current,
            "what_changed": {"baseline_id": baseline[0]["id"] if baseline else None, "changes": changes},
            "suggestions": suggestions, "truncated": truncated,
            "unavailable_sources": unavailable_sources,
            "limits": {"entries": 500, "execution": "manual_only", "haccp": reason},
        }

    @router.post("/{dossier_id}/simulations")
    async def simulate(dossier_id: str, body: SimulationIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        snapshot = await required_capture(_source_ref(body.source), uid, scope)
        data = snapshot["data"]
        if body.source.kind == "stock" and body.quantity_delta is not None and body.payment is None:
            before = int(data["stock"] or 0)
            after = before + body.quantity_delta
            if after < 0:
                raise HTTPException(status_code=422, detail="Le stock simulé ne peut pas être négatif.")
            result = {"stock_before": before, "stock_after": after, "below_alert": after <= int(data["alert"] if data["alert"] is not None else 5)}
            assumptions = {"quantity_delta": body.quantity_delta, "other_movements": 0}
        elif body.source.kind == "facture" and body.payment is not None and body.quantity_delta is None:
            before = round(float(data["total_ttc"] or 0) - float(data["paid"] or 0), 2)
            if before < 0 or body.payment > before:
                raise HTTPException(status_code=422, detail="Le paiement dépasse le solde de la facture.")
            result = {"remaining_before": before, "remaining_after": round(before - body.payment, 2)}
            assumptions = {"payment": body.payment, "other_payments": 0}
        else:
            raise HTTPException(status_code=422, detail="Simulation disponible pour un mouvement de stock ou un paiement uniquement.")
        return {"source": snapshot["source"], "fingerprint": snapshot["fingerprint"],
                "assumptions": assumptions, "result": result, "persisted": False, "executed": False}

    return router

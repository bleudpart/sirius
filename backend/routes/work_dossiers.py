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

GET /day?on=YYYY-MM-DD is a read-only live overview (no Outlook scan).
POST /proposals/{id}/review records rejection/deferral with rationale; deferred
proposals return on resume_on, and a changed source produces a new proposal ID.
POST /{id}/architect-decisions and /writing-revisions append private proposals.
GET /{id}/decision-journal exposes declared impacts and source changes, not
inferred cost or compliance. POST /{id}/accounting-review, /stock-coverage,
/inspection-preparation and /outlook-draft are read-only preparations.
POST /{id}/customer-followups saves a draft for a manually selected client.
POST/GET /{id}/client-events records voluntary client history and shows only
confirmed, due follow-ups on unchanged sources; never contacts a client.
GET /review-queue groups proposed memory and confirmed manual follow-ups.
Architect decisions accept human-declared plan/devis/milestone references and
versions, not verified document contents. A manual outcome is a user report,
not proof of external execution.
Coverage uses only explicitly user-verified sales observations. Inspection
never attributes untagged records to a requested site or certifies compliance.
Outlook reads one encoded /me/mailFolders/inbox/messages ID, never lists,
marks read or sends. Messages outside the inbox must be handled in Outlook.
"""

import hashlib
import json
import logging
import math
import uuid
from datetime import date, datetime, timezone
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
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
SourceKind = Literal["stock", "facture", "client", "haccp_trace", "haccp_nonconformity", "haccp_document"]
Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


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


class ProposalReviewIn(WorkInput):
    outcome: Literal["rejected", "deferred"]
    rationale: Text
    resume_on: date | None = None


class DocumentLinkIn(WorkInput):
    role: Literal["plan", "devis", "jalon"]
    reference: Text
    version: Text


class ArchitectDecisionIn(WorkInput):
    title: Text
    outcome: Literal["accepted", "rejected", "deferred"]
    rationale: Text
    alternatives: list[Text] = Field(min_length=1, max_length=10)
    constraints: list[Text] = Field(default_factory=list, max_length=20)
    declared_impacts: list[Text] = Field(default_factory=list, max_length=20)
    next_step: Text | None = None
    sources: list[SourceIn] = Field(default_factory=list, max_length=20)
    document_links: list[DocumentLinkIn] = Field(default_factory=list, max_length=20)


class ManualOutcomeIn(WorkInput):
    rationale: Text


class ClientEventIn(WorkInput):
    source: SourceIn
    kind: Literal["sale", "exchange", "quote_pending", "callback_promised", "question_pending"]
    note: Text
    occurred_on: date
    follow_up_on: date | None = None


class SelectedSourceIn(WorkInput):
    source: SourceIn


class SalesObservationIn(WorkInput):
    sold_units: int = Field(ge=0, le=1000000000)
    period_start: date
    period_end: date
    evidence: Text
    verified_at: datetime
    verified: StrictBool


class CoverageIn(SelectedSourceIn):
    sales: SalesObservationIn | None = None
    horizon_days: int = Field(default=7, ge=1, le=366)


class CustomerFollowupIn(SelectedSourceIn):
    objective: Text
    suggested_prose: Text


class WritingRevisionIn(WorkInput):
    title: Text
    sources: list[SourceIn] = Field(default_factory=list, max_length=20)
    suggested_prose: Text
    missing_facts: list[Text] = Field(default_factory=list, max_length=20)
    revision_of: Identifier | None = None


class InspectionIn(WorkInput):
    period_start: date
    period_end: date
    site_id: Identifier


class OutlookDraftIn(WorkInput):
    message_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)]
    suggested_prose: Text


SOURCE_FIELDS = {
    "stock": ("name", "ref", "stock", "alert", "price"),
    "facture": ("number", "client_id", "client_name", "due_date", "total_ttc", "paid", "status"),
    "haccp_trace": ("produit", "lot", "fournisseur", "dlc", "quantite"),
    "haccp_nonconformity": ("type", "description", "gravite", "statut", "action_corrective"),
    "haccp_document": ("nom", "date_expiration"),
    "client": ("name", "email", "phone", "company"),
}

logger = logging.getLogger(__name__)


def _explanation(source, rule, observed=None, threshold=None, missing_info=()):
    return {
        "source": source, "rule": rule, "observed": observed, "threshold": threshold,
        "verified_at": _now(), "missing_info": list(missing_info),
    }


def _number(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _date(value):
    try:
        return date.fromisoformat(str(value)[:10]) if value else None
    except ValueError:
        return None


def _invoice_review(snapshot):
    data = snapshot["data"]
    missing = [key for key in ("number", "due_date", "total_ttc", "paid", "recipient") if data.get(key) in (None, "")]
    total, paid = _number(data.get("total_ttc")), _number(data.get("paid"))
    if total is None or total < 0:
        missing.append("valid_total_ttc")
    if paid is None or paid < 0:
        missing.append("valid_paid")
    due = _date(data.get("due_date"))
    if due is None:
        missing.append("valid_due_date")
    # The invoice schema has amounts, but no verified receipt/attachment ledger.
    missing.append("payment_evidence_not_available_in_source")
    remaining = round(total - paid, 2) if total is not None and paid is not None and total >= 0 and paid >= 0 else None
    if remaining is not None and remaining < 0:
        missing.append("payment_exceeds_total")
    return {
        "source": snapshot["source"], "sourced_facts": data,
        "remaining": remaining, "due_date": due.isoformat() if due else None,
        "overdue": due < date.today() if due else None,
        "missing_info": missing,
        "questions": [
            "Quelle pièce justifie la facture et où est-elle conservée ?",
            "Un règlement a-t-il été reçu depuis le dernier montant enregistré ? Quelle preuve le confirme ?",
            "L'échéance, le solde et le destinataire ont-ils été vérifiés avant toute relance ?",
        ],
        "why_suggested": _explanation(snapshot["source"], "Vérifier l'échéance et les preuves, sans inférer un paiement.", missing_info=missing),
        "persisted": False, "executed": False,
    }

def _now():
    return datetime.now(timezone.utc).isoformat()


def _fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _source_ref(source):
    kind = source.kind
    return {"kind": kind, "id": source.id, "module": "themis" if kind in ("stock", "facture", "client") else "haccp"}


def _public(doc):
    return {key: value for key, value in doc.items() if key not in ("_id", "user_id")}


def _proposal(kind, doc, state, title, reason, label, module="themis", action_label=None,
              rule=None, observed=None, threshold=None, missing_info=()):
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
        "why_suggested": _explanation(
            {"module": module, "kind": kind, "id": source_id},
            rule or reason, observed, threshold, missing_info,
        ),
    }


async def _proposals(db, uid, haccp_scope):
    items = await db.themis_items.find({"user_id": uid}, {"_id": 0}).to_list(500)
    docs = await db.themis_docs.find({"user_id": uid, "kind": "facture"}, {"_id": 0}).to_list(500)
    today = date.today()
    result = []
    for item in items:
        stock, threshold = _number(item.get("stock")), _number(item.get("alert"))
        if stock is None or threshold is None or stock < 0 or threshold < 0:
            continue
        stock = int(stock) if stock.is_integer() else stock
        threshold = int(threshold) if threshold.is_integer() else threshold
        if stock <= threshold:
            label = item.get("name") or item.get("ref") or "Article"
            result.append(_proposal(
                "stock", item, f"{stock}:{threshold}", f"Stock bas : {label}",
                f"{stock} unité(s) en stock, seuil configuré à {threshold}. Vérifier avant de préparer un réapprovisionnement.",
                label, rule="stock <= alert", observed=stock, threshold=threshold,
                missing_info=["verified_sales_velocity", "supplier_purchase_price"],
            ))
    for doc in docs:
        if doc.get("status") in ("payé", "refusé") or not doc.get("due_date"):
            continue
        try:
            due = date.fromisoformat(str(doc["due_date"])[:10])
        except ValueError:
            continue
        total, paid = _number(doc.get("total_ttc")), _number(doc.get("paid"))
        if total is None or paid is None or total < 0 or paid < 0:
            continue
        remaining = round(total - paid, 2)
        if due < today and remaining > 0:
            number = doc.get("number") or "Facture"
            result.append(_proposal(
                "facture", doc, f"{due}:{remaining}:{doc.get('status')}",
                f"Courrier à préparer : facture {number} échue",
                f"Échéance {due.isoformat()}, montant restant {remaining:.2f} €. Vérifier le paiement, le destinataire et le contenu dans THÉMIS ; aucun e-mail ne sera envoyé sans votre validation.",
                number,
                action_label="Préparer la relance dans THÉMIS",
                rule="due_date < today and total_ttc - paid > 0",
                observed={"due_date": due.isoformat(), "remaining": remaining},
                threshold={"today": today.isoformat(), "remaining": 0},
                missing_info=["payment_evidence", "recipient_verification"],
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
                label, module="haccp", rule="dlc <= today + 2 days",
                observed=due, threshold={"today": today.isoformat(), "days": 2},
                missing_info=[key for key in ("lot", "fournisseur") if not trace.get(key)],
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
                rule="statut == ouverte (registre : valeur par défaut ouverte)",
                observed=nonconformity.get("statut"),
                missing_info=[key for key in ("statut", "action_corrective") if not nonconformity.get(key)],
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
                label, module="haccp", rule="date_expiration <= today + 30 days",
                observed=due, threshold={"today": today.isoformat(), "days": 30},
                missing_info=["document_content_not_verified"],
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
            "client": db.themis_clients,
            "haccp_trace": db.haccp_trace, "haccp_nonconformity": db.haccp_nc,
            "haccp_document": db.haccp_docs,
        }.get(kind)
        scope = {"user_id": uid} if kind in ("stock", "facture", "client") else haccp_scope
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
        ref = {"kind": kind, "id": source["id"], "module": "themis" if kind in ("stock", "facture", "client") else "haccp"}
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

    async def unmuted_proposals(uid, scope):
        candidates = await _proposals(db, uid, scope)
        # Read only mutes for these live candidates; do not silently miss old mutes.
        decisions = await db.sirius_work_proposal_mutes.find(
            {"user_id": uid, "proposal_id": {"$in": [item["id"] for item in candidates]}},
            {"_id": 0},
        ).to_list(len(candidates))
        muted = {
            row["proposal_id"] for row in decisions
            if row.get("outcome") != "deferred" or not row.get("resume_on")
            or row["resume_on"] > date.today().isoformat()
        }
        return [candidate for candidate in candidates if candidate["id"] not in muted]

    @router.get("/review-queue")
    async def review_queue(request: Request):
        uid, scope, _ = await context(request)
        entries = await db.sirius_work_entries.find(
            {"user_id": uid, "status": {"$in": ["proposed", "confirmed"]}}, {"_id": 0},
        ).sort("created_at", -1).to_list(501)
        items = []
        for entry in entries[:500]:
            stage = "to_confirm" if entry["status"] == "proposed" else (
                "manual_followup" if entry["kind"] in ("draft", "handoff")
                and not entry.get("manual_outcome") else None
            )
            if stage is None or not await visible_entry(entry, uid, scope):
                continue
            changed = False
            for previous in entry["source_snapshots"]:
                current = await capture(previous["source"], uid, scope)
                if current and current["fingerprint"] != previous["fingerprint"]:
                    changed = True
            items.append({
                "dossier_id": entry["dossier_id"], "entry": _public(entry),
                "stage": stage, "source_changed": changed,
            })
        return {"items": items, "truncated": len(entries) > 500, "read_only": True}

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
        candidates = await unmuted_proposals(uid, haccp_scope)
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
                "detail": "Aucune analyse automatique. Un message choisi explicitement peut préparer un brouillon via /outlook-draft après autorisation Microsoft.",
            },
        ]
        return {
            "proposals": candidates,
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

    @router.post("/proposals/{proposal_id}/review")
    async def review_proposal(proposal_id: str, body: ProposalReviewIn, request: Request):
        uid, scope, _ = await context(request)
        proposal = next((p for p in await _proposals(db, uid, scope) if p["id"] == proposal_id), None)
        if proposal is None:
            raise HTTPException(status_code=404, detail="Proposition introuvable.")
        if body.outcome == "rejected" and body.resume_on is not None:
            raise HTTPException(status_code=422, detail="Une reprise concerne uniquement un report.")
        if body.resume_on is not None and body.resume_on <= date.today():
            raise HTTPException(status_code=422, detail="La reprise doit être une date future.")
        decision = {
            "proposal_id": proposal_id, **body.model_dump(mode="json"),
            "source": proposal["source"], "why_suggested": proposal["why_suggested"],
            "reviewed_at": _now(),
        }
        await db.sirius_work_proposal_mutes.update_one(
            {"user_id": uid, "proposal_id": proposal_id},
            {"$set": {**decision, "user_id": uid}}, upsert=True,
        )
        return {"review": decision, "executed": False}

    @router.get("/day")
    async def day_view(request: Request, on: date | None = None):
        uid, scope, reason = await context(request)
        selected = on or date.today()
        dossiers = await db.sirius_work_dossiers.find({"user_id": uid}, {"_id": 0}).to_list(201)
        dossier_ids = {d["id"] for d in dossiers[:200]}
        entries = await db.sirius_work_entries.find(
            {"user_id": uid, "status": "confirmed", "kind": {"$in": ["commitment", "meeting"]},
             "dossier_id": {"$in": list(dossier_ids)}}, {"_id": 0},
        ).sort("created_at", -1).to_list(501)
        commitments = []
        for entry in entries[:500]:
            if not await visible_entry(entry, uid, scope):
                continue
            tasks = entry["content"]["tasks"] if entry["kind"] == "meeting" else [entry["content"]]
            for task in tasks:
                due = _date(task.get("due_date"))
                if due is not None and due > selected:
                    continue
                commitments.append({
                    "dossier_id": entry["dossier_id"], "entry_id": entry["id"],
                    "task_id": task.get("id"), "text": task["text"], "owner": task["owner"],
                    "due_date": task.get("due_date"), "status": "confirmed",
                    "why_suggested": _explanation(
                        {"kind": "commitment", "id": entry["id"], "module": "work-dossiers"},
                        "Engagement confirmé, échéance absente ou <= journée choisie.",
                        task.get("due_date"), selected.isoformat(),
                        ["due_date"] if due is None else [],
                    ),
                })
        return {
            "on": selected.isoformat(), "verified_at": _now(),
            "proposals": await unmuted_proposals(uid, scope), "commitments": commitments,
            "proposal_date_basis": "live_today", "read_only": True, "executed": False,
            "truncated": len(entries) > 500 or len(dossiers) > 200,
            "limits": {"dossiers": 200, "entries": 500, "stock": 500, "invoices": 500, "haccp_per_register": 300},
            "missing_info": ["La vue ne garantit pas l'exhaustivité des registres au-delà des limites.", reason] if reason else [
                "La vue ne garantit pas l'exhaustivité des registres au-delà des limites.",
            ],
        }

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

    @router.post("/{dossier_id}/architect-decisions", status_code=201)
    async def architect_decision(dossier_id: str, body: ArchitectDecisionIn, request: Request):
        uid, scope, _ = await context(request)
        actor = await require_user(request, db)
        if actor["user_id"] != uid:
            raise HTTPException(status_code=401, detail="Le compte connecté a changé.")
        name = actor.get("name")
        content = {
            **body.model_dump(mode="json", exclude={"sources"}),
            "impact_basis": "human_declared_not_inferred",
            "document_links_basis": "human_declared_not_verified",
            "decided_by": {
                "name": name.strip()[:120] if isinstance(name, str) and name.strip() else "Compte connecté",
                "identity": "authenticated_user",
            },
            "missing_info": ["Vérifier les contraintes, coûts, délais et pièces du projet avec le décideur."],
        }
        return {"entry": await save_entry(
            dossier_id, uid, scope, "architect_decision", content,
            [_source_ref(source) for source in body.sources],
        )}

    @router.get("/{dossier_id}/decision-journal")
    async def decision_journal(dossier_id: str, request: Request):
        payload = await thread(dossier_id, request)
        decisions = [entry for entry in payload["entries"] if entry["kind"] in ("decision", "architect_decision")]
        impacts = []
        for entry in decisions:
            changed = [
                {"source": current["source"], "fields": {
                    key: {"before": previous["data"].get(key), "after": value}
                    for key, value in current["data"].items()
                    if previous["data"].get(key) != value
                }}
                for previous in entry["source_snapshots"] for current in payload["sources"]
                if current["source"] == previous["source"] and current["fingerprint"] != previous["fingerprint"]
            ]
            impacts.append({
                "entry_id": entry["id"], "source_changes": changed,
                "declared_impacts": entry["content"].get("declared_impacts", []),
                "review_required": bool(changed), "inferred_impacts": [],
            })
        return {
            "decisions": decisions, "change_impact": impacts, "verified_at": _now(),
            "truncated": payload["truncated"], "read_only": True,
        }

    @router.post("/{dossier_id}/accounting-review")
    async def accounting_review(dossier_id: str, body: SelectedSourceIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        if body.source.kind != "facture":
            raise HTTPException(status_code=422, detail="Sélectionner une facture.")
        return _invoice_review(await required_capture(_source_ref(body.source), uid, scope))

    @router.post("/{dossier_id}/stock-coverage")
    async def stock_coverage(dossier_id: str, body: CoverageIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        if body.source.kind != "stock":
            raise HTTPException(status_code=422, detail="Sélectionner un article.")
        snapshot = await required_capture(_source_ref(body.source), uid, scope)
        stock = _number(snapshot["data"]["stock"])
        missing = [] if stock is not None and stock >= 0 else ["valid_stock"]
        velocity = coverage = None
        observation = None
        if body.sales is None:
            missing.append("verified_sales_observation")
        else:
            sales = body.sales
            verified_at = sales.verified_at
            if (
                sales.verified is not True or verified_at.tzinfo is None
                or verified_at > datetime.now(timezone.utc)
                or sales.period_end < sales.period_start
                or sales.period_end > verified_at.date()
                or (sales.period_end - sales.period_start).days >= 366
            ):
                raise HTTPException(status_code=422, detail="Fournir une observation vérifiée, datée avec fuseau, passée et sur 366 jours maximum.")
            observation = sales.model_dump(mode="json")
            velocity = sales.sold_units / ((sales.period_end - sales.period_start).days + 1)
            if velocity == 0:
                missing.append("positive_sales_velocity_for_coverage")
            elif stock is not None and stock >= 0:
                coverage = stock / velocity
        return {
            "source": snapshot["source"], "sourced_facts": snapshot["data"],
            "sales_observation": observation, "velocity_basis": "explicit_user_verified_observation",
            "units_per_day": velocity, "coverage_days": coverage,
            "horizon_days": body.horizon_days,
            "below_horizon": coverage < body.horizon_days if coverage is not None else None,
            "assumptions": ["Vitesse constante sur l'horizon ; aucun autre mouvement ni délai fournisseur inclus."],
            "why_suggested": _explanation(
                snapshot["source"], "stock / (sold_units / inclusive_period_days) < horizon_days",
                coverage, body.horizon_days, missing,
            ),
            "missing_info": missing, "persisted": False, "executed": False,
        }

    @router.post("/{dossier_id}/customer-followups", status_code=201)
    async def customer_followup(dossier_id: str, body: CustomerFollowupIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        if body.source.kind != "client":
            raise HTTPException(status_code=422, detail="Choisir manuellement un client.")
        snapshot = await required_capture(_source_ref(body.source), uid, scope)
        content = {
            "type": "customer_followup", "selection": "manual", "objective": body.objective,
            "to": snapshot["data"]["email"], "sourced_facts": snapshot["data"],
            "suggested_prose": body.suggested_prose,
            "missing_facts": ["Vérifier le dernier échange et la pertinence de la relance ; aucun historique déduit."],
            "checks": ["Relire le destinataire et le texte avant transfert et envoi manuels."],
        }
        return {"entry": await save_entry(dossier_id, uid, scope, "draft", content, snapshots=[snapshot])}

    @router.post("/{dossier_id}/client-events", status_code=201)
    async def client_event(dossier_id: str, body: ClientEventIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        if body.source.kind != "client":
            raise HTTPException(status_code=422, detail="Choisir un client autorisé.")
        if body.occurred_on > date.today() or (
            body.follow_up_on and body.follow_up_on < body.occurred_on
        ):
            raise HTTPException(status_code=422, detail="Vérifier les dates de l'échange et du suivi.")
        snapshot = await required_capture(_source_ref(body.source), uid, scope)
        return {"entry": await save_entry(
            dossier_id, uid, scope, "client_event",
            {**body.model_dump(mode="json", exclude={"source"}),
             "basis": "voluntary_user_entry", "consent_verified": False},
            snapshots=[snapshot],
        )}

    @router.get("/{dossier_id}/client-events")
    async def client_events(dossier_id: str, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        entries = await db.sirius_work_entries.find(
            {"user_id": uid, "dossier_id": dossier_id, "kind": "client_event"}, {"_id": 0},
        ).sort("created_at", -1).to_list(501)
        events = []
        followups = []
        needs_review = []
        for entry in entries[:500]:
            if not await visible_entry(entry, uid, scope):
                continue
            events.append(_public(entry))
            due = _date(entry["content"].get("follow_up_on"))
            if entry["status"] != "confirmed" or due is None or due > date.today():
                continue
            previous = entry["source_snapshots"][0]
            current = await capture(previous["source"], uid, scope)
            if current["fingerprint"] != previous["fingerprint"]:
                needs_review.append({"entry_id": entry["id"], "source": current["source"],
                                     "reason": "La source client a changé ; vérifier avant toute relance."})
                continue
            followups.append({
                "entry_id": entry["id"], "source": current["source"],
                "kind": entry["content"]["kind"], "note": entry["content"]["note"],
                "follow_up_on": due.isoformat(),
                "why_suggested": _explanation(
                    current["source"], "Date de suivi saisie volontairement et échue.",
                    due.isoformat(), date.today().isoformat(),
                    ["consent_to_contact_not_verified", "last_interaction_not_verified"],
                ),
                "execution": "manual_only",
            })
        return {"events": events, "followups": followups, "needs_review": needs_review,
                "truncated": len(entries) > 500, "read_only": True}

    @router.post("/{dossier_id}/writing-revisions", status_code=201)
    async def writing_revision(dossier_id: str, body: WritingRevisionIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        previous = None
        if body.revision_of:
            previous = await db.sirius_work_entries.find_one({
                "id": body.revision_of, "user_id": uid, "dossier_id": dossier_id, "kind": "writing_revision",
            })
            if not previous or not await visible_entry(previous, uid, scope):
                raise HTTPException(status_code=404, detail="Révision introuvable ou non autorisée.")
        snapshots = [await required_capture(_source_ref(source), uid, scope) for source in body.sources]
        if previous:
            for source in previous["sources"]:
                if source not in [item["source"] for item in snapshots]:
                    snapshots.append(await required_capture(source, uid, scope))
        content = {
            "title": body.title, "revision_of": body.revision_of,
            "revision": previous["content"]["revision"] + 1 if previous else 1,
            "sourced_facts": [{"source": item["source"], "facts": item["data"]} for item in snapshots],
            "suggested_prose": body.suggested_prose, "prose_is_verified": False,
            "missing_facts": body.missing_facts,
            "checks": ["Le texte proposé n'est pas une preuve ; confronter chaque affirmation aux sources."],
        }
        if not snapshots:
            content["missing_facts"] = ["Aucune source sélectionnée.", *body.missing_facts]
        return {"entry": await save_entry(
            dossier_id, uid, scope, "writing_revision", content, snapshots=snapshots,
        )}

    @router.post("/{dossier_id}/inspection-preparation")
    async def inspection_preparation(dossier_id: str, body: InspectionIn, request: Request):
        uid, scope, reason = await context(request)
        await dossier_for(dossier_id, uid)
        if scope is None:
            raise HTTPException(status_code=403, detail=reason)
        if body.period_end < body.period_start or (body.period_end - body.period_start).days >= 366:
            raise HTTPException(status_code=422, detail="La période doit couvrir de 1 à 366 jours.")
        registers = {
            "trace": (db.haccp_trace, "date_reception", ("produit", "lot", "fournisseur", "dlc")),
            "documents": (db.haccp_docs, "date_emission", ("nom", "date_expiration")),
            "nonconformities": (db.haccp_nc, "created_at", ("type", "description", "statut", "action_corrective")),
            "temperatures": (db.haccp_temp, "created_at", ("equipement_id", "valeur", "conforme", "releve_par")),
            "cleaning": (db.haccp_clean_log, "created_at", ("tache_id", "fait_par")),
            "controls": (db.haccp_controls, "created_at", ("type", "objet", "resultat", "statut", "valide_le")),
        }
        evidence, missing, limits = {}, [], {}
        for name, (collection, date_field, fields) in registers.items():
            rows = await collection.find(
                scope, {"_id": 0, "id": 1, "site_id": 1, date_field: 1, "created_at": 1,
                        **{field: 1 for field in fields}},
            ).sort("created_at", -1).to_list(301)
            evidence[name] = []
            unassigned = undated = 0
            for row in rows[:300]:
                record_day = _date(row.get(date_field) or row.get("created_at"))
                if record_day is None:
                    if row.get("site_id") in (None, "", body.site_id):
                        undated += 1
                    continue
                if not body.period_start <= record_day <= body.period_end:
                    continue
                if not row.get("site_id"):
                    unassigned += 1
                    continue
                if row["site_id"] != body.site_id:
                    continue
                absent = [field for field in fields if row.get(field) in (None, "")]
                evidence[name].append({
                    "source": {"module": "haccp", "register": name, "id": row.get("id")},
                    "date": record_day.isoformat(), "site_id": body.site_id,
                    "facts": {field: row.get(field) for field in fields}, "missing_info": absent,
                })
            if not evidence[name]:
                missing.append({"register": name, "reason": "no_verified_site_period_evidence"})
            if unassigned or undated:
                missing.append({"register": name, "reason": "site_or_date_unverified",
                                "unassigned_site": unassigned, "undated": undated})
            limits[name] = {"limit": 300, "truncated": len(rows) > 300}
        return {
            **body.model_dump(mode="json"), "evidence": evidence, "missing_evidence": missing,
            "verified_at": _now(), "limits": limits,
            "compliance": "not_assessed", "persisted": False, "executed": False,
            "questions": ["Confirmer le rattachement au site et fournir les preuves absentes.",
                          "Vérifier les signatures, pièces et actions correctives avec le responsable HACCP."],
        }

    @router.post("/{dossier_id}/outlook-draft")
    async def outlook_draft(dossier_id: str, body: OutlookDraftIn, request: Request):
        uid, _, _ = await context(request)
        await dossier_for(dossier_id, uid)
        if body.message_id in (".", ".."):
            raise HTTPException(status_code=422, detail="Identifiant de message invalide.")
        # Reuse the connector's user-scoped OAuth read; never invoke its LLM or write helpers.
        from microsoft_graph import _graph_get

        try:
            message = await _graph_get(
                db, uid, f"/me/mailFolders/inbox/messages/{quote(body.message_id, safe='')}",
                {"$select": "id,subject,from,body,receivedDateTime,isDraft"},
                {"Prefer": 'outlook.body-content-type="text"'},
            )
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                raise HTTPException(status_code=404, detail="Message introuvable dans votre boîte Outlook.") from exc
            logger.warning("Lecture du message Outlook impossible (HTTP %s).", exc.response.status_code)
            raise HTTPException(status_code=502, detail="Lecture Microsoft Graph indisponible.") from exc
        except httpx.RequestError as exc:
            logger.warning("Lecture du message Outlook impossible (%s).", type(exc).__name__)
            raise HTTPException(status_code=502, detail="Microsoft Graph injoignable.") from exc
        if message.get("isDraft") is not False or not message.get("receivedDateTime"):
            raise HTTPException(status_code=422, detail="Choisir un message reçu, pas un brouillon.")
        sender = ((message.get("from") or {}).get("emailAddress") or {})
        mail_body = message.get("body") or {}
        text = mail_body.get("content") or ""
        missing = []
        if not sender.get("address"):
            missing.append("sender_address")
        if mail_body.get("contentType", "").lower() != "text":
            text = ""
            missing.append("plain_text_body")
        if not text:
            missing.append("message_body")
        source = {"module": "outlook", "kind": "selected_message", "id": body.message_id}
        return {
            "source": source, "sourced_facts": {
                "subject": (message.get("subject") or "")[:2000],
                "sender": {key: str(sender.get(key) or "")[:2000] for key in ("name", "address")},
                "received_at": message["receivedDateTime"], "body_text": text[:2000],
                "body_truncated": len(text) > 2000, "content_trust": "untrusted_message_data",
            },
            "draft": {"to": sender.get("address") or None,
                      "subject": f"Re: {(message.get('subject') or '')[:1996]}",
                      "suggested_prose": body.suggested_prose},
            "missing_info": missing,
            "why_suggested": _explanation(source, "Message unique sélectionné explicitement par l'utilisateur.", missing_info=missing),
            "confirmation_required": True, "execution": "manual_only",
            "persisted": False, "executed": False,
        }

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
            total, paid = _number(data["total_ttc"]), _number(data["paid"])
            if total is None or paid is None or total < 0 or paid < 0:
                raise HTTPException(status_code=422, detail="Vérifier le montant et le paiement enregistrés avant un brouillon.")
            remaining = round(total - paid, 2)
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
                "missing_info": _invoice_review(snapshot)["missing_info"],
            }
        elif body.source.kind == "stock":
            stock, alert = _number(data["stock"]), _number(data["alert"])
            if body.quantity is None and (
                stock is None or alert is None or stock < 0 or alert < 0
                or not stock.is_integer() or not alert.is_integer()
            ):
                raise HTTPException(status_code=422, detail="Vérifier le stock et le seuil, ou fournir une quantité explicite.")
            quantity = body.quantity if body.quantity is not None else max(1, int(alert) + 1 - int(stock))
            content = {
                "type": "stock_reorder", "item_id": body.source.id,
                "lines": [{"label": data["name"] or data["ref"] or body.source.id,
                           "qty": quantity, "unit_price": None}],
                "notes": "Réapprovisionnement à vérifier ; fournisseur et prix d'achat non connus.",
                "checks": ["Choisir le fournisseur et vérifier quantité et prix avant commande manuelle."],
            }
        elif body.source.kind == "client":
            raise HTTPException(status_code=422, detail="Utiliser customer-followups avec un client choisi et un texte explicite.")
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

    @router.post("/{dossier_id}/entries/{entry_id}/manual-outcome")
    async def report_manual_outcome(dossier_id: str, entry_id: str, body: ManualOutcomeIn, request: Request):
        uid, scope, _ = await context(request)
        await dossier_for(dossier_id, uid)
        query = {"id": entry_id, "dossier_id": dossier_id, "user_id": uid, "status": "confirmed"}
        entry = await db.sirius_work_entries.find_one(query)
        if not entry:
            existing = await db.sirius_work_entries.find_one(
                {"id": entry_id, "dossier_id": dossier_id, "user_id": uid}
            )
            if not existing:
                raise HTTPException(status_code=404, detail="Élément introuvable.")
            raise HTTPException(status_code=409, detail="Confirmer la proposition avant de déclarer une suite externe.")
        if not await visible_entry(entry, uid, scope):
            raise HTTPException(status_code=404, detail="Élément introuvable.")
        if entry["kind"] not in ("draft", "handoff") or entry.get("manual_outcome"):
            raise HTTPException(status_code=409, detail="Aucune suite manuelle en attente pour cet élément.")
        reported = await db.sirius_work_entries.find_one_and_update(
            {**query, "manual_outcome": {"$exists": False}},
            {"$set": {"manual_outcome": {
                "rationale": body.rationale, "reported_at": _now(),
                "basis": "user_reported_not_verified",
            }}},
            return_document=True,
        )
        if not reported:
            raise HTTPException(status_code=409, detail="L'état a changé ; recharger le fil.")
        return {"entry": _public(reported), "executed": False}

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
            if entry["kind"] in ("decision", "architect_decision") and not entry["content"].get("next_step"):
                suggestions.append({"kind": "missing_next_step", "entry_id": entry["id"]})
            elif entry["kind"] == "commitment" and entry["status"] == "confirmed":
                due = entry["content"].get("due_date")
                suggestions.append({
                    "kind": "overdue_commitment" if due and due < date.today().isoformat() else "follow_commitment",
                    "entry_id": entry["id"],
                })
            if entry["status"] == "confirmed":
                if entry["kind"] in ("draft", "handoff") and not entry.get("manual_outcome"):
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
        rules = {
            "record_decision": "Aucune entrée autorisée : préciser l'objectif.",
            "human_confirmation": "status == proposed : relecture humaine obligatoire.",
            "missing_next_step": "Décision sans prochaine étape renseignée.",
            "overdue_commitment": "Engagement confirmé avec due_date < today.",
            "follow_commitment": "Engagement confirmé non terminé.",
            "manual_execution": "Brouillon confirmé : transfert manuel uniquement.",
            "manual_handoff": "Transfert confirmé : remise manuelle uniquement.",
            "task_proposal": "Tâche explicitement saisie dans une réunion confirmée.",
            "review_changed_source": "Empreinte actuelle différente de la source mémorisée.",
            "review_source": "Source autorisée sans entrée visible liée.",
        }
        for suggestion in suggestions:
            entry = next((item for item in visible if item["id"] == suggestion.get("entry_id")), None)
            source = suggestion.get("source") or {
                "module": "work-dossiers", "kind": "entry" if entry else "dossier",
                "id": entry["id"] if entry else dossier_id,
            }
            missing = ["next_step"] if suggestion["kind"] in ("record_decision", "missing_next_step") else []
            suggestion["why_suggested"] = _explanation(source, rules[suggestion["kind"]], missing_info=missing)
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
            stock, alert = _number(data["stock"]), _number(data["alert"])
            if stock is None or alert is None or stock < 0 or alert < 0 or not stock.is_integer():
                raise HTTPException(status_code=422, detail="Le stock et le seuil doivent être renseignés et valides.")
            before = int(stock)
            after = before + body.quantity_delta
            if after < 0:
                raise HTTPException(status_code=422, detail="Le stock simulé ne peut pas être négatif.")
            result = {"stock_before": before, "stock_after": after, "below_alert": after <= alert}
            assumptions = {"quantity_delta": body.quantity_delta, "other_movements": 0}
        elif body.source.kind == "facture" and body.payment is not None and body.quantity_delta is None:
            total, paid = _number(data["total_ttc"]), _number(data["paid"])
            if total is None or paid is None or total < 0 or paid < 0:
                raise HTTPException(status_code=422, detail="Les montants de la facture doivent être renseignés et valides.")
            before = round(total - paid, 2)
            if before < 0 or body.payment > before:
                raise HTTPException(status_code=422, detail="Le paiement dépasse le solde de la facture.")
            result = {"remaining_before": before, "remaining_after": round(before - body.payment, 2)}
            assumptions = {"payment": body.payment, "other_payments": 0}
        else:
            raise HTTPException(status_code=422, detail="Simulation disponible pour un mouvement de stock ou un paiement uniquement.")
        return {"source": snapshot["source"], "fingerprint": snapshot["fingerprint"],
                "assumptions": assumptions, "result": result, "persisted": False, "executed": False}

    return router

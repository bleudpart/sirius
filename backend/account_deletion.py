"""Account deletion queue and bounded server-side erasure after human review."""

import logging
import sqlite3
from datetime import datetime, timezone

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError, PyMongoError
from pydantic import BaseModel, ConfigDict, StrictBool

import local_memory
import storage

CONTACT = "danielsirius.pro2026@gmail.com"
logger = logging.getLogger(__name__)
PERSONAL_COLLECTIONS = (
    "sirius_chats", "local_memory", "episodic_memory",
    "sirius_work_dossiers", "sirius_work_entries", "sirius_work_snapshots",
    "sirius_work_proposal_mutes", "agora_deals", "agora_settings",
    "agora_coach_history", "nummarius_alerts",
)
REVIEW_COLLECTIONS = (
    "themis_docs", "themis_clients", "themis_items", "themis_stock_movements",
    "themis_orders", "themis_payments", "themis_pieces",
    "payment_transactions", "user_licenses", "enterprise_members", "enterprise_audit",
    "photo3d_jobs",
    "haccp_trace", "haccp_equip", "haccp_temp", "haccp_nc", "haccp_pms",
    "haccp_clean", "haccp_clean_log", "haccp_allerg", "haccp_docs", "haccp_controls",
)
FILE_COLLECTIONS = ("files", "user_files")
ID_COLLECTIONS = ("google_calendar", "microsoft_oauth", "email_prefs", "email_seen")


class DeletionReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm_user_id: str
    external_review_complete: StrictBool = False
    activity_stopped: StrictBool = False


async def deletion_plan(db, user_id: str) -> dict:
    user = await db.users.find_one({"user_id": user_id})
    if not user:
        raise HTTPException(status_code=404, detail="Compte introuvable.")
    blockers = []
    if user.get("role") == "admin":
        blockers.append("Compte administrateur : procédure distincte.")
    if not user.get("disabled"):
        blockers.append("Désactiver le compte et attendre la fin de ses opérations en cours.")
    if user.get("company_id"):
        blockers.append("Rattachement entreprise à traiter séparément.")
    request = await db.account_deletion_requests.find_one({"user_id": user_id})
    if not request or request.get("status") not in ("pending_review", "failed"):
        blockers.append("Demande absente ou déjà en cours de traitement.")
    for name in REVIEW_COLLECTIONS:
        query = {"user_id": user_id}
        if name in ("payment_transactions", "user_licenses"):
            query = {"$or": [{"user_id": user_id}, {"user_id": user.get("email")}]}
        if await getattr(db, name).count_documents(query):
            blockers.append(f"{name} : éléments à traiter ou conserver séparément.")
    if await db.enterprise_companies.count_documents({"owner_user_id": user_id}):
        blockers.append("Propriété d’entreprise à transférer séparément.")
    counts = {}
    for name in PERSONAL_COLLECTIONS + FILE_COLLECTIONS:
        counts[name] = await getattr(db, name).count_documents({"user_id": user_id})
    paths = set()
    for name in FILE_COLLECTIONS:
        async for document in getattr(db, name).find({"user_id": user_id}):
            if document.get("company_id"):
                blockers.append(f"{name} : fichier partagé à traiter séparément.")
                continue
            path = document.get("storage_path")
            if not path:
                if document.get("size", 0):
                    blockers.append(f"{name} : fichier sans chemin vérifiable.")
                continue
            if not isinstance(path, str):
                blockers.append(f"{name} : chemin de fichier invalide.")
                continue
            try:
                resolved = storage._safe_local_path(path)
                if resolved == storage.UPLOADS_DIR.resolve() or resolved.is_dir():
                    raise ValueError("Le chemin ne désigne pas un fichier.")
            except (ValueError, OSError) as exc:
                blockers.append(f"{name} : chemin de fichier invalide ({exc}).")
                continue
            paths.add(path)
    resolved_paths = {storage._safe_local_path(path) for path in paths}
    for name in FILE_COLLECTIONS:
        async for document in getattr(db, name).find({"user_id": {"$ne": user_id}}):
            path = document.get("storage_path")
            if isinstance(path, str) and path:
                try:
                    if storage._safe_local_path(path) in resolved_paths:
                        blockers.append("Un fichier est aussi référencé par un autre compte.")
                except (ValueError, OSError):
                    blockers.append("Une référence de fichier non vérifiable exige un examen distinct.")
    return {
        "user_id": user_id,
        "blockers": sorted(set(blockers)),
        "collections": counts,
        "file_paths": sorted(paths),
        "external_review": (
            "Vérifier les stockages non couverts, opérations en cours, copies locales, "
            "sauvegardes, prestataires et abonnements. Les justificatifs conservés "
            "doivent avoir un fondement, un périmètre et une échéance documentés. "
            "Cet outil ne supprime pas les copies chez les prestataires ou sur les appareils."
        ),
    }


async def finalize_account_deletion(db, *, user_id: str, review: DeletionReview) -> dict:
    if review.confirm_user_id != user_id or not review.external_review_complete or not review.activity_stopped:
        raise HTTPException(status_code=400, detail="Identifiant et validations de l’examen manuel requis.")
    plan = await deletion_plan(db, user_id)
    if plan["blockers"]:
        raise HTTPException(status_code=409, detail={"message": "Effacement bloqué.", "blockers": plan["blockers"]})
    claimed = await db.account_deletion_requests.find_one_and_update(
        {"user_id": user_id, "status": {"$in": ["pending_review", "failed"]}},
        {"$set": {"status": "processing"}},
    )
    if not claimed:
        raise HTTPException(status_code=409, detail="Demande déjà en cours de traitement.")
    try:
        for path in plan["file_paths"]:
            storage._safe_local_path(path).unlink(missing_ok=True)
        if local_memory.DB_PATH.exists():
            local_memory.delete_user_data(user_id)
        for name in PERSONAL_COLLECTIONS + FILE_COLLECTIONS:
            await getattr(db, name).delete_many({"user_id": user_id})
        for name in ID_COLLECTIONS:
            await getattr(db, name).delete_many({"_id": user_id})
        await db.ms_tokens.delete_many({"id": user_id})
        await db.oauth_states.delete_many({"uid": user_id})
        user = await db.users.find_one({"user_id": user_id})
        if user and user.get("email"):
            await db.password_reset_codes.delete_many({"email": user["email"]})
            await db.login_attempts.delete_many({"identifier": f"login:{user['email']}"})
        # Delete the queue before the account so database failures leave a disabled account to inspect.
        await db.account_deletion_requests.delete_many({"user_id": user_id})
        result = await db.users.delete_one({"user_id": user_id, "disabled": True})
        if not result.deleted_count:
            raise HTTPException(status_code=409, detail="État du compte modifié : examiner l’effacement partiel.")
    except (OSError, ValueError, sqlite3.Error, PyMongoError, HTTPException) as exc:
        logger.exception("Account deletion failed; manual inspection required")
        await db.account_deletion_requests.update_one(
            {"user_id": user_id},
            {"$set": {
                "status": "failed",
                "requested_at": claimed["requested_at"],
                "requested_by": claimed["requested_by"],
            }},
            upsert=True,
        )
        raise HTTPException(
            status_code=500,
            detail="Effacement incomplet. Le compte doit rester désactivé ; vérifier les données restantes avant toute reprise.",
        ) from exc
    return {
        "account_deleted": True,
        "scope": "reviewed_server_data",
        "message": "Compte et données du périmètre serveur vérifié effacés. Les copies externes et exceptions relèvent de l’examen manuel.",
    }


async def request_account_deletion(db, *, user_id: str, requested_by: str) -> dict:
    user = await db.users.find_one({"user_id": user_id})
    if not user:
        raise HTTPException(status_code=404, detail="Compte introuvable.")
    if user.get("role") == "admin":
        raise HTTPException(
            status_code=403,
            detail="Le compte administrateur nécessite une procédure distincte.",
        )
    now = datetime.now(timezone.utc).isoformat()
    await db.account_deletion_requests.create_index("user_id", unique=True)
    existing = await db.account_deletion_requests.find_one({"user_id": user_id})
    if existing:
        if existing.get("status") != "pending_review":
            raise HTTPException(status_code=409, detail="Effacement en cours ou incomplet : examen administrateur requis.")
        return _pending_response()
    try:
        await db.account_deletion_requests.insert_one({
            "user_id": user_id,
            "requested_at": now,
            "requested_by": requested_by,
            "status": "pending_review",
        })
    except DuplicateKeyError as exc:
        existing = await db.account_deletion_requests.find_one({"user_id": user_id})
        if not existing or existing.get("status") != "pending_review":
            raise HTTPException(status_code=409, detail="Effacement en cours : examen administrateur requis.") from exc
    return _pending_response()


def _pending_response() -> dict:
    return {
        "status": "pending_review",
        "account_deleted": False,
        "message": (
            "Demande de suppression enregistrée pour examen manuel. "
            "Le compte et ses données ne sont pas encore supprimés. "
            "Les documents partagés, justificatifs, abonnements, fichiers "
            f"et copies doivent être examinés. Contact : {CONTACT}."
        ),
    }

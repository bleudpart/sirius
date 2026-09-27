# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Socle Entreprise : équipes, rôles, audit et sauvegardes contrôlées."""

import json
import os
import re
import secrets
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from auth_api import _normalize_email, require_user
from runtime_paths import data_dir


ROLES = {"admin", "manager", "operator", "viewer"}
MANAGE_ROLES = {"admin", "manager"}
PERMISSIONS = {"haccp", "documents", "audit", "sites", "members", "backups", "themis", "integrations"}
ROLE_PERMISSIONS = {
    "admin": PERMISSIONS,
    "manager": PERMISSIONS - {"members"},
    "operator": {"haccp", "documents", "audit"},
    "viewer": {"haccp", "documents", "audit"},
}
BACKUP_COLLECTIONS = (
    "enterprise_companies",
    "enterprise_members",
    "enterprise_sites",
    "enterprise_audit",
    "haccp_trace",
    "haccp_equip",
    "haccp_temp",
    "haccp_pms",
    "haccp_nc",
    "haccp_clean",
    "haccp_clean_log",
    "haccp_allerg",
    "haccp_docs",
    "haccp_controls",
    "user_files",
)
SAFE_ARCHIVE_NAME = re.compile(r"^[a-zA-Z0-9_.-]{1,120}$")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def _json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


class CompanyIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)


class MemberPatch(BaseModel):
    role: str
    permissions: list[str] | None = None


class MemberAdd(BaseModel):
    email: str
    role: str = "operator"
    permissions: list[str] | None = None


class SiteIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    address: str = Field(default="", max_length=240)


class SitePatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    address: str | None = Field(default=None, max_length=240)
    active: bool | None = None


async def _user_context(request: Request, db):
    user = await require_user(request, db)
    membership = await db.enterprise_members.find_one({"user_id": user["user_id"]}, {"_id": 0})
    if not membership:
        return user, None, None
    company = await db.enterprise_companies.find_one({"id": membership["company_id"]}, {"_id": 0})
    return user, company, membership


async def record_audit(db, *, company_id, user, action, resource, resource_id="", details=None):
    event = {
        "id": f"audit_{secrets.token_hex(12)}",
        "company_id": company_id,
        "user_id": user.get("user_id"),
        "user_email": user.get("email"),
        "action": action,
        "resource": resource,
        "resource_id": resource_id,
        "details": details or {},
        "created_at": now_iso(),
    }
    await db.enterprise_audit.insert_one(event)
    return event


def _require_membership(company, membership):
    if not company or not membership:
        raise HTTPException(status_code=409, detail="Aucune entreprise n'est encore configurée.")


def _require_manager(membership):
    if membership.get("role") not in MANAGE_ROLES:
        raise HTTPException(status_code=403, detail="Droits entreprise insuffisants.")


def effective_permissions(membership):
    return set(membership.get("permissions") or ROLE_PERMISSIONS.get(membership.get("role"), set()))


def require_permission(membership, permission):
    if permission not in effective_permissions(membership):
        raise HTTPException(status_code=403, detail=f"Permission entreprise requise : {permission}.")


async def _backup_company(db, company, user):
    backup_dir = data_dir() / "backups" / "enterprise"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"sirius-entreprise-{company['id']}-{stamp}.zip"
    destination = backup_dir / filename
    manifest = {
        "format": 1,
        "created_at": now_iso(),
        "company": company,
        "created_by": user.get("email"),
        "collections": list(BACKUP_COLLECTIONS),
    }
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, default=_json_default, indent=2))
        for collection_name in BACKUP_COLLECTIONS:
            query = {"company_id": company["id"]} if collection_name != "enterprise_companies" else {"id": company["id"]}
            documents = await getattr(db, collection_name).find(query, {"_id": 0}).to_list(100000)
            payload = json.dumps(documents, ensure_ascii=False, default=_json_default, indent=2)
            archive.writestr(f"mongo/{collection_name}.json", payload)
        local_db = data_dir() / "sirius_local.db"
        if local_db.exists():
            archive.write(local_db, "local/sirius_local.db")
        uploads = data_dir() / "uploads" / "documents" / company["id"]
        if uploads.exists():
            for path in uploads.rglob("*"):
                if path.is_file():
                    archive.write(path, str(Path("uploads") / "documents" / company["id"] / path.relative_to(uploads)))
    await record_audit(db, company_id=company["id"], user=user, action="backup.create", resource="backup", resource_id=filename)
    return destination


async def _restore_company_archive(db, company_id, raw):
    """Validate and restore one company archive without mutating on bad input."""
    try:
        archive = zipfile.ZipFile(__import__("io").BytesIO(raw))
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("company", {}).get("id") != company_id:
            raise ValueError("entreprise différente")
        collection_payloads = []
        upload_payloads = []
        for name in archive.namelist():
            if name.startswith("mongo/") and name.endswith(".json"):
                collection_name = Path(name).stem
                if collection_name not in BACKUP_COLLECTIONS or collection_name == "enterprise_audit":
                    continue
                collection_payloads.append((collection_name, json.loads(archive.read(name))))
                continue
            if name.startswith("uploads/"):
                relative = PurePosixPath(name).relative_to("uploads")
                if relative.parts[:2] != ("documents", company_id) or ".." in relative.parts:
                    raise ValueError("chemin de fichier invalide")
                upload_payloads.append((relative, archive.read(name)))
    except (KeyError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        raise HTTPException(status_code=400, detail="Archive de sauvegarde invalide.") from error

    for collection_name, documents in collection_payloads:
        collection = getattr(db, collection_name)
        query = {"id": company_id} if collection_name == "enterprise_companies" else {"company_id": company_id}
        await collection.delete_many(query)
        if documents:
            await collection.insert_many(documents)

    company_uploads = (data_dir() / "uploads" / "documents" / company_id).resolve()
    if company_uploads.exists():
        shutil.rmtree(company_uploads)
    for relative, payload in upload_payloads:
        destination = (data_dir() / "uploads" / Path(*relative.parts)).resolve()
        uploads_root = (data_dir() / "uploads").resolve()
        if uploads_root not in destination.parents:
            raise HTTPException(status_code=400, detail="Archive de sauvegarde invalide.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
    return {"collections": len(collection_payloads), "files": len(upload_payloads)}


def make_enterprise_router(db):
    router = APIRouter(prefix="/enterprise", tags=["enterprise"])

    @router.get("/context")
    async def context(request: Request):
        user, company, membership = await _user_context(request, db)
        return {
            "user": user,
            "company": company,
            "membership": membership,
            "roles": sorted(ROLES),
        }

    @router.post("")
    async def create_company(body: CompanyIn, request: Request):
        user, company, membership = await _user_context(request, db)
        if company or membership:
            raise HTTPException(status_code=409, detail="Cet utilisateur appartient déjà à une entreprise.")
        company = {
            "id": f"company_{secrets.token_hex(12)}",
            "name": body.name.strip(),
            "owner_user_id": user["user_id"],
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        membership = {
            "id": f"member_{secrets.token_hex(12)}",
            "company_id": company["id"],
            "user_id": user["user_id"],
            "email": user["email"],
            "name": user.get("name", ""),
            "role": "admin",
            "joined_at": now_iso(),
        }
        await db.enterprise_companies.insert_one(company)
        await db.enterprise_members.insert_one(membership)
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"company_id": company["id"]}})
        await record_audit(db, company_id=company["id"], user=user, action="company.create", resource="company", resource_id=company["id"])
        return {"company": company, "membership": membership}

    @router.get("/members")
    async def list_members(request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        members = await db.enterprise_members.find({"company_id": company["id"]}, {"_id": 0}).sort("joined_at", 1).to_list(500)
        return {"company": company, "members": members}

    @router.patch("/members/{user_id}")
    async def update_member(user_id: str, body: MemberPatch, request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        _require_manager(membership)
        if body.role not in ROLES:
            raise HTTPException(status_code=400, detail="Rôle invalide.")
        target = await db.enterprise_members.find_one({"company_id": company["id"], "user_id": user_id}, {"_id": 0})
        if not target:
            raise HTTPException(status_code=404, detail="Membre introuvable.")
        if membership.get("role") != "admin" and (body.role == "admin" or target.get("role") == "admin"):
            raise HTTPException(status_code=403, detail="Seul un administrateur peut gérer un rôle administrateur.")
        permissions = set(body.permissions or ROLE_PERMISSIONS[body.role])
        if not permissions.issubset(PERMISSIONS):
            raise HTTPException(status_code=400, detail="Permission invalide.")
        if user_id == company.get("owner_user_id") and body.role != "admin":
            raise HTTPException(status_code=400, detail="Le propriétaire doit conserver le rôle administrateur.")
        await db.enterprise_members.update_one({"company_id": company["id"], "user_id": user_id}, {"$set": {"role": body.role, "permissions": sorted(permissions)}})
        await db.users.update_one({"user_id": user_id}, {"$set": {"role": body.role}})
        await record_audit(db, company_id=company["id"], user=user, action="member.role_change", resource="member", resource_id=user_id, details={"role": body.role})
        return {"ok": True, "user_id": user_id, "role": body.role, "permissions": sorted(permissions)}

    @router.post("/members")
    async def add_member(body: MemberAdd, request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        _require_manager(membership)
        if body.role not in ROLES or body.role == "admin":
            raise HTTPException(status_code=400, detail="Rôle d'ajout invalide.")
        permissions = set(body.permissions or ROLE_PERMISSIONS[body.role])
        if not permissions.issubset(PERMISSIONS):
            raise HTTPException(status_code=400, detail="Permission invalide.")
        email = _normalize_email(body.email)
        target_user = await db.users.find_one({"email": email})
        if not target_user:
            raise HTTPException(status_code=404, detail="Compte introuvable. Le membre doit d'abord créer son compte.")
        existing = await db.enterprise_members.find_one({"company_id": company["id"], "user_id": target_user["user_id"]})
        if existing:
            raise HTTPException(status_code=409, detail="Ce compte est déjà membre de l'entreprise.")
        member = {
            "id": f"member_{secrets.token_hex(12)}",
            "company_id": company["id"],
            "user_id": target_user["user_id"],
            "email": email,
            "name": target_user.get("name", ""),
            "role": body.role,
            "permissions": sorted(permissions),
            "joined_at": now_iso(),
        }
        await db.enterprise_members.insert_one(member)
        await db.users.update_one({"user_id": target_user["user_id"]}, {"$set": {"company_id": company["id"], "role": body.role}})
        await record_audit(db, company_id=company["id"], user=user, action="member.add", resource="member", resource_id=target_user["user_id"], details={"email": email, "role": body.role})
        return {"ok": True, "member": {key: value for key, value in member.items() if key != "id"}}

    @router.delete("/members/{user_id}")
    async def remove_member(user_id: str, request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        _require_manager(membership)
        if user_id == company.get("owner_user_id"):
            raise HTTPException(status_code=400, detail="Le propriétaire ne peut pas être retiré.")
        result = await db.enterprise_members.delete_one({"company_id": company["id"], "user_id": user_id})
        if not result.deleted_count:
            raise HTTPException(status_code=404, detail="Membre introuvable.")
        await db.users.update_one({"user_id": user_id}, {"$unset": {"company_id": ""}})
        await record_audit(db, company_id=company["id"], user=user, action="member.remove", resource="member", resource_id=user_id)
        return {"ok": True}

    @router.get("/sites")
    async def list_sites(request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        sites = await db.enterprise_sites.find({"company_id": company["id"]}, {"_id": 0}).sort("name", 1).to_list(200)
        return {"items": sites, "total": len(sites)}

    @router.post("/sites")
    async def create_site(body: SiteIn, request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        _require_manager(membership)
        site = {"id": f"site_{secrets.token_hex(12)}", "company_id": company["id"], "name": body.name.strip(), "address": body.address.strip(), "active": True, "created_at": now_iso(), "updated_at": now_iso()}
        await db.enterprise_sites.insert_one(site)
        await record_audit(db, company_id=company["id"], user=user, action="site.create", resource="site", resource_id=site["id"], details={"name": site["name"]})
        return {"site": site}

    @router.patch("/sites/{site_id}")
    async def update_site(site_id: str, body: SitePatch, request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        _require_manager(membership)
        changes = {key: value.strip() if isinstance(value, str) else value for key, value in body.model_dump(exclude_none=True).items()}
        if not changes:
            raise HTTPException(status_code=400, detail="Aucune modification fournie.")
        changes["updated_at"] = now_iso()
        result = await db.enterprise_sites.update_one({"id": site_id, "company_id": company["id"]}, {"$set": changes})
        if not result.modified_count:
            raise HTTPException(status_code=404, detail="Établissement introuvable.")
        await record_audit(db, company_id=company["id"], user=user, action="site.update", resource="site", resource_id=site_id, details=changes)
        return {"ok": True, "id": site_id}

    @router.get("/stats")
    async def enterprise_stats(request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        scope = {"company_id": company["id"]}
        values = {
            "members": await db.enterprise_members.count_documents(scope),
            "sites": await db.enterprise_sites.count_documents({**scope, "active": True}),
            "documents": await db.user_files.count_documents({**scope, "is_deleted": {"$ne": True}}),
            "audit_events": await db.enterprise_audit.count_documents(scope),
            "open_non_conformities": await db.haccp_nc.count_documents({**scope, "statut": {"$in": ["open", "ouverte", "ouvert"]}}),
        }
        return {"company_id": company["id"], "values": values, "generated_at": now_iso()}

    @router.get("/license")
    async def enterprise_license(request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        return {"plan": "Entreprise", "status": "active", "billing": "À configurer", "support": "danielpartel@hotmail.com", "features": ["multi-sites", "rôles", "audit", "sauvegardes"]}

    @router.get("/integrations")
    async def integration_status(request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        user_id = user.get("user_id")
        microsoft = await db.microsoft_oauth.find_one({"_id": user_id}) if hasattr(db, "microsoft_oauth") else None
        google = await db.google_calendar.find_one({"_id": user_id}) if hasattr(db, "google_calendar") else None
        items = [
            {"id": "outlook", "label": "Outlook / Microsoft 365", "configured": bool(os.getenv("MICROSOFT_CLIENT_ID") and os.getenv("MICROSOFT_REDIRECT_URI")), "connected": bool(microsoft), "action": "Ouvrir Outlook"},
            {"id": "google", "label": "Google Calendar / Gmail", "configured": bool(os.getenv("GOOGLE_CLIENT_ID") and os.getenv("GOOGLE_REDIRECT_URI")), "connected": bool(google), "action": "Ouvrir Google"},
            {"id": "home-assistant", "label": "Home Assistant", "configured": bool(os.getenv("HA_URL") and os.getenv("HA_TOKEN")), "connected": False, "action": "Configurer KERAUNOS"},
            {"id": "documents", "label": "Stockage documentaire local", "configured": True, "connected": True, "action": "Ouvrir les documents"},
            {"id": "exports", "label": "Exports PDF / CSV / DXF", "configured": True, "connected": True, "action": "Exporter depuis les modules"},
            {"id": "accounting-crm", "label": "THÉMIS / contacts CRM", "configured": True, "connected": True, "action": "Ouvrir THÉMIS"},
        ]
        return {"items": items, "checked_at": now_iso()}

    @router.get("/audit")
    async def list_audit(request: Request, limit: int = Query(100, ge=1, le=500)):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        events = await db.enterprise_audit.find({"company_id": company["id"]}, {"_id": 0}).sort("created_at", -1).to_list(limit)
        return {"items": events, "total": len(events)}

    @router.post("/backups")
    async def create_backup(request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        _require_manager(membership)
        path = await _backup_company(db, company, user)
        return FileResponse(str(path), media_type="application/zip", filename=path.name)

    @router.get("/backups")
    async def list_backups(request: Request):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        _require_manager(membership)
        directory = data_dir() / "backups" / "enterprise"
        items = []
        for path in sorted(directory.glob(f"sirius-entreprise-{company['id']}-*.zip"), reverse=True):
            items.append({"name": path.name, "size": path.stat().st_size, "created_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()})
        return {"items": items}

    @router.post("/backups/restore")
    async def restore_backup(request: Request, file: UploadFile = File(...), confirm: bool = Query(False)):
        user, company, membership = await _user_context(request, db)
        _require_membership(company, membership)
        if membership.get("role") != "admin":
            raise HTTPException(status_code=403, detail="Seul un administrateur peut restaurer une sauvegarde.")
        if not confirm:
            raise HTTPException(status_code=400, detail="Confirmez explicitement la restauration.")
        raw = await file.read()
        if len(raw) > 250 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Sauvegarde trop volumineuse.")
        await _restore_company_archive(db, company["id"], raw)
        await record_audit(db, company_id=company["id"], user=user, action="backup.restore", resource="backup", details={"filename": file.filename or ""})
        return {"ok": True, "message": "Sauvegarde restaurée, métadonnées et fichiers de l'entreprise inclus."}

    return router
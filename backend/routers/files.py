import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from auth_api import require_user
from enterprise import record_audit, require_permission
from storage import UPLOADS_DIR, _safe_local_path, put_object

router = APIRouter()
_db = None
MAX_FILE_SIZE = 20 * 1024 * 1024
SAFE_EXT = re.compile(r"^[a-z0-9]{1,8}$")
ALLOWED_TYPES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "text/plain",
    "text/csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def setup(db):
    global _db
    _db = db
    return


def _database():
    if _db is None:
        raise HTTPException(status_code=503, detail="Stockage documentaire indisponible.")
    return _db


def _extension(filename: str) -> str:
    suffix = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
    return suffix if SAFE_EXT.fullmatch(suffix) else "bin"


@router.post("/api/files/upload")
async def upload_file(request: Request, file: UploadFile = File(...), category: str = "general"):
    db = _database()
    user = await require_user(request, db)
    if user.get("company_id"):
        membership = await db.enterprise_members.find_one({"company_id": user["company_id"], "user_id": user["user_id"]}, {"_id": 0})
        require_permission(membership or {}, "documents")
    content = await file.read(MAX_FILE_SIZE + 1)
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="Fichier limité à 20 Mo.")
    content_type = (file.content_type or "application/octet-stream").lower()
    if content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Type de fichier non autorisé.")
    file_id = str(uuid.uuid4())
    storage_path = f"documents/{user.get('company_id') or user['user_id']}/{file_id}.{_extension(file.filename or '')}"
    put_object(storage_path, content, content_type)
    document = {
        "id": file_id,
        "user_id": user["user_id"],
        "company_id": user.get("company_id"),
        "name": (file.filename or "document").strip()[:180] or "document",
        "category": category.strip()[:80] or "general",
        "content_type": content_type,
        "size": len(content),
        "storage_path": storage_path,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "is_deleted": False,
    }
    await db.user_files.insert_one(document)
    if user.get("company_id"):
        await record_audit(db, company_id=user["company_id"], user=user, action="file.upload", resource="file", resource_id=file_id, details={"name": document["name"]})
    return {key: value for key, value in document.items() if key != "storage_path"}


@router.get("/api/files")
async def list_files(request: Request):
    db = _database()
    user = await require_user(request, db)
    if user.get("company_id"):
        membership = await db.enterprise_members.find_one({"company_id": user["company_id"], "user_id": user["user_id"]}, {"_id": 0})
        require_permission(membership or {}, "documents")
    query = {"is_deleted": {"$ne": True}}
    if user.get("company_id"):
        query["company_id"] = user["company_id"]
    else:
        query["user_id"] = user["user_id"]
    documents = await db.user_files.find(query, {"_id": 0, "storage_path": 0}).sort("created_at", -1).to_list(500)
    return {"items": documents, "total": len(documents)}


@router.get("/api/files/{file_id}")
async def get_file(file_id: str, request: Request):
    db = _database()
    user = await require_user(request, db)
    if user.get("company_id"):
        membership = await db.enterprise_members.find_one({"company_id": user["company_id"], "user_id": user["user_id"]}, {"_id": 0})
        require_permission(membership or {}, "documents")
    query = {"id": file_id, "is_deleted": {"$ne": True}}
    query["company_id" if user.get("company_id") else "user_id"] = user.get("company_id") or user["user_id"]
    document = await db.user_files.find_one(query, {"_id": 0, "storage_path": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document introuvable.")
    return document


@router.get("/api/files/{file_id}/content")
async def download_file(file_id: str, request: Request):
    db = _database()
    user = await require_user(request, db)
    if user.get("company_id"):
        membership = await db.enterprise_members.find_one({"company_id": user["company_id"], "user_id": user["user_id"]}, {"_id": 0})
        require_permission(membership or {}, "documents")
    query = {"id": file_id, "is_deleted": {"$ne": True}}
    query["company_id" if user.get("company_id") else "user_id"] = user.get("company_id") or user["user_id"]
    document = await db.user_files.find_one(query, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document introuvable.")
    path = _safe_local_path(document["storage_path"])
    if not path.exists():
        raise HTTPException(status_code=410, detail="Contenu du document indisponible.")
    return FileResponse(str(path), media_type=document.get("content_type") or "application/octet-stream", filename=document.get("name") or "document")


@router.delete("/api/files/{file_id}")
async def delete_file(file_id: str, request: Request):
    db = _database()
    user = await require_user(request, db)
    if user.get("company_id"):
        membership = await db.enterprise_members.find_one({"company_id": user["company_id"], "user_id": user["user_id"]}, {"_id": 0})
        require_permission(membership or {}, "documents")
    query = {"id": file_id, "is_deleted": {"$ne": True}}
    query["company_id" if user.get("company_id") else "user_id"] = user.get("company_id") or user["user_id"]
    document = await db.user_files.find_one(query, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document introuvable.")
    await db.user_files.update_one({"id": file_id}, {"$set": {"is_deleted": True, "deleted_at": datetime.now(timezone.utc).isoformat()}})
    if user.get("company_id"):
        await record_audit(db, company_id=user["company_id"], user=user, action="file.delete", resource="file", resource_id=file_id, details={"name": document.get("name", "")})
    return {"ok": True}

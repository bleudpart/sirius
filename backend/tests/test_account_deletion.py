import asyncio
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import auth_api
from account_deletion import DeletionReview, deletion_plan, finalize_account_deletion, request_account_deletion
import local_memory
import storage
from local_docstore import LocalDocStore
from test_account_inactivity import request_for


def test_request_keeps_account_and_owned_shared_and_payment_data(tmp_path):
    db = LocalDocStore(tmp_path / "deletion.db")
    asyncio.run(db.users.insert_one({"user_id": "client", "role": "user"}))
    for name in ("user_files", "payment_transactions", "sirius_work_dossiers"):
        asyncio.run(getattr(db, name).insert_one({"id": "owned", "user_id": "client"}))
        asyncio.run(getattr(db, name).insert_one({"id": "other", "user_id": "other"}))
    for _ in range(2):
        result = asyncio.run(request_account_deletion(db, user_id="client", requested_by="client"))
        assert result["status"] == "pending_review"
        assert result["account_deleted"] is False
    assert asyncio.run(db.users.count_documents({})) == 1
    assert asyncio.run(db.account_deletion_requests.count_documents({})) == 1
    for name in ("user_files", "payment_transactions", "sirius_work_dossiers"):
        assert asyncio.run(getattr(db, name).count_documents({})) == 2


def test_self_and_admin_routes_queue_requests_without_deletion(tmp_path):
    db = LocalDocStore(tmp_path / "deletion.db")
    client = {"user_id": "client", "email": "client@example.test", "role": "user"}
    admin = {"user_id": "admin", "email": "admin@example.test", "role": "admin"}
    for user in (client, admin):
        asyncio.run(db.users.insert_one(user))
    auth = auth_api.make_auth_router(db)
    self_route = next(route for route in auth.routes if route.path == "/auth/privacy/account")
    assert self_route.status_code == 202
    with pytest.raises(HTTPException) as confirmation:
        asyncio.run(self_route.endpoint(auth_api.PrivacyDeleteRequest(confirm=False), request_for(client)))
    assert confirmation.value.status_code == 400
    assert asyncio.run(db.account_deletion_requests.count_documents({})) == 0
    result = asyncio.run(self_route.endpoint(auth_api.PrivacyDeleteRequest(confirm=True), request_for(client)))
    assert result["account_deleted"] is False
    router = auth_api.make_admin_router(db)
    admin_route = next(route for route in router.routes if route.path == "/admin/users/{user_id}")
    assert admin_route.status_code == 202
    with pytest.raises(HTTPException) as forbidden:
        asyncio.run(admin_route.endpoint("client", request_for(client)))
    assert forbidden.value.status_code == 403
    result = asyncio.run(admin_route.endpoint("client", request_for(admin)))
    assert result["status"] == "pending_review"
    listing = next(route.endpoint for route in router.routes if route.path == "/admin/users")
    users = asyncio.run(listing(request_for(admin)))["users"]
    queued = next(user for user in users if user["user_id"] == "client")
    assert queued["deletion_request"]["status"] == "pending_review"
    assert asyncio.run(db.users.count_documents({})) == 2


def test_missing_and_admin_accounts_cannot_be_queued(tmp_path):
    db = LocalDocStore(tmp_path / "deletion.db")
    asyncio.run(db.users.insert_one({"user_id": "admin", "role": "admin"}))
    for uid, code in (("missing", 404), ("admin", 403)):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(request_account_deletion(db, user_id=uid, requested_by="reviewer"))
        assert exc.value.status_code == code
    assert asyncio.run(db.account_deletion_requests.count_documents({})) == 0


@pytest.fixture
def reviewed_account(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "deletion.db")
    monkeypatch.setattr(storage, "UPLOADS_DIR", tmp_path / "uploads")
    monkeypatch.setattr(local_memory, "DB_PATH", tmp_path / "memory.db")
    local_memory.init_local_db()
    user = {"user_id": "client", "email": "client@example.test", "role": "user", "disabled": True}
    asyncio.run(db.users.insert_one(user))
    asyncio.run(request_account_deletion(db, user_id="client", requested_by="client"))
    return db


def approved():
    return DeletionReview(confirm_user_id="client", external_review_complete=True, activity_stopped=True)


def test_finalize_erases_personal_files_memory_and_tokens_but_not_other_user(reviewed_account):
    db = reviewed_account
    asyncio.run(db.users.insert_one({"user_id": "other", "email": "other@example.test"}))
    storage.put_object("documents/client/file.txt", b"personal", "text/plain")
    storage.put_object("documents/other/file.txt", b"other", "text/plain")
    for uid in ("client", "other"):
        asyncio.run(db.files.insert_one({"user_id": uid, "storage_path": f"documents/{uid}/file.txt", "size": 5}))
        asyncio.run(db.sirius_work_entries.insert_one({"user_id": uid, "text": uid}))
        asyncio.run(db.microsoft_oauth.insert_one({"_id": uid, "token": uid}))
        asyncio.run(db.oauth_states.insert_one({"_id": f"state-{uid}", "uid": uid}))
    with sqlite3.connect(local_memory.DB_PATH) as con:
        for uid in ("client", "other"):
            con.execute("INSERT INTO episodes VALUES (?, ?, ?, ?, ?)", (uid, uid, "session", "summary", "2026-01-01"))
            con.execute("INSERT INTO facts (id, category, text, created_at, user_id) VALUES (?, ?, ?, ?, ?)", (uid, "souvenir", "text", "2026-01-01", uid))
            con.execute("INSERT INTO fact_vectors VALUES (?, ?, ?)", (uid, "model", "[]"))
    plan = asyncio.run(deletion_plan(db, "client"))
    assert plan["blockers"] == []
    result = asyncio.run(finalize_account_deletion(db, user_id="client", review=approved()))
    assert result["account_deleted"] is True
    assert result["scope"] == "reviewed_server_data"
    assert not storage._safe_local_path("documents/client/file.txt").exists()
    assert storage._safe_local_path("documents/other/file.txt").read_bytes() == b"other"
    assert asyncio.run(db.users.find_one({"user_id": "client"})) is None
    for name, query in (
        ("sirius_work_entries", {"user_id": "client"}),
        ("microsoft_oauth", {"_id": "client"}),
        ("oauth_states", {"uid": "client"}),
        ("account_deletion_requests", {"user_id": "client"}),
    ):
        assert asyncio.run(getattr(db, name).count_documents(query)) == 0
    assert asyncio.run(db.users.count_documents({})) == 1
    assert asyncio.run(db.sirius_work_entries.count_documents({"user_id": "other"})) == 1
    with sqlite3.connect(local_memory.DB_PATH) as con:
        for table in ("facts", "episodes", "fact_vectors"):
            assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 1


@pytest.mark.parametrize("collection,document", [
    ("payment_transactions", {"user_id": "client"}),
    ("payment_transactions", {"user_id": "client@example.test"}),
    ("enterprise_companies", {"owner_user_id": "client"}),
    ("themis_pieces", {"user_id": "client"}),
    ("photo3d_jobs", {"user_id": "client"}),
    ("user_files", {"user_id": "client", "company_id": "shared", "storage_path": "documents/shared/test.txt"}),
])
def test_business_and_shared_records_block_all_erasure(reviewed_account, collection, document):
    db = reviewed_account
    asyncio.run(getattr(db, collection).insert_one(document))
    asyncio.run(db.sirius_chats.insert_one({"user_id": "client", "text": "keep"}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(finalize_account_deletion(db, user_id="client", review=approved()))
    assert exc.value.status_code == 409
    assert asyncio.run(db.users.count_documents({"user_id": "client"})) == 1
    assert asyncio.run(db.sirius_chats.count_documents({})) == 1


@pytest.mark.parametrize("path", ["../outside.txt", ".", "documents"])
def test_invalid_file_paths_block_before_erasure(reviewed_account, path):
    storage.UPLOADS_DIR.mkdir()
    (storage.UPLOADS_DIR / "documents").mkdir()
    asyncio.run(reviewed_account.files.insert_one({"user_id": "client", "storage_path": path}))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(finalize_account_deletion(reviewed_account, user_id="client", review=approved()))
    assert exc.value.status_code == 409
    assert storage.UPLOADS_DIR.exists()


def test_shared_path_is_not_unlinked(reviewed_account):
    db = reviewed_account
    storage.put_object("shared.txt", b"keep", "text/plain")
    for uid, path in (("client", "shared.txt"), ("other", "./shared.txt")):
        asyncio.run(db.files.insert_one({"user_id": uid, "storage_path": path}))
    with pytest.raises(HTTPException):
        asyncio.run(finalize_account_deletion(db, user_id="client", review=approved()))
    assert storage._safe_local_path("shared.txt").read_bytes() == b"keep"


def test_failure_keeps_disabled_account_and_reports_incomplete_state(reviewed_account, monkeypatch):
    db = reviewed_account
    storage.put_object("blocked.txt", b"keep", "text/plain")
    asyncio.run(db.files.insert_one({"user_id": "client", "storage_path": "blocked.txt"}))
    original_unlink = Path.unlink

    def denied(self, **kwargs):
        raise PermissionError("file locked")

    monkeypatch.setattr(Path, "unlink", denied)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(finalize_account_deletion(db, user_id="client", review=approved()))
    assert exc.value.status_code == 500
    assert asyncio.run(db.users.find_one({"user_id": "client"}))["disabled"] is True
    assert asyncio.run(db.files.count_documents({})) == 1
    assert asyncio.run(db.account_deletion_requests.find_one({"user_id": "client"}))["status"] == "failed"
    with pytest.raises(HTTPException) as retry:
        asyncio.run(request_account_deletion(db, user_id="client", requested_by="client"))
    assert retry.value.status_code == 409
    monkeypatch.setattr(Path, "unlink", original_unlink)
    result = asyncio.run(finalize_account_deletion(db, user_id="client", review=approved()))
    assert result["account_deleted"] is True


def test_finalize_requires_review_disabled_account_and_admin(reviewed_account):
    db = reviewed_account
    with pytest.raises(HTTPException) as incomplete:
        asyncio.run(finalize_account_deletion(db, user_id="client", review=DeletionReview(confirm_user_id="client")))
    assert incomplete.value.status_code == 400
    asyncio.run(db.users.update_one({"user_id": "client"}, {"$set": {"disabled": False}}))
    with pytest.raises(HTTPException) as active:
        asyncio.run(finalize_account_deletion(db, user_id="client", review=approved()))
    assert active.value.status_code == 409
    router = auth_api.make_admin_router(db)
    endpoint = next(route.endpoint for route in router.routes if route.path == "/admin/users/{user_id}/finalize-deletion")
    client = asyncio.run(db.users.find_one({"user_id": "client"}))
    with pytest.raises(HTTPException) as forbidden:
        asyncio.run(endpoint("client", approved(), request_for(client)))
    assert forbidden.value.status_code == 403


def test_admin_can_finalize_but_cannot_reactivate_account_under_review(reviewed_account):
    db = reviewed_account
    admin = {"user_id": "admin", "email": "admin@example.test", "role": "admin"}
    asyncio.run(db.users.insert_one(admin))
    router = auth_api.make_admin_router(db)
    disable = next(route.endpoint for route in router.routes if route.path == "/admin/users/{user_id}/disable")
    with pytest.raises(HTTPException) as exc:
        asyncio.run(disable("client", request_for(admin)))
    assert exc.value.status_code == 409
    complete = next(route.endpoint for route in router.routes if route.path == "/admin/users/{user_id}/finalize-deletion")
    result = asyncio.run(complete("client", approved(), request_for(admin)))
    assert result["account_deleted"] is True
    assert asyncio.run(db.users.count_documents({})) == 1


def test_changed_account_at_final_step_restores_failed_request(reviewed_account, monkeypatch):
    db = reviewed_account
    collection_type = type(db.users)
    original_delete = collection_type.delete_one

    async def changed_delete(self, query):
        if query == {"user_id": "client", "disabled": True}:
            return SimpleNamespace(deleted_count=0)
        return await original_delete(self, query)

    monkeypatch.setattr(collection_type, "delete_one", changed_delete)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(finalize_account_deletion(db, user_id="client", review=approved()))
    assert exc.value.status_code == 500
    request = asyncio.run(db.account_deletion_requests.find_one({"user_id": "client"}))
    assert request["status"] == "failed"
    assert request["requested_at"]
    assert asyncio.run(db.users.find_one({"user_id": "client"}))["disabled"] is True

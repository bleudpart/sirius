import asyncio
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException, Request

import auth_api
from local_docstore import LocalDocStore


def request_for(user):
    token = auth_api.create_access_token(user)
    return Request({
        "type": "http",
        "headers": [(b"authorization", f"Bearer {token}".encode())],
    })


def test_authenticated_session_records_activity_without_login(tmp_path):
    db = LocalDocStore(tmp_path / "accounts.db")
    user = {"user_id": "client", "email": "client@example.test", "role": "user"}
    asyncio.run(db.users.insert_one(user))
    before = datetime.now(timezone.utc)
    result = asyncio.run(auth_api.require_user(request_for(user), db))
    stored = asyncio.run(db.users.find_one({"user_id": "client"}))
    assert result["user_id"] == "client"
    assert auth_api._activity_datetime(stored["last_activity"]) >= before
    assert stored["inactivity_tracking_started_at"] == stored["last_activity"]
    started = stored["inactivity_tracking_started_at"]
    asyncio.run(auth_api.require_user(request_for(user), db))
    stored = asyncio.run(db.users.find_one({"user_id": "client"}))
    assert stored["inactivity_tracking_started_at"] == started


def test_disabled_account_does_not_record_activity(tmp_path):
    db = LocalDocStore(tmp_path / "accounts.db")
    user = {"user_id": "disabled", "email": "disabled@example.test", "disabled": True}
    asyncio.run(db.users.insert_one(user))
    with pytest.raises(HTTPException) as exc:
        asyncio.run(auth_api.require_user(request_for(user), db))
    assert exc.value.status_code == 401
    stored = asyncio.run(db.users.find_one({"user_id": "disabled"}))
    assert "last_activity" not in stored


@pytest.mark.parametrize("now,status", [
    ("2027-10-02T09:59:59+00:00", "observing"),
    ("2027-10-02T10:00:00+00:00", "review_required"),
])
def test_review_uses_exact_twelve_calendar_months(now, status):
    document = {
        "last_activity": "2020-01-01T00:00:00+00:00",
        "inactivity_tracking_started_at": "2026-10-02T10:00:00+00:00",
    }
    review = auth_api._inactivity_review(document, datetime.fromisoformat(now))
    assert review["status"] == status
    assert review["review_after"] == "2027-10-02T10:00:00+00:00"


def test_recent_activity_postpones_review_and_handles_leap_year():
    review = auth_api._inactivity_review({
        "inactivity_tracking_started_at": datetime(2023, 1, 1, tzinfo=timezone.utc),
        "last_activity": datetime(2024, 2, 29, tzinfo=timezone.utc),
    }, datetime(2025, 2, 27, tzinfo=timezone.utc))
    assert review["status"] == "observing"
    assert review["review_after"] == "2025-02-28T00:00:00+00:00"


def test_unknown_tracking_and_admin_require_distinct_review():
    now = datetime.now(timezone.utc)
    assert auth_api._inactivity_review({}, now)["status"] == "unknown"
    assert auth_api._inactivity_review({
        "inactivity_tracking_started_at": "invalid",
    }, now)["status"] == "unknown"
    assert auth_api._inactivity_review({"role": "admin"}, now)["status"] == "excluded"


def test_admin_list_starts_observation_without_deleting_accounts(tmp_path):
    db = LocalDocStore(tmp_path / "accounts.db")
    admin = {"user_id": "admin", "email": "admin@example.test", "role": "admin"}
    client = {"user_id": "old", "email": "old@example.test", "created_at": "2020-01-01T00:00:00"}
    asyncio.run(db.users.insert_one(admin))
    asyncio.run(db.users.insert_one(client))
    router = auth_api.make_admin_router(db)
    endpoint = next(route.endpoint for route in router.routes if route.path == "/admin/users")
    result = asyncio.run(endpoint(request_for(admin)))
    old = next(user for user in result["users"] if user["user_id"] == "old")
    assert old["inactivity_review"]["status"] == "observing"
    assert isinstance(old["activity"]["last_activity"], int)
    assert old["created_at"] == "2020-01-01T00:00:00+00:00"
    assert asyncio.run(db.users.count_documents({})) == 2
    again = asyncio.run(endpoint(request_for(admin)))
    same = next(user for user in again["users"] if user["user_id"] == "old")
    assert same["inactivity_review"]["review_after"] == old["inactivity_review"]["review_after"]


def test_review_list_rejects_non_admin_and_anonymous_requests(tmp_path):
    db = LocalDocStore(tmp_path / "accounts.db")
    user = {"user_id": "client", "email": "client@example.test", "role": "user"}
    asyncio.run(db.users.insert_one(user))
    router = auth_api.make_admin_router(db)
    endpoint = next(route.endpoint for route in router.routes if route.path == "/admin/users")
    with pytest.raises(HTTPException) as forbidden:
        asyncio.run(endpoint(request_for(user)))
    assert forbidden.value.status_code == 403
    with pytest.raises(HTTPException) as anonymous:
        asyncio.run(endpoint(Request({"type": "http", "headers": []})))
    assert anonymous.value.status_code == 401


def test_concurrent_activity_update_does_not_overwrite_newer_activity(tmp_path, monkeypatch):
    db = LocalDocStore(tmp_path / "accounts.db")
    user = {
        "user_id": "client", "email": "client@example.test", "role": "user",
        "last_activity": "2026-01-01T00:00:00+00:00",
    }
    asyncio.run(db.users.insert_one(user))
    collection = db.users
    original_find = collection.find_one
    newer = "2099-01-01T00:00:00+00:00"

    async def racing_find(self, query):
        stored = await original_find(query)
        await collection.update_one(query, {"$set": {"last_activity": newer}})
        return stored

    monkeypatch.setattr(type(collection), "find_one", racing_find)
    asyncio.run(auth_api.require_user(request_for(user), db))
    stored = asyncio.run(original_find({"user_id": "client"}))
    assert stored["last_activity"] == newer

from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import sqlite3
import uuid

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from chronos_store import ChronosStore
from routes.chronos import EventIn, EventUpdateIn, make_chronos_router


@pytest.fixture
def chronos_client(tmp_path):
    store = ChronosStore(tmp_path / "chronos.sqlite3")

    async def require_user(request, _db):
        user_id = request.headers.get("x-test-user")
        if not user_id:
            raise HTTPException(status_code=401, detail="Authentication required.")
        return {"user_id": user_id}

    app = FastAPI()
    app.include_router(make_chronos_router(require_user, db=None, store=store))
    with TestClient(app) as client:
        yield client, store


def event_payload(
    start="2026-10-16T09:00:00+00:00",
    end="2026-10-16T10:00:00+00:00",
    **overrides,
):
    return {
        "title": "  Briefing  ",
        "start": start,
        "end": end,
        "timezone": "UTC",
        "notes": "  Notes  ",
        **overrides,
    }


def test_create_update_delete_persist_after_store_restart(chronos_client, tmp_path):
    client, store = chronos_client
    headers = {"x-test-user": "user-1"}
    created_response = client.post("/chronos/events", headers=headers, json=event_payload())
    assert created_response.status_code == 201
    created = created_response.json()["event"]
    assert created["title"] == "Briefing"
    assert created["notes"] == "Notes"
    assert created["revision"] == 1
    assert created["start"] == "2026-10-16T09:00:00.000000+00:00"
    assert created["end"] == "2026-10-16T10:00:00.000000+00:00"
    assert "user_id" not in created

    restarted = ChronosStore(tmp_path / "chronos.sqlite3")
    assert restarted.get_event("user-1", created["id"]) == created

    updated_response = client.put(
        f"/chronos/events/{created['id']}",
        headers=headers,
        json=event_payload(
            start="2026-10-16T11:00:00+00:00",
            end="2026-10-16T12:00:00+00:00",
            title="Updated",
            notes="Replacement",
            revision=1,
        ),
    )
    assert updated_response.status_code == 200
    updated = updated_response.json()["event"]
    assert updated["revision"] == 2
    assert updated["title"] == "Updated"
    assert updated["notes"] == "Replacement"
    assert restarted.get_event("user-1", created["id"]) == updated

    deleted = client.delete(
        f"/chronos/events/{created['id']}", headers=headers, params={"revision": 2}
    )
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    with pytest.raises(HTTPException) as missing:
        store.get_event("user-1", created["id"])
    assert missing.value.status_code == 404


def test_authentication_and_user_scoping(chronos_client):
    client, store = chronos_client
    assert client.get("/chronos/events", params={"on": "2026-10-16", "timezone": "UTC"}).status_code == 401
    owner = {"x-test-user": "owner"}
    other = {"x-test-user": "other"}
    created = client.post("/chronos/events", headers=owner, json=event_payload()).json()["event"]

    assert client.get(
        "/chronos/events", headers=other, params={"on": "2026-10-16", "timezone": "UTC"}
    ).json() == {
        "events": [],
        "truncated": False,
        "timezone": "UTC",
        "date": "2026-10-16",
    }
    assert client.put(
        f"/chronos/events/{created['id']}",
        headers=other,
        json=event_payload(revision=1),
    ).status_code == 404
    assert client.delete(
        f"/chronos/events/{created['id']}", headers=other, params={"revision": 1}
    ).status_code == 404
    with pytest.raises(HTTPException) as hidden:
        store.get_event("other", created["id"])
    assert hidden.value.status_code == 404


def test_listing_uses_local_day_boundaries_and_dst(chronos_client):
    client, _ = chronos_client
    headers = {"x-test-user": "day-user"}
    payloads = [
        event_payload(
            start="2026-03-28T23:30:00+01:00",
            end="2026-03-29T00:00:00+01:00",
            title="Ends at local midnight",
            timezone="Europe/Paris",
        ),
        event_payload(
            start="2026-03-29T00:30:00+01:00",
            end="2026-03-29T03:30:00+02:00",
            title="Crosses DST change",
            timezone="Europe/Paris",
        ),
        event_payload(
            start="2026-03-30T00:00:00+02:00",
            end="2026-03-30T01:00:00+02:00",
            title="Next local day",
            timezone="Europe/Paris",
        ),
    ]
    for payload in payloads:
        assert client.post("/chronos/events", headers=headers, json=payload).status_code == 201

    response = client.get(
        "/chronos/events",
        headers=headers,
        params={"on": "2026-03-29", "timezone": "Europe/Paris"},
    )
    body = response.json()
    assert response.status_code == 200
    assert body["timezone"] == "Europe/Paris"
    assert body["date"] == "2026-03-29"
    assert [event["title"] for event in body["events"]] == ["Crosses DST change"]


def test_day_list_is_limited_to_500_events(chronos_client):
    client, store = chronos_client
    start_day = datetime(2026, 10, 16, tzinfo=timezone.utc)
    for index in range(501):
        start = start_day + timedelta(minutes=index * 2)
        store.create_event(
            "many-events",
            {
                "title": f"Event {index}",
                "start": start,
                "end": start + timedelta(minutes=1),
                "timezone": "UTC",
                "notes": "",
            },
        )
    response = client.get(
        "/chronos/events",
        headers={"x-test-user": "many-events"},
        params={"on": "2026-10-16", "timezone": "UTC"},
    )
    assert response.status_code == 200
    assert len(response.json()["events"]) == 500
    assert response.json()["truncated"] is True
    conflicts = store.preview_conflicts(
        "many-events",
        event_payload(start=start_day.isoformat(), end=(start_day + timedelta(days=1)).isoformat()),
    )
    assert len(conflicts) == 501
    assert [event["title"] for event in conflicts] == [
        f"Event {index}" for index in range(501)
    ]


def test_overlap_edges_allow_conflicts_and_rejected_write_is_atomic(chronos_client):
    client, _ = chronos_client
    headers = {"x-test-user": "overlap-user"}
    first = client.post("/chronos/events", headers=headers, json=event_payload()).json()["event"]
    touching = client.post(
        "/chronos/events",
        headers=headers,
        json=event_payload(
            start="2026-10-16T10:00:00+00:00",
            end="2026-10-16T11:00:00+00:00",
            title="Touching edge",
        ),
    )
    assert touching.status_code == 201

    rejected_payload = event_payload(
        start="2026-10-16T09:30:00+00:00",
        end="2026-10-16T10:00:00+00:00",
    )
    rejected = client.post("/chronos/events", headers=headers, json=rejected_payload)
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["message"] == "Event overlaps existing events."
    assert len(rejected.json()["detail"]["conflicts"]) == 1
    assert len(client.get(
        "/chronos/events",
        headers=headers,
        params={"on": "2026-10-16", "timezone": "UTC"},
    ).json()["events"]) == 2

    allowed = client.post(
        "/chronos/events",
        headers=headers,
        json={**rejected_payload, "allow_conflicts": True},
    )
    assert allowed.status_code == 201
    assert [event["id"] for event in allowed.json()["conflicts"]] == [first["id"]]


def test_update_overlap_failure_and_stale_revision_do_not_write(chronos_client):
    client, _ = chronos_client
    headers = {"x-test-user": "revision-user"}
    first = client.post("/chronos/events", headers=headers, json=event_payload()).json()["event"]
    second = client.post(
        "/chronos/events",
        headers=headers,
        json=event_payload(
            start="2026-10-16T11:00:00+00:00",
            end="2026-10-16T12:00:00+00:00",
            title="Second",
        ),
    ).json()["event"]
    proposed = event_payload(
        start="2026-10-16T09:30:00+00:00",
        end="2026-10-16T10:30:00+00:00",
        title="Must not be applied",
        revision=1,
    )
    overlap = client.put(f"/chronos/events/{second['id']}", headers=headers, json=proposed)
    assert overlap.status_code == 409
    assert overlap.json()["detail"]["conflicts"][0]["id"] == first["id"]

    stale = client.put(
        f"/chronos/events/{first['id']}",
        headers=headers,
        json={**event_payload(title="stale"), "revision": 2},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_revision"] == 1
    actual = client.get(
        "/chronos/events",
        headers=headers,
        params={"on": "2026-10-16", "timezone": "UTC"},
    ).json()["events"]
    assert {event["title"] for event in actual} == {"Briefing", "Second"}


@pytest.mark.parametrize(
    "payload",
    [
        event_payload(start="2026-10-16T09:00:00", end="2026-10-16T10:00:00"),
        event_payload(start="2026-10-16T10:00:00+00:00", end="2026-10-16T09:00:00+00:00"),
        event_payload(
            start="2026-10-16T09:00:00+00:00",
            end="2026-11-17T10:00:00+00:00",
        ),
        event_payload(timezone="Not/AZone"),
        event_payload(start="2026-10-16T09:00:00+00:00", timezone="Europe/Paris"),
        event_payload(title="   "),
        event_payload(allow_conflicts="true"),
        {**event_payload(), "unexpected": "field"},
    ],
)
def test_invalid_payloads_are_rejected_before_writing(chronos_client, payload):
    client, _ = chronos_client
    headers = {"x-test-user": "invalid-user"}
    response = client.post("/chronos/events", headers=headers, json=payload)
    assert response.status_code == 422
    assert client.get(
        "/chronos/events",
        headers=headers,
        params={"on": "2026-10-16", "timezone": "UTC"},
    ).json()["events"] == []


def test_update_requires_positive_integer_revision_and_delete_uses_optimistic_lock(chronos_client):
    client, _ = chronos_client
    headers = {"x-test-user": "delete-revision-user"}
    created = client.post("/chronos/events", headers=headers, json=event_payload()).json()["event"]

    invalid = client.put(
        f"/chronos/events/{created['id']}",
        headers=headers,
        json={**event_payload(), "revision": 0},
    )
    assert invalid.status_code == 422
    stale_delete = client.delete(
        f"/chronos/events/{created['id']}", headers=headers, params={"revision": 2}
    )
    assert stale_delete.status_code == 409
    assert client.get(
        "/chronos/events",
        headers=headers,
        params={"on": "2026-10-16", "timezone": "UTC"},
    ).json()["events"][0]["id"] == created["id"]


def test_sql_metacharacters_are_data_not_query_syntax(chronos_client):
    client, _ = chronos_client
    user_id = "' OR 1=1 --"
    headers = {"x-test-user": user_id}
    created = client.post(
        "/chronos/events",
        headers=headers,
        json=event_payload(title="x'); DROP TABLE chronos_events; --"),
    )
    assert created.status_code == 201
    assert client.get(
        "/chronos/events",
        headers=headers,
        params={"on": "2026-10-16", "timezone": "UTC"},
    ).json()["events"][0]["title"] == "x'); DROP TABLE chronos_events; --"
    assert client.get(
        "/chronos/events",
        headers={"x-test-user": "another-user"},
        params={"on": "2026-10-16", "timezone": "UTC"},
    ).json()["events"] == []


def test_storage_failures_are_logged_and_return_503(chronos_client, monkeypatch, caplog):
    client, store = chronos_client

    def fail_list(*args):
        raise OSError(f"disk unavailable during call with {len(args)} arguments")

    monkeypatch.setattr(store, "list_events", fail_list)
    response = client.get(
        "/chronos/events",
        headers={"x-test-user": "storage-user"},
        params={"on": "2026-10-16", "timezone": "UTC"},
    )
    assert response.status_code == 503
    assert "Chronos SQLite storage operation failed" in caplog.text


def test_store_create_and_update_accept_json_model_dumps(tmp_path):
    store = ChronosStore(tmp_path / "json.sqlite3")
    payload = EventIn.model_validate(event_payload(
        start="2026-03-29T01:30:00+01:00",
        end="2026-03-29T03:30:00+02:00",
        timezone="Europe/Paris",
    )).model_dump(mode="json")
    created = store.create_event("owner", payload)["event"]
    assert created["start"] == "2026-03-29T00:30:00.000000+00:00"
    assert created["end"] == "2026-03-29T01:30:00.000000+00:00"
    assert created["title"] == "Briefing"
    update = EventUpdateIn.model_validate({
        **payload, "title": "  Updated  ", "revision": 1,
    }).model_dump(mode="json")
    assert store.preview_conflicts("owner", update, exclude_id=created["id"]) == []
    result = store.update_event("owner", created["id"], update)
    assert result["conflicts"] == []
    assert result["event"]["revision"] == 2
    assert result["event"]["title"] == "Updated"


def test_preview_full_interval_exclusion_edges_and_user_scope(tmp_path):
    store = ChronosStore(tmp_path / "preview.sqlite3")
    early = store.create_event("owner", event_payload())["event"]
    later = store.create_event("owner", event_payload(
        start="2026-10-18T09:00:00Z", end="2026-10-18T10:00:00Z",
    ))["event"]
    store.create_event("other", event_payload())
    span = event_payload(start="2026-10-16T08:00:00Z", end="2026-10-19T00:00:00Z")

    assert store.preview_conflicts("owner", span) == [early, later]
    assert store.preview_conflicts("owner", span, exclude_id=early["id"]) == [later]
    assert store.preview_conflicts("' OR 1=1 --", span) == []
    assert store.preview_conflicts("owner", span, exclude_id="' OR 1=1 --") == [early, later]
    assert store.preview_conflicts("owner", event_payload(
        start="2026-10-16T10:00:00Z", end="2026-10-18T09:00:00Z",
    )) == []
    assert store.get_event("owner", early["id"]) == early
    assert store.get_event("owner", later["id"]) == later


@pytest.mark.parametrize("operation", ["create", "update"])
def test_write_rechecks_conflicts_added_after_preview(tmp_path, operation):
    store = ChronosStore(tmp_path / "recheck.sqlite3")
    existing = store.create_event("owner", event_payload(
        start="2026-10-15T09:00:00Z", end="2026-10-15T10:00:00Z",
    ))["event"]
    proposal = event_payload()
    if operation == "update":
        proposal["revision"] = 1
    assert store.preview_conflicts("owner", proposal, exclude_id=existing["id"]) == []
    concurrent = ChronosStore(store.path).create_event("owner", event_payload())["event"]
    assert store.preview_conflicts("owner", proposal, exclude_id=existing["id"]) == [concurrent]
    with pytest.raises(HTTPException) as blocked:
        if operation == "create":
            store.create_event("owner", proposal)
        else:
            store.update_event("owner", existing["id"], proposal)
    assert blocked.value.status_code == 409
    assert blocked.value.detail["conflicts"] == [concurrent]
    assert store.get_event("owner", existing["id"]) == existing
    assert store.preview_conflicts("owner", proposal, exclude_id=existing["id"]) == [concurrent]


@pytest.mark.parametrize("operation", ["create", "update", "preview"])
@pytest.mark.parametrize("invalid", [
    {"start": "2026-10-16T09:00:00"},
    {"end": "2026-10-16T08:00:00Z"},
    {"end": "2026-11-17T10:00:00Z"},
    {"timezone": "Not/AZone"},
    {"timezone": "Europe/Paris"},
    {"title": " "},
    {"allow_conflicts": "false"},
    {"extra": "private-input"},
])
def test_store_validates_direct_json_payloads(tmp_path, operation, invalid):
    store = ChronosStore(tmp_path / "validation.sqlite3")
    original = store.create_event("owner", event_payload())["event"]
    payload = {**event_payload(), **invalid}
    if operation == "update":
        payload["revision"] = 1
    with pytest.raises(HTTPException) as failure:
        if operation == "create":
            store.create_event("owner", payload)
        elif operation == "update":
            store.update_event("owner", original["id"], payload)
        else:
            store.preview_conflicts("owner", payload)
    assert failure.value.status_code == 422
    assert all("input" not in error and "ctx" not in error for error in failure.value.detail)
    assert store.get_event("owner", original["id"]) == original


@pytest.mark.parametrize("revision", [None, 0, True, "1", 1.5])
def test_store_update_validates_revision_before_writing(tmp_path, revision):
    store = ChronosStore(tmp_path / "revision.sqlite3")
    original = store.create_event("owner", event_payload())["event"]
    with pytest.raises(HTTPException) as failure:
        store.update_event("owner", original["id"], {
            **event_payload(), "revision": revision,
        })
    assert failure.value.status_code == 422
    assert store.get_event("owner", original["id"]) == original


@pytest.mark.parametrize("invalid", [
    {"end": "2026-10-16T09:00:00Z"},
    {"end": "2026-10-16T08:59:59Z"},
    {"end": "2026-11-16T09:00:00.000001Z"},
    {"start": "2026-10-16T09:00:00"},
    {"end": "2026-10-16T10:00:00"},
    {"timezone": "Not/AZone"},
    {"timezone": "Europe/Paris"},
    {"end": "2026-10-16T12:00:00+02:00"},
    {"title": ""},
    {"title": "x" * 161},
    {"notes": "x" * 2001},
    {"allow_conflicts": 1},
    {"unknown": "not allowed"},
])
def test_event_model_pure_validation_rejects_invalid_proposals(invalid):
    with pytest.raises(ValidationError):
        EventIn.model_validate({**event_payload(), **invalid})


def test_event_model_accepts_exact_31_day_boundary():
    model = EventIn.model_validate(event_payload(end="2026-11-16T09:00:00Z"))
    assert model.end - model.start == timedelta(days=31)


@pytest.mark.parametrize("operation", ["create", "update"])
@pytest.mark.parametrize("change", ["new", "revision", "removed", "unchanged"])
def test_confirmation_snapshot_is_checked_atomically(tmp_path, monkeypatch, operation, change):
    store = ChronosStore(tmp_path / "confirm.sqlite3")
    other_store = ChronosStore(store.path)
    target = store.create_event("owner", event_payload(
        start="2026-10-15T09:00:00Z", end="2026-10-15T10:00:00Z",
    ))["event"]
    conflict = store.create_event("owner", event_payload())["event"]
    proposal = event_payload(allow_conflicts=True)
    if operation == "update":
        proposal["revision"] = 1
    preview = store.preview_conflicts("owner", proposal, exclude_id=target["id"])
    expected = [{"id": event["id"], "revision": event["revision"]} for event in preview]
    if change == "new":
        other_store.create_event("owner", event_payload(allow_conflicts=True))
    elif change == "revision":
        other_store.update_event("owner", conflict["id"], event_payload(
            title="Changed after preview", revision=1,
        ))
    elif change == "removed":
        other_store.delete_event("owner", conflict["id"], revision=1)

    current = store.preview_conflicts("owner", proposal, exclude_id=target["id"])
    original_conflicts = store._conflicts

    def assert_inside_write_transaction(connection, *args, **kwargs):
        assert connection.in_transaction
        return original_conflicts(connection, *args, **kwargs)

    monkeypatch.setattr(store, "_conflicts", assert_inside_write_transaction)

    def confirm():
        if operation == "create":
            return store.create_event("owner", proposal, expected_conflicts=expected)
        return store.update_event("owner", target["id"], proposal, expected_conflicts=expected)

    if change == "unchanged":
        result = confirm()
        assert result["conflicts"] == preview
        assert result["event"]["revision"] == (1 if operation == "create" else 2)
    else:
        with pytest.raises(HTTPException) as failure:
            confirm()
        assert failure.value.status_code == 409
        assert failure.value.detail["conflicts"] == current
        assert store.get_event("owner", target["id"]) == target
        assert other_store.preview_conflicts(
            "owner", proposal, exclude_id=target["id"]
        ) == current


@pytest.mark.parametrize("expected", [None, [], [{"id": "x", "revision": "1"}],
                                      [{"id": "x", "revision": True}],
                                      [{"revision": 1}],
                                      [{"id": "x", "revision": 1}] * 2])
def test_confirmation_snapshot_empty_none_and_invalid(tmp_path, expected):
    store = ChronosStore(tmp_path / "snapshot.sqlite3")
    if expected in (None, []):
        assert store.create_event(
            "owner", event_payload(), expected_conflicts=expected
        )["conflicts"] == []
    else:
        with pytest.raises(HTTPException) as failure:
            store.create_event("owner", event_payload(), expected_conflicts=expected)
        assert failure.value.status_code == 422


def test_expected_empty_snapshot_blocks_new_overlap_even_when_allowed(tmp_path):
    store = ChronosStore(tmp_path / "empty-snapshot.sqlite3")
    conflict = store.create_event("owner", event_payload())["event"]
    with pytest.raises(HTTPException) as failure:
        store.create_event(
            "owner", event_payload(allow_conflicts=True), expected_conflicts=[]
        )
    assert failure.value.status_code == 409
    assert failure.value.detail["conflicts"] == [conflict]


def test_matching_snapshot_does_not_override_allow_conflicts_false(tmp_path):
    store = ChronosStore(tmp_path / "explicit-allow.sqlite3")
    conflict = store.create_event("owner", event_payload())["event"]
    with pytest.raises(HTTPException) as failure:
        store.create_event("owner", event_payload(), expected_conflicts=[conflict])
    assert failure.value.status_code == 409
    assert failure.value.detail["message"] == "Event overlaps existing events."


def test_idempotent_post_replays_after_restart_and_event_changes(chronos_client):
    client, store = chronos_client
    key = str(uuid.uuid4())
    headers = {"x-test-user": "owner", "Idempotency-Key": key}
    payload = event_payload(allow_conflicts=True)
    original = client.post("/chronos/events", headers=headers, json=payload)
    assert original.status_code == 201
    repeated = client.post("/chronos/events", headers=headers, json=payload)
    assert repeated.status_code == 201
    assert repeated.json() == original.json()
    assert len(store.preview_conflicts("owner", payload)) == 1

    event = original.json()["event"]
    store.update_event("owner", event["id"], event_payload(title="Changed", revision=1))
    restarted = ChronosStore(store.path)
    assert restarted.create_event("owner", payload, idempotency_key=key) == original.json()
    store.delete_event("owner", event["id"], revision=2)
    assert restarted.create_event("owner", payload, idempotency_key=key) == original.json()
    assert store.preview_conflicts("owner", payload) == []


def test_idempotent_post_different_payload_409_and_crossuser_isolation(chronos_client):
    client, store = chronos_client
    key = str(uuid.uuid4())
    headers = {"x-test-user": "owner", "Idempotency-Key": key}
    first = client.post("/chronos/events", headers=headers, json=event_payload())
    different = client.post(
        "/chronos/events", headers=headers, json=event_payload(title="Different")
    )
    assert different.status_code == 409
    assert len(store.preview_conflicts("owner", event_payload())) == 1
    other = client.post(
        "/chronos/events",
        headers={**headers, "x-test-user": "other"},
        json=event_payload(title="Different"),
    )
    assert other.status_code == 201
    assert other.json()["event"]["id"] != first.json()["event"]["id"]
    assert store.preview_conflicts("owner", event_payload()) == [first.json()["event"]]


def test_idempotency_fingerprint_canonicalizes_defaults_whitespace_and_utc(tmp_path):
    store = ChronosStore(tmp_path / "canonical.sqlite3")
    key = str(uuid.uuid4())
    payload = event_payload()
    original = store.create_event("owner", payload, idempotency_key=key)
    canonical = EventIn.model_validate(payload).model_dump()
    canonical["start"] = "2026-10-16T09:00:00Z"
    canonical["end"] = "2026-10-16T10:00:00.000000+00:00"
    assert store.create_event("owner", canonical, idempotency_key=key.upper()) == original
    with pytest.raises(HTTPException) as failure:
        store.create_event("owner", {**payload, "allow_conflicts": True}, idempotency_key=key)
    assert failure.value.status_code == 409


def test_idempotent_replay_returns_original_conflicts_before_snapshot_recheck(tmp_path):
    store = ChronosStore(tmp_path / "replay-snapshot.sqlite3")
    conflict = store.create_event("owner", event_payload())["event"]
    key = str(uuid.uuid4())
    payload = event_payload(allow_conflicts=True)
    result = store.create_event(
        "owner", payload, expected_conflicts=[conflict], idempotency_key=key
    )
    store.delete_event("owner", conflict["id"], revision=1)
    assert store.create_event(
        "owner", payload, expected_conflicts=[conflict], idempotency_key=key
    ) == result
    assert len(store.preview_conflicts("owner", payload)) == 1


@pytest.mark.parametrize("key", ["", "x", "a" * 1000, "x" * 36, str(uuid.uuid4()).replace("-", "")])
def test_invalid_idempotency_header_is_rejected(chronos_client, key):
    client, store = chronos_client
    response = client.post(
        "/chronos/events",
        headers={"x-test-user": "owner", "Idempotency-Key": key},
        json=event_payload(),
    )
    assert response.status_code == 422
    assert store.preview_conflicts("owner", event_payload()) == []


def test_failed_snapshot_does_not_consume_idempotency_key(tmp_path):
    store = ChronosStore(tmp_path / "failed-snapshot.sqlite3")
    key = str(uuid.uuid4())
    conflict = store.create_event("owner", event_payload())["event"]
    payload = event_payload(allow_conflicts=True)
    with pytest.raises(HTTPException) as failure:
        store.create_event("owner", payload, expected_conflicts=[], idempotency_key=key)
    assert failure.value.status_code == 409
    result = store.create_event(
        "owner", payload, expected_conflicts=[conflict], idempotency_key=key
    )
    assert result["conflicts"] == [conflict]


def test_idempotency_record_failure_rolls_back_event_and_key(tmp_path):
    store = ChronosStore(tmp_path / "atomic-key.sqlite3")
    with store._connection() as connection:
        connection.execute(
            "CREATE TRIGGER fail_request BEFORE INSERT ON chronos_create_requests "
            "BEGIN SELECT RAISE(ABORT, 'simulated key insert failure'); END"
        )
    key = str(uuid.uuid4())
    with pytest.raises(sqlite3.IntegrityError):
        store.create_event("owner", event_payload(), idempotency_key=key)
    assert store.preview_conflicts("owner", event_payload()) == []
    with store._connection() as connection:
        connection.execute("DROP TRIGGER fail_request")
    result = store.create_event("owner", event_payload(), idempotency_key=key)
    assert store.preview_conflicts("owner", event_payload()) == [result["event"]]


def test_concurrent_idempotent_creates_insert_only_once(tmp_path):
    path = tmp_path / "concurrent-key.sqlite3"
    store = ChronosStore(path)
    store.preview_conflicts("owner", event_payload())
    key = str(uuid.uuid4())

    def create(_):
        return ChronosStore(path).create_event(
            "owner", event_payload(allow_conflicts=True), idempotency_key=key
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(create, range(4)))
    assert all(result == results[0] for result in results)
    assert store.preview_conflicts("owner", event_payload()) == [results[0]["event"]]


def test_user_purge_removes_events_and_private_replay_results_only_for_owner(tmp_path):
    store = ChronosStore(tmp_path / "purge.sqlite3")
    owner = "' OR 1=1 --"
    key = str(uuid.uuid4())
    owner_payload = event_payload(notes="private-owner-note-purge-marker")
    owner_result = store.create_event(owner, owner_payload, idempotency_key=key)
    # Deleted events still have private notes in their saved replay response.
    store.delete_event(owner, owner_result["event"]["id"], revision=1)
    store.create_event(owner, event_payload(
        notes="private-owner-note-purge-marker", allow_conflicts=True,
    ))
    other_payload = event_payload(notes="private-other-note-preserved-marker")
    other = store.create_event("other", other_payload, idempotency_key=key)
    assert store.count_user_events(owner) == 1
    assert store.count_user_events("other") == 1
    assert store.count_user_events("absent") == 0

    assert store.delete_user_data(owner) == {"events": 1, "idempotency": 1}
    assert store.count_user_events(owner) == 0
    assert store.count_user_events("other") == 1
    assert store.delete_user_data(owner) == {"events": 0, "idempotency": 0}
    assert store.get_event("other", other["event"]["id"]) == other["event"]
    assert ChronosStore(store.path).create_event(
        "other", other_payload, idempotency_key=key
    ) == other
    assert b"private-owner-note-purge-marker" not in store.path.read_bytes()

    new = store.create_event(owner, owner_payload, idempotency_key=key)
    assert new["event"]["id"] != owner_result["event"]["id"]


@pytest.mark.parametrize("use_default_path", [False, True])
def test_user_count_and_purge_do_not_create_missing_database(tmp_path, monkeypatch, use_default_path):
    path = tmp_path / "missing-parent" / "chronos.sqlite3"
    if use_default_path:
        monkeypatch.setattr("chronos_store.runtime_paths.data_file", lambda name: path)
        store = ChronosStore()
    else:
        store = ChronosStore(path)
    assert store.path == path
    assert store.count_user_events("owner") == 0
    assert store.delete_user_data("owner") == {"events": 0, "idempotency": 0}
    assert not path.exists()
    assert not path.parent.exists()


def test_user_purge_rolls_back_both_tables_on_storage_failure(tmp_path):
    store = ChronosStore(tmp_path / "purge-rollback.sqlite3")
    key = str(uuid.uuid4())
    original = store.create_event("owner", event_payload(), idempotency_key=key)
    with store._connection() as connection:
        connection.execute(
            "CREATE TRIGGER fail_purge BEFORE DELETE ON chronos_create_requests "
            "BEGIN SELECT RAISE(ABORT, 'simulated purge failure'); END"
        )
    with pytest.raises(sqlite3.IntegrityError):
        store.delete_user_data("owner")
    assert store.count_user_events("owner") == 1
    assert store.create_event("owner", event_payload(), idempotency_key=key) == original

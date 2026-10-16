"""User-scoped SQLite storage and shared Chronos event validation.

Create, update and preview accept Python or JSON dictionaries. Conflict previews
cover the entire interval and return every matching event (no truncation).
Previews are advisory: writes always recheck conflicts inside their transaction.
Pass expected_conflicts to require an unchanged set of conflict IDs/revisions
at confirmation time; None preserves ordinary CRUD overlap behavior.
Create accepts an optional UUID idempotency key. Successful results are persisted
per user and replayed verbatim, even after later event changes or deletion.
Fingerprints use validated fields with UTC-normalized times; conflict snapshots
are preconditions for the first write, not part of the event payload fingerprint.
Account purge deletes events and saved create responses in one transaction.
Count and purge return zero without opening an absent database; path is a Path.
"""

import hashlib
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Annotated, Generator
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)

import runtime_paths


_MAX_EVENTS_PER_DAY = 500
_EVENT_COLUMNS = (
    "id, user_id, title, start, end, timezone, notes, revision, created_at, updated_at"
)


class EventIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Annotated[
        str, StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=160)
    ]
    start: datetime
    end: datetime
    timezone: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=100)]
    notes: Annotated[
        str, StringConstraints(strict=True, strip_whitespace=True, max_length=2000)
    ] = ""
    allow_conflicts: StrictBool = False

    @field_validator("start", "end", mode="before")
    @classmethod
    def require_datetime(cls, value):
        if not isinstance(value, (datetime, str)):
            raise ValueError("A datetime with a UTC offset is required.")
        if isinstance(value, str):
            try:
                value = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as error:
                raise ValueError("A valid ISO datetime is required.") from error
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Naive datetimes are not allowed.")
        return value

    @field_validator("timezone")
    @classmethod
    def require_iana_timezone(cls, value):
        try:
            ZoneInfo(value)
        except (ValueError, ZoneInfoNotFoundError) as error:
            raise ValueError("A valid IANA timezone is required.") from error
        return value

    @model_validator(mode="after")
    def validate_interval_and_offsets(self):
        duration = self.end.astimezone(timezone.utc) - self.start.astimezone(timezone.utc)
        if duration <= timedelta(0):
            raise ValueError("Event end must be after event start.")
        if duration > timedelta(days=31):
            raise ValueError("Event duration cannot exceed 31 days.")
        zone = ZoneInfo(self.timezone)
        if self.start.utcoffset() != self.start.astimezone(zone).utcoffset():
            raise ValueError("Start offset does not match the event timezone.")
        if self.end.utcoffset() != self.end.astimezone(zone).utcoffset():
            raise ValueError("End offset does not match the event timezone.")
        return self


class EventUpdateIn(EventIn):
    revision: StrictInt = Field(ge=1)


class ChronosStore:
    def __init__(self, path: str | Path | None = None):
        self.path = Path(path) if path is not None else runtime_paths.data_file("chronos.sqlite3")

    @contextmanager
    def _connection(self) -> Generator[sqlite3.Connection, None, None]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(self.path), timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS chronos_events (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    start TEXT NOT NULL,
                    end TEXT NOT NULL,
                    timezone TEXT NOT NULL,
                    notes TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK (revision >= 1),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_chronos_events_user_start "
                "ON chronos_events(user_id, start)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS chronos_create_requests ("
                "user_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, "
                "result TEXT NOT NULL, PRIMARY KEY (user_id, key))"
            )
            yield connection
        finally:
            connection.close()

    @contextmanager
    def _write_transaction(self) -> Generator[sqlite3.Connection, None, None]:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    @staticmethod
    def _utc_iso(value: datetime) -> str:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Chronos timestamps must include a UTC offset.")
        return value.astimezone(timezone.utc).isoformat(timespec="microseconds")

    @staticmethod
    def _event(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "title": row["title"],
            "start": row["start"],
            "end": row["end"],
            "timezone": row["timezone"],
            "notes": row["notes"],
            "revision": row["revision"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _validate_payload(payload: dict, *, update: bool = False) -> dict:
        model = EventUpdateIn if update else EventIn
        try:
            return model.model_validate(payload).model_dump()
        except ValidationError as error:
            raise HTTPException(
                status_code=422,
                detail=error.errors(
                    include_input=False, include_context=False, include_url=False
                ),
            ) from error

    @staticmethod
    def _payload_values(payload: dict) -> tuple[str, str, str, str, str]:
        return (
            payload["title"],
            ChronosStore._utc_iso(payload["start"]),
            ChronosStore._utc_iso(payload["end"]),
            payload["timezone"],
            payload["notes"],
        )

    @staticmethod
    def _idempotency_key(value: str | None) -> str | None:
        if value is None:
            return None
        message = "Idempotency-Key must be a hyphenated UUID string (36 characters)."
        if not isinstance(value, str) or len(value) != 36:
            raise HTTPException(status_code=422, detail=message)
        try:
            normalized = str(uuid.UUID(value))
        except ValueError as error:
            raise HTTPException(status_code=422, detail=message) from error
        if normalized != value.lower():
            raise HTTPException(status_code=422, detail=message)
        return normalized

    @staticmethod
    def _conflicts(
        connection: sqlite3.Connection,
        user_id: str,
        start: str,
        end: str,
        exclude_event_id: str | None = None,
    ) -> list[dict]:
        query = (
            f"SELECT {_EVENT_COLUMNS} FROM chronos_events "
            "WHERE user_id = ? AND start < ? AND end > ?"
        )
        parameters: list[str] = [user_id, end, start]
        if exclude_event_id is not None:
            query += " AND id != ?"
            parameters.append(exclude_event_id)
        query += " ORDER BY start, id"
        rows = connection.execute(query, parameters).fetchall()
        return [ChronosStore._event(row) for row in rows]

    @staticmethod
    def _revision_error(current_revision: int) -> HTTPException:
        return HTTPException(
            status_code=409,
            detail={
                "message": "Event revision is stale.",
                "current_revision": current_revision,
            },
        )

    @staticmethod
    def _conflict_snapshot(expected_conflicts: list[dict] | None) -> dict[str, int] | None:
        if expected_conflicts is None:
            return None
        if not isinstance(expected_conflicts, list):
            raise HTTPException(status_code=422, detail="Invalid expected conflict snapshot.")
        snapshot: dict[str, int] = {}
        for event in expected_conflicts:
            if not isinstance(event, dict):
                raise HTTPException(status_code=422, detail="Invalid expected conflict snapshot.")
            event_id, revision = event.get("id"), event.get("revision")
            if (
                not isinstance(event_id, str)
                or not event_id
                or type(revision) is not int
                or revision < 1
                or event_id in snapshot
            ):
                raise HTTPException(status_code=422, detail="Invalid expected conflict snapshot.")
            snapshot[event_id] = revision
        return snapshot

    @staticmethod
    def _check_conflict_snapshot(
        conflicts: list[dict], expected: dict[str, int] | None
    ) -> None:
        if expected is not None and {
            event["id"]: event["revision"] for event in conflicts
        } != expected:
            raise HTTPException(
                status_code=409,
                detail={
                    "message": "Conflicts changed since the proposal. Review and confirm again.",
                    "conflicts": conflicts,
                },
            )

    def preview_conflicts(
        self, user_id: str, payload: dict, exclude_id: str | None = None
    ) -> list[dict]:
        """Return all overlaps, scoped to the user, without reserving or writing an event.

        Accepts EventIn or EventUpdateIn dictionaries; exclude_id omits the event
        being replaced. Touching edges do not overlap. Results are never capped
        by the daily listing limit, including on later days of the interval.
        """
        payload = self._validate_payload(payload, update="revision" in payload)
        _, start, end, _, _ = self._payload_values(payload)
        with self._connection() as connection:
            return self._conflicts(connection, user_id, start, end, exclude_id)

    def list_events(self, user_id: str, on: date, timezone_name: str) -> dict:
        zone = ZoneInfo(timezone_name)
        day_start = datetime.combine(on, time.min, tzinfo=zone).astimezone(timezone.utc)
        day_end = datetime.combine(
            on + timedelta(days=1), time.min, tzinfo=zone
        ).astimezone(timezone.utc)
        start = self._utc_iso(day_start)
        end = self._utc_iso(day_end)
        with self._connection() as connection:
            rows = connection.execute(
                f"SELECT {_EVENT_COLUMNS} FROM chronos_events "
                "WHERE user_id = ? AND start < ? AND end > ? "
                "ORDER BY start, id LIMIT ?",
                (user_id, end, start, _MAX_EVENTS_PER_DAY + 1),
            ).fetchall()
        return {
            "events": [self._event(row) for row in rows[:_MAX_EVENTS_PER_DAY]],
            "truncated": len(rows) > _MAX_EVENTS_PER_DAY,
            "timezone": timezone_name,
            "date": on.isoformat(),
        }

    def get_event(self, user_id: str, event_id: str) -> dict:
        with self._connection() as connection:
            row = connection.execute(
                f"SELECT {_EVENT_COLUMNS} FROM chronos_events "
                "WHERE user_id = ? AND id = ?",
                (user_id, event_id),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Event not found.")
        return self._event(row)

    def create_event(
        self,
        user_id: str,
        payload: dict,
        *,
        expected_conflicts: list[dict] | None = None,
        idempotency_key: str | None = None,
    ) -> dict:
        payload = self._validate_payload(payload)
        expected = self._conflict_snapshot(expected_conflicts)
        key = self._idempotency_key(idempotency_key)
        title, start, end, timezone_name, notes = self._payload_values(payload)
        fingerprint = None
        if key is not None:
            canonical_payload = {**payload, "start": start, "end": end}
            fingerprint = hashlib.sha256(json.dumps(
                canonical_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True
            ).encode("utf-8")).hexdigest()
        event_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        allow_conflicts = payload.get("allow_conflicts", False)
        with self._write_transaction() as connection:
            if key is not None:
                previous = connection.execute(
                    "SELECT fingerprint, result FROM chronos_create_requests "
                    "WHERE user_id = ? AND key = ?",
                    (user_id, key),
                ).fetchone()
                if previous is not None:
                    if previous["fingerprint"] != fingerprint:
                        raise HTTPException(
                            status_code=409,
                            detail="Idempotency-Key was already used with a different payload.",
                        )
                    return json.loads(previous["result"])
            conflicts = self._conflicts(connection, user_id, start, end)
            self._check_conflict_snapshot(conflicts, expected)
            if conflicts and not allow_conflicts:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "Event overlaps existing events.",
                        "conflicts": conflicts,
                    },
                )
            connection.execute(
                "INSERT INTO chronos_events "
                "(id, user_id, title, start, end, timezone, notes, revision, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
                (event_id, user_id, title, start, end, timezone_name, notes, now, now),
            )
            row = connection.execute(
                f"SELECT {_EVENT_COLUMNS} FROM chronos_events "
                "WHERE user_id = ? AND id = ?",
                (user_id, event_id),
            ).fetchone()
            result = {"event": self._event(row), "conflicts": conflicts}
            if key is not None:
                connection.execute(
                    "INSERT INTO chronos_create_requests (user_id, key, fingerprint, result) "
                    "VALUES (?, ?, ?, ?)",
                    (user_id, key, fingerprint, json.dumps(result, ensure_ascii=True)),
                )
        return result

    def update_event(
        self,
        user_id: str,
        event_id: str,
        payload: dict,
        *,
        expected_conflicts: list[dict] | None = None,
    ) -> dict:
        payload = self._validate_payload(payload, update=True)
        expected = self._conflict_snapshot(expected_conflicts)
        title, start, end, timezone_name, notes = self._payload_values(payload)
        expected_revision = payload["revision"]
        allow_conflicts = payload.get("allow_conflicts", False)
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        with self._write_transaction() as connection:
            existing = connection.execute(
                f"SELECT {_EVENT_COLUMNS} FROM chronos_events "
                "WHERE user_id = ? AND id = ?",
                (user_id, event_id),
            ).fetchone()
            if existing is None:
                raise HTTPException(status_code=404, detail="Event not found.")
            if existing["revision"] != expected_revision:
                raise self._revision_error(existing["revision"])
            conflicts = self._conflicts(
                connection, user_id, start, end, exclude_event_id=event_id
            )
            self._check_conflict_snapshot(conflicts, expected)
            if conflicts and not allow_conflicts:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "Event overlaps existing events.",
                        "conflicts": conflicts,
                    },
                )
            connection.execute(
                "UPDATE chronos_events SET title = ?, start = ?, end = ?, timezone = ?, "
                "notes = ?, revision = revision + 1, updated_at = ? "
                "WHERE user_id = ? AND id = ? AND revision = ?",
                (
                    title,
                    start,
                    end,
                    timezone_name,
                    notes,
                    now,
                    user_id,
                    event_id,
                    expected_revision,
                ),
            )
            row = connection.execute(
                f"SELECT {_EVENT_COLUMNS} FROM chronos_events "
                "WHERE user_id = ? AND id = ?",
                (user_id, event_id),
            ).fetchone()
        return {"event": self._event(row), "conflicts": conflicts}

    def count_user_events(self, user_id: str) -> int:
        """Count only this user's events without creating an absent database."""
        if not self.path.exists():
            return 0
        with self._connection() as connection:
            row = connection.execute(
                "SELECT COUNT(*) FROM chronos_events WHERE user_id = ?",
                (user_id,),
            ).fetchone()
        return row[0]

    def delete_user_data(self, user_id: str) -> dict:
        """Purge this user's events and replay results, returning deleted row counts."""
        if not self.path.exists():
            return {"events": 0, "idempotency": 0}
        with self._write_transaction() as connection:
            connection.execute("PRAGMA secure_delete = ON")
            events = connection.execute(
                "DELETE FROM chronos_events WHERE user_id = ?", (user_id,)
            ).rowcount
            idempotency = connection.execute(
                "DELETE FROM chronos_create_requests WHERE user_id = ?", (user_id,)
            ).rowcount
        return {"events": events, "idempotency": idempotency}

    def delete_event(self, user_id: str, event_id: str, revision: int) -> dict:
        with self._write_transaction() as connection:
            existing = connection.execute(
                "SELECT revision FROM chronos_events WHERE user_id = ? AND id = ?",
                (user_id, event_id),
            ).fetchone()
            if existing is None:
                raise HTTPException(status_code=404, detail="Event not found.")
            if existing["revision"] != revision:
                raise self._revision_error(existing["revision"])
            connection.execute(
                "DELETE FROM chronos_events WHERE user_id = ? AND id = ? AND revision = ?",
                (user_id, event_id, revision),
            )
        return {"deleted": True}

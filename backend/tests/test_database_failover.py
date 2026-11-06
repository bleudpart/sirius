import asyncio
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pymongo.errors import ServerSelectionTimeoutError

import auth_api
import server


ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.parametrize(
    "mode, guard, mongo_url, required",
    [
        ("", "1", "mongodb://remote.example/sirius", True),
        ("", "1", "", False),
        ("", "0", "mongodb://remote.example/sirius", False),
        ("mongo", "0", "", True),
        ("local", "1", "mongodb://remote.example/sirius", False),
    ],
)
def test_database_policy_is_explicit_and_preserves_local_mode(monkeypatch, mode, guard, mongo_url, required):
    monkeypatch.setattr(server, "_DB_MODE", mode)
    monkeypatch.setenv("SIRIUS_REQUIRE_CONFIGURED_MONGO", guard)
    monkeypatch.setenv("MONGO_URL", mongo_url)
    assert server._mongodb_required() is required


def test_cloud_outage_does_not_switch_to_empty_local_database_and_recovers(monkeypatch, caplog):
    monkeypatch.setattr(server, "_DB_MODE", "")
    monkeypatch.setenv("SIRIUS_REQUIRE_CONFIGURED_MONGO", "1")
    monkeypatch.setenv("MONGO_URL", "mongodb://test:secret@remote.example/sirius")
    monkeypatch.setattr(server, "mongo_url", "mongodb://test:secret@remote.example/sirius")
    ping = AsyncMock(side_effect=[ConnectionError("unavailable"), ConnectionError("unavailable"), {"ok": 1}])
    monkeypatch.setattr(server, "client", SimpleNamespace(admin=SimpleNamespace(command=ping)))
    switched = []
    monkeypatch.setattr(server, "db", SimpleNamespace(backend_name="mongodb", use=switched.append))
    monkeypatch.setattr(server, "LocalDocStore", lambda: pytest.fail("unexpected SQLite fallback"))

    asyncio.run(server._select_database_backend())
    assert not switched
    degraded = asyncio.run(server.health_check())
    assert degraded["status"] == "degraded"
    assert degraded["checks"]["database"] == "mongodb"
    assert degraded["checks"]["mongo"] == "down"
    assert degraded["checks"]["mongo_required"] is True
    assert "secret" not in caplog.text

    restored = asyncio.run(server.health_check())
    assert restored["status"] == "ok"
    assert restored["checks"]["mongo"] == "ok"
    assert restored["checks"]["mongo_required"] is True
    assert not switched


@pytest.mark.parametrize(
    "guard, mongo_url",
    [("0", "mongodb://remote.example/sirius"), ("1", "")],
)
def test_automatic_local_fallback_remains_available_when_not_protected(monkeypatch, guard, mongo_url):
    monkeypatch.setattr(server, "_DB_MODE", "")
    monkeypatch.setenv("SIRIUS_REQUIRE_CONFIGURED_MONGO", guard)
    monkeypatch.setenv("MONGO_URL", mongo_url)
    ping = AsyncMock(side_effect=ConnectionError("unavailable"))
    monkeypatch.setattr(server, "client", SimpleNamespace(admin=SimpleNamespace(command=ping)))
    sentinel = object()
    monkeypatch.setattr(server, "LocalDocStore", lambda: sentinel)
    switched = []
    monkeypatch.setattr(server, "db", SimpleNamespace(use=switched.append))

    asyncio.run(server._select_database_backend())
    assert switched == [sentinel]


def test_explicit_local_mode_does_not_try_mongodb(monkeypatch):
    monkeypatch.setattr(server, "_DB_MODE", "local")
    monkeypatch.setenv("SIRIUS_REQUIRE_CONFIGURED_MONGO", "1")
    monkeypatch.setenv("MONGO_URL", "mongodb://remote.example/sirius")
    ping = AsyncMock()
    monkeypatch.setattr(server, "client", SimpleNamespace(admin=SimpleNamespace(command=ping)))
    asyncio.run(server._select_database_backend())
    ping.assert_not_awaited()


def test_forced_mongodb_never_falls_back(monkeypatch):
    monkeypatch.setattr(server, "_DB_MODE", "mongo")
    monkeypatch.setenv("SIRIUS_REQUIRE_CONFIGURED_MONGO", "0")
    ping = AsyncMock(side_effect=ConnectionError("unavailable"))
    monkeypatch.setattr(server, "client", SimpleNamespace(admin=SimpleNamespace(command=ping)))
    monkeypatch.setattr(server, "LocalDocStore", lambda: pytest.fail("unexpected SQLite fallback"))
    asyncio.run(server._select_database_backend())


def test_real_registration_fails_explicitly_during_outage_then_uses_same_database(monkeypatch):
    class Users:
        online = False

        def __init__(self):
            self.documents = []

        async def find_one(self, _query):
            if not self.online:
                raise ServerSelectionTimeoutError("private connection details")
            return None

        async def insert_one(self, document):
            if not self.online:
                raise ServerSelectionTimeoutError("private connection details")
            self.documents.append(document)

    users = Users()
    router = server.db
    monkeypatch.setattr(router, "_backend", SimpleNamespace(users=users))
    monkeypatch.setattr(server, "_DB_MODE", "")
    monkeypatch.setenv("SIRIUS_REQUIRE_CONFIGURED_MONGO", "1")
    monkeypatch.setenv("MONGO_URL", "mongodb://remote.example/sirius")
    ping = AsyncMock(side_effect=ConnectionError("unavailable"))
    monkeypatch.setattr(server, "client", SimpleNamespace(admin=SimpleNamespace(command=ping)))
    monkeypatch.setattr(server, "LocalDocStore", lambda: pytest.fail("unexpected SQLite fallback"))
    monkeypatch.setattr(auth_api, "_issue_session", AsyncMock(return_value={"status": "registered"}))
    asyncio.run(server._select_database_backend())

    client = TestClient(server.app, raise_server_exceptions=False)
    payload = {"email": "cook@example.test", "password": "Test-password-123!", "name": "Cuisine"}

    unavailable = client.post("/api/auth/register", json=payload)
    assert unavailable.status_code == 503
    assert "temporairement indisponible" in unavailable.json()["detail"]
    assert "private connection details" not in unavailable.text
    assert users.documents == []

    users.online = True
    restored = client.post("/api/auth/register", json=payload)
    assert restored.status_code == 200
    assert len(users.documents) == 1
    assert router.backend_name == "mongodb"
    assert server.app.exception_handlers[server.ConnectionFailure] is server._mongo_unavailable


def test_setup_and_deployment_install_the_guard_without_editing_user_data():
    hetzner = ROOT / "deploy" / "hetzner"
    guard = (hetzner / "sirius-database.conf").read_text(encoding="utf-8")
    assert "Environment=SIRIUS_REQUIRE_CONFIGURED_MONGO=1" in guard
    for name in ("setup.sh", "deploy.sh"):
        script = (hetzner / name).read_text(encoding="utf-8")
        assert "sirius-database.conf" in script
        assert "90-sirius-managed-database.conf" in script
        assert script.index("sirius-database.conf") < script.index("systemctl daemon-reload")

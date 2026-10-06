import asyncio

import pytest
from fastapi import HTTPException

import usage_quota
from local_docstore import LocalDocStore


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.delenv("SIRIUS_PACKAGED", raising=False)
    monkeypatch.delenv("SIRIUS_QUOTA", raising=False)
    monkeypatch.setenv("SIRIUS_QUOTA_STT", "2")
    return LocalDocStore(str(tmp_path / "quota.db"))


USER = {"user_id": "user_quota", "role": "user"}


def test_quota_blocks_after_daily_limit_with_french_message(db):
    async def scenario():
        await usage_quota.consume(db, USER, "stt")
        await usage_quota.consume(db, USER, "stt")
        with pytest.raises(HTTPException) as error:
            await usage_quota.consume(db, USER, "stt")
        assert error.value.status_code == 429
        assert "micro" in error.value.detail
        summary = await usage_quota.usage_summary(db, USER)
        assert summary["usage"]["stt"] == 2
        assert summary["limits"]["stt"] == 2

    asyncio.run(scenario())


def test_admin_and_local_pc_are_never_limited(db, monkeypatch):
    async def scenario():
        for _ in range(5):
            await usage_quota.consume(db, {"user_id": "admin", "role": "admin"}, "stt")
        monkeypatch.setenv("SIRIUS_PACKAGED", "1")
        for _ in range(5):
            await usage_quota.consume(db, USER, "stt")
        assert await usage_quota.usage_summary(db, USER) == {"enabled": False}

    asyncio.run(scenario())


def test_invalid_limit_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "beaucoup")
    assert usage_quota.daily_limit("chat") == usage_quota.DEFAULT_LIMITS["chat"]

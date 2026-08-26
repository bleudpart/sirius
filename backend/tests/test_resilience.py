"""Tests unitaires de la couche de résilience (retry + disjoncteur)."""
import asyncio

import pytest
import requests

import resilience
from resilience import (
    CircuitOpenError,
    get_breaker,
    breakers_snapshot,
    resilient_call,
    resilient_call_sync,
)


@pytest.fixture(autouse=True)
def _isolated_breakers(monkeypatch):
    monkeypatch.setattr(resilience, "_breakers", {})


def test_retry_then_success():
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise ValueError("transitoire")
        return "ok"

    result = asyncio.run(
        resilient_call(flaky, service="svc-retry", attempts=3, base_delay=0.01)
    )
    assert result == "ok"
    assert calls["n"] == 3
    assert breakers_snapshot()["svc-retry"] == "closed"


def test_exhausted_attempts_raises_last_error():
    async def always_fails():
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        asyncio.run(
            resilient_call(always_fails, service="svc-fail", attempts=2, base_delay=0.01)
        )


def test_timeout_counts_as_failure():
    async def too_slow():
        await asyncio.sleep(1.0)

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(
            resilient_call(
                too_slow, service="svc-slow", attempts=1, timeout=0.05,
                retry_on=(asyncio.TimeoutError,),
            )
        )


def test_breaker_opens_and_short_circuits():
    async def always_fails():
        raise ValueError("boom")

    with pytest.raises(ValueError):
        asyncio.run(
            resilient_call(
                always_fails, service="svc-open", attempts=3, base_delay=0.01,
                failure_threshold=3, reset_timeout=60.0,
            )
        )
    assert breakers_snapshot()["svc-open"] == "open"

    async def never_called():
        raise AssertionError("ne doit pas être appelé : circuit ouvert")

    with pytest.raises(CircuitOpenError):
        asyncio.run(resilient_call(never_called, service="svc-open"))


def test_breaker_half_open_then_recovers():
    breaker = get_breaker("svc-recover", failure_threshold=1, reset_timeout=0.05)
    breaker.record_failure()
    assert not breaker.allow()

    import time
    time.sleep(0.06)
    assert breaker.allow()  # demi-ouvert : appel d'essai autorisé

    async def works():
        return 42

    result = asyncio.run(resilient_call(works, service="svc-recover"))
    assert result == 42
    assert breakers_snapshot()["svc-recover"] == "closed"


def test_sync_variant_retries_and_opens():
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] < 2:
            raise requests.ConnectionError("réseau")
        return {"ok": True}

    result = resilient_call_sync(
        flaky, service="svc-sync", attempts=3, base_delay=0.01,
        retry_on=(requests.RequestException,),
    )
    assert result == {"ok": True}
    assert calls["n"] == 2


def test_sync_circuit_open_raises_without_calling():
    def always_fails():
        raise requests.ConnectionError("down")

    with pytest.raises(requests.ConnectionError):
        resilient_call_sync(
            always_fails, service="svc-sync-open", attempts=2, base_delay=0.01,
            retry_on=(requests.RequestException,),
            failure_threshold=2, reset_timeout=60.0,
        )

    def never_called():
        raise AssertionError("ne doit pas être appelé")

    with pytest.raises(CircuitOpenError):
        resilient_call_sync(never_called, service="svc-sync-open")

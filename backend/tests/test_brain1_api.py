import asyncio

import httpx
import pytest
from fastapi import FastAPI

import server


@pytest.mark.parametrize("endpoint", ["/api/intent", "/api/chat"])
def test_identical_requests_share_only_the_active_execution(monkeypatch, endpoint):
    async def scenario():
        app = FastAPI()
        app.include_router(server.api_router)
        agent = server.tri_cortex.hermes if endpoint.endswith("/intent") else server.tri_cortex.iris
        started, joined, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        original_run = agent.guard.run
        calls = 0

        async def user(_request, _db):
            return {"user_id": "test-user", "role": "user", "company_id": "company"}

        async def operation():
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return {"value": calls}

        async def intent_reply(_req, _user):
            return await operation()

        async def chat_reply(_req, _request, _user):
            return await operation()

        async def observed_run(key, handler):
            if key in agent.guard._inflight:
                joined.set()
            return await original_run(key, handler)

        monkeypatch.setattr(server, "require_user", user)
        monkeypatch.setattr(server, "_rate_ok", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(server, "_intent_reply", intent_reply)
        monkeypatch.setattr(server, "_chat_reply", chat_reply)
        monkeypatch.setattr(agent.guard, "run", observed_run)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            body = {"text": "Bonjour"}
            first = asyncio.create_task(client.post(endpoint, json=body))
            await asyncio.wait_for(started.wait(), timeout=2)
            second = asyncio.create_task(client.post(endpoint, json=body))
            try:
                await asyncio.wait_for(joined.wait(), timeout=2)
            finally:
                release.set()
                responses = await asyncio.gather(first, second)
            assert [response.json() for response in responses] == [{"value": 1}, {"value": 1}]
            assert (await client.post(endpoint, json=body)).json() == {"value": 2}
        assert calls == 2

    asyncio.run(scenario())


@pytest.mark.parametrize("endpoint", ["/api/intent", "/api/chat"])
@pytest.mark.parametrize("field,changed", [
    ("company_id", "other-company"),
    ("role", "admin"),
    ("trial_started_at", "2026-02-01"),
])
def test_concurrent_requests_do_not_share_different_authorization_contexts(monkeypatch, endpoint, field, changed):
    async def scenario():
        app = FastAPI()
        app.include_router(server.api_router)
        first_started, second_started, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        base = {"user_id": "test-user", "role": "user", "company_id": "company", "trial_started_at": "2026-01-01"}

        async def user(request, _db):
            return {**base, **({field: changed} if request.headers["x-variant"] == "second" else {})}

        async def operation(account):
            (second_started if account[field] == changed else first_started).set()
            await release.wait()
            return {"value": account[field]}

        async def intent_reply(_req, account):
            return await operation(account)

        async def chat_reply(_req, _request, account):
            return await operation(account)

        monkeypatch.setattr(server, "require_user", user)
        monkeypatch.setattr(server, "_rate_ok", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(server, "_intent_reply", intent_reply)
        monkeypatch.setattr(server, "_chat_reply", chat_reply)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            body = {"text": "Bonjour"}
            first = asyncio.create_task(client.post(endpoint, json=body, headers={"x-variant": "first"}))
            await asyncio.wait_for(first_started.wait(), timeout=2)
            second = asyncio.create_task(client.post(endpoint, json=body, headers={"x-variant": "second"}))
            try:
                await asyncio.wait_for(second_started.wait(), timeout=2)
            finally:
                release.set()
                responses = await asyncio.gather(first, second)
            assert [response.json() for response in responses] == [{"value": base[field]}, {"value": changed}]

    asyncio.run(scenario())


@pytest.mark.parametrize("endpoint", ["/api/intent", "/api/chat"])
def test_concurrent_requests_with_different_provider_keys_do_not_share_execution(monkeypatch, endpoint):
    async def scenario():
        app = FastAPI()
        app.include_router(server.api_router)
        first_started, second_started, release = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def user(_request, _db):
            return {"user_id": "test-user", "role": "user", "company_id": "company"}

        async def operation(req):
            label = req.keys["groq_key"]
            (first_started if label == "first-key" else second_started).set()
            await release.wait()
            return {"value": label}

        async def intent_reply(req, _account):
            return await operation(req)

        async def chat_reply(req, _request, _account):
            return await operation(req)

        monkeypatch.setattr(server, "require_user", user)
        monkeypatch.setattr(server, "_rate_ok", lambda *_args, **_kwargs: True)
        monkeypatch.setattr(server, "_intent_reply", intent_reply)
        monkeypatch.setattr(server, "_chat_reply", chat_reply)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            first = asyncio.create_task(client.post(endpoint, json={"text": "Bonjour", "keys": {"groq_key": "first-key"}}))
            await asyncio.wait_for(first_started.wait(), timeout=2)
            second = asyncio.create_task(client.post(endpoint, json={"text": "Bonjour", "keys": {"groq_key": "second-key"}}))
            try:
                await asyncio.wait_for(second_started.wait(), timeout=2)
            finally:
                release.set()
                responses = await asyncio.gather(first, second)
            assert [response.json() for response in responses] == [{"value": "first-key"}, {"value": "second-key"}]

    asyncio.run(scenario())

import asyncio

import pytest

from tri_cortex.brain1_agents import HERMES, IRIS, Brain1Agent, RequestGuard, normalize_request
from tri_cortex.telemetry import EventBus, Telemetry


def make_agent(spec=IRIS, window=4):
    telemetry = Telemetry(EventBus())
    telemetry.states[spec.id] = "idle"
    return Brain1Agent(spec, telemetry, window=window), telemetry


def test_roles_are_exclusive_and_defined():
    assert HERMES.endpoints == ("/api/intent",)
    assert IRIS.endpoints == ("/api/chat", "/api/chat/stream")
    assert not set(HERMES.endpoints) & set(IRIS.endpoints)
    assert "sans converser" in HERMES.role
    assert "sans executer d'action" in IRIS.role


@pytest.mark.parametrize("left,right", [
    ("Zirius, ouvre Thémis !", "ouvre themis"),
    ("ΣIRIUS ouvre THÉMIS", "Ouvre Themis."),
    ("Dis Sirius, quelle heure est-il ?", "quelle heure est il"),
])
def test_normalization_merges_spoken_variants(left, right):
    assert normalize_request(left) == normalize_request(right)


def test_identical_requests_in_flight_share_one_execution():
    async def scenario():
        agent, telemetry = make_agent()
        calls = 0
        release = asyncio.Event()

        async def operation():
            nonlocal calls
            calls += 1
            await release.wait()
            return {"answer": "Bonjour"}

        key = agent.key("user:a", "dialogue", "Zirius, bonjour", "default")
        first = asyncio.create_task(agent.handle("user:a", "dialogue", key, operation))
        second = asyncio.create_task(agent.handle("user:a", "dialogue", key, operation))
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(first, second)
        frame = telemetry.frame(frozenset({"user:a"}))
        return calls, results, frame

    calls, results, frame = asyncio.run(scenario())
    assert calls == 1
    assert results == [{"answer": "Bonjour"}, {"answer": "Bonjour"}]
    iris = next(node for node in frame.brain1_agents if node.id == "iris")
    assert iris.parent == "brain_1"
    assert iris.completed == 1 and iris.duplicates_blocked == 1


def test_recent_result_is_reused_then_expires():
    async def scenario():
        guard = RequestGuard(window=0.05)
        calls = 0

        async def operation():
            nonlocal calls
            calls += 1
            return {"n": calls}

        first, dup1 = await guard.run("k", operation)
        second, dup2 = await guard.run("k", operation)
        second["n"] = 99
        await asyncio.sleep(0.08)
        third, dup3 = await guard.run("k", operation)
        return calls, first, dup1, dup2, third, dup3

    calls, first, dup1, dup2, third, dup3 = asyncio.run(scenario())
    assert calls == 2 and first == {"n": 1} and third == {"n": 2}
    assert (dup1, dup2, dup3) == (False, True, False)


def test_failure_is_not_cached_so_a_retry_runs_again():
    async def scenario():
        guard = RequestGuard(window=10)
        attempts = 0

        async def operation():
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise RuntimeError("fournisseur indisponible")
            return "ok"

        with pytest.raises(RuntimeError):
            await guard.run("k", operation)
        return await guard.run("k", operation), attempts

    (result, duplicate), attempts = asyncio.run(scenario())
    assert result == "ok" and not duplicate and attempts == 2


def test_different_users_options_or_agents_never_collide():
    iris, _ = make_agent(IRIS)
    hermes, _ = make_agent(HERMES)
    base = iris.key("user:a", "dialogue", "bonjour", "default", "normal", "jarvis")
    assert base != iris.key("user:b", "dialogue", "bonjour", "default", "normal", "jarvis")
    assert base != iris.key("user:a", "dialogue", "bonjour", "default", "normal", "profond")
    assert base != iris.key("user:a", "dialogue", "bonsoir", "default", "normal", "jarvis")
    assert base != hermes.key("user:a", "dialogue", "bonjour", "default", "normal", "jarvis")
    assert base != iris.key("user:a", "dialogue", "bonjour", {"profile": {"tone": "calme"}})
    assert iris.key("user:a", "dialogue", "bonjour", {"profile": {"tone": "calme"}}) != iris.key(
        "user:a", "dialogue", "bonjour", {"profile": {"tone": "direct"}},
    )


def test_stream_and_non_stream_share_the_same_duplicate_guard():
    async def scenario():
        agent, _ = make_agent(window=1)
        calls = 0

        async def operation():
            nonlocal calls
            calls += 1
            return {"answer": "Bonjour"}

        stream_key = agent.key("user:a", "dialogue", "bonjour en flux")
        assert agent.claim_stream("user:a", stream_key)
        ignored = await agent.handle("user:a", "dialogue", stream_key, operation)
        async for _ in agent.track_stream("user:a", stream_key, _source(['data: {"type": "done"}\n\n'])):
            pass
        assert not agent.claim_stream("user:a", stream_key)

        regular_key = agent.key("user:a", "dialogue", "bonjour normal")
        assert await agent.handle("user:a", "dialogue", regular_key, operation) == {"answer": "Bonjour"}
        assert not agent.claim_stream("user:a", regular_key)
        return ignored, calls

    ignored, calls = asyncio.run(scenario())
    assert ignored["ignored"] is True
    assert calls == 1


def test_stream_duplicate_is_refused_until_window_ends_and_failure_frees_it():
    async def consume(agent, key, chunks):
        return [chunk async for chunk in agent.track_stream("user:a", key, _source(chunks))]

    async def scenario():
        agent, telemetry = make_agent(window=0.05)
        key = agent.key("user:a", "dialogue", "bonjour")
        assert agent.claim_stream("user:a", key)
        assert not agent.claim_stream("user:a", key)
        await consume(agent, key, ['data: {"type": "done"}\n\n'])
        assert not agent.claim_stream("user:a", key)
        await asyncio.sleep(0.08)
        assert agent.claim_stream("user:a", key)
        await consume(agent, key, ['data: {"type": "error"}\n\n'])
        assert agent.claim_stream("user:a", key)
        return telemetry.frame(frozenset({"user:a"}))

    frame = asyncio.run(scenario())
    iris = next(node for node in frame.brain1_agents if node.id == "iris")
    assert iris.duplicates_blocked == 2


async def _source(chunks):
    for chunk in chunks:
        yield chunk


def test_frame_keeps_the_legacy_graph_contract():
    agent, telemetry = make_agent()
    telemetry.flow("user:a", "brain_1", "iris")
    frame = telemetry.frame(frozenset({"user:a"}))
    assert len(frame.nodes) == 3 and len(frame.satellites) == 4
    assert [node.id for node in frame.brain1_agents] == ["hermes", "iris"]
    assert all(edge.target != "iris" for edge in frame.edge_flows)

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import sirius_brain as brain


@pytest.fixture(autouse=True)
def isolated_providers(monkeypatch):
    monkeypatch.setattr(brain, "ENV_K3_KEY", "")
    monkeypatch.setattr(brain, "ENV_GROQ_LLM_KEY", "")
    monkeypatch.setattr(brain, "ENV_SERP_KEY", "")
    monkeypatch.setattr(brain, "_research_briefing_follow_up", AsyncMock(return_value=""))
    monkeypatch.setattr(brain, "_research_current_prices", AsyncMock(return_value=""))


class Stream:
    def __aiter__(self):
        return self.chunks()

    async def chunks(self):
        for text in ["La décision utile. ", "Son explication."]:
            yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])


def fake_provider(*, stream=False):
    completions = SimpleNamespace(create=AsyncMock(
        return_value=Stream() if stream else SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(
                content='{"reponse":"La décision utile.","memoire":[],"popups":[]}'
            ))]
        )
    ))
    provider = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    provider.with_options = lambda **kwargs: provider
    return provider, completions.create


@pytest.mark.parametrize("stream", [False, True])
def test_reflection_and_research_start_together(monkeypatch, stream):
    provider, create = fake_provider(stream=stream)
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: provider)

    async def run():
        reflection_started = asyncio.Event()
        research_started = asyncio.Event()

        async def reflect(*args, **kwargs):
            reflection_started.set()
            await asyncio.wait_for(research_started.wait(), 0.5)
            return "Comparer les risques avant de décider."

        async def research(*args, **kwargs):
            research_started.set()
            await asyncio.wait_for(reflection_started.wait(), 0.5)
            return ""

        monkeypatch.setattr(brain, "_kimi_reflect", reflect)
        monkeypatch.setattr(brain, "_research_briefing_follow_up", research)
        kwargs = dict(mode="profond", keys={"k3": "fake-kimi", "groq_key": "fake-groq"})
        if stream:
            return "".join([part async for part in brain.ask_sirius_stream("Analyse cette décision", **kwargs)])
        return (await brain.ask_sirius("Analyse cette décision", **kwargs))["reponse"]

    assert "décision utile" in asyncio.run(run())
    assert "Comparer les risques" in create.call_args.kwargs["messages"][0]["content"]


def test_stream_kimi_fallback_does_not_restart_groq_or_research(monkeypatch):
    provider, create = fake_provider(stream=True)
    monkeypatch.setattr(brain, "k3_client", lambda key: provider)
    restart = AsyncMock(side_effect=AssertionError("The HTTP path must not be restarted"))
    monkeypatch.setattr(brain, "ask_sirius", restart)

    async def run():
        return "".join([part async for part in brain.ask_sirius_stream(
            "Explique cette décision", keys={"k3": "fake-kimi"}
        )])

    assert asyncio.run(run()) == "La décision utile. Son explication."
    restart.assert_not_called()
    assert create.call_args.kwargs["stream"] is True
    brain._research_briefing_follow_up.assert_awaited_once()
    brain._research_current_prices.assert_awaited_once()


def test_reflection_uses_history_and_has_a_bounded_wait_without_retries(monkeypatch, caplog):
    provider, create = fake_provider()
    options = []
    provider.with_options = lambda **kwargs: options.append(kwargs) or provider
    monkeypatch.setattr(brain, "k3_client", lambda key: provider)
    monkeypatch.setattr(brain, "KIMI_REFLECTION_TIMEOUT", 0.02)

    async def slow(**kwargs):
        await asyncio.Event().wait()

    create.side_effect = slow
    answer = asyncio.run(brain._kimi_reflect(
        "Et pour le second choix ?", key="fake-kimi",
        history=[{"role": "assistant", "content": "Deux choix : A et B."}],
    ))
    assert answer == ""
    assert "Kimi indisponible" in caplog.text
    assert options == [{"max_retries": 0}]
    payload = create.call_args.kwargs
    assert payload["timeout"] == 0.02
    assert payload["max_tokens"] == 700
    assert payload["messages"][1]["content"] == "Deux choix : A et B."
    assert "Compare les options utiles" in payload["messages"][0]["content"]


@pytest.mark.parametrize("stream", [False, True])
def test_normal_mode_improves_answer_guidance_without_an_extra_reflection_call(monkeypatch, stream):
    provider, create = fake_provider(stream=stream)
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: provider)
    reflect = AsyncMock(side_effect=AssertionError("No extra reflection in normal mode"))
    monkeypatch.setattr(brain, "_kimi_reflect", reflect)

    async def run():
        kwargs = dict(keys={"groq_key": "fake-groq", "k3": "fake-kimi"})
        if stream:
            return [part async for part in brain.ask_sirius_stream("Explique cette décision", **kwargs)]
        return await brain.ask_sirius("Explique cette décision", **kwargs)

    asyncio.run(run())
    reflect.assert_not_called()
    payload = create.call_args.kwargs
    assert "Commence par une phrase courte" in payload["messages"][0]["content"]
    assert "Distingue les faits des hypothèses" in payload["messages"][0]["content"]
    assert payload["max_tokens"] == 1200
    assert payload["extra_body"] == {"reasoning_effort": "low"}


def test_partial_stream_failure_never_appends_another_model_answer(monkeypatch):
    class InterruptedStream:
        def __aiter__(self):
            return self.chunks()

        async def chunks(self):
            yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Début de réponse."))])
            raise RuntimeError("Connection lost")

    provider, create = fake_provider(stream=True)
    create.return_value = InterruptedStream()
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: provider)
    parts = []

    async def run():
        async for part in brain.ask_sirius_stream("Explique cette décision", keys={"groq_key": "fake-groq"}):
            parts.append(part)

    with pytest.raises(RuntimeError, match="Connection lost"):
        asyncio.run(run())
    assert parts == ["Début de réponse."]
    create.assert_awaited_once()


def test_groq_success_does_not_initialize_the_unused_kimi_fallback(monkeypatch):
    provider, create = fake_provider(stream=True)
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: provider)
    kimi = AsyncMock(side_effect=AssertionError("Unused fallback"))
    monkeypatch.setattr(brain, "k3_client", kimi)

    async def run():
        return [part async for part in brain.ask_sirius_stream(
            "Explique cette décision", keys={"groq_key": "fake-groq", "k3": "fake-kimi"}
        )]

    assert asyncio.run(run()) == ["La décision utile. ", "Son explication."]
    create.assert_awaited_once()
    kimi.assert_not_called()


def test_empty_groq_stream_tries_kimi_once(monkeypatch, caplog):
    class EmptyStream:
        def __aiter__(self):
            return self.chunks()

        async def chunks(self):
            yield SimpleNamespace(choices=[])

    groq, create = fake_provider(stream=True)
    create.return_value = EmptyStream()
    kimi, kimi_create = fake_provider(stream=True)
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: groq)
    monkeypatch.setattr(brain, "k3_client", lambda key: kimi)

    async def run():
        return [part async for part in brain.ask_sirius_stream(
            "Explique cette décision", mode="turbo",
            keys={"groq_key": "fake-groq", "k3": "fake-kimi"},
        )]

    assert asyncio.run(run()) == ["La décision utile. ", "Son explication."]
    create.assert_awaited_once()
    kimi_create.assert_awaited_once()
    assert "sans texte" in caplog.text

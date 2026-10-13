import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import sirius_brain as brain


@pytest.fixture(autouse=True)
def isolated_providers(monkeypatch):
    monkeypatch.setattr(brain, "ENV_CEREBRAS_KEY", "")
    brain._cerebras_clients.clear()
    monkeypatch.setattr(brain, "ENV_K3_KEY", "")
    monkeypatch.setattr(brain, "ENV_GROQ_LLM_KEY", "")
    monkeypatch.setattr(brain, "ENV_SERP_KEY", "")
    monkeypatch.setattr(brain, "_research_briefing_follow_up", AsyncMock(return_value=""))
    monkeypatch.setattr(brain, "_research_current_prices", AsyncMock(return_value=""))


@pytest.mark.parametrize("stream", [False, True])
def test_cerebras_answers_while_kimi_keeps_deep_reflection(monkeypatch, stream):
    provider, create = fake_provider(stream=stream)
    clients = []
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: clients.append(kwargs) or provider)
    reflection = AsyncMock(return_value="Notes privées de réflexion.")
    monkeypatch.setattr(brain, "_kimi_reflect", reflection)

    async def run():
        kwargs = {"mode": "profond", "keys": {"cerebras": "fake-cerebras", "k3": "fake-kimi"}}
        if stream:
            return "".join([part async for part in brain.ask_sirius_stream("Explique cette décision", **kwargs)])
        return (await brain.ask_sirius("Explique cette décision", **kwargs))["reponse"]

    assert "décision utile" in asyncio.run(run())
    assert clients[0]["base_url"] == "https://api.cerebras.ai/v1"
    assert clients[0]["api_key"] == "fake-cerebras"
    payload = create.call_args.kwargs
    assert payload["model"] == "gpt-oss-120b"
    assert payload["extra_body"] == {"reasoning_effort": "low", "reasoning_format": "hidden"}
    assert "presence_penalty" not in payload
    assert "max_tokens" not in payload
    assert payload["max_completion_tokens"] == 3248
    assert "Notes privées de réflexion" in payload["messages"][0]["content"]
    assert reflection.call_args.args[5] == "fake-kimi"


def test_personal_groq_is_not_replaced_by_owner_cerebras(monkeypatch):
    monkeypatch.setattr(brain, "ENV_CEREBRAS_KEY", "owner-cerebras")
    service, key, endpoint, _ = brain.fast_provider({"groq_key": "personal-groq"})
    assert (service, key, endpoint) == ("groq", "personal-groq", brain.GROQ_LLM_ENDPOINT)


def test_cerebras_clients_reuse_transport_without_sharing_credentials(monkeypatch):
    transport = SimpleNamespace(is_closed=False)
    monkeypatch.setattr(brain, "_cerebras_transport", transport)
    created = []
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: created.append(kwargs) or SimpleNamespace())
    first = brain.fast_client("cerebras", "personal-one")
    second = brain.fast_client("cerebras", "personal-two")
    assert first is brain.fast_client("cerebras", "personal-one")
    assert second is not first
    assert [item["api_key"] for item in created] == ["personal-one", "personal-two"]
    assert all(item["http_client"] is transport for item in created)


def test_cerebras_warmup_does_not_send_credentials_or_generate_text(monkeypatch):
    transport = SimpleNamespace(is_closed=False, head=AsyncMock())
    monkeypatch.setattr(brain, "_cerebras_transport", transport)
    prepare = AsyncMock()
    monkeypatch.setattr(brain.asyncio, "to_thread", prepare)
    asyncio.run(brain.warm_cerebras_connection())
    prepare.assert_awaited_once_with(brain.importlib.import_module, "openai.resources.chat.completions")
    transport.head.assert_awaited_once_with(f"{brain.CEREBRAS_ENDPOINT}/models", timeout=4.0)


def test_cerebras_transport_keeps_idle_connections_and_closes_on_shutdown(monkeypatch):
    transport = SimpleNamespace(is_closed=False, aclose=AsyncMock())
    options = []
    monkeypatch.setattr(brain, "_cerebras_transport", None)
    monkeypatch.setattr(brain, "DefaultAsyncHttpxClient", lambda **kwargs: options.append(kwargs) or transport)
    assert brain.cerebras_transport() is brain.cerebras_transport()
    assert options[0]["limits"].keepalive_expiry == 120
    asyncio.run(brain.close_cerebras_connections())
    transport.aclose.assert_awaited_once()
    assert brain._cerebras_transport is None
    assert not brain._cerebras_clients


def test_cerebras_warmup_offline_is_logged_without_blocking_chat(monkeypatch, caplog):
    import httpx
    transport = SimpleNamespace(is_closed=False, head=AsyncMock(side_effect=httpx.ConnectError("offline")))
    monkeypatch.setattr(brain, "_cerebras_transport", transport)
    monkeypatch.setattr(brain.asyncio, "to_thread", AsyncMock())
    with caplog.at_level("INFO"):
        asyncio.run(brain.warm_cerebras_connection())
    assert "Préchauffage Cerebras indisponible : ConnectError" in caplog.text


@pytest.mark.parametrize("tokens", [64, 200, 512, 1000, 1200, 2600])
def test_cerebras_reserves_reasoning_budget_without_changing_groq(tokens):
    assert brain.fast_options("cerebras", tokens)["max_completion_tokens"] == tokens + 2048
    assert brain.fast_options("groq", tokens)["max_tokens"] == tokens


def test_cerebras_owner_key_respects_expired_trial(monkeypatch):
    from provider_access import provider_scope
    monkeypatch.setattr(brain, "ENV_CEREBRAS_KEY", "owner-cerebras")
    with provider_scope({"role": "user"}, {}):
        assert brain.fast_provider()[1] == ""
    with provider_scope({"role": "user"}, {"cerebras": "personal-cerebras"}):
        assert brain.fast_provider()[1] == "personal-cerebras"


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
def test_news_answers_have_detail_guidance_and_larger_budget(monkeypatch, stream):
    provider, create = fake_provider(stream=stream)
    monkeypatch.setattr(brain, "AsyncOpenAI", lambda **kwargs: provider)

    async def run():
        kwargs = {"keys": {"groq_key": "fake-groq"}}
        if stream:
            return "".join([part async for part in brain.ask_sirius_stream("Explique les actualités du jour", **kwargs)])
        return await brain.ask_sirius("Explique les actualités du jour", **kwargs)

    asyncio.run(run())
    payload = create.call_args.kwargs
    assert payload["max_tokens"] == 2200
    assert "250 à 450 mots" in payload["messages"][0]["content"]
    assert "sans les mélanger" in payload["messages"][0]["content"]
    assert "aucune source récente" in payload["messages"][0]["content"]


def test_news_depth_does_not_force_a_long_answer_after_a_pause():
    assert brain._is_news_request("Explique les conséquences\nCONTEXTE DU DERNIER BRIEFING :\nActualités")
    assert not brain._is_news_request("Merci\nCONTEXTE DU DERNIER BRIEFING :\nActualités")
    assert not brain._is_news_request("Bonjour")


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

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from sirius_brain import (
    _targeted_answer_guidance,
    _answer_from_research,
    _finalize_targeted_answer,
    _research_current_prices,
    ask_sirius,
    ask_sirius_stream,
    is_current_price_question,
    is_targeted_factual_question,
)


@pytest.mark.parametrize("question", [
    "prix d'un au kg de faux-filet",
    "Combien coûte un kilo de faux-filet ?",
])
def test_food_price_questions_are_recognized_for_live_lookup(question):
    assert is_current_price_question(question)
    assert is_targeted_factual_question(question)


@pytest.mark.parametrize("question", [
    "Quelle est la capitale de l'Islande ?",
    "Qui est le président actuel de la Commission européenne ?",
    "Quel est le dernier cours de Nvidia ?",
])
def test_other_targeted_factual_questions_are_also_researched(question):
    assert is_targeted_factual_question(question)


def test_product_price_without_explicit_measure_is_still_researched():
    assert is_current_price_question("prix du dernier iPhone 17")
    assert is_targeted_factual_question("prix du dernier iPhone 17")
    assert is_targeted_factual_question("prix iPhone")
    assert not is_current_price_question("combien d'habitants en Islande")
    assert is_targeted_factual_question("combien d'habitants en Islande")


@pytest.mark.parametrize("question", [
    "météo Paris demain",
    "horaires d'ouverture du musée aujourd'hui",
    "taux de change euro dollar actuel",
])
def test_short_current_world_questions_are_researched(question):
    assert is_targeted_factual_question(question)


@pytest.mark.parametrize("question", [
    "Bonjour Sirius",
    "Qui suis-je ?",
    "Calcule 17 fois 24",
    "Écris un message de remerciement à mon équipe",
])
def test_simple_local_or_personal_requests_do_not_trigger_web_lookup(question):
    assert not is_targeted_factual_question(question)


def test_food_price_lookup_builds_french_unit_query_and_returns_sources(monkeypatch):
    import webagent

    search = AsyncMock(return_value=[
        {
            "title": "Prix du faux-filet au kilo",
            "source": "Boucherie Exemple",
            "link": "https://example.test/faux-filet",
            "snippet": "Faux-filet origine France : 34,90 €/kg.",
        },
        {
            "title": "Filet de bœuf en promotion",
            "source": "Supermarché voisin",
            "link": "https://example.test/filet-boeuf",
            "snippet": "Filet de bœuf entier : 26,65 €.",
        },
        {
            "title": "Colis de viande de 5 kg",
            "source": "Catalogue",
            "link": "https://example.test/colis",
            "snippet": "Assortiment de viande : 25,00 € le colis.",
        },
        {
            "title": "Promotions boucherie cette semaine",
            "source": "Réseau social",
            "link": "https://example.test/listes",
            "snippet": "Onglet de bœuf 21,95 €/kg, hampe 16,95 €/kg, faux-filet : quelle pièce préférez-vous ?",
        },
    ])
    monkeypatch.setattr(webagent, "serp_results", search)

    context = asyncio.run(_research_current_prices("prix d'un au kg de faux-filet", "test-serp-key"))

    query = search.await_args.args[0]
    assert "faux-filet" in query
    assert "au kg" in query
    assert "France" in query
    assert "supermarché boucherie" in query
    assert "34,90 €/kg" in context
    assert "https://example.test/faux-filet" in context
    assert "filet-boeuf" not in context
    assert "colis" not in context
    assert "listes" not in context


def test_price_guidance_requires_direct_answer_and_prevents_search_deflection():
    sourced = _targeted_answer_guidance("- Boucherie | https://example.test\n  34,90 €/kg")
    unsourced = _targeted_answer_guidance("")

    assert "fourchette" in sourced
    assert "N'invente aucun fait" in sourced
    assert "ne renvoie jamais l'utilisateur faire la recherche lui-même" in sourced
    assert "fournis une fourchette indicative" in unsourced
    assert "ne demande pas à l'utilisateur d'aller chercher" in unsourced


def test_deflecting_faux_filet_answer_is_replaced_with_sourced_per_kilo_range():
    sources = (
        "- Faux-filet Carrefour | Carrefour (https://carrefour.example/faux-filet)\n"
        "  Faux-filet à griller : 32.99 € / KG.\n"
        "- Faux-filet maturé | RadarSuper (https://radar.example/faux-filet)\n"
        "  Faux-filet maturé : 24,91 €/kg."
    )

    answer = _finalize_targeted_answer(
        "prix d'un au kg de faux-filet",
        "Je vous conseille de contacter un revendeur pour connaître le tarif exact.",
        sources,
    )

    assert "entre 24,91 et 32,99 €/kg" in answer
    assert "carrefour.example/faux-filet" in answer
    assert "radar.example/faux-filet" in answer
    assert "contacter un revendeur" not in answer


def test_other_targeted_deflection_is_replaced_by_search_extracts():
    sources = "- Site météo (https://meteo.example)\n  Demain à Paris : 18 °C et faible risque de pluie."

    answer = _finalize_targeted_answer(
        "météo Paris demain",
        "Pour des informations précises, consultez un site météo.",
        sources,
    )

    assert "18 °C" in answer
    assert "https://meteo.example" in answer


class _FakeStream:
    def __aiter__(self):
        self.parts = iter(("Le faux-filet coûte environ ", "34,90 €/kg selon la source."))
        return self

    async def __anext__(self):
        try:
            text = next(self.parts)
        except StopIteration:
            raise StopAsyncIteration
        return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])


class _DeflectingStream:
    def __aiter__(self):
        self.parts = iter(("Pour le tarif exact, consultez ", "votre revendeur local."))
        return self

    async def __anext__(self):
        try:
            text = next(self.parts)
        except StopIteration:
            raise StopAsyncIteration
        return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text))])


class _FakeCompletions:
    def __init__(self, answer="Le faux-filet coûte environ 34,90 €/kg selon la source."):
        self.payload = None
        self.answer = answer

    async def create(self, **payload):
        self.payload = payload
        if payload.get("stream"):
            return _FakeStream()
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({
            "reponse": self.answer,
            "memoire": [],
            "popups": [],
        }, ensure_ascii=False)))])


def _install_fake_llm(monkeypatch, answer="Le faux-filet coûte environ 34,90 €/kg selon la source."):
    completions = _FakeCompletions(answer)
    fake_client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    monkeypatch.setattr("sirius_brain.AsyncOpenAI", lambda **_kwargs: fake_client)
    monkeypatch.setattr("sirius_brain._research_briefing_follow_up", AsyncMock(return_value=""))
    monkeypatch.setattr(
        "sirius_brain._research_current_prices",
        AsyncMock(return_value="- Boucherie Exemple (https://example.test/faux-filet)\n  34,90 €/kg."),
    )
    return completions


@pytest.mark.parametrize("mode", ["turbo", "normal", "profond"])
def test_answer_modes_receive_research_sources_and_mark_search_used(monkeypatch, mode):
    completions = _install_fake_llm(monkeypatch)
    monkeypatch.setattr("sirius_brain._kimi_reflect", AsyncMock(return_value=""))

    result = asyncio.run(ask_sirius(
        "prix d'un au kg de faux-filet",
        mode=mode,
        keys={"groq_key": "test-key", "serp": "test-serp"},
    ))

    system_prompt = completions.payload["messages"][0]["content"]
    assert "34,90 €/kg" in system_prompt
    assert "https://example.test/faux-filet" in system_prompt
    assert "ne renvoie jamais l'utilisateur faire la recherche lui-même" in system_prompt
    assert result["used_search"] is True


def test_non_streaming_deflection_is_replaced_by_the_sourced_answer(monkeypatch):
    _install_fake_llm(monkeypatch, "Pour le tarif exact, consultez votre revendeur local.")
    monkeypatch.setattr(
        "sirius_brain._research_current_prices",
        AsyncMock(return_value=(
            "- Faux-filet Carrefour | Carrefour (https://carrefour.example/faux-filet)\n"
            "  Faux-filet à griller : 32.99 € / KG.\n"
            "- Faux-filet maturé | RadarSuper (https://radar.example/faux-filet)\n"
            "  Faux-filet maturé : 24,91 €/kg."
        )),
    )

    result = asyncio.run(ask_sirius(
        "prix d'un au kg de faux-filet",
        mode="turbo",
        keys={"groq_key": "test-key", "serp": "test-serp"},
    ))

    assert "consultez votre revendeur" not in result["reponse"].lower()
    assert "entre 24,91 et 32,99 €/kg" in result["reponse"]
    assert result["used_search"] is True


@pytest.mark.parametrize("mode", ["turbo", "normal", "profond"])
def test_streaming_answer_modes_receive_targeted_research(monkeypatch, mode):
    completions = _install_fake_llm(monkeypatch)
    monkeypatch.setattr("sirius_brain._kimi_reflect", AsyncMock(return_value=""))

    async def collect():
        return "".join([
            chunk async for chunk in ask_sirius_stream(
                "prix d'un au kg de faux-filet",
                mode=mode,
                keys={"groq_key": "test-key", "serp": "test-serp"},
            )
        ])

    answer = asyncio.run(collect())
    system_prompt = completions.payload["messages"][0]["content"]
    assert "34,90 €/kg" in system_prompt
    assert "https://example.test/faux-filet" in system_prompt
    assert "34,90 €/kg" in answer


def test_streaming_deflection_is_never_shown_before_source_fallback(monkeypatch):
    import sirius_brain

    completions = SimpleNamespace(create=AsyncMock(return_value=_DeflectingStream()))
    fake_client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    monkeypatch.setattr(sirius_brain, "AsyncOpenAI", lambda **_kwargs: fake_client)
    monkeypatch.setattr(sirius_brain, "_research_briefing_follow_up", AsyncMock(return_value=""))
    monkeypatch.setattr(
        sirius_brain,
        "_research_current_prices",
        AsyncMock(return_value=(
            "- Faux-filet Carrefour | Carrefour (https://carrefour.example/faux-filet)\n"
            "  Faux-filet à griller : 32.99 € / KG.\n"
            "- Faux-filet maturé | RadarSuper (https://radar.example/faux-filet)\n"
            "  Faux-filet maturé : 24,91 €/kg."
        )),
    )

    async def collect():
        return "".join([
            part async for part in sirius_brain.ask_sirius_stream(
                "prix d'un au kg de faux-filet",
                mode="turbo",
                keys={"groq_key": "test-key", "serp": "test-serp"},
            )
        ])

    answer = asyncio.run(collect())
    assert "consultez votre revendeur" not in answer.lower()
    assert "entre 24,91 et 32,99 €/kg" in answer
    assert "carrefour.example" in answer
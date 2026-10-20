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


@pytest.mark.parametrize("question,scope", [
    ("actus du jour", "all"),
    ("Peux-tu me donner les actualités du jour ?", "all"),
    ("Recherche approfondie sur l'actualité du jour", "all"),
    ("Les dernières nouvelles en France", "france"),
    ("Les infos du jour dans le monde", "international"),
    ("Les actualités en France et dans le monde", "all"),
    ("Les actualités économiques en France", None),
    ("Explique les conséquences des actualités", None),
    ("Les infos sur l'économie", None),
    ("Résultats sportifs du jour", None),
    ("Explique cette actualité\nCONTEXTE DU DERNIER BRIEFING :\nSujet précis", None),
])
def test_general_news_scope_preserves_topical_research(question, scope):
    from sirius_brain import _general_news_scope, _is_news_request, needs_targeted_guidance

    assert _general_news_scope(question) == scope
    if scope:
        assert _is_news_request(question)
        assert needs_targeted_guidance(question)


def test_general_retry_inherits_news_but_not_an_unrelated_conversation():
    from sirius_brain import _with_follow_up_topic, _general_news_scope

    question = "Non, essaye général."
    history = [{"role": "user", "content": "Recherche approfondie sur les actus du jour"}]
    assert _general_news_scope(_with_follow_up_topic(question, history)) == "all"
    assert _with_follow_up_topic(question, [{"role": "user", "content": "Explique mon projet"}]) == question
    assert _with_follow_up_topic("Les nouvelles économiques", history) == "Les nouvelles économiques"


@pytest.mark.parametrize("question,expected,excluded", [
    ("Peux-tu me donner les actus du jour ?", "Fait France", None),
    ("Les infos du jour en France", "Fait France", "Fait international"),
    ("Les nouvelles internationales", "Fait international", "Fait France"),
])
def test_general_news_uses_dated_bulletin_instead_of_keyword_search(monkeypatch, question, expected, excluded):
    import briefing_news
    import sirius_brain as brain
    import webagent

    sections = [
        {"id": section_id, "label": label, "status": "ok", "articles": [{
            "titre": title, "description": "Fait vérifié.",
            "date": "2026-10-20T03:00:00+00:00", "source": "Franceinfo",
            "url": f"https://www.franceinfo.fr/{section_id}/article.html",
        }]}
        for section_id, label, title in [
            ("france", "France", "Fait France"),
            ("monde", "International", "Fait international"),
        ]
    ]
    fetch = AsyncMock(return_value={"sections": sections})
    search = AsyncMock(side_effect=AssertionError("Pas de recherche web générique pour le bulletin"))
    monkeypatch.setattr(briefing_news, "fetch_briefing_news", fetch)
    monkeypatch.setattr(webagent, "serp_results", search)
    context = asyncio.run(brain._research_current_prices(question))
    fetch.assert_awaited_once()
    search.assert_not_awaited()
    assert expected in context
    assert "https://www.franceinfo.fr/" in context
    assert "2026-10-20T03:00:00+00:00" in context
    if excluded:
        assert excluded not in context


def test_general_news_reports_timeout_without_inventing_sources(monkeypatch, caplog):
    import briefing_news

    monkeypatch.setattr(briefing_news, "fetch_briefing_news", AsyncMock(side_effect=asyncio.TimeoutError))
    context = asyncio.run(_research_current_prices("actus du jour"))
    assert "aucune actualité vérifiée" in context
    assert "Bulletin indisponible" in caplog.text


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
        return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text), finish_reason="stop" if text.endswith("source.") else None)])


class _DeflectingStream:
    def __aiter__(self):
        self.parts = iter(("Pour le tarif exact, consultez ", "votre revendeur local."))
        return self

    async def __anext__(self):
        try:
            text = next(self.parts)
        except StopIteration:
            raise StopAsyncIteration
        return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=text), finish_reason="stop" if text.endswith("local.") else None)])


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
@pytest.mark.parametrize("stream", [False, True])
def test_general_bulletin_reaches_all_chat_answer_paths(monkeypatch, mode, stream):
    import briefing_news
    import sirius_brain as brain
    import webagent

    completions = _install_fake_llm(monkeypatch)
    monkeypatch.setattr(brain, "_research_current_prices", _research_current_prices)
    monkeypatch.setattr(briefing_news, "fetch_briefing_news", AsyncMock(return_value={"sections": [
        {"id": "france", "label": "France", "status": "ok", "articles": [{
            "titre": "Titre vérifié du bulletin", "description": "Fait sourcé.",
            "date": "2026-10-20T03:00:00+00:00", "source": "Franceinfo",
            "url": "https://www.franceinfo.fr/article.html",
        }]},
    ]}))
    search = AsyncMock(side_effect=AssertionError("Le panorama ne doit pas chercher un sujet arbitraire"))
    monkeypatch.setattr(webagent, "serp_results", search)

    async def run():
        kwargs = {"mode": mode, "keys": {"groq_key": "test-key"}}
        if stream:
            return "".join([part async for part in ask_sirius_stream("les nouvelles", **kwargs)])
        return await ask_sirius("les nouvelles", **kwargs)

    asyncio.run(run())
    system_prompt = completions.payload["messages"][0]["content"]
    assert "Titre vérifié du bulletin" in system_prompt
    assert "https://www.franceinfo.fr/article.html" in system_prompt
    assert "ACTUALITÉ À DÉVELOPPER" in system_prompt
    search.assert_not_awaited()


@pytest.mark.parametrize("mode", ["turbo", "normal", "profond"])
@pytest.mark.parametrize("stream", [False, True])
def test_sports_sources_reach_every_answer_path_without_weather_context(monkeypatch, mode, stream):
    import sirius_brain as brain

    completions = _install_fake_llm(monkeypatch)
    sources = "SCORES STRUCTURÉS TEST : Ligue 1, Domicile 2 – 1 Visiteurs, terminé le 16/10/2026."
    monkeypatch.setattr(brain, "_research_current_prices", AsyncMock(return_value=sources))
    follow_up = AsyncMock(return_value="MÉTÉO À NE PAS RECHERCHER")
    deep = AsyncMock(return_value="ANCIEN BULLETIN")
    monkeypatch.setattr(brain, "_research_briefing_follow_up", follow_up)
    monkeypatch.setattr(brain, "_research_deep_sources", deep)
    question = "les résultats\nCONTEXTE — BULLETIN ΣIRIUS DÉJÀ ANNONCÉ À L'UTILISATEUR :\nMétéo Rosny"

    async def run():
        keys = {"groq_key": "test-key"}
        if stream:
            return "".join([part async for part in ask_sirius_stream(question, mode=mode, keys=keys)])
        return await ask_sirius(question, mode=mode, keys=keys)

    assert asyncio.run(run())
    system_prompt = completions.payload["messages"][0]["content"]
    assert sources in system_prompt
    assert "France ET à l'international" in system_prompt
    assert "horaires en heure de Paris" in system_prompt
    assert "une seule fois pour la liste" in system_prompt
    assert "« contre », jamais « vs » ni « versus »" in system_prompt
    assert "N'invente aucun score" in system_prompt
    follow_up.assert_not_awaited()
    deep.assert_not_awaited()


@pytest.mark.parametrize("mode", ["turbo", "normal", "profond"])
def test_answer_modes_receive_research_sources_and_mark_search_used(monkeypatch, mode):
    completions = _install_fake_llm(monkeypatch)

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

def test_live_event_question_uses_dated_news_and_forbids_old_knowledge(monkeypatch):
    from datetime import datetime, timezone

    import sirius_brain
    import webagent

    monkeypatch.setattr(webagent, "serp_results", AsyncMock(return_value=[]))
    news = AsyncMock(return_value=[{
        "title": "Manchester City-PSG (2-4)",
        "source": "SO FOOT.com",
        "published": datetime(2026, 10, 14, 22, 34, tzinfo=timezone.utc),
    }])
    monkeypatch.setattr(sirius_brain, "_google_news_results", news)
    question = "quel est le résultat du match PSG Manchester City"

    context = asyncio.run(_research_current_prices(question, ""))

    assert "Manchester City-PSG (2-4) | SO FOOT.com" in context
    assert "publié le jeudi 15 octobre 2026 à 00:34" in context
    assert "N'utilise jamais tes connaissances" in _targeted_answer_guidance(context, question)
    no_source = _targeted_answer_guidance("", question)
    assert "ne donne AUCUN résultat" in no_source


def test_news_query_keeps_only_useful_keywords():
    from sirius_brain import _news_search_query, is_live_event_question

    assert _news_search_query("Quel est le résultat du match PSG ?") == "résultat match PSG"
    assert is_live_event_question("qui a gagné hier en Ligue des champions")
    assert not is_live_event_question("c'est quoi Calliope ?")


def test_google_news_rss_is_parsed_sorted_and_recent(monkeypatch):
    from datetime import datetime, timezone

    import sirius_brain

    rss = b"""<?xml version="1.0"?><rss><channel>
    <item><title>Vieux match - L'Equipe</title><source>L'Equipe</source><pubDate>Mon, 01 Jun 2026 10:00:00 GMT</pubDate></item>
    <item><title>PSG gagne 4-2 - franceinfo</title><source>franceinfo</source><pubDate>Wed, 14 Oct 2026 21:00:00 GMT</pubDate></item>
    <item><title>Analyse du match - SO FOOT</title><source>SO FOOT</source><pubDate>Wed, 14 Oct 2026 23:00:00 GMT</pubDate></item>
    </channel></rss>"""

    class Response:
        content = rss

        def raise_for_status(self):
            return None

    class Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url, params=None, headers=None):
            assert params["q"].endswith("when:7d")
            return Response()

    monkeypatch.setattr(sirius_brain.httpx, "AsyncClient", Client)
    results = asyncio.run(sirius_brain._google_news_results(
        "résultat PSG", now=datetime(2026, 10, 15, 6, 0, tzinfo=timezone.utc),
    ))

    assert [item["title"] for item in results] == ["Analyse du match", "PSG gagne 4-2"]

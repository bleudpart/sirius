import asyncio
import time
from datetime import date, datetime, timezone
from unittest.mock import AsyncMock

import httpx
import pytest

import sports_results as sports

NOW = datetime(2026, 10, 16, 15, tzinfo=timezone.utc)
DAY = date(2026, 10, 16)


def match(*, start="2026-10-16T13:00Z", state="post", completed=True, score=True):
    return {
        "id": "42", "date": start,
        "status": {"type": {"state": state, "completed": completed}},
        "competitors": [
            {"team": {"displayName": "Visiteurs"}, "homeAway": "away", **({"score": "1"} if score else {})},
            {"team": {"displayName": "Domicile"}, "homeAway": "home", **({"score": "2"} if score else {})},
        ],
    }


def payload(*matches):
    return {"events": [{"name": "Compétition", "competitions": list(matches)}]}


@pytest.mark.parametrize("question", [
    "affiche le résultat du sport en France ?",
    "résultats sportifs aujourd'hui en France et à l'étranger",
    "les résultats", "Donne-moi les résultats", "Les scores du tennis",
    "Qui a gagné le match de basket ?", "Résultats Ligue 1",
])
def test_detect_sports_results(question):
    assert sports.is_sports_results_question(question)


@pytest.mark.parametrize("question", [
    "résultat de 2 + 2", "mes résultats d'analyse médicale", "résultat des élections",
    "explique les règles du tennis", "ma facture",
])
def test_not_every_result_is_sport(question):
    assert not sports.is_sports_results_question(question)


def test_strip_both_generations_of_bulletin_context():
    for marker in ("CONTEXTE DU DERNIER BRIEFING :", "CONTEXTE — BULLETIN ΣIRIUS DÉJÀ ANNONCÉ À L'UTILISATEUR :"):
        assert sports.sports_question(f"résultats sportifs ?\n\n{marker}\nMétéo Rosny") == "résultats sportifs ?"


def test_date_is_paris_local_day_not_tournament_date_or_utc_day():
    previous_utc_day = match(start="2026-10-15T23:00Z")
    wrong_day = match(start="2026-10-14T12:00Z")
    rows = sports.parse_scoreboard(payload(previous_utc_day, wrong_day), "Football", "Ligue 1", DAY, NOW)
    assert len(rows) == 1
    assert rows[0]["date"].startswith("2026-10-16T01:00")
    assert rows[0]["participants"] == "Domicile / Visiteurs"
    assert rows[0]["score"] == "2 – 1"
    assert rows[0]["state"] == "terminé"


def test_scheduled_zero_scores_are_not_results_and_future_finals_are_rejected():
    scheduled = match(start="2026-10-16T20:00Z", state="pre", completed=False)
    future_final = match(start="2026-10-16T21:00Z")
    rows = sports.parse_scoreboard(payload(scheduled, future_final), "Football", "Ligue 1", DAY, NOW)
    assert len(rows) == 1
    assert rows[0]["state"] == "à venir"
    assert rows[0]["score"] is None


def test_missing_score_never_becomes_zero_and_duplicates_are_removed():
    game = match(score=False, state="in", completed=False)
    rows = sports.parse_scoreboard(payload(game, game), "Basket", "NBA", DAY, NOW)
    assert len(rows) == 1
    assert rows[0]["score"] is None
    assert rows[0]["state"] == "en cours"


def test_postponed_completed_match_is_not_a_final_result():
    game = match()
    game["status"]["type"]["name"] = "STATUS_POSTPONED"
    rows = sports.parse_scoreboard(payload(game), "Rugby", "Top 14", DAY, NOW)
    assert rows[0]["state"] == "reporté/interrompu"
    assert rows[0]["score"] is None


def test_tennis_uses_match_date_and_sets_not_tournament_status():
    game = match()
    game["competitors"] = [
        {"athlete": {"displayName": "Joueur A"}, "linescores": [{"value": 6.0}, {"value": 7.0}]},
        {"athlete": {"displayName": "Joueur B"}, "linescores": [{"value": 4.0}, {"value": 5.0}]},
    ]
    data = {"events": [{
        "name": "Tournoi", "date": "2026-10-01T00:00Z",
        "groupings": [{"competitions": [game]}],
    }]}
    rows = sports.parse_scoreboard(data, "Tennis", "ATP", DAY, NOW)
    assert rows[0]["score"] == "6-4, 7-5"
    assert rows[0]["competition"] == "ATP — Tournoi"


def test_partial_provider_failure_is_logged_and_other_results_survive(monkeypatch, caplog):
    monkeypatch.setattr(sports, "_cache", {})
    monkeypatch.setattr(sports, "LEAGUES", (
        ("Football", "Ligue 1", "soccer/fra.1"), ("Basket", "NBA", "basketball/nba"),
    ))

    class Client:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            pass

        async def get(self, url, **kwargs):
            assert kwargs["params"]["dates"] in ("20261015", "20261016")
            return httpx.Response(
                503 if "nba" in url else 200, json=payload(match()), request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(sports.httpx, "AsyncClient", Client)
    context = asyncio.run(sports.sports_results_context("résultats sportifs aujourd'hui", now=NOW))
    assert "2 – 1 | terminé" in context
    assert "NBA : source indisponible" in context
    assert "France" in context or "françaises ET internationales" in context
    assert "NBA indisponible" in caplog.text
    assert ("basketball/nba", DAY.isoformat()) not in sports._cache


@pytest.mark.parametrize(("text", "expected"), [
    ("aujourd'hui", DAY), ("hier", date(2026, 10, 15)), ("avant-hier", date(2026, 10, 14)),
    ("le 2026-10-10", date(2026, 10, 10)), ("ce week-end", None), ("2026-99-99", None),
    ("le 15/10/2026", date(2026, 10, 15)), ("au 15 octobre", date(2026, 10, 15)),
    ("le 31 février 2026", None), ("en octobre", None), ("le 12", None),
    ("du 12 au 16 octobre", None),
])
def test_explicit_period_is_not_silently_replaced_by_today(text, expected):
    assert sports._requested_day(text, NOW) == expected


def test_research_strips_weather_and_uses_scores_and_lequipe(monkeypatch):
    import sirius_brain as brain
    import webagent

    web = AsyncMock(return_value=[])
    news = AsyncMock(return_value=[])
    scores = AsyncMock(return_value="SCORES TESTÉS")
    monkeypatch.setattr(webagent, "serp_results", web)
    monkeypatch.setattr(brain, "_google_news_results", news)
    monkeypatch.setattr(brain, "sports_results_context", scores)
    monkeypatch.setattr(brain, "motorsport_context", AsyncMock(return_value="F1 dernière course datée"))
    question = "affiche le résultat du sport en France ?"
    contaminated = question + "\nCONTEXTE — BULLETIN ΣIRIUS DÉJÀ ANNONCÉ À L'UTILISATEUR :\nMétéo Rosny"
    context = asyncio.run(brain._research_current_prices(contaminated))
    assert "SCORES TESTÉS" in context
    assert "F1 dernière course datée" in context
    assert web.await_args.args[0] == question
    assert news.await_args.args[0] == "site:lequipe.fr " + question
    assert scores.await_args.args[0] == question
    assert brain._with_follow_up_topic(question, [{"role": "user", "content": "résultat F1"}]) == question
    guidance = brain._targeted_answer_guidance(context, contaminated)
    assert "France ET à l'international" in guidance
    assert "Un programme à venir" not in guidance or "pas" in guidance
    assert "N'invente aucun score" in guidance


@pytest.mark.parametrize(("question", "names"), [
    ("résultats Ligue 1", ["Ligue 1"]), ("scores rugby", ["Top 14", "Premiership"]),
    ("résultats WTA", ["WTA"]), ("résultats athlétisme", []),
])
def test_specific_competition_and_unsupported_sports_do_not_fetch_other_sports(question, names):
    assert [name for _, name, _ in sports._selected_leagues(question)] == names


def test_penalty_shootout_is_not_hidden_by_a_draw():
    game = match()
    game["competitors"][0]["score"] = "2"
    game["competitors"][0]["shootoutScore"] = "3"
    game["competitors"][1]["shootoutScore"] = "4"
    rows = sports.parse_scoreboard(payload(game), "Football", "Ligue 1", DAY, NOW)
    assert rows[0]["score"] == "2 – 2 (t.a.b. 4 – 3)"


def install_http(monkeypatch, handler):
    client = sports.httpx.AsyncClient
    monkeypatch.setattr(sports.httpx, "AsyncClient", lambda **kwargs: client(
        transport=httpx.MockTransport(handler), **kwargs,
    ))
    monkeypatch.setattr(sports, "_cache", {})
    monkeypatch.setattr(sports, "LEAGUES", (("Football", "Ligue 1", "soccer/fra.1"),))


def test_cache_reused_for_one_minute_then_refreshed(monkeypatch):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=payload(match()))

    install_http(monkeypatch, handler)
    for _ in range(2):
        context = asyncio.run(sports.sports_results_context("scores Ligue 1", now=NOW))
        assert "2 – 1" in context
    assert len(calls) == 2
    key = ("soccer/fra.1", DAY.isoformat())
    sports._cache[key] = (time.monotonic() - 61, sports._cache[key][1])
    asyncio.run(sports.sports_results_context("scores Ligue 1", now=NOW))
    assert len(calls) == 4


@pytest.mark.parametrize("failure", ["invalid", "timeout", "http"])
def test_total_failure_is_explicit_never_cached_and_never_invents_scores(monkeypatch, failure, caplog):
    def handler(request):
        if failure == "timeout":
            raise httpx.ReadTimeout("test timeout", request=request)
        return httpx.Response(503 if failure == "http" else 200, json={"bad": []})

    install_http(monkeypatch, handler)
    context = asyncio.run(sports.sports_results_context("résultats Ligue 1", now=NOW))
    assert "Ligue 1 : source indisponible" in context
    assert "Ligue 1 indisponible" in caplog.text
    assert not sports._cache
    assert "terminé" not in context


def test_one_failed_utc_day_keeps_valid_results_with_partial_warning(monkeypatch):
    def handler(request):
        return httpx.Response(
            503 if request.url.params["dates"] == "20261015" else 200, json=payload(match()),
        )

    install_http(monkeypatch, handler)
    context = asyncio.run(sports.sports_results_context("scores Ligue 1", now=NOW))
    assert "couverture incomplète" in context
    assert "2 – 1" in context
    assert not sports._cache

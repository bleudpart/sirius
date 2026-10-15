import asyncio
from unittest.mock import AsyncMock

import httpx

import motorsport_results as motorsport


def test_series_detection_covers_f1_motogp_and_other_disciplines():
    assert motorsport.requested_series("Qui a gagné le dernier Grand Prix de F1 ?") == ["f1"]
    assert motorsport.requested_series("classement Formule 1") == ["f1"]
    assert motorsport.requested_series("résultats Moto2 et Moto3") == ["moto2", "moto3"]
    assert motorsport.requested_series("qui mène le championnat MotoGP") == ["motogp"]
    assert motorsport.requested_series("qui a gagné le grand prix") == ["f1", "motogp"]
    assert motorsport.requested_series("résultat du rallye WRC") == []
    assert motorsport.is_motorsport_question("résultat du rallye WRC")
    assert motorsport.is_motorsport_question("qui a gagné les 24 heures du Mans")
    assert not motorsport.is_motorsport_question("quel temps fait-il à Lyon")


def _jolpica(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path.endswith("/current/last/results.json"):
        races = [{"season": "2026", "round": "17", "raceName": "Singapore Grand Prix", "date": "2026-10-11",
                  "Results": [
                      {"positionText": "1", "points": "25", "status": "Finished",
                       "Driver": {"givenName": "Max", "familyName": "Verstappen"}, "Constructor": {"name": "Red Bull"}},
                      {"positionText": "R", "points": "0", "status": "Retired",
                       "Driver": {"givenName": "Lando", "familyName": "Norris"}, "Constructor": {"name": "McLaren"}},
                  ]}]
        return httpx.Response(200, json={"MRData": {"RaceTable": {"Races": races}}})
    if path.endswith("/driverStandings.json"):
        table = [{"round": "17", "DriverStandings": [
            {"position": "1", "points": "340", "Driver": {"givenName": "Andrea Kimi", "familyName": "Antonelli"}},
        ]}]
        return httpx.Response(200, json={"MRData": {"StandingsTable": {"StandingsLists": table}}})
    if path.endswith("/constructorStandings.json"):
        table = [{"ConstructorStandings": [{"position": "1", "points": "578", "Constructor": {"name": "Mercedes"}}]}]
        return httpx.Response(200, json={"MRData": {"StandingsTable": {"StandingsLists": table}}})
    races = [{"round": "18", "raceName": "United States Grand Prix", "date": "2026-10-25"}]
    return httpx.Response(200, json={"MRData": {"RaceTable": {"Races": races}}})


def test_f1_summary_formats_official_results_in_french():
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(_jolpica)) as client:
            return await motorsport._f1_summary(client)

    summary = asyncio.run(run())

    assert "Singapore Grand Prix, dimanche 11 octobre 2026 (manche 17)" in summary
    assert "1. Max Verstappen (Red Bull) — 25 pts" in summary
    assert "R. Lando Norris (McLaren) — 0 pts (Retired)" in summary
    assert "Championnat pilotes F1 après la manche 17 : 1. Andrea Kimi Antonelli 340 pts" in summary
    assert "1. Mercedes 578 pts" in summary
    assert "Prochaine course F1 : United States Grand Prix, dimanche 25 octobre 2026" in summary


def test_motorsport_context_skips_failed_sources(monkeypatch):
    motorsport._cache.clear()

    async def summary(_client, series):
        if series == "motogp":
            raise httpx.ConnectError("hors ligne")
        return "FORMULE 1 — données"

    monkeypatch.setattr(motorsport, "_series_summary", summary)

    context = asyncio.run(motorsport.motorsport_context("qui a gagné le grand prix"))

    assert context.startswith("DONNÉES OFFICIELLES SPORT AUTO")
    assert "FORMULE 1 — données" in context
    assert asyncio.run(motorsport.motorsport_context("résultat du rallye WRC")) == ""


def test_research_puts_official_motorsport_data_before_articles(monkeypatch):
    import sirius_brain
    import webagent

    monkeypatch.setattr(webagent, "serp_results", AsyncMock(return_value=[]))
    monkeypatch.setattr(sirius_brain, "_google_news_results", AsyncMock(return_value=[]))
    monkeypatch.setattr(sirius_brain, "motorsport_context", AsyncMock(return_value="DONNÉES OFFICIELLES SPORT AUTO :\nF1"))
    question = "qui est en tête du championnat de F1"

    context = asyncio.run(sirius_brain._research_current_prices(question, ""))

    assert context.startswith("DONNÉES OFFICIELLES SPORT AUTO")
    assert sirius_brain.needs_targeted_guidance(question)
    assert "N'utilise jamais tes connaissances" in sirius_brain._targeted_answer_guidance(context, question)


def test_follow_up_inherits_previous_motorsport_topic():
    import sirius_brain

    history = [
        {"role": "user", "content": "donne moi le résultat du MotoGP."},
        {"role": "assistant", "content": "Bezzecchi a gagné en Indonésie."},
    ]
    follow_up = "SIRIUS, donne-moi le résultat complet avec tous les acteurs."

    research_prompt = sirius_brain._with_follow_up_topic(follow_up, history)

    assert motorsport.requested_series(research_prompt) == ["motogp"]
    assert research_prompt.endswith(follow_up)
    assert sirius_brain._with_follow_up_topic("quel temps fait-il à Lyon", history) == "quel temps fait-il à Lyon"
    assert sirius_brain._with_follow_up_topic(follow_up, [{"role": "user", "content": "recette de crêpes"}]) == follow_up

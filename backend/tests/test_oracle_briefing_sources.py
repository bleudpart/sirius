from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth_api
import briefing_news
import provider_access
from routes import pantheon_oracle as oracle


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_overview_keeps_real_news_and_forwards_personal_keys(monkeypatch, method):
    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url, **kwargs):
            return httpx.Response(200, json={})

    monkeypatch.setattr(oracle.httpx, "AsyncClient", Client)
    monkeypatch.setattr(oracle, "_crypto_cache", {"ts": 0, "data": []})
    monkeypatch.setattr(provider_access, "provider_env", lambda *args, **kwargs: "")
    monkeypatch.setattr(auth_api, "resolve_user_id", AsyncMock(return_value="legacy"))
    monkeypatch.setattr(oracle, "prime_overview", lambda: {
        "habits": {"hours": [0] * 24, "weekdays": [0] * 7}, "totals": {"days": 1},
        "confidence": 0, "suggestions": [],
    })
    article = {"titre": "Fait récent vérifié", "description": "Description factuelle.",
               "date": "2026-10-13T08:00:00+00:00", "source": "Franceinfo",
               "url": "https://example.com/article"}
    sections = [{"id": "sport", "label": "Sport", "status": "ok", "articles": [article]}]
    monkeypatch.setattr(briefing_news, "fetch_briefing_news", AsyncMock(return_value={"sections": sections}))
    enrich = AsyncMock(return_value="")
    monkeypatch.setattr(oracle, "enrich_briefing", enrich)
    app = FastAPI()
    app.include_router(oracle.make_pantheon_oracle_router(
        SimpleNamespace(), lambda *args: True, AsyncMock(return_value={"user_id": "test"}),
    ), prefix="/api")
    client = TestClient(app)
    keys = {"cerebras": "fake-personal-key"}
    response = client.request(method, "/api/oracle/overview", **({"json": {"keys": keys}} if method == "POST" else {}))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["stocks"] == []
    assert body["stocks_live"] is False
    assert body["news"] == [article]
    assert "Marchés : données indisponibles" in body["briefing"]
    assert "Fait récent vérifié" in body["briefing"]
    assert enrich.call_args.kwargs["keys"] == (keys if method == "POST" else None)
    assert enrich.call_args.args[0]["marches_actions"] == []
    assert "fake-personal-key" not in response.text
    assert body["astro"] == []
    assert body["astro_status"] == "unavailable"
    assert body["moon"]["estimated"] is True
    assert "phase lunaire approximative" in body["briefing"]


def test_briefing_follow_up_search_does_not_mix_other_news_from_context(monkeypatch):
    import asyncio
    import sirius_brain as brain
    import webagent

    search = AsyncMock(return_value=[{"title": "Économie", "snippet": "Contexte ciblé", "link": "https://example.com"}])
    monkeypatch.setattr(webagent, "serp_results", search)
    prompt = "Explique cette actualité économique\nCONTEXTE DU DERNIER BRIEFING :\nSport et culture sans rapport."
    asyncio.run(brain._research_current_prices(prompt, "fake-serp"))
    assert search.call_args.args[0] == "Explique cette actualité économique"


@pytest.mark.parametrize("available", [True, False])
def test_connectivity_reports_sources_not_fixed_success(monkeypatch, available):
    class Client:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def get(self, url, **kwargs):
            return httpx.Response(200 if available else 503)

    monkeypatch.setattr(oracle.httpx, "AsyncClient", Client)
    monkeypatch.setattr(oracle, "log_service", lambda *args: None)
    monkeypatch.setattr(briefing_news, "fetch_briefing_news", AsyncMock(return_value={
        "sections": [{"status": "ok" if available else "unavailable",
                      "articles": [{"titre": "Actualité"}] if available else []}],
    }))
    db = SimpleNamespace(google_calendar=SimpleNamespace(find_one=AsyncMock(return_value={"token": "test"})))
    app = FastAPI()
    app.include_router(oracle.make_pantheon_oracle_router(db, lambda *args: True, AsyncMock()))
    response = TestClient(app).get("/pantheon/connectivity")
    assert response.status_code == 200
    services = {s["name"]: s for s in response.json()["services"]}
    assert services["ACTUALITÉS"]["status"] == ("CONNECTÉ" if available else "DÉCONNECTÉ")
    assert services["ACTUALITÉS"]["latency"] is None
    assert services["GOOGLE CALENDAR"]["status"] == "CONFIGURÉ — NON VÉRIFIÉ"
    assert services["GOOGLE CALENDAR"]["latency"] is None
    assert services["GOOGLE CALENDAR"]["real"] is False
    assert services["NOYAU ΣIRIUS"]["latency"] is None


@pytest.mark.parametrize("commands,memories", [(0, 0), (3, 2)])
def test_cortex_counts_real_activity_without_artificial_minimum(monkeypatch, tmp_path, commands, memories):
    import sqlite3
    from datetime import datetime, timezone
    import local_memory
    path = tmp_path / "empty.db"
    with sqlite3.connect(path) as connection:
        connection.executescript("""
            CREATE TABLE events (created_at TEXT, intent TEXT);
            CREATE TABLE facts (created_at TEXT);
        """)
        now = datetime.now(timezone.utc).isoformat()
        connection.executemany("INSERT INTO events VALUES (?, ?)", [(now, "math")] * commands)
        connection.executemany("INSERT INTO facts VALUES (?)", [(now,)] * memories)
    monkeypatch.setattr(local_memory, "DB_PATH", str(path))
    db = SimpleNamespace(consult_history=SimpleNamespace(count_documents=AsyncMock(return_value=0)))
    app = FastAPI()
    app.include_router(oracle.make_pantheon_oracle_router(db, lambda *args: True, AsyncMock()))
    body = TestClient(app).get("/cortex/stats").json()
    assert body["activite_cognitive"] == commands
    assert body["charge_memoire"] == memories
    assert body["sous_systemes"]["logique"] == (100 if commands else 0)
    assert body["sous_systemes"]["vision"] == 0


@pytest.mark.parametrize("configured,valid_quote", [(False, False), (True, False), (True, True)])
def test_hephaistos_alpha_vantage_uses_configured_key_and_validates_quote(monkeypatch, configured, valid_quote):
    from routes import hephaistos
    requests = []
    class Client:
        def __init__(self, **kwargs):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def get(self, url, **kwargs):
            requests.append((url, kwargs))
            data = {"Global Quote": {"05. price": "100"}} if valid_quote else {"Information": "Quota atteint"}
            return httpx.Response(200, json=data)
        async def post(self, url, **kwargs):
            return httpx.Response(422, json={})
    monkeypatch.setattr(hephaistos.httpx, "AsyncClient", Client)
    monkeypatch.setattr(hephaistos.psutil, "cpu_percent", lambda **kwargs: 1)
    monkeypatch.setattr(hephaistos, "log_service", lambda *args: None)
    monkeypatch.setattr(provider_access, "provider_env",
                        lambda provider, *args: "private-test-key" if configured and provider == "alphavantage" else "")
    app = FastAPI()
    app.include_router(hephaistos.make_hephaistos_router(SimpleNamespace(
        command=AsyncMock(), diagnostics=SimpleNamespace(insert_one=AsyncMock()),
    )))
    response = TestClient(app).get("/hephaistos/diagnostic")
    assert response.status_code == 200
    av = next(s for s in response.json()["groups"]["integrations"] if s["name"] == "ALPHA VANTAGE")
    assert av["status"] == ("NON CONFIGURÉ" if not configured else "OK" if valid_quote else "FAIL")
    av_requests = [(url, kwargs) for url, kwargs in requests if "alphavantage" in url]
    assert len(av_requests) == int(configured)
    if configured:
        assert av_requests[0][1]["params"]["apikey"] == "private-test-key"
    assert "private-test-key" not in response.text
    assert not any("apikey=demo" in url for url, _ in requests)

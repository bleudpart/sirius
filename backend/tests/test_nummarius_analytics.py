import asyncio
import math
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import auth_api
import nummarius_market_data as market
from nummarius_api import make_nummarius_router
from nummarius_indicators import analyze, ema, rsi, sma


def bars(count=280, constant=False):
    start = datetime(2020, 1, 1)
    return [{"date": (start + timedelta(days=index)).date().isoformat(),
             "open": 100.0 if constant else 100.0 + index,
             "close": 100.0 if constant else 100.0 + index,
             "high": 102.0 if constant else 102.0 + index,
             "low": 98.0 if constant else 98.0 + index, "volume": 1000.0}
            for index in range(count)]


def source(count=280):
    return {
        "bars": bars(count), "currency": "USD", "exchange_timezone": "America/New_York",
        "exchange": "NMS", "source": "Yahoo Finance chart", "source_url": "https://finance.yahoo.com/quote/AAPL/history/",
        "fetched_at": "2026-10-16T00:00:00+00:00", "cached": False, "rejected_bars": 0,
        "splits": [], "incomplete_sessions_excluded": 0,
    }


def payload():
    return {"chart": {"result": [{
        "meta": {"currency": "USD", "exchangeTimezoneName": "America/New_York", "exchangeName": "NMS"},
        "timestamp": [1577883600, 1577970000, 1578056400],
        "indicators": {"quote": [{"open": [100, 101, 102], "close": [101, 102, 103],
                                  "high": [102, 103, 104], "low": [99, 100, 101], "volume": [10, 20, 30]}]},
    }]}}


def test_exact_moving_averages_and_warmups():
    result = analyze(bars())
    assert result["series"][18]["mm20"] is None
    assert result["series"][19]["mm20"] == 109.5
    assert result["series"][198]["mm200"] is None
    assert result["series"][199]["mm200"] == 199.5
    assert result["latest"]["mm200"] == 279.5
    assert result["latest"]["atr14"] == 4
    assert result["latest"]["rsi14"] == 100
    assert result["trend"] == "above_mm200"
    assert result["volume_average_20d"] == 1000
    assert result["max_drawdown_pct"] == 0
    assert sma([1, 2, 3, 4], 3) == [None, None, 2, 3]
    assert ema([1, 2, 3, 4], 3) == [None, None, 2, 3]


def test_constant_series_has_no_invented_momentum_or_volatility():
    result = analyze(bars(constant=True))
    assert result["latest"]["rsi14"] == 50
    assert result["latest"]["macd"] == 0
    assert result["latest"]["macd_signal"] == 0
    assert result["latest"]["bollinger_upper"] == result["latest"]["bollinger_lower"] == 100
    assert result["volatility_20d_annualized_pct"] == 0
    assert result["trend"] == "on_mm200"


def test_rsi_matches_wilder_published_example():
    values = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
              45.89, 46.03, 45.61, 46.28, 46.28, 46.00]
    result = rsi(values)
    assert result[13] is None
    assert result[14] == pytest.approx(70.464135, abs=0.00001)
    assert result[15] == pytest.approx(66.249619, abs=0.00001)
    assert rsi(list(reversed(range(20))))[-1] == 0


def test_missing_history_and_volume_stay_unknown():
    result = analyze(bars(5))
    assert result["latest"]["mm20"] is None
    assert result["latest"]["macd"] is None
    assert result["latest"]["macd_signal"] is None
    assert result["latest"]["atr14"] is None
    assert result["volatility_20d_annualized_pct"] is None
    assert result["trend"] == "history_insufficient"
    data = bars()
    data[-1]["volume"] = None
    assert analyze(data)["volume_average_20d"] is None
    with pytest.raises(ValueError):
        analyze([])


def test_bollinger_and_drawdown_are_computed_not_estimated():
    data = bars(21, constant=True)
    data[-1].update(open=80, close=80, high=82, low=78)
    result = analyze(data)
    assert result["max_drawdown_pct"] == -20
    assert result["latest"]["bollinger_upper"] == pytest.approx(107.717798, abs=0.00001)
    assert result["latest"]["bollinger_lower"] == pytest.approx(90.282202, abs=0.00001)
    assert result["latest"]["atr14"] == pytest.approx((4 * 13 + 22) / 14, abs=0.00001)
    assert math.isfinite(result["volatility_20d_annualized_pct"])


def test_normalization_rejects_bad_bars_and_keeps_source_dates():
    data = payload()
    data["chart"]["result"][0]["indicators"]["quote"][0]["close"][1] = None
    result = market.normalize_chart(data)
    assert [bar["date"] for bar in result["bars"]] == ["2020-01-01", "2020-01-03"]
    assert result["rejected_bars"] == 1
    assert result["currency"] == "USD"
    assert result["exchange_timezone"] == "America/New_York"


def test_duplicate_sessions_and_invalid_structure_are_not_silently_accepted():
    data = payload()
    data["chart"]["result"][0]["timestamp"][1] = data["chart"]["result"][0]["timestamp"][0]
    with pytest.raises(ValueError, match="Duplicate"):
        market.normalize_chart(data)
    for data in ({}, {"chart": {"result": []}}, {"chart": {"result": [{"meta": []}]}}):
        with pytest.raises(ValueError):
            market.normalize_chart(data)


def test_open_daily_session_is_excluded_until_close(monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2020, 1, 3, 18, tzinfo=timezone.utc).astimezone(tz)
    monkeypatch.setattr(market, "datetime", Clock)
    data = payload()
    data["chart"]["result"][0]["meta"]["currentTradingPeriod"] = {
        "regular": {"end": datetime(2020, 1, 3, 21, tzinfo=timezone.utc).timestamp()},
    }
    result = market.normalize_chart(data)
    assert result["incomplete_sessions_excluded"] == 1
    assert result["bars"][-1]["date"] == "2020-01-02"


def test_requested_period_changes_view_not_indicator_warmup(monkeypatch):
    reader = AsyncMock(return_value=source())
    monkeypatch.setattr(market, "daily_market", reader)
    result = asyncio.run(market.technical_analysis("AAPL", "APPLE", "1m"))
    assert len(result["series"]) == 22
    assert result["latest"]["mm200"] == 279.5
    assert result["performance_pct"]["1m"] == pytest.approx((379 / 358 - 1) * 100, abs=0.00001)
    assert result["performance_pct"]["5y"] is None
    assert result["source"] == "Yahoo Finance chart"
    assert result["calculation_version"] == "nummarius-daily-v1"
    assert result["calculation_parameters"]["rsi_wilder"] == 14
    assert result["calculation_inputs"]["daily_bars"] == source()["bars"]
    assert len(result["data_version"]) == 64
    other_period = asyncio.run(market.technical_analysis("AAPL", "APPLE", "1y"))
    assert other_period["data_version"] == result["data_version"]
    assert other_period["calculation_inputs"] == result["calculation_inputs"]


def test_connector_cache_and_unavailability_never_return_a_fake_empty_success(monkeypatch):
    market._cache.clear()
    calls = []
    async def get(_client, url, **kwargs):
        calls.append((url, kwargs))
        return httpx.Response(200, json=payload(), request=httpx.Request("GET", url))
    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    first = asyncio.run(market.daily_market("AAPL"))
    second = asyncio.run(market.daily_market("AAPL"))
    assert not first["cached"] and second["cached"]
    assert first["fetched_at"] == second["fetched_at"]
    assert len(calls) == 1
    assert "apikey" not in str(calls).lower()
    market._cache.clear()
    async def unavailable(_client, url, **_kwargs):
        raise httpx.ConnectError("offline")
    monkeypatch.setattr(httpx.AsyncClient, "get", unavailable)
    with pytest.raises(HTTPException) as failure:
        asyncio.run(market.daily_market("AAPL"))
    assert failure.value.status_code == 503


@pytest.fixture
def client(monkeypatch):
    async def user(request, db):
        if request.headers.get("x-test-user") != "owner":
            raise HTTPException(401)
        return {"user_id": "owner"}
    monkeypatch.setattr(auth_api, "require_user", user)
    monkeypatch.setattr(market, "daily_market", AsyncMock(return_value=source()))
    app = FastAPI()
    app.include_router(make_nummarius_router({}), prefix="/api")
    with TestClient(app) as test:
        yield test


def test_analytics_api_requires_auth_and_valid_catalogue_period(client):
    assert client.get("/api/nummarius/analysis/AAPL").status_code == 401
    headers = {"x-test-user": "owner"}
    assert client.get("/api/nummarius/analysis/AAPL", headers=headers).status_code == 200
    assert client.get("/api/nummarius/analysis/bitcoin", headers=headers).status_code == 422
    assert client.get("/api/nummarius/analysis/AAPL?period=unexpected", headers=headers).status_code == 422
    for query in ("symbols=AAPL,AAPL", "symbols=FOREIGN", "symbols=", "symbols=AAPL,MSFT,NVDA,TSLA,AAPL"):
        assert client.get(f"/api/nummarius/compare?{query}", headers=headers).status_code == 422
    result = client.get("/api/nummarius/compare", headers=headers)
    assert result.status_code == 200
    assert len(result.json()["items"]) == 4
    for item in result.json()["items"]:
        assert "series" not in item["analysis"]
        assert "calculation_inputs" not in item["analysis"]
        assert len(item["analysis"]["data_version"]) == 64


def test_comparison_preserves_partial_provider_failures(client, monkeypatch):
    async def read(symbol):
        if symbol == "TSLA":
            raise HTTPException(503, "Source indisponible")
        return source()
    monkeypatch.setattr(market, "daily_market", read)
    result = client.get("/api/nummarius/compare", headers={"x-test-user": "owner"}).json()
    assert [item["status"] for item in result["items"]] == ["available", "available", "available", "unavailable"]
    assert "analysis" not in result["items"][-1]

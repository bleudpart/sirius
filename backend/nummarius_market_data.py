"""Public daily OHLC connector; no account holdings or API keys leave SIRIUS."""

import asyncio
import hashlib
import json
import logging
import math
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx
from fastapi import HTTPException

from nummarius_indicators import analyze, rounded

logger = logging.getLogger(__name__)
CACHE_SECONDS = 900
_cache = {}


def number(value, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return float(value) if value > 0 or (not positive and value >= 0) else None


def normalize_chart(payload):
    chart = payload.get("chart") if isinstance(payload, dict) else None
    results = chart.get("result") if isinstance(chart, dict) else None
    if not isinstance(results, list) or not results or not isinstance(results[0], dict):
        raise ValueError("Missing market series")
    result = results[0]
    meta = result.get("meta") or {}
    indicators = result.get("indicators") or {}
    if not isinstance(meta, dict) or not isinstance(indicators, dict):
        raise ValueError("Invalid market metadata")
    quotes = indicators.get("quote")
    if not isinstance(quotes, list) or not quotes or not isinstance(quotes[0], dict):
        raise ValueError("Missing OHLC series")
    quote = quotes[0]
    timestamps = result.get("timestamp")
    if not isinstance(timestamps, list) or any(
        not isinstance(quote.get(name, []), list) for name in ("open", "high", "low", "close", "volume")
    ):
        raise ValueError("Invalid OHLC arrays")
    zone_name = meta.get("exchangeTimezoneName")
    if not isinstance(zone_name, str):
        raise ValueError("Missing exchange timezone")
    zone = ZoneInfo(zone_name)
    now = datetime.now(timezone.utc)
    today = now.astimezone(zone).date()
    periods = meta.get("currentTradingPeriod") or {}
    regular = periods.get("regular", {}) if isinstance(periods, dict) else {}
    session_end = number(regular.get("end")) if isinstance(regular, dict) else None
    bars, rejected, incomplete = {}, 0, 0
    for index, timestamp in enumerate(timestamps):
        values = {name: number((quote.get(name) or [])[index], positive=name != "volume")
                  if index < len(quote.get(name) or []) else None
                  for name in ("open", "high", "low", "close", "volume")}
        if (number(timestamp, positive=True) is None or any(values[name] is None for name in ("open", "high", "low", "close"))
                or values["low"] > min(values["open"], values["close"])
                or values["high"] < max(values["open"], values["close"])):
            rejected += 1
            continue
        day_date = datetime.fromtimestamp(timestamp, zone).date()
        if day_date > today or (day_date == today and (session_end is None or now.timestamp() < session_end)):
            incomplete += 1
            continue
        day = day_date.isoformat()
        if day in bars:
            raise ValueError("Duplicate daily market session")
        bars[day] = {"date": day, **values}
    if not bars or not isinstance(meta.get("currency"), str):
        raise ValueError("Missing validated prices or currency")
    events = result.get("events") or {}
    splits = events.get("splits") or {} if isinstance(events, dict) else {}
    if not isinstance(splits, dict):
        raise ValueError("Invalid split events")
    return {
        "bars": [bars[day] for day in sorted(bars)],
        "currency": meta["currency"], "exchange_timezone": meta["exchangeTimezoneName"],
        "exchange": meta.get("exchangeName"), "rejected_bars": rejected,
        "incomplete_sessions_excluded": incomplete, "splits": list(splits.values()),
    }


async def daily_market(symbol):
    cached = _cache.get(symbol)
    if cached and time.monotonic() - cached["clock"] < CACHE_SECONDS:
        return {**cached["data"], "cached": True}
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    try:
        async with httpx.AsyncClient(timeout=18) as client:
            response = await client.get(url, params={"range": "5y", "interval": "1d", "events": "splits"},
                                        headers={"User-Agent": "SIRIUS market analysis"})
            response.raise_for_status()
            data = normalize_chart(response.json())
    except (httpx.HTTPError, ValueError, TypeError, KeyError, IndexError, OverflowError, OSError) as exc:
        logger.warning("NUMMARIUS daily market data unavailable for %s (%s)", symbol, type(exc).__name__)
        raise HTTPException(503, "Historique OHLC indisponible ou invalide. Aucun indicateur inventé.") from exc
    data.update({
        "source": "Yahoo Finance chart", "source_url": f"https://finance.yahoo.com/quote/{symbol}/history/",
        "fetched_at": datetime.now(timezone.utc).isoformat(), "cached": False,
        "price_basis": "provider_ohlc_without_cash_dividend_reinvestment",
        "delayed": True, "interval": "1d",
    })
    _cache[symbol] = {"clock": time.monotonic(), "data": data}
    return data


async def technical_analysis(symbol, label, period):
    data = await daily_market(symbol)
    calculated = analyze(data["bars"])
    counts = {"1m": 22, "3m": 66, "1y": 252, "5y": 1260}
    visible = calculated["series"][-counts[period]:]
    all_bars = data["bars"]
    last = all_bars[-1]
    performance = {}
    for name, days in (("1d", 1), ("1w", 5), ("1m", 21), ("1y", 252), ("5y", 1260)):
        performance[name] = rounded((last["close"] / all_bars[-days - 1]["close"] - 1) * 100) if len(all_bars) > days else None
    source = {key: value for key, value in data.items() if key != "bars"}
    return {
        **source, **calculated, "series": visible, "symbol": symbol, "label": label,
        "data_version": hashlib.sha256(json.dumps(all_bars, sort_keys=True, allow_nan=False).encode()).hexdigest(),
        "calculation_inputs": {"daily_bars": all_bars},
        "calculation_version": "nummarius-daily-v1",
        "calculation_parameters": {
            "sma": [20, 50, 100, 200], "rsi_wilder": 14, "macd_ema": [12, 26, 9],
            "bollinger_population": [20, 2], "atr_wilder": 14,
            "volatility_log_returns_sample": 20, "annualization_sessions": 252,
        },
        "period": period, "available_sessions": len(all_bars), "visible_sessions": len(visible),
        "history_start": all_bars[0]["date"], "as_of": last["date"], "performance_pct": performance,
        "age_calendar_days": (datetime.now(timezone.utc).date() - datetime.fromisoformat(last["date"]).date()).days,
        "range_high": max(bar["high"] for bar in visible), "range_low": min(bar["low"] for bar in visible),
        "limitations": [
            "Clôtures journalières différées, pas un cours en temps réel. Cache maximal : quinze minutes.",
            "Performance de prix hors réinvestissement des dividendes, frais et change. Horizons en séances (252/an).",
            "Ajustements du fournisseur : les fractionnements sont signalés, pas recalculés par SIRIUS.",
            "Volatilité sur vingt rendements logarithmiques, annualisée sur 252 séances ; pas une prévision.",
            "Supports/résistances : extrema des vingt dernières séances, pas des objectifs de cours.",
            "Fondamentaux, actualités et calendrier non raccordés à cette analyse technique.",
        ],
    }


async def compare_assets(stocks, period):
    async def one(symbol, label):
        try:
            analysis = await technical_analysis(symbol, label, period)
            return {"symbol": symbol, "status": "available",
                    "analysis": {key: value for key, value in analysis.items() if key not in ("series", "calculation_inputs")}}
        except HTTPException as exc:
            if exc.status_code != 503:
                raise
            return {"symbol": symbol, "status": "unavailable", "reason": exc.detail}
    items = await asyncio.gather(*(one(symbol, label) for symbol, label in stocks))
    return {"items": items, "period": period, "executed": False}

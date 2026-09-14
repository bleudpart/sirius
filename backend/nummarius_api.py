# © 2026 Daniel Partel – ΣIRIUS Assistant. PORTUS NUMMARIUS# — bourse & marchés.
import os
import time
import uuid

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

STOCKS = [("AAPL", "APPLE"), ("MSFT", "MICROSOFT"), ("NVDA", "NVIDIA"), ("TSLA", "TESLA")]
CRYPTOS = [("bitcoin", "BITCOIN"), ("ethereum", "ETHEREUM"), ("solana", "SOLANA")]

_stock_hist = {}   # sym -> {"ts": epoch, "points": [(date, close)]}
_crypto_hist = {}  # f"{cid}:{days}" -> {"ts": epoch, "points": [(iso, price)]}

STOCK_TTL = 6 * 3600      # Alpha Vantage gratuit : 25 requêtes/jour → cache long
CRYPTO_TTL = 15 * 60


class MarketAlertIn(BaseModel):
    asset_id: str
    alert_type: str = "price_above"
    threshold: float = Field(..., gt=0)


async def _stock_yahoo(sym: str) -> list:
    async with httpx.AsyncClient(timeout=20) as cx:
        r = await cx.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}",
                         params={"range": "6mo", "interval": "1d"},
                         headers={"User-Agent": "Mozilla/5.0"})
    res = ((r.json() or {}).get("chart") or {}).get("result") or []
    if not res:
        return []
    ts = res[0].get("timestamp") or []
    closes = (((res[0].get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
    points = []
    for t, v in zip(ts, closes):
        if v is None:
            continue
        d = time.strftime("%Y-%m-%d", time.gmtime(t))
        points.append((d, round(float(v), 2)))
    return points


async def _stock_daily(sym: str) -> list:
    c = _stock_hist.get(sym)
    if c and time.time() - c["ts"] < STOCK_TTL:
        return c["points"]
    points = []
    key = os.environ.get("ALPHA_VANTAGE_API_KEY", "").strip()
    if key:
        try:
            async with httpx.AsyncClient(timeout=25) as cx:
                r = await cx.get("https://www.alphavantage.co/query",
                                 params={"function": "TIME_SERIES_DAILY", "symbol": sym,
                                         "outputsize": "compact", "apikey": key})
            series = (r.json() or {}).get("Time Series (Daily)") or {}
            points = sorted(((d, float(v["4. close"])) for d, v in series.items()), key=lambda x: x[0])
        except Exception:
            points = []
    if not points:
        try:
            points = await _stock_yahoo(sym)  # repli gratuit sans quota
        except Exception:
            points = []
    if not points:
        if c:
            return c["points"]
        raise HTTPException(status_code=429, detail="Sources boursières indisponibles, réessaie plus tard.")
    _stock_hist[sym] = {"ts": time.time(), "points": points}
    return points


async def _crypto_chart(cid: str, days: int) -> list:
    ck = f"{cid}:{days}"
    c = _crypto_hist.get(ck)
    if c and time.time() - c["ts"] < CRYPTO_TTL:
        return c["points"]
    async with httpx.AsyncClient(timeout=25) as cx:
        r = await cx.get(f"https://api.coingecko.com/api/v3/coins/{cid}/market_chart",
                         params={"vs_currency": "usd", "days": days})
    prices = (r.json() or {}).get("prices") or []
    step = max(1, len(prices) // 120)
    points = [(int(p[0] / 1000), round(float(p[1]), 2)) for p in prices[::step]]
    if not points:
        if c:
            return c["points"]
        raise HTTPException(status_code=429, detail="CoinGecko indisponible, réessaie plus tard.")
    _crypto_hist[ck] = {"ts": time.time(), "points": points}
    return points


def make_nummarius_router(db):
    r = APIRouter(prefix="/nummarius", tags=["nummarius"])

    async def _uid(request: Request):
        from auth_api import require_user
        return (await require_user(request, db))["user_id"]

    @r.get("/market")
    async def market(request: Request):
        """Vue d'ensemble : prix, variation et sparkline (30 derniers points) par actif."""
        await _uid(request)
        assets, errors = [], []
        for sym, label in STOCKS:
            try:
                pts = await _stock_daily(sym)
                closes = [p[1] for p in pts]
                ch = round((closes[-1] - closes[-2]) / closes[-2] * 100, 2) if len(closes) > 1 else 0.0
                assets.append({"id": sym, "label": label, "type": "stock", "currency": "$",
                               "price": round(closes[-1], 2), "change": ch,
                               "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                               "spark": closes[-30:]})
            except HTTPException as e:
                errors.append(f"{label}: {e.detail}")
        for cid, label in CRYPTOS:
            try:
                pts = await _crypto_chart(cid, 30)
                closes = [p[1] for p in pts]
                day_pts = [p[1] for p in pts if p[0] >= time.time() - 90000]
                base = day_pts[0] if len(day_pts) > 1 else (closes[-2] if len(closes) > 1 else closes[-1])
                ch = round((closes[-1] - base) / base * 100, 2) if base else 0.0
                assets.append({"id": cid, "label": label, "type": "crypto", "currency": "$",
                               "price": round(closes[-1], 2), "change": ch,
                               "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                               "spark": closes[-30:]})
            except HTTPException as e:
                errors.append(f"{label}: {e.detail}")
        return {"assets": assets, "errors": errors}

    @r.get("/history/{asset_id}")
    async def history(asset_id: str, request: Request, range: str = "1m"):
        """Courbe d'évolution : range = 1s | 1m | 3m | max."""
        await _uid(request)
        stock = next((s for s in STOCKS if s[0] == asset_id), None)
        crypto = next((c for c in CRYPTOS if c[0] == asset_id), None)
        if stock:
            pts = await _stock_daily(asset_id)
            n = {"1s": 6, "1m": 22, "3m": 66, "max": len(pts)}.get(range, 22)
            return {"label": stock[1], "type": "stock", "currency": "$",
                    "points": [{"t": d, "v": v} for d, v in pts[-n:]]}
        if crypto:
            days = {"1s": 7, "1m": 30, "3m": 90, "max": 365}.get(range, 30)
            pts = await _crypto_chart(asset_id, days)
            return {"label": crypto[1], "type": "crypto", "currency": "$",
                    "points": [{"t": t, "v": v} for t, v in pts]}
        raise HTTPException(status_code=404, detail="Actif inconnu.")

    @r.post("/alerts")
    async def create_alert(body: MarketAlertIn, request: Request):
        uid = await _uid(request)
        valid_assets = {asset_id for asset_id, _ in STOCKS + CRYPTOS}
        if body.asset_id not in valid_assets:
            raise HTTPException(status_code=422, detail="Actif NUMMARIUS inconnu.")
        if body.alert_type not in ("price_above", "price_below", "variation"):
            raise HTTPException(status_code=422, detail="Type d'alerte invalide.")
        alert = {"id": str(uuid.uuid4()), "user_id": uid, **body.dict(), "active": True, "created_at": time.time()}
        await db.nummarius_alerts.insert_one(alert)
        alert.pop("_id", None)
        return {"ok": True, "alert": alert}

    @r.get("/alerts")
    async def list_alerts(request: Request):
        uid = await _uid(request)
        market_data = await market(request)
        current = {asset["id"]: asset for asset in market_data["assets"]}
        alerts = await db.nummarius_alerts.find({"user_id": uid, "active": True}, {"_id": 0}).sort("created_at", -1).to_list(100)
        for alert in alerts:
            asset = current.get(alert["asset_id"])
            value = asset.get("price") if asset and alert["alert_type"].startswith("price_") else asset.get("change") if asset else None
            alert["current_value"] = value
            alert["triggered"] = value is not None and (value >= alert["threshold"] if alert["alert_type"] in ("price_above", "variation") else value <= alert["threshold"])
        return {"alerts": alerts}

    @r.delete("/alerts/{alert_id}")
    async def delete_alert(alert_id: str, request: Request):
        uid = await _uid(request)
        result = await db.nummarius_alerts.delete_one({"id": alert_id, "user_id": uid})
        if not result.deleted_count:
            raise HTTPException(status_code=404, detail="Alerte introuvable.")
        return {"ok": True}

    return r

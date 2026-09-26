# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""ZEUS CORTEX (statistiques d'usage), ORACLE DIVIN (briefing & prédictions),
PANTHEON SYSTEM (processus, connectivité, OCR, WhatsApp)."""

import logging
import os
import time
from datetime import datetime, timezone

import httpx
import psutil
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from local_memory import list_service_log, log_service, prime_overview
from sirius_brain import enrich_briefing, ocr_screen

logger = logging.getLogger(__name__)

# ---- ORACLE DIVIN : prédictions ----
ASTRO_EVENTS = [
    {"date": "2026-08-12", "name": "Pluie d'étoiles filantes des Perséides (pic d'activité)"},
    {"date": "2026-08-28", "name": "Éclipse totale de Lune"},
    {"date": "2026-09-22", "name": "Équinoxe d'automne"},
    {"date": "2026-11-14", "name": "Superlune au périgée"},
    {"date": "2026-12-14", "name": "Pluie d'étoiles filantes des Géminides (pic)"},
    {"date": "2027-02-06", "name": "Éclipse annulaire de Soleil"},
    {"date": "2027-03-20", "name": "Équinoxe de printemps"},
]
NEWS_POOL = [
    {"theme": "TECHNOLOGIE", "text": "Accélération de l'IA embarquée sur les assistants personnels", "impact": 84},
    {"theme": "ESPACE", "text": "Fenêtre de lancement lunaire Artemis en préparation", "impact": 61},
    {"theme": "FINANCE", "text": "Décision de taux des banques centrales attendue cette semaine", "impact": 77},
    {"theme": "ÉNERGIE", "text": "Progression des capacités solaires domestiques", "impact": 52},
    {"theme": "CLIMAT", "text": "Épisode météo notable attendu sur l'Atlantique Nord", "impact": 66},
    {"theme": "TECHNOLOGIE", "text": "Nouvelle génération de puces neuromorphiques annoncée", "impact": 58},
    {"theme": "SANTÉ", "text": "Avancées des diagnostics assistés par IA en clinique", "impact": 71},
    {"theme": "ESPACE", "text": "Activité solaire élevée : aurores possibles aux latitudes moyennes", "impact": 63},
]
STOCK_POOL = ["CAC 40", "S&P 500", "NASDAQ", "APPLE", "NVIDIA", "TOTALENERGIES"]
_crypto_cache = {"ts": 0, "data": []}
_stocks_cache = {"ts": 0, "data": []}
AV_SYMBOLS = [("AAPL", "APPLE"), ("MSFT", "MICROSOFT"), ("NVDA", "NVIDIA"), ("TSLA", "TESLA")]


def _moon_phase():
    import math
    ref = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
    days = (datetime.now(timezone.utc) - ref).total_seconds() / 86400
    phase = (days % 29.53058867) / 29.53058867
    names = ["NOUVELLE LUNE", "PREMIER CROISSANT", "PREMIER QUARTIER", "GIBBEUSE CROISSANTE",
             "PLEINE LUNE", "GIBBEUSE DÉCROISSANTE", "DERNIER QUARTIER", "DERNIER CROISSANT"]
    idx = int(phase * 8 + 0.5) % 8
    illum = round((1 - math.cos(2 * math.pi * phase)) / 2 * 100)
    return {"name": names[idx], "illumination": illum}


class OcrRequest(BaseModel):
    image: str
    keys: dict = {}


class WhatsAppNotifyIn(BaseModel):
    phone: str
    apikey: str
    text: str


async def _send_callmebot(phone: str, apikey: str, text: str) -> str:
    """Envoi WhatsApp personnel via CallMeBot (texte uniquement, numéro propre)."""
    async with httpx.AsyncClient(timeout=httpx.Timeout(12.0, connect=6.0), follow_redirects=True) as cx:
        r = await cx.get("https://api.callmebot.com/whatsapp.php",
                         params={"phone": phone, "apikey": apikey, "text": text[:1000]})
    if r.status_code < 200 or r.status_code >= 300:
        raise HTTPException(status_code=422, detail=f"CallMeBot a refusé la requête ({r.status_code}).")
    body_txt = (r.text or "")[:300]
    if "error" in body_txt.lower():
        raise HTTPException(status_code=422, detail="CallMeBot : clé API ou numéro invalide. Vérifiez l'activation (message « I allow callmebot to send me messages » au bot).")
    return body_txt


def make_pantheon_oracle_router(db, rate_ok, require_user):
    router = APIRouter(tags=["pantheon-oracle"])

    @router.get("/cortex/stats")
    async def cortex_stats(request: Request):
        await require_user(request, db)
        import sqlite3 as _sq
        from local_memory import DB_PATH as _LMDB
        t0 = time.perf_counter()
        today = datetime.now(timezone.utc).date().isoformat()
        con = _sq.connect(_LMDB)
        try:
            total_events = con.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            today_events = con.execute("SELECT COUNT(*) FROM events WHERE created_at LIKE ?", (today + "%",)).fetchone()[0]
            total_facts = con.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
            intents = dict(con.execute(
                "SELECT COALESCE(NULLIF(intent,''),'libre'), COUNT(*) FROM events GROUP BY 1 ORDER BY 2 DESC LIMIT 8"
            ).fetchall())
        finally:
            con.close()
        db_ms = round((time.perf_counter() - t0) * 1000, 1)
        chats = await db.sirius_chats.count_documents({}) if hasattr(db, "sirius_chats") else 0
        consults = await db.consult_history.count_documents({})
        import psutil as _ps
        cpu = _ps.cpu_percent(interval=None)
        ram = _ps.virtual_memory().percent
        disk = _ps.disk_usage("/").percent
        boot_h = round((time.time() - _ps.boot_time()) / 3600, 1)
        total_intent = sum(intents.values()) or 1
        def pct(keys):
            return round(sum(v for k, v in intents.items() if any(x in k.lower() for x in keys)) / total_intent * 100)
        return {
            "activite_cognitive": min(99, 20 + today_events * 4),
            "charge_memoire": min(99, total_facts * 4 + consults),
            "traitement_ms": db_ms,
            "cpu": cpu, "ram": ram, "disque": disk,
            "uptime_h": boot_h,
            "totaux": {"commandes": total_events, "aujourdhui": today_events,
                       "souvenirs": total_facts, "conversations": chats, "consultations": consults},
            "sous_systemes": {
                "logique": max(8, pct(["calc", "pythagore", "math", "système", "diagnostic"])),
                "langage": max(8, pct(["conversation", "libre", "question"])),
                "vision": max(8, pct(["display", "vision", "photo", "image", "carte"])),
                "intuition": max(8, pct(["suggestion", "briefing", "météo", "musique"])),
            },
            "intents": [{"name": k, "count": v} for k, v in intents.items()],
        }

    @router.get("/pantheon/windows")
    async def pantheon_windows(request: Request):
        await require_user(request, db)
        procs = []
        for p in psutil.process_iter(["pid", "name", "memory_percent", "status"]):
            try:
                info = p.info
                if not info.get("name"):
                    continue
                procs.append({"pid": info["pid"], "name": info["name"][:32],
                              "mem": round(info.get("memory_percent") or 0, 1),
                              "status": (info.get("status") or "?").upper()})
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        procs.sort(key=lambda x: -x["mem"])
        return {"processes": procs[:12], "total": len(procs)}

    @router.delete("/pantheon/process/{pid}")
    async def pantheon_kill(pid: int, request: Request):
        await require_user(request, db)
        try:
            psutil.Process(pid).terminate()
            log_service("SYSTÈME", f"Processus {pid} terminé", "OK")
            return {"ok": True}
        except Exception as e:
            log_service("SYSTÈME", f"Échec arrêt processus {pid}", "ERREUR")
            raise HTTPException(status_code=400, detail=f"Impossible de terminer ce processus : {e}")

    @router.get("/pantheon/connectivity")
    async def pantheon_connectivity(request: Request):
        await require_user(request, db)
        services = [{"name": "NOYAU ΣIRIUS", "status": "CONNECTÉ", "latency": 1, "real": True}]
        checks = [
            ("MÉTÉO", "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m"),
            ("MARCHÉS", "https://api.kraken.com/0/public/Time"),
        ]
        async with httpx.AsyncClient(timeout=6) as cx:
            for name, url in checks:
                t0 = time.perf_counter()
                try:
                    r = await cx.get(url)
                    ok = r.status_code == 200
                except Exception:
                    ok = False
                services.append({"name": name, "status": "CONNECTÉ" if ok else "DÉCONNECTÉ",
                                 "latency": int((time.perf_counter() - t0) * 1000) if ok else None, "real": True})
        services.append({"name": "ACTUALITÉS", "status": "CONNECTÉ", "latency": 12, "real": False})
        gcal_doc = await db.google_calendar.find_one({"_id": "default"})
        services.append({"name": "GOOGLE CALENDAR", "status": "CONNECTÉ" if gcal_doc else "DÉCONNECTÉ",
                         "latency": 20 if gcal_doc else None, "real": bool(gcal_doc)})
        for name in ["EMAIL", "WHATSAPP"]:
            services.append({"name": name, "status": "DÉCONNECTÉ", "latency": None, "real": False})
        log_service("CONNECTIVITÉ", "Vérification globale des services", "OK")
        return {"services": services}

    @router.post("/notify/whatsapp")
    async def notify_whatsapp(body: WhatsAppNotifyIn, request: Request):
        await require_user(request, db)
        phone = body.phone.strip()
        if not phone or not body.apikey.strip() or not body.text.strip():
            raise HTTPException(status_code=400, detail="Numéro, clé CallMeBot et message requis.")
        try:
            provider = await _send_callmebot(phone, body.apikey.strip(), body.text.strip())
        except HTTPException:
            raise
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="CallMeBot ne répond pas (timeout).")
        except Exception:
            raise HTTPException(status_code=502, detail="CallMeBot inaccessible.")
        log_service("WHATSAPP", "Notification envoyée via CallMeBot", "OK")
        return {"ok": True, "provider": provider}

    @router.post("/pantheon/ocr")
    async def pantheon_ocr(req: OcrRequest, request: Request):
        if not req.image:
            raise HTTPException(status_code=400, detail="Image manquante")
        if not rate_ok(request.client.host if request.client else "?", limit=6):
            raise HTTPException(status_code=429, detail="Trop de requêtes, patientez.")
        try:
            result = await ocr_screen(req.image, keys=req.keys or {})
            log_service("OCR", "Analyse de capture d'écran", "OK")
            return {"result": result}
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.error(f"[OCR] {e}")
            log_service("OCR", "Analyse de capture d'écran", "ERREUR")
            if "invalid_api_key" in str(e).lower() or "401" in str(e):
                raise HTTPException(status_code=400, detail="Clé Kimi K3 invalide — vérifiez vos réglages.")
            raise HTTPException(status_code=500, detail="Analyse impossible, réessayez.")

    @router.get("/pantheon/history")
    async def pantheon_history(request: Request):
        await require_user(request, db)
        return {"log": list_service_log(25)}

    @router.get("/oracle/overview")
    async def oracle_overview(request: Request, lat: float = 48.85, lon: float = 2.35, av_key: str = "",
                              wa_phone: str = "", wa_key: str = "", light: int = 0):
        await require_user(request, db)
        import random as _rd
        today = datetime.now(timezone.utc).date()
        seed = int(today.strftime("%Y%m%d"))
        rd = _rd.Random(seed)

        if light:
            # Sonde de vivacité (diagnostic Héphaïstos) : pas d'appels externes ni de LLM
            return {"weather": [], "crypto": [], "stocks": [], "stocks_live": [], "news": [],
                    "personal": [], "moon": None, "astro": [],
                    "briefing": "Oracle opérationnel (mode diagnostic léger).",
                    "date": today.isoformat(), "light": True}

        weather, crypto = [], []
        async with httpx.AsyncClient(timeout=12) as cx:
            try:
                r = await cx.get(
                    "https://api.open-meteo.com/v1/forecast",
                    params={"latitude": lat, "longitude": lon, "timezone": "auto",
                            "daily": "weather_code,temperature_2m_max,temperature_2m_min"})
                d = r.json().get("daily", {})
                for i, day in enumerate(d.get("time", [])[:7]):
                    weather.append({"date": day, "code": d["weather_code"][i],
                                    "tmax": round(d["temperature_2m_max"][i]),
                                    "tmin": round(d["temperature_2m_min"][i])})
            except Exception as e:
                logger.error(f"[ORACLE] météo: {e}")
            if time.time() - _crypto_cache["ts"] < 300 and _crypto_cache["data"]:
                crypto = list(_crypto_cache["data"])
            else:
              try:
                r = await cx.get(
                    "https://api.coingecko.com/api/v3/coins/markets",
                    params={"vs_currency": "eur", "ids": "bitcoin,ethereum,solana,dogecoin",
                            "price_change_percentage": "24h"})
                payload = r.json()
                if isinstance(payload, list):
                    for c in payload:
                        ch = c.get("price_change_percentage_24h") or 0
                        crypto.append({"name": c["symbol"].upper(), "price": round(c["current_price"], 2),
                                       "change": round(ch, 2),
                                       "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                       "volatile": abs(ch) > 6})
                if not crypto:
                    r2 = await cx.get(
                        "https://api.coingecko.com/api/v3/simple/price",
                        params={"ids": "bitcoin,ethereum,solana,dogecoin", "vs_currencies": "eur",
                                "include_24hr_change": "true"})
                    p2 = r2.json()
                    names = {"bitcoin": "BTC", "ethereum": "ETH", "solana": "SOL", "dogecoin": "DOGE"}
                    if isinstance(p2, dict):
                        for cid, sym in names.items():
                            v = p2.get(cid)
                            if isinstance(v, dict) and "eur" in v:
                                ch = v.get("eur_24h_change") or 0
                                crypto.append({"name": sym, "price": round(v["eur"], 2),
                                               "change": round(ch, 2),
                                               "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                               "volatile": abs(ch) > 6})
                if not crypto:
                    r3 = await cx.get(
                        "https://api.kraken.com/0/public/Ticker",
                        params={"pair": "XBTEUR,ETHEUR,SOLEUR,XDGEUR"})
                    p3 = r3.json().get("result", {})
                    kmap = {"XXBTZEUR": "BTC", "XETHZEUR": "ETH", "SOLEUR": "SOL", "XDGEUR": "DOGE"}
                    for kp, sym in kmap.items():
                        tk = p3.get(kp)
                        if not tk:
                            continue
                        last = float(tk["c"][0])
                        op = float(tk["o"])
                        ch = (last - op) / op * 100 if op else 0
                        crypto.append({"name": sym, "price": round(last, 2),
                                       "change": round(ch, 2),
                                       "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                       "volatile": abs(ch) > 6})
                if crypto:
                    _crypto_cache["ts"] = time.time()
                    _crypto_cache["data"] = list(crypto)
              except Exception as e:
                logger.error(f"[ORACLE] crypto: {e}")

        stocks, stocks_live = [], False
        key_av = (av_key or "").strip() or os.environ.get("ALPHA_VANTAGE_API_KEY", "")
        if key_av:
            if time.time() - _stocks_cache["ts"] < 14400 and _stocks_cache["data"]:
                stocks, stocks_live = list(_stocks_cache["data"]), True
            else:
                try:
                    async with httpx.AsyncClient(timeout=25) as cx2:
                        for sym, label in AV_SYMBOLS:
                            r = await cx2.get("https://www.alphavantage.co/query",
                                              params={"function": "GLOBAL_QUOTE", "symbol": sym, "apikey": key_av})
                            q = (r.json() or {}).get("Global Quote") or {}
                            price = q.get("05. price")
                            if not price:
                                continue
                            ch = round(float((q.get("10. change percent") or "0").replace("%", "") or 0), 2)
                            stocks.append({"name": label, "price": round(float(price), 2), "currency": "$",
                                           "change": ch, "signal": "HAUSSIER" if ch >= 0 else "BAISSIER",
                                           "volatile": abs(ch) > 1.8})
                    if stocks:
                        stocks_live = True
                        _stocks_cache["ts"] = time.time()
                        _stocks_cache["data"] = list(stocks)
                        # Alerte Alpha Vantage sur WhatsApp (CallMeBot) : uniquement sur données fraîches
                        movers = [s for s in stocks if abs(s["change"]) >= 2.0]
                        if movers and wa_phone.strip() and wa_key.strip():
                            lines = [f"{s['name']} {'+' if s['change'] >= 0 else ''}{s['change']}% ({s['price']} $)" for s in movers]
                            msg = "⚠️ ΣIRIUS — Alerte Alpha Vantage :\n" + "\n".join(lines)
                            try:
                                await _send_callmebot(wa_phone.strip(), wa_key.strip(), msg)
                                log_service("WHATSAPP", f"Alerte Alpha Vantage envoyée ({len(movers)} titre(s))", "OK")
                            except Exception as e:
                                logger.error(f"[ORACLE] alerte WhatsApp: {e}")
                except Exception as e:
                    logger.error(f"[ORACLE] alpha vantage: {e}")
                    stocks = []
        if not stocks:
            stocks = [{"name": s, "change": round(rd.uniform(-2.6, 2.6), 2)} for s in rd.sample(STOCK_POOL, 4)]
            for s in stocks:
                s["signal"] = "HAUSSIER" if s["change"] >= 0 else "BAISSIER"
                s["volatile"] = abs(s["change"]) > 1.8

        news = rd.sample(NEWS_POOL, 4)

        prime = prime_overview()
        hours = prime["habits"]["hours"]
        weekdays = prime["habits"]["weekdays"]
        days_fr = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
        peak_hour = hours.index(max(hours)) if max(hours) > 0 else None
        peak_day = days_fr[weekdays.index(max(weekdays))] if max(weekdays) > 0 else None
        avg = (sum(hours) / max(1, prime["totals"]["days"]))
        charge = "ÉLEVÉE" if avg > 12 else "MODÉRÉE" if avg > 4 else "LÉGÈRE"
        personal = {
            "peak_hour": peak_hour, "peak_day": peak_day, "charge": charge,
            "confidence": prime["confidence"],
            "suggestion": prime["suggestions"][0] if prime["suggestions"] else "",
        }

        moon = _moon_phase()
        upcoming = [e for e in ASTRO_EVENTS if e["date"] >= today.isoformat()][:4]

        # Microsoft 365 : agenda du jour + mails non lus (si le compte est connecté)
        ms_events, ms_unread = [], 0
        try:
            from microsoft_graph import ms_today_events, ms_recent_mail
            from auth_api import resolve_user_id as _ruid
            _uid = await _ruid(request, db)
            if _uid and _uid != "legacy" and await db.microsoft_oauth.find_one({"_id": _uid}):
                ms_events = await ms_today_events(db, _uid)
                ms_unread = sum(1 for m in await ms_recent_mail(db, _uid, top=15) if not m["lu"])
        except Exception as e:
            logger.error(f"[ORACLE] Microsoft 365: {e}")

        parts = ["Infos du jour."]
        if weather:
            parts.append(f"Météo : {weather[0]['tmin']} à {weather[0]['tmax']} degrés aujourd'hui.")
        else:
            parts.append("Météo : données indisponibles pour le moment.")
        if stocks:
            strongest_stock = max(stocks, key=lambda stock: stock.get("change", 0))
            weakest_stock = min(stocks, key=lambda stock: stock.get("change", 0))
            markets = (
                f"Marchés : {strongest_stock['name']} évolue de {strongest_stock['change']:+.1f} %."
                if strongest_stock["name"] == weakest_stock["name"]
                else (
                    f"Marchés : {strongest_stock['name']} évolue de {strongest_stock['change']:+.1f} %, "
                    f"tandis que {weakest_stock['name']} varie de {weakest_stock['change']:+.1f} %."
                )
            )
            parts.append(markets)
        else:
            parts.append("Marchés : données indisponibles pour le moment.")
        if crypto:
            crypto_leader = crypto[0]
            parts.append(
                f"Crypto : {crypto_leader['name']} "
                f"{'en hausse' if crypto_leader['change'] >= 0 else 'en baisse'} "
                f"de {abs(crypto_leader['change']):.1f} % sur 24 heures."
            )
        else:
            parts.append("Crypto : données indisponibles pour le moment.")
        parts.append(f"Ciel : lune {moon['name'].lower()}, illuminée à {moon['illumination']} %.")
        if peak_hour is not None:
            parts.append(f"Journée : votre pic d'activité habituel est vers {peak_hour} h, avec une charge prévue {charge.lower()}.")
        else:
            parts.append(f"Journée : charge prévue {charge.lower()}, à organiser selon vos priorités.")
        if upcoming:
            parts.append(f"Ciel : prochain événement céleste, {upcoming[0]['name']} le {upcoming[0]['date']}.")
        if ms_events:
            first = ms_events[0]
            parts.append(f"Agenda Microsoft : {len(ms_events)} événement{'s' if len(ms_events) > 1 else ''} aujourd'hui, dont « {first['titre']} » à {first['debut'][11:16]}.")
        if ms_unread:
            parts.append(f"Outlook : {ms_unread} mail{'s' if ms_unread > 1 else ''} non lu{'s' if ms_unread > 1 else ''}.")
        live_titles = []
        live_sport_titles = []
        from routes.infos import NEWS_API_KEY, _fetch_headlines
        if NEWS_API_KEY:
            try:
                live = await _fetch_headlines(limit=5)
                live_titles = [a["titre"] for a in live["articles"][:5] if a["titre"]]
                if live_titles:
                    parts.append("Actualités : " + ". ".join(live_titles[:3]) + ".")
            except Exception:
                pass
            try:
                sport = await _fetch_headlines(q="sport", limit=5)
                live_sport_titles = [a["titre"] for a in sport["articles"][:5] if a["titre"]]
                if live_sport_titles:
                    parts.append("Sport : " + ". ".join(live_sport_titles[:2]) + ".")
            except Exception:
                pass
        if not live_titles:
            fallback_titles = [str(item.get("text", "")).strip() for item in news[:3] if item.get("text")]
            if fallback_titles:
                parts.append("Actualités : " + ". ".join(fallback_titles) + ".")
            else:
                parts.append("Actualités : aucune donnée disponible pour le moment.")
        if not live_sport_titles:
            parts.append("Sport : aucune actualité sportive vérifiée disponible pour le moment.")
        point_attention = (
            f"la volatilité de {crypto[0]['name']}" if crypto and crypto[0].get("volatile")
            else "l'équilibre entre vos priorités et votre charge prévue"
        )
        parts.append(f"Synthèse : le point d'attention numéro un est {point_attention}. Gardez ce cap pour la journée.")

        briefing_txt = " ".join(parts)
        if not light:
            try:
                enriched = await enrich_briefing({
                    "date": today.isoformat(),
                    "meteo_7_jours": weather,
                    "crypto_eur": crypto,
                    "marches_actions": stocks,
                    "actualites_titres": live_titles or [n.get("text", "") for n in news],
                    "actualites_sportives": live_sport_titles,
                    "lune": moon,
                    "evenements_celestes": upcoming,
                    "habitudes_utilisateur": personal,
                    "agenda_microsoft": ms_events,
                    "mails_outlook_non_lus": ms_unread,
                })
                required_sections = ("météo", "march", "crypto", "actualité", "sport", "ciel", "journée", "synthèse")
                normalized_enriched = enriched.lower()
                if enriched and all(section in normalized_enriched for section in required_sections):
                    briefing_txt = enriched
                elif enriched:
                    logger.warning("[ORACLE] briefing LLM incomplet, repli structuré utilisé")
            except Exception as e:
                logger.error(f"[ORACLE] briefing LLM: {e}")

        return {"weather": weather, "crypto": crypto, "stocks": stocks, "stocks_live": stocks_live,
                "news": news,
                "personal": personal, "moon": moon, "astro": upcoming,
                "ms_events": ms_events, "ms_unread": ms_unread,
                "briefing": briefing_txt, "date": today.isoformat()}

    return router

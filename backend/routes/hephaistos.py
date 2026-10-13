# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""HÉPHAÏSTOS : diagnostic système réel (endpoints internes, services, intégrations)
et statut de configuration des clés API (booléens uniquement, jamais les valeurs)."""

import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
import sys

import httpx
import psutil
from fastapi import APIRouter, Request

from auth_api import require_user
from local_memory import log_service

logger = logging.getLogger(__name__)


def make_hephaistos_router(db):
    router = APIRouter(tags=["hephaistos"])

    @router.get("/hephaistos/diagnostic")
    async def hephaistos_diagnostic(source: str = "manuel"):
        """Diagnostic RÉEL : endpoints internes, services système, intégrations externes."""
        started = datetime.now(timezone.utc)
        report = {"generated_at": started.isoformat(), "groups": {}, "summary": {}}

        # --- Groupe 1 : endpoints internes (/api) ---
        base = "http://localhost:8001/api"
        endpoints = [
            ("ORACLE", "GET", "/oracle/overview?lat=48.85&lon=2.35&light=1"),
            ("ATLAS", "POST", "/atlas/route", {"from_address": "Paris", "to_address": "Lyon"}),
            ("HERACLES", "POST", "/heracles/check", {"input": "@sirius_diag"}),
            ("PANTHEON", "GET", "/pantheon/connectivity"),
            ("FICHIERS", "GET", "/files"),
            ("NOTIFY", "POST", "/notify/whatsapp", {"phone": "", "apikey": "", "text": ""}),
            ("PUSH", "GET", "/push/public_key"),
        ]
        core = []
        async with httpx.AsyncClient(timeout=30) as cx:
            for item in endpoints:
                name, method, path = item[0], item[1], item[2]
                payload = item[3] if len(item) > 3 else None
                t0 = time.perf_counter()
                try:
                    if method == "GET":
                        r = await cx.get(base + path)
                    else:
                        r = await cx.post(base + path, json=payload)
                    healthy = 200 <= r.status_code < 300 or (
                        name in {"NOTIFY", "HERACLES"} and r.status_code in {400, 422}
                    )
                    status = "NON VÉRIFIÉ" if r.status_code in {401, 403} else "OK" if healthy else "FAIL"
                    core.append({"name": name, "status": status,
                                 "code": r.status_code, "latency": int((time.perf_counter() - t0) * 1000)})
                except Exception as e:
                    core.append({"name": name, "status": "FAIL", "code": None,
                                 "latency": None, "error": f"{type(e).__name__}: {e}"[:120]})
        report["groups"]["endpoints"] = core

        # --- Groupe 2 : services système (compatible production : Mongo externe, frontend statique) ---
        sysroot = []
        try:
            mem = psutil.virtual_memory()
            cpu = psutil.cpu_percent(interval=0.3)
            # Backend : trivialement actif (il exécute ce diagnostic)
            sysroot.append({"name": "BACKEND (uvicorn)", "status": "OK", "detail": "actif"})
            front_up = False
            front_detail = "introuvable"
            try:
                async with httpx.AsyncClient(timeout=4) as cx:
                    r = await cx.get("http://localhost:3000/")
                    front_up = r.status_code == 200 and "<html" in r.text.lower()
                    if front_up:
                        front_detail = "page HTML accessible (port 3000)"
            except httpx.HTTPError as error:
                logger.info("[HEPHAISTOS] frontend HTTP : %s", type(error).__name__)
            if not front_up:
                root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
                front_up = (root / "frontend" / "build" / "index.html").is_file()
                if front_up:
                    front_detail = "build statique présent (accès HTTP non vérifié)"
            front_status = "NON VÉRIFIÉ" if front_up and "non vérifié" in front_detail else "OK" if front_up else "FAIL"
            sysroot.append({"name": "FRONTEND (node)", "status": front_status, "detail": front_detail})
            sysroot.append({"name": "CPU", "status": "OK" if cpu < 92 else "FAIL", "detail": f"{cpu:.0f}%"})
            sysroot.append({"name": "MÉMOIRE", "status": "OK" if mem.percent < 92 else "FAIL", "detail": f"{mem.percent:.0f}%"})
        except Exception as e:
            sysroot.append({"name": "SYSTÈME", "status": "FAIL", "detail": str(e)[:80]})
        # MongoDB : ping réel (fonctionne aussi avec une base externe/managée en production)
        try:
            await db.command("ping")
            sysroot.append({"name": "MONGODB", "status": "OK", "detail": "ping réussi"})
        except Exception as e:
            sysroot.append({"name": "MONGODB", "status": "FAIL", "detail": f"{type(e).__name__}: {e}"[:80]})
        report["groups"]["system"] = sysroot

        from provider_access import provider_env
        kimi_key = provider_env("k3", "K3_API_KEY", "DANIEL_DEV_K3")
        av_key = provider_env("alphavantage", "ALPHA_VANTAGE_API_KEY")
        ext = []
        integ = [
            ("KIMI K3 (LLM)", "https://api.moonshot.cn/v1/models", bool(kimi_key)),
            ("ALPHA VANTAGE", "https://www.alphavantage.co/query", bool(av_key)),
            ("OPENSTREETMAP", "https://nominatim.openstreetmap.org/search?q=Paris&format=json&limit=1", True),
            ("OSRM (routes)", "https://router.project-osrm.org/route/v1/driving/2.35,48.85;4.83,45.76?overview=false", True),
            ("CALLMEBOT", "https://api.callmebot.com/whatsapp.php", True),
            ("OPEN-METEO", "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m", True),
        ]
        # En-tête ASCII obligatoire : httpx encode les headers en latin-1 (le Σ levait UnicodeEncodeError).
        default_headers = {"User-Agent": "SIRIUS-HUD/1.0 (contact@sirius.local)"}

        async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=default_headers) as cx:
            for name, url, configured in integ:
                if name == "CALLMEBOT":
                    ext.append({"name": name, "status": "NON VÉRIFIÉ", "code": None,
                                "configured": None, "latency": None,
                                "detail": "Vérification nécessitant un numéro et une clé personnels ; aucun message envoyé."})
                    continue
                if not configured:
                    ext.append({"name": name, "status": "NON CONFIGURÉ", "code": None,
                                "configured": False, "latency": None})
                    continue
                t0 = time.perf_counter()
                try:
                    req_headers = {}
                    if name.startswith("KIMI") and kimi_key:
                        req_headers["Authorization"] = "Bearer " + kimi_key

                    params = {"function": "GLOBAL_QUOTE", "symbol": "AAPL", "apikey": av_key} if name == "ALPHA VANTAGE" else None
                    r = await cx.get(url, headers=req_headers, params=params)
                    reachable = 200 <= r.status_code < 300
                    if name == "ALPHA VANTAGE" and reachable:
                        quote = r.json().get("Global Quote") or {}
                        reachable = float(quote.get("05. price") or 0) > 0
                    ext.append({
                        "name": name,
                        "status": "OK" if reachable else "FAIL",
                        "code": r.status_code,
                        "configured": configured,
                        "latency": int((time.perf_counter() - t0) * 1000)
                    })
                except Exception as e:
                    ext.append({
                        "name": name,
                        "status": "FAIL",
                        "code": None,
                        "configured": configured,
                        "latency": None,
                        "error": type(e).__name__
                    })
        report["groups"]["integrations"] = ext

        # --- Synthèse ---
        all_items = core + sysroot + ext
        total = len(all_items)
        passed = sum(1 for i in all_items if i["status"] == "OK")
        rate = round(passed / total * 100) if total else 0
        report["summary"] = {
            "total": total, "passed": passed, "failed": total - passed, "rate": rate,
            "state": "OK" if rate == 100 else ("DÉGRADÉ" if rate >= 70 else "CRITIQUE"),
            "duration_ms": int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
            "failed_modules": [i["name"] for i in all_items if i["status"] != "OK"],
        }
        report["speech"] = (
            f"Diagnostic terminé. {passed} modules sur {total} opérationnels, "
            f"soit {rate} pour cent. État du système : {report['summary']['state'].lower()}."
            + (f" Attention aux modules : {', '.join(report['summary']['failed_modules'][:4])}." if report['summary']['failed_modules'] else " Tous les systèmes sont nominaux, monsieur.")
        )
        log_service("HÉPHAÏSTOS", f"Diagnostic complet — {passed}/{total} OK ({rate}%)",
                    "OK" if rate == 100 else "ERREUR")
        try:
            await db.diagnostics.insert_one({
                "at": started.isoformat(), "source": source,
                "rate": rate, "passed": passed, "failed": total - passed, "total": total,
                "state": report["summary"]["state"],
                "failed_modules": report["summary"]["failed_modules"],
                "duration_ms": report["summary"]["duration_ms"],
            })
        except Exception as e:
            logger.error(f"[HÉPHAÏSTOS] persistance historique: {e}")
        return report

    @router.get("/hephaistos/history")
    async def hephaistos_history(request: Request, limit: int = 40):
        await require_user(request, db)
        docs = await db.diagnostics.find({}, {"_id": 0}).sort("at", -1).to_list(max(1, min(limit, 200)))
        return {"history": list(reversed(docs))}

    @router.delete("/hephaistos/history")
    async def hephaistos_history_purge(request: Request, keep: int = 0):
        """Purge l'historique des diagnostics. keep>0 conserve les N plus récents."""
        await require_user(request, db)
        if keep > 0:
            recent = await db.diagnostics.find({}, {"at": 1}).sort("at", -1).to_list(keep)
            cutoff = recent[-1]["at"] if len(recent) >= keep else None
            res = await db.diagnostics.delete_many({"at": {"$lt": cutoff}} if cutoff else {"_id": None})
        else:
            res = await db.diagnostics.delete_many({})
        log_service("HÉPHAÏSTOS", f"Historique purgé — {res.deleted_count} diagnostic(s) supprimé(s)", "OK")
        return {"ok": True, "deleted": res.deleted_count}

    @router.get("/system/keys_status")
    async def keys_status(request: Request):
        await require_user(request, db)
        def ok(name):
            return bool((os.environ.get(name) or "").strip())
        return {"keys": [
            {"id": "k3", "service": "Kimi K3 / Moonshot (cerveau LLM)", "configured": ok("DANIEL_DEV_K3")},
            {"id": "tts", "service": "Google TTS (voix premium)", "configured": ok("GOOGLE_TTS_API_KEY")},
            {"id": "serp", "service": "SerpAPI (recherche web)", "configured": ok("SERP_API_KEY")},
            {"id": "news", "service": "NewsAPI (actualités)", "configured": ok("NEWS_API_KEY")},
            {"id": "weather", "service": "OpenWeather (météo)", "configured": ok("OPENWEATHER_API_KEY")},
            {"id": "gmaps", "service": "Google Maps (Atlas — carte & navigation)", "configured": ok("GOOGLE_MAPS_API_KEY") or ok("MAPS_PLATFORM_API_Key")},
            {"id": "alpha", "service": "Alpha Vantage (bourse)", "configured": ok("ALPHA_VANTAGE_API_KEY")},
            {"id": "countries", "service": "RestCountries (pays)", "configured": ok("RESTCOUNTRIES_API_KEY")},
            {"id": "europeana", "service": "Europeana (patrimoine)", "configured": ok("EUROPEANA_API_KEY")},
            {"id": "spotify", "service": "Spotify (musique)", "configured": ok("SPOTIFY_CLIENT_ID") and ok("SPOTIFY_CLIENT_SECRET")},
            {"id": "fal", "service": "Fal.ai (images / vidéos)", "configured": ok("FAL_KEY")},
            {"id": "outlook", "service": "Microsoft Outlook (Graph)", "configured": ok("MS_CLIENT_ID") and ok("MS_CLIENT_SECRET")},
            {"id": "gemini", "service": "Google Gemini (génération d'images)", "configured": ok("GEMINI_API_KEY")},
        ]}

    return router

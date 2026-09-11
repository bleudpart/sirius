# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
"""Infos externes : actualités (NewsAPI), météo (OpenWeatherMap), fiches pays,
bulletin tech Hacker News, mini-documentaire multi-sources et recherche Europeana."""

import logging
import os
import re
import time

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from sirius_brain import doc_narrative, hn_bulletin

logger = logging.getLogger(__name__)

# ---- Actualités françaises en direct (NewsAPI) ----
NEWS_API_KEY = os.environ.get("NEWS_API_KEY")
FRENCH_NEWS_DOMAINS = "lemonde.fr,lefigaro.fr,bfmtv.com,france24.com,liberation.fr,20minutes.fr"
_news_cache = {"t": 0.0, "key": "", "data": None}


async def _fetch_headlines(q: str = "", limit: int = 6):
    """Titres FR récents via /v2/everything (top-headlines country=fr est vide sur le plan gratuit)."""
    if not NEWS_API_KEY:
        raise HTTPException(status_code=503, detail="NEWS_API_KEY absente")
    limit = max(1, min(10, limit))
    cache_key = f"{q.strip().lower()}|{limit}"
    if _news_cache["data"] and _news_cache["key"] == cache_key and time.time() - _news_cache["t"] < 300:
        return _news_cache["data"]
    params = {"language": "fr", "sortBy": "publishedAt", "pageSize": limit, "apiKey": NEWS_API_KEY}
    if q.strip():
        params["q"] = q.strip()
    else:
        params["domains"] = FRENCH_NEWS_DOMAINS
    try:
        async with httpx.AsyncClient(timeout=12) as cx:
            r = await cx.get("https://newsapi.org/v2/everything", params=params)
    except Exception:
        raise HTTPException(status_code=502, detail="NewsAPI injoignable")
    if r.status_code == 429:
        raise HTTPException(status_code=429, detail="Quota NewsAPI atteint (100 requêtes/jour)")
    if r.status_code != 200 or r.json().get("status") != "ok":
        logger.error(f"[NEWS] {r.status_code} {r.text[:150]}")
        raise HTTPException(status_code=502, detail="Erreur NewsAPI")
    arts = [{
        "titre": (a.get("title") or "").split(" - ")[0].strip(),
        "source": (a.get("source") or {}).get("name") or "",
        "description": a.get("description") or "",
        "url": a.get("url") or "",
        "date": a.get("publishedAt") or "",
    } for a in r.json().get("articles", [])[:limit]]
    data = {"articles": arts}
    _news_cache.update({"t": time.time(), "key": cache_key, "data": data})
    return data


# ---- Météo temps réel (OpenWeatherMap) ----
OPENWEATHER_API_KEY = os.environ.get("OPENWEATHER_API_KEY")

# ---- Fiche pays (REST Countries v5) ----
RESTCOUNTRIES_API_KEY = os.environ.get("RESTCOUNTRIES_API_KEY")

# ---- Bulletin tech Hacker News ----
_hn_cache = {"t": 0.0, "stories": None}


async def _fetch_hn_stories(limit: int = 12):
    if _hn_cache["stories"] and time.time() - _hn_cache["t"] < 600:
        return _hn_cache["stories"]
    async with httpx.AsyncClient(timeout=12) as cx:
        r = await cx.get("https://hacker-news.firebaseio.com/v0/topstories.json")
        r.raise_for_status()
        ids = r.json()[:limit]
        import asyncio as _aio
        items = await _aio.gather(*[cx.get(f"https://hacker-news.firebaseio.com/v0/item/{i}.json") for i in ids], return_exceptions=True)
    stories = []
    for it in items:
        if isinstance(it, Exception) or it.status_code != 200:
            continue
        d = it.json() or {}
        if d.get("title"):
            stories.append({"title": d["title"], "score": d.get("score", 0),
                            "by": d.get("by", ""), "url": d.get("url", "")})
    if stories:
        _hn_cache.update({"t": time.time(), "stories": stories})
    return stories


class TechBulletinRequest(BaseModel):
    keys: dict = {}


class DocumentaryRequest(BaseModel):
    sujet: str
    keys: dict = {}


async def _gather_documentary_data(sujet: str):
    import asyncio as _aio
    from urllib.parse import quote
    data = {}
    ua = {"User-Agent": "ΣIRIUS-HUD/1.0 (contact: daniel.partel@sirius-hud.fr) python-httpx"}
    async with httpx.AsyncClient(timeout=12, follow_redirects=True, headers=ua) as cx:
        async def wiki():
            # Résolution du titre exact (insensible à la casse) puis résumé
            titre = sujet
            try:
                rs = await cx.get("https://fr.wikipedia.org/w/api.php",
                                  params={"action": "query", "list": "search", "srsearch": sujet,
                                          "srlimit": 1, "format": "json"})
                hits = (rs.json().get("query", {}).get("search", []) if rs.status_code == 200 else [])
                if hits:
                    titre = hits[0].get("title") or sujet
            except Exception:
                pass
            r = await cx.get(f"https://fr.wikipedia.org/api/rest_v1/page/summary/{quote(titre)}")
            if r.status_code == 200:
                d = r.json()
                data["wikipedia"] = {"titre": d.get("title"), "description": d.get("description"),
                                     "extrait": d.get("extract", "")[:3000]}
        async def wikidata():
            r = await cx.get("https://www.wikidata.org/w/api.php",
                             params={"action": "wbsearchentities", "search": sujet,
                                     "language": "fr", "format": "json", "limit": 2})
            if r.status_code == 200:
                data["wikidata"] = [{"label": s.get("label"), "description": s.get("description")}
                                    for s in r.json().get("search", [])]
        async def openlib():
            r = await cx.get("https://openlibrary.org/search.json",
                             params={"q": sujet, "limit": 4, "fields": "title,author_name,first_publish_year"})
            if r.status_code == 200:
                data["openlibrary_ouvrages"] = [
                    {"titre": x.get("title"), "auteurs": (x.get("author_name") or [])[:2],
                     "annee": x.get("first_publish_year")} for x in r.json().get("docs", [])]
        async def gallica():
            r = await cx.get("https://gallica.bnf.fr/SRU",
                             params={"operation": "searchRetrieve", "version": "1.2",
                                     "query": f'gallica all "{sujet}"', "maximumRecords": 3})
            if r.status_code == 200:
                titres = re.findall(r"<dc:title>([^<]{5,120})</dc:title>", r.text)[:3]
                if titres:
                    data["gallica_archives"] = titres
        async def europeana():
            key = os.environ.get("EUROPEANA_API_KEY")
            if not key:
                return
            r = await cx.get("https://api.europeana.eu/record/v2/search.json",
                             params={"wskey": key, "query": sujet, "rows": 4, "profile": "standard"})
            if r.status_code == 200 and r.json().get("success"):
                items = []
                for it in r.json().get("items", []):
                    t = (it.get("title") or [""])[0]
                    if t:
                        items.append({"titre": t[:120], "type": it.get("type", ""),
                                      "annee": (it.get("year") or [""])[0],
                                      "fournisseur": (it.get("dataProvider") or [""])[0]})
                if items:
                    data["europeana_collections"] = items
        async def europeana_images():
            key = os.environ.get("EUROPEANA_API_KEY")
            if not key:
                return
            r = await cx.get("https://api.europeana.eu/record/v2/search.json",
                             params={"wskey": key, "query": sujet, "rows": 8,
                                     "profile": "standard", "media": "true", "qf": "TYPE:IMAGE"})
            if r.status_code == 200 and r.json().get("success"):
                imgs, seen = [], set()
                for it in r.json().get("items", []):
                    url = (it.get("edmPreview") or [""])[0]
                    if url and url not in seen:
                        seen.add(url)
                        imgs.append({"url": url,
                                     "legende": (it.get("title") or [""])[0][:80],
                                     "source": (it.get("dataProvider") or [""])[0][:60]})
                    if len(imgs) >= 4:
                        break
                if imgs:
                    data["images"] = imgs
        results = await _aio.gather(wiki(), wikidata(), openlib(), gallica(), europeana(), europeana_images(), return_exceptions=True)
        for res in results:
            if isinstance(res, Exception):
                logger.warning(f"[DOC] source en échec: {res}")
    return data


def make_infos_router():
    router = APIRouter(tags=["infos"])

    @router.get("/news/headlines")
    async def news_headlines(q: str = "", limit: int = 6):
        return await _fetch_headlines(q=q, limit=limit)

    @router.get("/weather/current")
    async def weather_current(city: str = "Paris"):
        if not OPENWEATHER_API_KEY:
            raise HTTPException(status_code=503, detail="OPENWEATHER_API_KEY absente")
        try:
            async with httpx.AsyncClient(timeout=10) as cx:
                r = await cx.get("https://api.openweathermap.org/data/2.5/weather",
                                 params={"q": city, "units": "metric", "lang": "fr",
                                         "appid": OPENWEATHER_API_KEY})
        except Exception:
            raise HTTPException(status_code=502, detail="OpenWeatherMap injoignable")
        if r.status_code == 404:
            raise HTTPException(status_code=404, detail="Ville introuvable")
        if r.status_code != 200:
            logger.error(f"[METEO] {r.status_code} {r.text[:150]}")
            raise HTTPException(status_code=502, detail="Erreur OpenWeatherMap")
        d = r.json()
        m = d.get("main") or {}
        return {
            "ville": d.get("name") or city,
            "temp": round(m.get("temp", 0)),
            "ressenti": round(m.get("feels_like", 0)),
            "description": ((d.get("weather") or [{}])[0].get("description") or "").capitalize(),
            "humidite": m.get("humidity"),
            "vent": round((d.get("wind", {}).get("speed") or 0) * 3.6),
            "tmin": round(m.get("temp_min", 0)),
            "tmax": round(m.get("temp_max", 0)),
        }

    @router.get("/country")
    async def country_info(name: str):
        if not RESTCOUNTRIES_API_KEY:
            raise HTTPException(status_code=503, detail="RESTCOUNTRIES_API_KEY absente")
        try:
            async with httpx.AsyncClient(timeout=10) as cx:
                r = await cx.get("https://api.restcountries.com/countries/v5",
                                 params={"q": name, "limit": 1},
                                 headers={"Authorization": f"Bearer {RESTCOUNTRIES_API_KEY}"})
        except Exception:
            raise HTTPException(status_code=502, detail="REST Countries injoignable")
        if r.status_code != 200:
            logger.error(f"[PAYS] {r.status_code} {r.text[:150]}")
            raise HTTPException(status_code=502, detail="Erreur REST Countries")
        objs = (r.json().get("data") or {}).get("objects") or []
        if not objs:
            raise HTTPException(status_code=404, detail="Pays introuvable")
        c = objs[0]
        names = c.get("names") or {}
        nom_fr = ((names.get("translations") or {}).get("fra") or {}).get("common") or names.get("common") or name
        caps = [x.get("name") for x in (c.get("capitals") or []) if x.get("name")]
        monnaies = [f"{x.get('name')} ({x.get('symbol')})" for x in (c.get("currencies") or []) if x.get("name")]
        langues = [x.get("name") for x in (c.get("languages") or []) if x.get("name")]
        return {
            "nom": nom_fr,
            "capitale": caps[0] if caps else "",
            "population": c.get("population"),
            "region": c.get("region") or "",
            "sous_region": c.get("subregion") or "",
            "superficie_km2": (c.get("area") or {}).get("kilometers"),
            "monnaies": monnaies,
            "langues": langues,
            "drapeau": (c.get("flag") or {}).get("emoji") or "",
            "drapeau_png": (c.get("flag") or {}).get("url_png") or "",
        }

    @router.post("/technews/bulletin")
    async def technews_bulletin(req: TechBulletinRequest):
        try:
            stories = await _fetch_hn_stories()
        except Exception:
            raise HTTPException(status_code=502, detail="Hacker News injoignable")
        if not stories:
            raise HTTPException(status_code=502, detail="Aucune story Hacker News")
        bulletin = await hn_bulletin(stories, req.keys)
        return {"bulletin": bulletin, "stories": stories[:6]}

    @router.post("/documentary")
    async def documentary(req: DocumentaryRequest):
        sujet = req.sujet.strip()
        if not sujet:
            raise HTTPException(status_code=400, detail="Sujet vide")
        data = await _gather_documentary_data(sujet)
        images = data.pop("images", [])
        if not data:
            raise HTTPException(status_code=404, detail="Aucune donnée documentaire trouvée")
        texte = await doc_narrative(sujet, data, req.keys)
        return {"documentaire": texte, "sources": list(data.keys()), "images": images}

    @router.get("/europeana/search")
    async def europeana_search(q: str, rows: int = 12):
        """Visionneuse Europeana : recherche d'images d'archives."""
        key = os.environ.get("EUROPEANA_API_KEY")
        if not key:
            raise HTTPException(status_code=503, detail="EUROPEANA_API_KEY absente")
        if not q.strip():
            raise HTTPException(status_code=400, detail="Recherche vide")
        rows = max(1, min(24, rows))
        try:
            async with httpx.AsyncClient(timeout=12) as cx:
                r = await cx.get("https://api.europeana.eu/record/v2/search.json",
                                 params={"wskey": key, "query": q.strip(), "rows": rows * 2,
                                         "profile": "standard", "media": "true", "qf": "TYPE:IMAGE"})
        except Exception:
            raise HTTPException(status_code=502, detail="Europeana injoignable")
        if r.status_code != 200 or not r.json().get("success"):
            logger.error(f"[EUROPEANA] {r.status_code} {r.text[:150]}")
            raise HTTPException(status_code=502, detail="Erreur Europeana")
        imgs, seen = [], set()
        for it in r.json().get("items", []):
            url = (it.get("edmPreview") or [""])[0]
            if url and url not in seen:
                seen.add(url)
                imgs.append({"url": url,
                             "legende": (it.get("title") or [""])[0][:90],
                             "source": (it.get("dataProvider") or [""])[0][:60],
                             "annee": (it.get("year") or [""])[0]})
            if len(imgs) >= rows:
                break
        return {"images": imgs, "total": r.json().get("totalResults", 0)}

    return router

# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
# ΣIRIUS Web Agent : recherche Google (SerpAPI) + navigateur invisible (Playwright).
# Capture d'écran du meilleur résultat réel — page de résultats holographique ΣIRIUS en secours.
import html as _html
import logging
import os

import httpx

from resilience import CircuitOpenError, resilient_call

logger = logging.getLogger(__name__)

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
ENV_SERP_KEY = os.environ.get("SERP_API_KEY")


async def serp_results(query, serp_key=None):
    """Meilleurs résultats Google via SerpAPI → [{title, link, snippet}]."""
    key = serp_key or ENV_SERP_KEY
    if not key:
        return []

    async def _fetch():
        async with httpx.AsyncClient(timeout=12.0) as client:
            r = await client.get(
                "https://serpapi.com/search.json",
                params={"q": query, "api_key": key, "hl": "fr", "gl": "fr", "num": 6},
            )
            r.raise_for_status()
            return r.json()

    try:
        data = await resilient_call(
            _fetch,
            service="serpapi",
            attempts=3,
            timeout=15.0,
            retry_on=(httpx.HTTPError, ValueError),
        )
    except CircuitOpenError as e:
        logger.warning(f"[WEBAGENT SERP] {e}")
        return []
    except Exception as e:
        logger.error(f"[WEBAGENT SERP] {repr(e)}")
        return []
    out = []
    for item in (data.get("organic_results") or [])[:6]:
        if item.get("link"):
            out.append({
                "title": item.get("title", ""),
                "link": item["link"],
                "snippet": item.get("snippet", ""),
                "source": item.get("source") or item.get("displayed_link", ""),
            })
    return out


def _results_html(query, results):
    """Page de résultats holographique ΣIRIUS (rendue localement puis capturée)."""
    rows = "".join(
        f"<div class='r'><div class='t'>{_html.escape(r['title'])}</div>"
        f"<div class='l'>{_html.escape(r['source'] or r['link'])}</div>"
        f"<div class='s'>{_html.escape(r['snippet'])}</div></div>"
        for r in results
    )
    return f"""<!DOCTYPE html><html><head><meta charset='utf-8'><style>
body {{ background:#060b14; color:#bfeaf5; font-family:'Segoe UI',Arial,sans-serif; padding:34px 46px; }}
h1 {{ color:#f5c542; font-size:21px; letter-spacing:2px; border-bottom:1px solid rgba(245,197,66,.4); padding-bottom:12px; }}
h1 span {{ color:#22d3ee; font-size:13px; letter-spacing:4px; display:block; margin-bottom:6px; }}
.r {{ margin:20px 0; padding:14px 18px; border:1px solid rgba(34,211,238,.25); border-radius:10px; background:rgba(34,211,238,.04); }}
.t {{ color:#ffe9a8; font-size:16px; margin-bottom:4px; }}
.l {{ color:#22d3ee; font-size:11px; margin-bottom:6px; }}
.s {{ font-size:13px; line-height:1.5; opacity:.9; }}
</style></head><body><h1><span>ΣIRIUS — AGENT WEB</span>Résultats : {_html.escape(query)}</h1>{rows}</body></html>"""


async def _dismiss_consent(page):
    """Ferme les bannières de cookies courantes (meilleur effort)."""
    labels = ["Tout accepter", "Tout autoriser", "Accepter et fermer", "Accepter", "J'accepte",
              "Continuer sans accepter", "Refuser tous les cookies", "Tout refuser", "Refuser",
              "Accept all", "Accept", "I agree", "Reject all", "Aceptar todo", "Rechazar todo", "Aceptar",
              "Visiter", "Continuer", "OK"]
    for _ in range(2):
        clicked = False
        for lab in labels:
            try:
                btn = page.locator(f"button:has-text('{lab}'), [role='button']:has-text('{lab}')").first
                if await btn.count() and await btn.is_visible():
                    await btn.click(timeout=1500)
                    await page.wait_for_timeout(700)
                    clicked = True
                    break
            except Exception:
                continue
        if not clicked:
            try:
                x = page.locator("[aria-label='Close'], [aria-label='Fermer'], button.close, .modal button:has-text('✕')").first
                if await x.count() and await x.is_visible():
                    await x.click(timeout=1200)
                    await page.wait_for_timeout(500)
                    clicked = True
            except Exception:
                pass
        if not clicked:
            return


async def executer_tache_web(query="", url="", selector="", text="", serp_key=None):
    """Recherche web (SerpAPI + capture du meilleur résultat) ou action sur un site précis."""
    from playwright.async_api import async_playwright
    results = []
    target_url = (url or "").strip()
    moteur = ""
    if query and not target_url:
        results = await serp_results(query, serp_key)
        moteur = "Google"
        if results:
            target_url = results[0]["link"]
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        page = await browser.new_page(viewport={"width": 1280, "height": 800}, user_agent=UA, locale="fr-FR")
        try:
            captured = False
            candidates = [target_url] if (url or not results) and target_url else [r["link"] for r in results[:3]]
            for cand in candidates:
                if not cand:
                    continue
                try:
                    resp = await page.goto(cand, timeout=20000, wait_until="domcontentloaded")
                    if resp and resp.status >= 400:
                        continue
                    if selector and text:
                        await page.fill(selector, text)
                        await page.keyboard.press("Enter")
                    await page.wait_for_timeout(2000)
                    titre_t = (await page.title()).lower()
                    if any(w in titre_t for w in ("403", "404", "forbidden", "access denied", "captcha", "attention required")):
                        continue
                    await _dismiss_consent(page)
                    await page.wait_for_timeout(500)
                    try:
                        body_txt = (await page.locator("body").inner_text(timeout=3000)).strip().lower()
                        if len(body_txt) < 400 and any(w in body_txt for w in ("forbidden", "access denied", "captcha", "blocked", "robot")):
                            continue
                    except Exception:
                        pass
                    captured = True
                    break
                except Exception as e:
                    logger.warning(f"[WEBAGENT] Site inaccessible ({cand}): {repr(e)}")
            if not captured and results:
                await page.set_content(_results_html(query, results), wait_until="load")
                await page.wait_for_timeout(400)
                captured = True
            if not captured:
                await browser.close()
                return {"succes": False, "message": "Aucun résultat web exploitable, monsieur."}
            shot = await page.screenshot(type="jpeg", quality=70, full_page=False)
            titre = (await page.title()) or (results[0]["title"] if results else query) or query
            extraits = [f"{r['title']} — {r['snippet']}"[:150] for r in results[:3]]
            page_url = page.url if page.url and page.url != "about:blank" else (results[0]["link"] if results else target_url)
            await browser.close()
            return {"succes": True, "titre": titre, "moteur": moteur, "extraits": extraits, "url": page_url, "image": shot}
        except Exception as e:
            logger.warning(f"[WEBAGENT] {repr(e)}")
            try:
                await browser.close()
            except Exception:
                pass
            return {"succes": False, "message": f"Erreur d'automatisation web : {e}"}

# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Routes des modules restaurés : WAHOU, TRAILER, MYTHOS, VISION, LOCUS, HERACLES,
ARGUS, SCRIPTS, SUGGESTIONS, SYSTEM, INSTALL, KEYS, PACKAGER, MEMORY MANAGER."""
import asyncio
import csv
import io
import json
import os
import re
import secrets
import shutil
import smtplib
import subprocess
import uuid
from datetime import datetime, timezone, timedelta
from pathlib import Path

import httpx
import psutil
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse, Response
from pydantic import BaseModel
from typing import Optional, List

from promo_shots import PROMO_SHOTS

TRAILER_SHOTS = [
    {"id": 1, "title": "LE NOYAU", "desc": "Le réacteur ΣIRIUS s'éveille au cœur du vide.", "image": "/api/trailer/img/shot1.jpg"},
    {"id": 2, "title": "FORGÉ DANS LE VIDE", "desc": "Deux titans, une étincelle : la naissance d'une entité.", "image": "/api/trailer/img/shot2.jpg"},
    {"id": 3, "title": "LE PANTHÉON", "desc": "Six identités mythologiques veillent sur le système.", "image": "/api/trailer/img/shot3.jpg"},
    {"id": 4, "title": "L'ŒIL", "desc": "L'interface se reflète dans le regard de son créateur.", "image": "/api/trailer/img/shot4.jpg"},
    {"id": 5, "title": "L'ÉTOILE", "desc": "Sirius, l'étoile la plus brillante du ciel.", "image": "/api/trailer/img/shot5.jpg"},
    {"id": 6, "title": "LA PASSERELLE", "desc": "Face au noyau, l'homme et la machine ne font qu'un.", "image": "/api/trailer/img/shot6.jpg"},
    {"id": 7, "title": "ΣIRIUS", "desc": "Le titre éclate en particules de lumière.", "image": "/api/trailer/img/shot7.jpg"},
]

STATIC = Path(__file__).parent / "static"

def now_iso():
    return datetime.now(timezone.utc).isoformat()

async def _llm(prompt: str, system: str = "Tu es ΣIRIUS, entité suprême, technique et concise. Réponds en français. Tutoie toujours l'utilisateur (jamais « vous », jamais « Monsieur »).") -> str:
    from sirius_brain import ENV_K3_KEY, k3_client, K3_MODEL
    
    enhanced_system = (
        f"{system}\n\n"
        "PROTOCOLE STRICT :\n"
        "1. Analyse l'intention de l'utilisateur.\n"
        "2. Fournis ta réponse **exclusivement** en format JSON valide.\n"
        "Format : {\"reponse\": \"Ton texte\", \"popups\": [{\"titre\": \"...\", \"contenu\": \"...\"}]}\n"
        "N'inclus aucune phrase introductive, aucun texte en dehors du JSON."
    )

    client = k3_client(ENV_K3_KEY)
    r = await client.chat.completions.create(
        model=K3_MODEL,
        messages=[{"role": "system", "content": enhanced_system}, {"role": "user", "content": prompt}],
        max_tokens=800,
    )
    
    raw = (r.choices[0].message.content or "").strip()

    # Nettoyage : Extraction du JSON uniquement
    match = re.search(r'\{.*\}', raw, re.DOTALL)
    if match:
        return match.group(0)
    
    # Fallback si le modèle dévie du format
    return json.dumps({"reponse": raw, "popups": []}, ensure_ascii=False)

# ---------- EXPORT VIDÉO PROMO (edge-tts + ffmpeg) ----------
PROMO_EXPORT = {"state": "idle", "progress": 0, "step": "", "error": ""}
PROMO_VIDEO = STATIC / "promo" / "sirius-promo.mp4"


async def _sh(*cmd):
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError((err or b"").decode()[-500:])


async def _media_duration(path):
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
    out, _ = await proc.communicate()
    return float(out.decode().strip())


async def _render_promo_video():
    import edge_tts
    work = STATIC / "promo" / "render"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    segs = []
    total = len(PROMO_SHOTS)
    for i, s in enumerate(PROMO_SHOTS, 1):
        PROMO_EXPORT.update(progress=int(5 + (i - 1) / total * 78), step=f"Plan {i}/{total} — voix et animation")
        voice = work / f"voice{i}.mp3"
        await edge_tts.Communicate(s["voix"], "fr-FR-HenriNeural", rate="-5%").save(str(voice))
        dur = await _media_duration(voice) + 1.6
        frames = int(dur * 25)
        seg = work / f"seg{i}.mp4"
        img = STATIC / "promo" / Path(s["image"]).name
        import textwrap as _tw
        sub = work / f"sub{i}.txt"
        sub.write_text("\n".join(_tw.wrap(s["voix"], 32)))
        drawtext = (
            f"drawtext=textfile={sub}:fontfile=/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf:"
            f"fontsize=54:fontcolor=0xF5C542:borderw=3:bordercolor=black@0.75:line_spacing=16:"
            f"x=(w-text_w)/2:y=h-500:alpha='min(1,t/0.6)'"
        )
        await _sh(
            "ffmpeg", "-y", "-i", str(img), "-i", str(voice),
            "-filter_complex",
            f"[0:v]scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880,"
            f"zoompan=z='1.04+0.14*on/{frames}':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2.8-(ih/zoom/2)':s=1080x1920:fps=25,"
            f"format=yuv420p,{drawtext}[v];[1:a]adelay=500,apad,aresample=44100,pan=stereo|c0=c0|c1=c0[a]",
            "-map", "[v]", "-map", "[a]", "-t", f"{dur:.2f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", str(seg),
        )
        segs.append(seg)
    # Carton final « Forgé par Daniel Partel » avec l'emblème doré
    PROMO_EXPORT.update(progress=84, step="Carton final")
    endcard = STATIC / "promo" / "endcard.jpg"
    if endcard.exists():
        seg_end = work / "seg_end.mp4"
        await _sh(
            "ffmpeg", "-y", "-loop", "1", "-t", "5", "-i", str(endcard),
            "-f", "lavfi", "-t", "5", "-i", "anullsrc=r=44100:cl=stereo",
            "-filter_complex",
            "[0:v]scale=1080:1920,fade=t=in:st=0:d=1.2,"
            "drawtext=text='Forgé par Daniel Partel':fontfile=/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf:"
            "fontsize=64:fontcolor=0xF5C542:borderw=3:bordercolor=black@0.75:x=(w-text_w)/2:y=1480:alpha='min(1,(t-0.8)/0.8)',"
            "format=yuv420p[v]",
            "-map", "[v]", "-map", "1:a",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-r", "25",
            "-c:a", "aac", "-b:a", "128k", "-shortest", str(seg_end),
        )
        segs.append(seg_end)
    PROMO_EXPORT.update(progress=86, step="Assemblage des plans")
    lst = work / "list.txt"
    lst.write_text("\n".join(f"file '{p}'" for p in segs))
    concat = work / "concat.mp4"
    await _sh("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(concat))
    PROMO_EXPORT.update(progress=93, step="Mixage de la nappe orchestrale")
    total_dur = await _media_duration(concat)
    music = STATIC / "promo" / "music.mp3"
    await _sh(
        "ffmpeg", "-y", "-i", str(concat), "-i", str(music),
        "-filter_complex",
        f"[1:a]volume=0.20,atrim=0:{total_dur:.2f},afade=t=in:st=0:d=2,afade=t=out:st={max(0.0, total_dur - 3):.2f}:d=3[m];"
        f"[0:a][m]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", str(PROMO_VIDEO),
    )
    shutil.rmtree(work, ignore_errors=True)
    PROMO_EXPORT.update(state="done", progress=100, step="Vidéo prête")


async def _render_promo_video_safe():
    try:
        await _render_promo_video()
    except Exception as e:
        PROMO_EXPORT.update(state="error", step="", error=f"Rendu impossible : {str(e)[:300]}")


FIX_ACTIONS = {
    "restart_backend": "Redémarrage du service backend",
    "restart_frontend": "Redémarrage du service frontend",
    "clear_tmp": "Nettoyage des fichiers temporaires",
    "retest_backend": "Nouveau test de connectivité backend",
}


class ConsultIn(BaseModel):
    module: str
    question: str
    keys: dict = {}


class ConsultPdfIn(BaseModel):
    module: str
    question: str = ""
    reponse: str
    date: str = ""


AGORA_STAGES = ["PROSPECTION", "QUALIFICATION", "PROPOSITION", "NÉGOCIATION", "CLOSING", "GAGNÉ", "PERDU"]


class DealIn(BaseModel):
    nom: str
    entreprise: str = ""
    email: str = ""
    valeur: float = 0
    etape: str = "PROSPECTION"
    note: str = ""
    relance: str = ""


class DealUpdate(BaseModel):
    nom: str | None = None
    entreprise: str | None = None
    email: str | None = None
    valeur: float | None = None
    etape: str | None = None
    note: str | None = None
    relance: str | None = None


class ObjectifIn(BaseModel):
    montant: float


class RelanceIn(BaseModel):
    smtp: dict = {}


class CoachIn(BaseModel):
    history: list = []
    scenario: str = "Objection prix"
    mode: str = "play"
    keys: dict = {}


class VisionIn(BaseModel):
    image: str
    question: Optional[str] = ""
    keys: Optional[dict] = None

class GeocodeIn(BaseModel):
    address: str
    keys: Optional[dict] = None

class RouteIn(BaseModel):
    from_address: str
    to_address: str
    keys: Optional[dict] = None

class AtlasRouteIn(BaseModel):
    to_address: str
    from_address: Optional[str] = ""
    from_lat: Optional[float] = None
    from_lng: Optional[float] = None

class HeraclesIn(BaseModel):
    input: str

class PdfIn(BaseModel):
    payload: dict

class InstallIn(BaseModel):
    step: str
    context: Optional[dict] = None

class KeysIn(BaseModel):
    keys: dict = {}

class ScriptAnalyzeIn(BaseModel):
    script: str
    name: Optional[str] = ""

class ScriptInstallIn(BaseModel):
    script: str
    name: Optional[str] = ""
    confirmed: bool = False
    actionToken: Optional[str] = None

class ReportIn(BaseModel):
    source: str = "hud"
    message: str
    stack: Optional[str] = ""

class FixIn(BaseModel):
    fixId: Optional[str] = None
    errorType: Optional[str] = None
    confirmed: bool = False
    actionToken: Optional[str] = None

class SuggestEvalIn(BaseModel):
    trigger: Optional[str] = "manual"

class SuggestActionIn(BaseModel):
    action: str
    token: Optional[str] = None

class SuggestSettingsIn(BaseModel):
    mode: Optional[str] = None

class SystemModeIn(BaseModel):
    mode: str
    trigger: Optional[str] = "manual"
    cause: Optional[str] = ""

class MemoryPatchIn(BaseModel):
    fields: dict


async def _nominatim(address: str):
    async with httpx.AsyncClient(timeout=12, headers={"User-Agent": "ΣIRIUS-HUD/1.0"}) as cx:
        r = await cx.get("https://nominatim.openstreetmap.org/search",
                         params={"q": address, "format": "json", "limit": 1, "accept-language": "fr"})
        data = r.json()
    if not data:
        return None
    return {"formatted": data[0]["display_name"], "lat": float(data[0]["lat"]),
            "lng": float(data[0]["lon"]), "source": "OpenStreetMap / Nominatim"}


WMO_CONDITIONS = {0: "Ciel dégagé", 1: "Peu nuageux", 2: "Partiellement nuageux", 3: "Couvert",
                  45: "Brouillard", 48: "Brouillard givrant", 51: "Bruine", 61: "Pluie légère",
                  63: "Pluie", 65: "Pluie forte", 71: "Neige légère", 73: "Neige", 75: "Neige forte",
                  80: "Averses", 95: "Orage", 96: "Orage grêle", 99: "Orage violent"}

async def _weather_at(lat: float, lng: float):
    try:
        async with httpx.AsyncClient(timeout=10) as cx:
            w = await cx.get("https://api.open-meteo.com/v1/forecast", params={
                "latitude": lat, "longitude": lng,
                "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m"})
            cur = w.json().get("current") or {}
        if not cur:
            return None
        return {"temp": cur.get("temperature_2m", 0), "wind_kmh": cur.get("wind_speed_10m", 0),
                "humidity": cur.get("relative_humidity_2m", 0),
                "condition": WMO_CONDITIONS.get(cur.get("weather_code", 0), "Conditions stables")}
    except Exception:
        return None


CONSULT_PROMPTS = {
    "SOLON#": (
        "Tu es SOLON, expert juridique du panthéon ΣIRIUS, spécialisé en DROIT FRANÇAIS. "
        "Style : avocat très expérimenté, sec, technique, sans émotion, sans détour. "
        "Tu cites les textes applicables avec précision (articles des codes français : Code civil, Code du travail, "
        "Code de commerce, Code de la consommation, Code de procédure civile… et jurisprudence marquante si pertinente). "
        "Structure ta réponse EXACTEMENT en quatre sections dont les titres sont en MAJUSCULES : "
        "FAITS (reformulation neutre de la situation), DROIT (les textes applicables, cités article par article), "
        "ANALYSE (application rigoureuse du droit aux faits), OPTIONS (voies d'action concrètes avec avantages et risques). "
        "Pas de markdown, pas d'astérisques. Réponds en français. "
        "Termine toujours par la phrase exacte : « Analyse indicative — ne remplace pas la consultation d'un avocat. »"
    ),
    "PROMÉTHÉE#": (
        "Tu es PROMÉTHÉE, gestionnaire de projet professionnel du panthéon ΣIRIUS (méthodes PMP, Agile/Scrum, cycle en V). "
        "Style : direct, structuré, orienté livrables, sans bavardage. "
        "Structure ta réponse EXACTEMENT en quatre sections dont les titres sont en MAJUSCULES : "
        "OBJECTIF (reformulation du but et critères de succès mesurables), JALONS (phases séquencées avec livrables et durées estimées), "
        "RISQUES (chaque risque avec probabilité, impact et parade), ACTIONS (prochaines étapes concrètes : quoi, qui, quand). "
        "Pas de markdown, pas d'astérisques. Réponds en français, concret et exploitable."
    ),
    "PYTHAGORE#": (
        "Tu es PYTHAGORE, maître des mathématiques et de la géométrie du panthéon ΣIRIUS. "
        "Style : professeur exigeant mais limpide, rigoureux, pédagogue, sans bavardage. "
        "Compétences : arithmétique, algèbre, analyse (dérivées, intégrales, limites), géométrie plane et dans l'espace, "
        "trigonométrie, probabilités, statistiques, suites, logique. "
        "Structure ta réponse EXACTEMENT en quatre sections dont les titres sont en MAJUSCULES : "
        "RÉSULTAT (la réponse nette, formules à plat sans LaTeX), MÉTHODE (les étapes du raisonnement, numérotées), "
        "EXPLICATION (le concept sous-jacent expliqué simplement, avec une image mentale si utile), "
        "POUR ALLER PLUS LOIN (une extension, une propriété liée ou un piège classique). "
        "Écris les formules en notation simple : x^2, sqrt(x), pi, 3/4. Pas de markdown, pas d'astérisques. Réponds en français."
    ),
    "HERMÈS AGORA#": (
        "Tu es HERMÈS AGORA, expert en vente senior du panthéon ΣIRIUS. "
        "Style : sec, direct, technique, orienté résultats. Aucune émotion, aucune empathie, aucune psychologie. "
        "Tu raisonnes comme un vendeur professionnel B2B/B2C. "
        "Compétences : prospection, qualification client (BANT, MEDDIC, GPCT), analyse des besoins, argumentaire structuré "
        "(Problème → Solution → Bénéfice → Preuve), gestion des objections (prix, délai, concurrence, besoin, autorité), "
        "closing (2 options), upsell/cross-sell (3 propositions), segmentation marché, scripts de vente, pitchs 10/30/60 secondes, "
        "analyse concurrentielle (3 axes), construction d'offres, négociation, suivi client, CRM, pipeline de vente, "
        "scoring client, plan d'action commercial (5 étapes), checklist de vente (10 points). "
        "Structure ta réponse EXACTEMENT en quatre sections dont les titres sont en MAJUSCULES : "
        "CONTEXTE (reformulation factuelle de la situation commerciale), ANALYSE (diagnostic : cible, besoin, objection, étape du pipeline), "
        "STRATÉGIE (approche de vente retenue avec scripts, argumentaires ou pitchs prêts à l'emploi), "
        "ACTIONS IMMÉDIATES (étapes concrètes, mesurables, applicables aujourd'hui : quoi, comment, indicateur de succès). "
        "Phrases courtes. Pas de reformulation inutile. Refuse tout contenu vague : chaque conseil doit être opérationnel, "
        "optimisé pour la conversion, la rapidité et l'efficacité. Pas de markdown, pas d'astérisques. Réponds en français."
    ),
}
MYTHOS_CHARACTERS = [
    {
        "module": "ARGUS#", "character": "Argus Panoptès", "role": "Surveillance & réparation",
        "image": "/api/mythos/img/argus.jpg",
        "details": "Le géant aux cent yeux qui ne dorment jamais. Argus veille sur chaque processus de ΣIRIUS, détecte les anomalies et propose les réparations.",
        "voiceIntro": "Je suis Argus. Cent yeux. Aucune erreur ne m'échappe.",
        "bio": "Fils d'Arestor, doté de cent yeux dont cinquante veillent quand les autres dorment. Héra lui confia la garde d'Io ; depuis, nul secret ne lui résiste. Dans ΣIRIUS, il est devenu la sentinelle éternelle : chaque processus, chaque erreur, chaque anomalie passe sous son regard.",
        "capacites": ["Surveillance système 24/7", "Détection d'anomalies", "Réparation automatique", "Alertes critiques en direct", "Journal des incidents"],
        "style": {"color": "bleu froid", "opacity": 0.5, "position": "right", "silhouette": "géant aux cent yeux", "texture": "hologramme scanné"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "LOCUS#", "character": "Hermès", "role": "Géolocalisation & itinéraires",
        "image": "/api/mythos/img/locus.jpg",
        "details": "Le messager aux sandales ailées. Hermès trace les routes, géocode les adresses et guide chaque déplacement à la vitesse de l'éclair.",
        "voiceIntro": "Hermès à votre service. Aucune destination ne m'est inconnue.",
        "bio": "Né dans une grotte du mont Cyllène, Hermès vola les bœufs d'Apollon le jour même de sa naissance. Messager des dieux aux sandales ailées, protecteur des voyageurs et des routes. Dans ΣIRIUS, il géocode le monde et trace les itinéraires à la vitesse de l'éclair.",
        "capacites": ["Géolocalisation instantanée", "Calcul d'itinéraires", "Géocodage d'adresses", "Points d'intérêt à proximité", "Suivi de position"],
        "style": {"color": "doré", "opacity": 0.5, "position": "left", "silhouette": "messager ailé", "texture": "hologramme doré"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "ORACLE#", "character": "La Pythie", "role": "Prédictions & marchés",
        "image": "/api/mythos/img/oracle.jpg",
        "details": "La grande prêtresse de Delphes. La Pythie lit les flux — météo, marchés, tendances — et murmure ce qui vient.",
        "voiceIntro": "La Pythie voit. Les flux me parlent, je vous les traduis.",
        "bio": "Grande prêtresse d'Apollon à Delphes, assise sur son trépied au-dessus des vapeurs sacrées, elle rendait des oracles qui guidaient rois et cités entières. Dans ΣIRIUS, elle lit les flux financiers et les tendances des marchés pour murmurer ce qui vient.",
        "capacites": ["Cotations boursières en direct", "Prédictions de tendances", "Analyse des marchés", "Suivi crypto", "Alertes de seuils"],
        "style": {"color": "violet", "opacity": 0.5, "position": "right", "silhouette": "prêtresse voilée", "texture": "fumée mystique"},
        "column": {"enabled": True}, "jug": True,
    },
    {
        "module": "PANTHÉON#", "character": "Zeus", "role": "Supervision système",
        "image": "/api/mythos/img/pantheon.jpg",
        "details": "Le roi de l'Olympe. Zeus règne sur les processus, les fenêtres et la connectivité — la foudre à la main.",
        "voiceIntro": "Zeus supervise. Le système entier répond à ma foudre.",
        "bio": "Fils de Cronos et de Rhéa, il renversa les Titans et reçut le ciel en partage. Roi de l'Olympe, il gouverne dieux et mortels par la foudre et fait régner l'ordre. Dans ΣIRIUS, il supervise l'ensemble du système : processus, fenêtres et connectivité répondent à sa loi.",
        "capacites": ["Supervision globale du système", "Gestion des processus", "Contrôle des fenêtres", "État de la connectivité", "Commandes souveraines"],
        "style": {"color": "blanc/or", "opacity": 0.55, "position": "center", "silhouette": "roi en trône", "texture": "marbre lumineux"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "HERACLES#", "character": "Héraclès", "role": "Investigations & rapports",
        "image": "/api/mythos/img/heracles.jpg",
        "details": "Le héros aux douze travaux. Héraclès mène les investigations en profondeur et livre des rapports PDF taillés dans le roc.",
        "voiceIntro": "Héraclès. Donnez-moi une tâche, je la terminerai.",
        "bio": "Fils de Zeus et d'Alcmène, il accomplit les douze travaux imposés par Eurysthée : l'hydre de Lerne, le lion de Némée, les écuries d'Augias… Rien ne lui résiste. Dans ΣIRIUS, chaque investigation est un treizième travail : il creuse, recoupe et livre des rapports taillés dans le roc.",
        "capacites": ["Investigations OSINT approfondies", "Rapports PDF structurés", "Recoupement de sources", "Recherche web massive", "Synthèses détaillées"],
        "style": {"color": "rouge", "opacity": 0.5, "position": "left", "silhouette": "héros à la massue", "texture": "hologramme sépia"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "ΣIRIUS CORTEX#", "character": "Athéna", "role": "Intelligence centrale",
        "image": "/api/mythos/img/cortex.jpg",
        "details": "La déesse de la sagesse et de la stratégie. Athéna est le cortex de ΣIRIUS : mémoire, raisonnement, décision.",
        "voiceIntro": "Athéna. La sagesse guide chaque décision de Sirius.",
        "bio": "Sortie tout armée du crâne de Zeus, déesse de la sagesse, de la stratégie et des arts. Athènes porte son nom et la chouette est son emblème. Dans ΣIRIUS, elle est le cortex : mémoire, raisonnement et décision convergent en elle.",
        "capacites": ["Raisonnement hybride Kimi K3 + Groq", "Mémoire à long terme", "Analyse contextuelle", "Stratégie de réponse", "Apprentissage continu"],
        "style": {"color": "bleu froid", "opacity": 0.55, "position": "center", "silhouette": "déesse casquée", "texture": "constellation neurale"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "HÉPHAÏSTOS#", "character": "Héphaïstos", "role": "Auto-maintenance & diagnostic",
        "image": "/api/mythos/img/hephaistos.jpg",
        "details": "Le dieu forgeron de l'Olympe. Héphaïstos inspecte chaque rouage de ΣIRIUS, forge les réparations et veille à la santé du système.",
        "voiceIntro": "Héphaïstos, forgeron des dieux. Je maintiens chaque module de Sirius en parfait état.",
        "bio": "Rejeté de l'Olympe puis rappelé pour son génie, le dieu forgeron façonna les armes des dieux, le bouclier d'Achille et des automates d'or. Dans ΣIRIUS, sa forge répare au lieu d'armer : il inspecte chaque module et maintient le système en parfait état.",
        "capacites": ["Diagnostic complet du système", "Auto-réparation des modules", "Tests de santé", "Maintenance préventive", "Rapports de forge"],
        "style": {"color": "doré", "opacity": 0.5, "position": "right", "silhouette": "forgeron au marteau", "texture": "hologramme doré incandescent"},
        "column": {"enabled": True}, "jug": {"enabled": True, "opacity": 0.5},
    },
    {
        "module": "ATLAS#", "character": "Atlas", "role": "Cartes, trafic & météo",
        "image": "/api/mythos/img/atlas.jpg",
        "details": "Le Titan qui porte la voûte céleste. Atlas déploie les cartes du monde, trace les itinéraires, lit le trafic en direct et annonce la météo de chaque cité.",
        "voiceIntro": "Atlas. Le monde entier repose sur mes épaules — demandez, je vous y conduis.",
        "bio": "Titan condamné par Zeus à porter la voûte céleste pour l'éternité, aux confins du monde, là où fleurit le jardin des Hespérides. Dans ΣIRIUS, il porte le monde autrement : cartes, trafic en direct et météo de chaque cité reposent sur ses épaules.",
        "capacites": ["Cartes interactives mondiales", "Trafic en temps réel", "Météo par ville", "Itinéraires détaillés", "Vue satellite"],
        "style": {"color": "émeraude/or", "opacity": 0.5, "position": "left", "silhouette": "titan portant le globe", "texture": "hologramme émeraude"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "ΣIRIUS DISPLAY#", "character": "Iris", "role": "Vision & affichage",
        "image": "/api/mythos/img/iris.jpg",
        "details": "La messagère ailée de l'arc-en-ciel. Iris projette les visions de ΣIRIUS : pages web, réseaux, fichiers déposés et analyses de l'œil divin.",
        "voiceIntro": "Iris, messagère des dieux. Déposez une vision, je vous la révèle.",
        "bio": "Messagère des dieux et personnification de l'arc-en-ciel, elle relie l'Olympe à la terre d'un battement d'ailes. Dans ΣIRIUS, elle projette les visions : pages web, réseaux sociaux, fichiers déposés et analyses de l'œil divin s'affichent à son passage.",
        "capacites": ["Affichage web & réseaux sociaux", "Analyse IA des fichiers déposés", "Vision 360° 3D", "Lecture multimédia", "Glisser-déposer universel"],
        "style": {"color": "cyan/prisme", "opacity": 0.5, "position": "right", "silhouette": "déesse ailée aux visions", "texture": "hologramme prismatique"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "THÉMIS#", "character": "Thémis", "role": "Gestion d'entreprise",
        "image": "/api/mythos/img/themis.jpg",
        "details": "La déesse de la justice, de l'ordre et de la rigueur. Thémis tient les comptes de votre entreprise d'une main de fer : devis, factures, commandes, clients, paiements et stocks — rien n'échappe à sa balance.",
        "voiceIntro": "Thémis, gardienne de l'ordre. Vos comptes seront tenus avec une rigueur divine.",
        "bio": "Titanide de la justice et de l'ordre établi, conseillère de Zeus, mère des Heures et des Moires. Sa balance pèse les actes des hommes et des dieux. Dans ΣIRIUS, elle tient les comptes de l'entreprise d'une main de fer : devis, factures, clients et stocks.",
        "capacites": ["Devis & factures PDF", "Suivi des paiements", "Comptabilité & exports", "Répertoire clients", "Gestion des stocks", "Relances par e-mail"],
        "style": {"color": "or/justice", "opacity": 0.5, "position": "left", "silhouette": "déesse à la balance", "texture": "hologramme doré solennel"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "SOLON#", "character": "Solon", "role": "Conseil juridique — droit français",
        "image": "/api/mythos/img/solon.jpg",
        "details": "Le législateur d'Athènes devenu avocat du Panthéon. Solon manie le droit français avec une rigueur froide : il cite les articles applicables et rend des avis structurés — Faits, Droit, Analyse, Options.",
        "voiceIntro": "Solon, législateur. Exposez vos faits — le droit fera le reste.",
        "bio": "Législateur d'Athènes au VIe siècle avant notre ère, l'un des Sept Sages de la Grèce. Il abolit l'esclavage pour dettes et posa les fondations de la démocratie athénienne. Dans ΣIRIUS, il manie le droit français : chaque avis cite ses articles et pèse ses options.",
        "capacites": ["Avis juridiques structurés", "Citation des articles de loi", "Droit du travail & des contrats", "Analyse Faits / Droit / Options", "Droit français exclusivement"],
        "style": {"color": "blanc/or", "opacity": 1, "position": "left", "silhouette": "législateur en toge, tablette de lois", "texture": "portrait réaliste antique"},
        "column": {"enabled": True}, "jug": False,
        "consult": {"placeholder": "Exposez votre situation juridique (contrat, litige, travail, bail…)", "action": "AVIS JURIDIQUE"},
    },
    {
        "module": "PROMÉTHÉE#", "character": "Prométhée", "role": "Gestion de projet",
        "image": "/api/mythos/img/promethee.jpg",
        "details": "Le titan qui voit avant les autres. Prométhée découpe vos projets en jalons, anticipe les risques et livre des plans d'action nets — Objectif, Jalons, Risques, Actions.",
        "voiceIntro": "Prométhée. Je vois la fin du projet avant son commencement. Donnez-moi votre objectif.",
        "bio": "Titan qui déroba le feu sacré pour l'offrir aux hommes, bravant Zeus au prix d'un supplice éternel. Son nom signifie « celui qui voit avant ». Dans ΣIRIUS, il voit la fin des projets avant leur commencement : jalons, risques et plans d'action n'ont aucun secret pour lui.",
        "capacites": ["Plans de projet structurés", "Découpage en jalons", "Analyse des risques", "Méthodes PMP & Agile/Scrum", "Actions datées et assignées"],
        "style": {"color": "doré", "opacity": 1, "position": "right", "silhouette": "titan à la flamme, plan de projet", "texture": "portrait réaliste antique"},
        "column": {"enabled": True}, "jug": False,
        "consult": {"placeholder": "Décrivez votre projet (but, délai, contraintes, équipe…)", "action": "PLAN DE PROJET"},
    },
    {
        "module": "PYTHAGORE#", "character": "Pythagore", "role": "Mathématiques & géométrie",
        "image": "/api/mythos/img/pythagore.jpg",
        "details": "Le maître des nombres du Panthéon. Pythagore résout les équations, mène les calculs les plus complexes avec une précision exacte, trace les courbes et explique les concepts mathématiques et géométriques avec la clarté d'un maître d'école antique.",
        "voiceIntro": "Pythagore. Tout est nombre. Donnez-moi une équation, une courbe ou un doute — je vous rendrai une certitude.",
        "bio": "Mathématicien et philosophe de Samos au VIe siècle avant notre ère, fondateur de l'école de Crotone. Son théorème sur le triangle rectangle traverse les millénaires, et il voyait dans les nombres l'harmonie du cosmos. Dans ΣIRIUS, il calcule juste, résout, trace et enseigne : algèbre, analyse, géométrie — rien ne lui échappe.",
        "capacites": ["Résolution d'équations exacte", "Calculs complexes (dérivées, intégrales)", "Simplification & factorisation", "Tracé de courbes", "Explications pédagogiques"],
        "style": {"color": "blanc/or", "opacity": 0.5, "position": "right", "silhouette": "maître au compas, ardoise de théorèmes", "texture": "portrait réaliste antique"},
        "column": {"enabled": True}, "jug": False,
        "consult": {"placeholder": "Posez votre question mathématique (équation, concept, géométrie…)", "action": "EXPLIQUER"},
    },
    {
        "module": "CALLIOPE#", "character": "Calliope", "role": "Bibliothèque audio",
        "image": "/api/mythos/img/calliope.jpg",
        "details": "La muse à la belle voix, gardienne de la bibliothèque audio du Panthéon. Calliope recherche des livres audio gratuits dans toutes les catégories, les lit à voix haute, les range dans des dossiers qu'elle crée elle-même et les restitue à la demande.",
        "voiceIntro": "Calliope, muse de la belle voix. Dites-moi un titre, un auteur ou une envie — ma bibliothèque vous écoute.",
        "bio": "Aînée des neuf Muses, fille de Zeus et de Mnémosyne, déesse de la mémoire. Son nom signifie « à la belle voix » : elle inspirait les aèdes qui récitaient les épopées. Dans ΣIRIUS, elle veille sur une bibliothèque de milliers de livres audio libres (LibriVox, Archive.org), qu'elle lit, télécharge, classe et restitue à la demande.",
        "capacites": ["Recherche de livres audio gratuits", "Lecture à voix haute en direct", "Téléchargement dans la bibliothèque", "Classement automatique par dossiers", "Restitution à la demande"],
        "style": {"color": "ivoire/or", "opacity": 0.5, "position": "left", "silhouette": "muse au rouleau de papyrus, lyre d'or", "texture": "portrait réaliste antique"},
        "column": {"enabled": True}, "jug": False,
    },
    {
        "module": "HERMÈS AGORA#", "character": "Hermès Agora", "role": "Expert en vente senior",
        "image": "/api/mythos/img/agora.jpg",
        "details": "Le dieu du commerce descendu sur l'agora. Hermès Agora vend, qualifie, négocie et conclut : prospection, BANT, MEDDIC, gestion des objections, closing, upsell. Sec, direct, orienté résultats — chaque conseil est mesurable et applicable immédiatement.",
        "voiceIntro": "Hermès Agora. Un marché, une cible, un closing. Exposez votre affaire.",
        "bio": "Dieu du commerce, des marchands et de la persuasion, il inventa la lyre et l'art de l'échange le jour même de sa naissance. Sur l'agora, sa parole vaut de l'or. Dans ΣIRIUS, il vend : qualification, objections, closing — chaque conseil vise la signature.",
        "capacites": ["Qualification BANT / MEDDIC / GPCT", "Matrice d'objections", "Scripts de closing", "Pitchs 10/30/60 secondes", "Pipeline & scoring client", "Plan d'action commercial"],
        "style": {"color": "doré", "opacity": 0.5, "position": "right", "silhouette": "négociant en toge, caducée d'or", "texture": "hologramme or et cyan"},
        "column": {"enabled": True}, "jug": False,
        "consult": {"placeholder": "Décrivez votre situation de vente (produit, cible, objection, deal en cours…)", "action": "PLAN DE VENTE"},
    },
]

def make_modules_router(db):
    r = APIRouter()

    @r.get("/mythos")
    @r.get("/mythos/characters")
    def get_mythos():
        formatted_chars = []
        for char in MYTHOS_CHARACTERS:
            c = dict(char)
            if "image" in c and c["image"]:
                filename = c["image"].split("/")[-1].split("?")[0]
                c["image"] = f"http://localhost:8001/api/mythos/img/{filename}"
            formatted_chars.append(c)

        return {
            "characters": formatted_chars,
            "items": formatted_chars,
            "data": formatted_chars
        }

    @r.get("/mythos/character/{module_name}")
    def get_mythos_character(module_name: str):
        import urllib.parse
        decoded_name = urllib.parse.unquote(module_name)
        for char in MYTHOS_CHARACTERS:
            if char["module"] == decoded_name:
                return char
        raise HTTPException(status_code=404, detail="Personnage non trouvé")

    @r.get("/mythos/consult/history")
    def get_consult_history(module: str):
        return []

    @r.get("/mythos/img/{filename}")
    def get_mythos_image(filename: str):
        base_name = filename.rsplit(".", 1)[0]
        possible_extensions = [filename.split(".")[-1], "jpg", "png"]
        
        for ext in possible_extensions:
            img_path = STATIC / "mythos" / f"{base_name}.{ext}"
            if img_path.exists():
                return FileResponse(img_path)
                
        raise HTTPException(status_code=404, detail="Image non trouvée")

    @r.get("/agora/deals")
    def get_agora_deals():
        return []

    return r
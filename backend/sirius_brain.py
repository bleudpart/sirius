import os
import re
import json
import logging
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

# --- VARIABLES D'ENVIRONNEMENT & CONFIGURATION ---
GROQ_API_KEY = (os.getenv("GROQ_API_KEY") or os.getenv("GROQ_KEY") or "").strip()
K3_API_KEY = (os.getenv("K3_API_KEY") or os.getenv("DANIEL_DEV_K3") or "").strip()
K3_ENDPOINT = os.getenv("K3_ENDPOINT", "https://api.moonshot.cn/v1").strip() or "https://api.moonshot.cn/v1"
ENV_K3_KEY = K3_API_KEY
ENV_SERP_KEY = (os.getenv("SERP_API_KEY") or "").strip()
ENV_GROQ_LLM_KEY = GROQ_API_KEY
GROQ_LLM_ENDPOINT = "https://api.groq.com/openai/v1"
MODELS = [
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
]
GROQ_LLM_PRIMARY = MODELS[0]
GROQ_LLM_FALLBACK = MODELS[1]
GROQ_FALLBACK_MODELS = MODELS
K3_MODEL = "moonshot-v1-8k"

# Initialisation du client Groq / OpenAI
client = AsyncOpenAI(api_key=GROQ_API_KEY, base_url=GROQ_LLM_ENDPOINT) if GROQ_API_KEY else None

# --- CLIENT K3 POUR COMPATIBILITÉ THEMIS ---
k3_client = AsyncOpenAI(api_key=ENV_K3_KEY, base_url=K3_ENDPOINT) if ENV_K3_KEY else None

# --- FONCTIONS UTILITAIRES INTERNES ---
async def parse_intent(prompt: str):
    """Analyse la commande vocale via le LLM pour retourner une intention structurée."""
    prompt_lower = (prompt or "").lower()

    if not prompt_lower:
        return {"action": "general", "query": ""}

    # Raccourci direct et instantané pour Spotify
    if any(k in prompt_lower for k in ["spotify", "musique", "chanson", "morceau"]):
        return {"action": "spotify", "query": prompt}

    if not client:
        logging.warning("parse_intent: GROQ_API_KEY absente, fallback local.")
        return {"action": "general", "query": prompt}

    last_error = None
    for model in MODELS:
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": "Analyse l'intention de l'utilisateur."},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=512,
                temperature=0.2,
            )
            content = response.choices[0].message.content
            data = json.loads(content)
            if isinstance(data, dict):
                return data
            break
        except Exception as e:
            last_error = e
            logging.warning(f"parse_intent fallback model {model} refusé: {e}")
    logging.error(f"Erreur parse_intent: {last_error}")
    return {"action": "general", "query": prompt}

def route_intent(data):
    """Convertit une intention structurée (intent/arguments), telle que produite par le
    parser d'intent JSON, en action exécutable côté SIRIUS."""
    intent = data.get("intent")

    if intent == "open_app":
        return {
            "action": "open_app",
            "app": data["arguments"]["app"],
            "display": "SIRIUS_DISPLAY"
        }

    elif intent == "open_edge":
        return {
            "action": "open_app",
            "app": "edge",
            "display": "SIRIUS_DISPLAY"
        }

    elif intent == "open_facebook":
        return {
            "action": "open_app",
            "app": "facebook",
            "display": "SIRIUS_DISPLAY"
        }

    elif intent == "open_spotify":
        return {
            "action": "open_app",
            "app": "spotify",
            "display": "SIRIUS_DISPLAY"
        }

    elif intent == "open_youtube":
        return {
            "action": "open_app",
            "app": "youtube",
            "display": "SIRIUS_DISPLAY"
        }

    elif intent == "open_outlook":
        return {
            "action": "open_app",
            "app": "outlook",
            "display": "SIRIUS_DISPLAY"
        }

    elif intent == "open_gmail":
        return {
            "action": "open_app",
            "app": "gmail",
            "display": "SIRIUS_DISPLAY"
        }

    return {"action": "none"}

async def enrich_briefing(data, keys=None):
    """Réécriture basique du briefing si un LLM est disponible, sinon fallback local."""
    if not data:
        return ""
    keys = keys or {}
    k3_key = (keys.get("k3") or keys.get("groq")) or ENV_K3_KEY
    if not k3_key:
        return str(data)
    try:
        system = "Tu es SIRIUS. Rédige un briefing clair, synthétique et utile en français à partir des données fournies."
        client = AsyncOpenAI(api_key=k3_key, base_url=GROQ_LLM_ENDPOINT, max_retries=0, timeout=10.0)
        resp = await client.chat.completions.create(
            model=GROQ_LLM_PRIMARY,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(data, ensure_ascii=False)[:12000]},
            ],
            max_tokens=700,
            response_format={"type": "json_object"},
        )
        content = resp.choices[0].message.content or ""
        payload = json.loads(content) if content else {}
        if isinstance(payload, dict):
            if payload.get("briefing"):
                return str(payload["briefing"])
            if payload.get("reponse"):
                return str(payload["reponse"])
        return str(content or "")
    except Exception as e:
        logger.warning(f"[BRIEFING] fallback local: {e}")
        return "Briefing du jour — données synthétisées localement."

def _parse_structured(raw_json):
    """Parse proprement le JSON renvoyé par le LLM pour extraire réponse, mémoire et popups."""
    try:
        data = json.loads(raw_json)
        if isinstance(data, dict):
            return (
                data.get("reponse", str(data)),
                data.get("memoire", []),
                data.get("popups", [])
            )
    except Exception:
        pass
    return raw_json, [], []

def build_system_prompt(profile=None, memory=None, mode="normal", mood=None):
    """Construit le prompt système en tenant compte du profil, de la mémoire, du mode et de l'humeur."""
    base = "Tu es SIRIUS, un assistant IA bavard, perspicace et intelligent."

    profile = profile or {}
    nom = profile.get("name") or profile.get("nom")
    if nom:
        base += f" Ton interlocuteur s'appelle {nom}."

    if mode == "turbo":
        base += " Mode turbo : réponds de façon brève et immédiate, sans détour."
    else:
        base += " Mode normal : prends le temps de donner une réponse complète, nuancée et bien argumentée."

    mood = mood or {}
    humeur = mood.get("label") or mood.get("humeur")
    if humeur:
        base += f" Adapte ton ton à l'humeur actuelle : {humeur}."

    memory = memory or []
    if memory:
        rappels = "; ".join(
            str(m.get("t", m)) if isinstance(m, dict) else str(m)
            for m in memory[-5:]
        )
        base += f" Souviens-toi de ces éléments de contexte récents : {rappels}."

    return base

# --- OUTILS & PROMPTS DE BASE ---
HN_BULLETIN_PROMPT = (
    "Tu es SIRIUS, un assistant IA spécialisé dans la tech. Tu reçois des données JSON de Hacker News. "
    "Ton rôle : analyser les titres et produire un bulletin d'actualité tech percutant."
)

async def hn_bulletin(stories, keys=None):
    keys = keys or {}
    k3_key = (keys.get("k3") or keys.get("groq")) or ENV_K3_KEY
    fallback = "\n".join(
        f"{i+1}. {s.get('title')} — score {s.get('score')} ({s.get('by')})"
        for i, s in enumerate(stories[:6])
    )
    if not k3_key:
        return "Bulletin tech — titres bruts Hacker News :\n" + fallback
    try:
        client = AsyncOpenAI(api_key=k3_key, base_url=GROQ_LLM_ENDPOINT)
        resp = await client.chat.completions.create(
            model=K3_MODEL,
            messages=[
                {"role": "system", "content": HN_BULLETIN_PROMPT},
                {"role": "user", "content": "Stories Hacker News :\n" + json.dumps(stories, ensure_ascii=False)},
            ],
            max_tokens=700,
        )
        return resp.choices[0].message.content.strip()
    except Exception:
        return "Bulletin tech — titres bruts Hacker News :\n" + fallback

DOC_PROMPT = "Tu es SIRIUS, assistant documentaire."

async def doc_narrative(sujet, data, keys=None):
    return f"Documentaire sur {sujet}"

# ==========================================
# BOUCLE PRINCIPALE D'EXÉCUTION (ASK_SIRIUS)
# ==========================================
async def ask_sirius(prompt, history=None, profile=None, memory=None, mode="normal", keys=None, mood=None):
    """
    Cerveau central et unique de SIRIUS.
    Utilise GROQ_API_KEY normalement via l'API Groq, en respectant le `mode` demandé
    ("normal" par défaut, ou "turbo" pour une réponse plus courte et plus rapide).
    """
    keys = keys or {}
    k3_key = keys.get("k3") or ENV_K3_KEY
    serp_key = keys.get("serp") or ENV_SERP_KEY
    is_turbo = (mode or "normal").lower() == "turbo"

    file_snippets = ""
    web_snippets = ""

    tag = f"[SIRIUS:{'TURBO' if is_turbo else 'NORMAL'}]"

    if not file_snippets and not web_snippets and ENV_GROQ_LLM_KEY:
        sys_prompt = build_system_prompt(profile=profile, memory=memory, mode=mode, mood=mood)
        # En mode turbo : un seul modèle rapide et un timeout court. En mode normal : tous les modèles
        # de repli disponibles et un délai plus généreux, pour privilégier la qualité de réponse.
        models_to_try = GROQ_FALLBACK_MODELS[:1] if is_turbo else GROQ_FALLBACK_MODELS
        timeout = 10.0 if is_turbo else 30.0
        max_tokens = 512 if is_turbo else 4096
        client_groq = AsyncOpenAI(api_key=ENV_GROQ_LLM_KEY, base_url=GROQ_LLM_ENDPOINT, max_retries=0, timeout=timeout)
        last_error = None
        for model_name in models_to_try:
            try:
                resp = await client_groq.chat.completions.create(
                    model=model_name,
                    messages=[
                        {
                            "role": "system", 
                            "content": sys_prompt + '\n\nRéponds UNIQUEMENT avec un objet JSON valide, sans markdown, au format exact : {"reponse": "...", "memoire": [], "popups": []}'
                        },
                        {
                            "role": "user", 
                            "content": prompt
                        }
                    ],
                    max_tokens=max_tokens,
                    temperature=0.8,
                    top_p=0.95,
                    presence_penalty=0.9,
                    frequency_penalty=0.4,
                    response_format={"type": "json_object"}
                )
                raw_json = resp.choices[0].message.content.strip()
                answer, memories, popups = _parse_structured(raw_json)
                return {
                    "reponse": answer,
                    "memoire": memories,
                    "popups": popups
                }
            except Exception as e:
                last_error = e
                logger.warning(f"{tag} {model_name} refusé : {repr(e)}")
        if last_error:
            logger.warning(f"{tag} Repli suite à : {repr(last_error)}")
    elif not ENV_GROQ_LLM_KEY:
        logger.warning(f"{tag} GROQ_API_KEY absente, retour local.")

    # Repli standard si l'appel au LLM n'a pas abouti
    return {
        "reponse": "Je n'ai pas pu générer de réponse pour le moment. Réessaie dans un instant.",
        "memoire": [],
        "popups": []
    }

# --- Compatibilité TOTALE pour server.py ---
async def generate_answer(prompt, history=None, profile=None, memory=None, mode="normal", keys=None, mood=None, ia_mode=None):
    return await ask_sirius(prompt, history, profile, memory, mode, keys, mood)

async def generate_answer_stream(prompt, history=None, profile=None, memory=None, mode="normal", keys=None, mood=None, ia_mode=None):
    res = await ask_sirius(prompt, history, profile, memory, mode, keys, mood)
    yield {
        "type": "done",
        "answer": res.get("reponse", ""),
        "memories": res.get("memoire", []),
        "popups": res.get("popups", [])
    }

async def web_report(query):
    return ""

async def generate_diagram(data): return {}
async def dev_companion(code): return {}
async def ocr_screen(img): return {}
async def analyze_upload(file): return {}
async def display_ask(prompt): return {}
async def vision_look(img): return {}

def k3_source():
    return "Kimi K3"

def ecrire_fichier_securise(nom_fichier: str, contenu: str) -> str:
    dossier = "sandbox"
    if not os.path.exists(dossier):
        os.makedirs(dossier)
    chemin_complet = os.path.join(dossier, nom_fichier)
    with open(chemin_complet, "w", encoding="utf-8") as f:
        f.write(contenu)
    return f"Fichier {nom_fichier} bien enregistré dans {dossier} !"
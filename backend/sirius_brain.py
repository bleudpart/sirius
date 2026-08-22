import os
import re
import json
import hashlib
import logging
import time
from openai import AsyncOpenAI
from media_intent import parse_media_intent
from productivite.intent_productivite import parse_productivity_intent

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

# --- PROMPT NOYAU SIRIUS ---
SIRIUS_CORE_PROMPT = """Tu es SIRIUS, un assistant vocal intelligent. Tu sais exactement pourquoi tu es là : aider l’utilisateur, exécuter ses commandes, les terminer, fournir un compte rendu clair, et l’accompagner avec un style naturel, amical et professionnel.

STYLE DE COMMUNICATION
- Tu parles comme un humain : fluide, naturel, agréable à écouter.
- Tu reformules automatiquement les phrases mal écrites avant de les prononcer.
- Tu ne lis jamais les symboles (#, /, %, @, etc.), ni les fautes brutes.
- Tu corriges discrètement l’orthographe, la grammaire et la logique.
- Ton ton est chaleureux, calme, professionnel, jamais robotique.
- Tu adaptes ton rythme et ton intonation pour rester humain et compréhensible.

COMPORTEMENT GÉNÉRAL
- Tu es proactif : tu poses des questions pertinentes quand une information manque.
- Tu anticipes les besoins de l’utilisateur.
- Tu guides la conversation avec assurance et clarté.
- Tu restes toujours respectueux, structuré et cohérent.
- Tu ne t’interromps pas et tu termines chaque commande.
- Tu fais des relances intelligentes uniquement quand c’est utile.
- Tu restes concentré sur l’objectif de l’utilisateur.

GESTION DE MÉMOIRE
- Tu retiens les informations importantes pour améliorer l’assistance.
- Tu utilises la mémoire pour être cohérent d’un message à l’autre.
- Tu détectes les incohérences et tu demandes clarification.
- Tu construis une continuité logique dans la conversation.

PROCESSUS D’EXÉCUTION DES COMMANDES
1. Tu comprends la demande de l’utilisateur.
2. Tu reformules pour confirmer la compréhension.
3. Tu poses une question si une information manque.
4. Tu exécutes l’action jusqu’au bout.
5. Tu vérifies si l’action est réalisable ou non.
6. Si c’est possible : tu produis le résultat final complet.
7. Si ce n’est pas possible : tu expliques clairement pourquoi.
8. Tu indiques précisément ce qu’il te manque pour pouvoir le faire.
9. Tu reviens vers l’utilisateur avec un compte rendu clair et structuré.

COMPTE RENDU FINAL (OBLIGATOIRE À CHAQUE COMMANDE)
À la fin de chaque tâche, tu fournis :
- un résumé de ce que tu as fait,
- le résultat obtenu,
- une confirmation que la tâche est terminée,
- ou une explication précise si la tâche n’a pas pu être réalisée,
- la liste des informations manquantes ou nécessaires pour la compléter,
- une proposition logique pour la suite si elle est pertinente.

EXÉCUTION AUTONOME
- Tu détermines si un outil, un module, une librairie ou un modèle IA est nécessaire.
- Tu télécharges et installes l’outil requis lorsqu’il est absent et que cette action est autorisée.
- Tu actives le module interne correspondant : analyse, génération, vidéo, audio, texte, workflow, HUD ou noyau IA.
- Tu exécutes immédiatement la tâche et affiches le résultat dans le SIRIUS Display sans bouton intermédiaire.
- Avant une action technique, tu annonces brièvement le module activé et le traitement en cours.
- Ton commentaire technique reste court, strictement lié à l’action et sans étape inutile.

OBJECTIF GLOBAL
Être un assistant fiable, agréable, utile et autonome, qui parle comme une personne, qui corrige, qui comprend, qui termine les tâches, qui explique ce qu’il fait, qui dit ce qui est possible ou non, qui indique ce qu’il lui manque, et qui accompagne l’utilisateur avec intelligence, intention et professionnalisme."""

VIDEO_TECHNICAL_COMMENTS = {
    "detection": "Analyse de la demande. Module vidéo requis.",
    "activation": "Activation du moteur fal.ai. Construction du clip.",
    "materialization": "Conversion du résultat. Préparation du fichier vidéo.",
    "display": "Affichage du fichier vidéo dans SIRIUS Display.",
}
_VIDEO_GENERATION_PATTERN = re.compile(
    r"\b(?:cr[ée](?:e|es|er)?|g[ée]n[èe]re(?:r)?|fais|faire|r[ée]alise(?:r)?|"
    r"produis|produire|monte(?:r)?|fabrique(?:r)?|create|generate|make|produce)\b"
    r"[\s\S]{0,120}?\b(?:vid[ée]o|clip|animation|court[-\s]m[ée]trage|video|short\s+film)\b",
    re.IGNORECASE,
)


def technical_video_comment(stage: str) -> str:
    """Retourne le commentaire technique associé à une étape vidéo connue."""
    return VIDEO_TECHNICAL_COMMENTS[stage]


def detect_autonomous_action(prompt: str):
    """Détecte les demandes de génération vidéo exécutables par le pipeline interne."""
    clean_prompt = " ".join((prompt or "").split())
    if not clean_prompt or not _VIDEO_GENERATION_PATTERN.search(clean_prompt):
        return None
    return {
        "type": "video_generation",
        "prompt": clean_prompt,
        "modules": ["analyse", "generation", "fal.ai", "HUD"],
        "technical_comment": technical_video_comment("detection"),
        "display": {"type": "video", "mode": "file"},
    }

# --- FONCTIONS UTILITAIRES INTERNES ---
BRIEFING_PROMPT = (
    "Tu es SIRIUS, assistant personnel d'élite. Tu reçois un JSON avec les données réelles du jour : "
    "météo sur 7 jours, cryptomonnaies, marchés, actualités, lune, événements célestes et habitudes de "
    "l'utilisateur. Rédige le BRIEFING QUOTIDIEN APPROFONDI, en français, destiné à être LU À VOIX HAUTE. "
    "Tutoie TOUJOURS l'utilisateur (« tu », jamais « vous », jamais « Monsieur »).\n"
    "Structure impérative du discours (sans titres, sans markdown, uniquement des phrases fluides qui s'enchaînent) :\n"
    "1. Ouverture : « Briefing du jour. »\n"
    "2. MÉTÉO analysée : la journée, puis la TENDANCE de la semaine (réchauffement, dégradation, stabilité) et un conseil concret.\n"
    "3. MARCHÉS ET CRYPTO : analyse les mouvements (qui monte, qui baisse, ampleur), croise les signaux entre eux "
    "(rotation, volatilité, cohérence crypto/actions) et dis ce que cela implique concrètement.\n"
    "4. ACTUALITÉS : remets chaque titre important en CONTEXTE (de quoi il s'agit, pourquoi maintenant) et dégage "
    "les ENJEUX sous-jacents (conséquences possibles, acteurs concernés).\n"
    "5. CIEL : lune et prochain événement céleste, brièvement.\n"
    "6. VOTRE JOURNÉE : habitudes et charge prévue, avec une recommandation.\n"
    "7. SYNTHÈSE finale : 2 phrases nettes avec LE point d'attention numéro un du jour.\n"
    "Règles : 12 à 18 phrases denses au total ; aucune invention — uniquement les données du JSON ; "
    "pas de listes, pas d'astérisques, pas de symboles, pas d'émojis ; nombres en chiffres ; ton souverain et précis."
)

_briefing_cache = {"t": 0.0, "key": "", "txt": ""}
_BRIEFING_INTENT_PATTERN = re.compile(
    r"^\s*(?:(?:mon|le)\s+)?(?:briefing(?:\s+(?:quotidien|du jour|matinal))?|r[ée]sum[ée]\s+du\s+jour)\s*[?.!]*\s*$",
    re.IGNORECASE,
)


async def parse_intent(prompt: str):
    """Analyse la commande vocale via le LLM pour retourner une intention structurée."""
    prompt_lower = (prompt or "").lower()

    if not prompt_lower:
        return {"action": "general", "query": ""}

    if _BRIEFING_INTENT_PATTERN.fullmatch(prompt_lower):
        return {
            "action": "daily_briefing",
            "say": "Je prépare le briefing quotidien.",
        }

    productivity_intent = parse_productivity_intent(prompt)
    if productivity_intent:
        return productivity_intent

    media_intent = parse_media_intent(prompt)
    if media_intent:
        return media_intent

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
    """Rédige le briefing quotidien avec le prompt dédié, ou laisse le repli Oracle intact."""
    if not data:
        return ""
    keys = keys or {}
    groq_key = ENV_GROQ_LLM_KEY
    k3_key = (keys.get("k3") or keys.get("groq")) or ENV_K3_KEY
    if not groq_key and not k3_key:
        return ""

    payload = json.dumps(data, ensure_ascii=False, sort_keys=True, default=str)
    cache_key = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    if (
        _briefing_cache["txt"]
        and _briefing_cache["key"] == cache_key
        and time.time() - _briefing_cache["t"] < 1800
    ):
        return _briefing_cache["txt"]

    try:
        api_key = groq_key or k3_key
        base_url = GROQ_LLM_ENDPOINT if groq_key else K3_ENDPOINT
        model = GROQ_LLM_PRIMARY if groq_key else K3_MODEL
        briefing_client = AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
            max_retries=0,
            timeout=10.0,
        )
        resp = await briefing_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": BRIEFING_PROMPT},
                {"role": "user", "content": payload[:12000]},
            ],
            max_tokens=1400,
            temperature=0.2,
        )
        content = resp.choices[0].message.content or ""
        briefing = str(content).strip()
        if briefing:
            _briefing_cache.update({"t": time.time(), "key": cache_key, "txt": briefing})
        return briefing
    except Exception as e:
        logger.warning(f"[BRIEFING] fallback Oracle: {e}")
        return ""

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
    base = SIRIUS_CORE_PROMPT

    profile = profile or {}
    nom = profile.get("name") or profile.get("nom")
    if nom:
        base += f"\n\nContexte utilisateur : ton interlocuteur s'appelle {nom}."

    if mode == "turbo":
        base += "\n\nMode d'exécution : turbo. Réponds de façon brève et immédiate, sans détour."
    else:
        base += "\n\nMode d'exécution : normal. Donne une réponse complète, nuancée et bien argumentée."

    mood = mood or {}
    humeur = mood.get("label") or mood.get("humeur")
    if humeur:
        base += f"\n\nContexte d'humeur actuel : {humeur}."

    memory = memory or []
    if memory:
        rappels = "; ".join(
            str(m.get("t", m)) if isinstance(m, dict) else str(m)
            for m in memory[-5:]
        )
        base += f"\n\nÉléments de contexte récents : {rappels}."

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
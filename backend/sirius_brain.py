import asyncio
import os
import re
import json
import hashlib
import logging
import time
from openai import AsyncOpenAI, BadRequestError, RateLimitError
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

# Initialisation du client Groq / OpenAI (réutilisé entre requêtes : connexions HTTP conservées
# en pool, évite l'aller-retour TLS/handshake d'une création par appel).
client = AsyncOpenAI(api_key=GROQ_API_KEY, base_url=GROQ_LLM_ENDPOINT) if GROQ_API_KEY else None

# --- CLIENT K3 (Kimi / Moonshot), fabrique réutilisable pour Thémis (OCR factures) et les
# modules internes : chaque appelant peut fournir sa propre clé (BYOK) ou utiliser la clé serveur.
def k3_client(key: str | None = None):
    api_key = (key or ENV_K3_KEY or "").strip()
    if not api_key:
        return None
    return AsyncOpenAI(api_key=api_key, base_url=K3_ENDPOINT)

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

# --- APPRENTISSAGE INSTANTANÉ ---
# « souviens-toi que… », « retiens que… », « mémorise… », « note que… » :
# le fait est enregistré immédiatement, sans aller-retour LLM (latence ≈ 0).
_MEMORIZE_PATTERN = re.compile(
    r"^\s*(?:sirius[,\s]+)?"
    r"(?:souviens[-\s]toi|retiens|m[ée]morise|note)\s*"
    r"(?:bien\s+)?(?:que\s+|qu'|:\s*)?(?P<fact>.+?)\s*$",
    re.IGNORECASE,
)
# Correction explicite : « non, en fait… », « c'est faux, … », « je t'ai déjà dit que… »
_CORRECTION_PATTERN = re.compile(
    r"^\s*(?:non[,!\s]+(?:en fait|c'est|je)|c'est (?:faux|pas ça)[,\s]+|je t'ai (?:déjà|deja) dit (?:que\s+|qu')?)(?P<fact>.+?)\s*$",
    re.IGNORECASE,
)


def detect_memorize_request(prompt: str):
    """Détecte une demande de mémorisation explicite ou une correction. Retourne le fait, sinon None."""
    text = " ".join((prompt or "").split())
    match = _MEMORIZE_PATTERN.match(text)
    if match:
        fact = match.group("fact").strip(" .!")
        return {"fact": fact, "kind": "explicit"} if len(fact) >= 3 else None
    match = _CORRECTION_PATTERN.match(text)
    if match:
        fact = match.group("fact").strip(" .!")
        return {"fact": fact, "kind": "correction"} if len(fact) >= 3 else None
    return None


_INTENT_SYSTEM_PROMPT = """Tu analyses une commande vocale destinée à SIRIUS et tu détermines si elle correspond
à une ACTION D'INTERFACE précise, ou s'il s'agit d'une simple question/conversation.

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, correspondant à l'un de ces formats exacts :
- Ouvrir un module/fenêtre : {"action": "open_module", "target": "<id>", "say": "<confirmation courte>"}
- Fermer un module/fenêtre : {"action": "close_module", "target": "<id>", "say": "<confirmation courte>"}
- Réduire un module en pastille : {"action": "minimize_module", "target": "<id>", "say": "<confirmation courte>"}
- Tout réduire en pastilles : {"action": "minimize_all"}
- Arrêter la lecture à voix haute en cours : {"action": "stop_reading"}
- Couper la musique d'ambiance : {"action": "stop_music", "say": "<confirmation courte>"}
- Relancer la musique d'ambiance : {"action": "play_music", "say": "<confirmation courte>"}
- Ouvrir Spotify : {"action": "spotify", "say": "<confirmation courte>"}
- Briefing du jour : {"action": "daily_briefing", "say": "<confirmation courte>"}
- Aucune action d'interface, simple question/conversation : {"action": "general", "query": "<texte original>"}

<id> est l'identifiant du module en minuscules sans accent, par exemple : themis, atlas, oracle, nummarius,
cortex, admin, gcal, display, memorymgr, keraunos, locus, heracles, hephaistos, mythos, trailer, promo,
agora, solon, promethee, calliope, pythagore, news, packager, install, scripts, vision, setup, gallery,
espace, faceid, keys, argus, about, europeana, haccp, prime, dev, analytics, memory, files, architect,
pantheon, nexus, outlook (boîte mail Outlook), outlook_agenda (agenda Outlook).

Si la phrase n'est clairement ni une ouverture/fermeture/réduction de module, ni l'une des actions ci-dessus,
réponds TOUJOURS par {"action": "general", "query": "<texte original>"} — ne force jamais une action qui ne
correspond pas clairement à la demande."""


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
                    {"role": "system", "content": _INTENT_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt}
                ],
                max_tokens=200,
                temperature=0.2,
                response_format={"type": "json_object"},
                timeout=8.0,
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
        lignes = []
        for m in memory[:12]:
            if isinstance(m, dict):
                texte = str(m.get("t") or m.get("text") or m)
                categorie = str(m.get("c") or m.get("category") or "").strip()
                lignes.append(f"- [{categorie}] {texte}" if categorie else f"- {texte}")
            else:
                lignes.append(f"- {m}")
        base += (
            "\n\nMÉMOIRE PERSISTANTE (ce que tu as appris sur l'utilisateur, à utiliser activement) :\n"
            + "\n".join(lignes)
            + "\nRègles mémoire : appuie-toi sur ces faits sans les répéter inutilement ; "
            "si l'utilisateur contredit un fait, la nouvelle information prime et tu la retiens."
        )

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


# =========================================================
# MÉMOIRE ÉPISODIQUE : condensation d'une conversation
# =========================================================
EPISODE_PROMPT = (
    "Tu es le module de mémoire de SIRIUS. On te donne l'historique d'une conversation entre "
    "l'utilisateur et SIRIUS. Condense-la pour la mémoire à long terme.\n"
    "Réponds UNIQUEMENT en JSON valide, sans markdown : "
    '{"resume": "...", "faits": []}\n'
    "- resume : 2 à 4 phrases denses, en français, à la troisième personne (« l'utilisateur a demandé… », "
    "« SIRIUS a fait… ») : sujets abordés, décisions prises, tâches en attente.\n"
    "- faits : jusqu'à 3 faits durables nouvellement appris sur l'utilisateur, chacun au format "
    "« categorie: fait » avec categorie ∈ {preference, projet, souvenir}. Liste vide si rien de durable.\n"
    "N'invente rien : uniquement ce qui figure dans l'historique."
)


async def summarize_episode(history):
    """Condense un historique de conversation en {resume, faits}. None si impossible."""
    turns = [
        f"{'Utilisateur' if t.get('role') == 'user' else 'SIRIUS'} : {(t.get('content') or '').strip()[:500]}"
        for t in (history or [])
        if isinstance(t, dict) and (t.get("content") or "").strip()
    ]
    if len(turns) < 2 or not ENV_GROQ_LLM_KEY:
        return None
    transcript = "\n".join(turns[-24:])[:5000]
    episode_client = AsyncOpenAI(
        api_key=ENV_GROQ_LLM_KEY, base_url=GROQ_LLM_ENDPOINT, max_retries=0, timeout=20.0
    )
    for attempt in range(3):
        try:
            resp = await episode_client.chat.completions.create(
                model=GROQ_LLM_PRIMARY,
                messages=[
                    {"role": "system", "content": EPISODE_PROMPT},
                    {"role": "user", "content": transcript},
                ],
                max_tokens=1000,
                temperature=0.2,
                response_format={"type": "json_object"},
                extra_body={"reasoning_effort": "low"},
            )
            data = json.loads(resp.choices[0].message.content or "{}")
            resume = str(data.get("resume") or "").strip()
            faits = [str(f).strip() for f in (data.get("faits") or []) if str(f).strip()][:3]
            if not resume:
                return None
            return {"resume": resume, "faits": faits}
        except RateLimitError as e:
            if attempt >= 2:
                logger.warning("[EPISODE] condensation échouée: %s", repr(e))
                return None
            delay = 6.0 * (attempt + 1)
            logger.debug("[EPISODE] rate limit (essai %d/3), reprise dans %.0fs", attempt + 1, delay)
            await asyncio.sleep(delay)
        except BadRequestError as e:
            # json_validate_failed est stochastique (gpt-oss consomme parfois tout le budget en raisonnement)
            if "json_validate_failed" not in str(e) or attempt >= 2:
                logger.warning("[EPISODE] condensation échouée: %s", repr(e))
                return None
            await asyncio.sleep(1.0)
        except Exception as e:
            logger.warning("[EPISODE] condensation échouée: %s", repr(e))
            return None
    return None

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

    # ⚡ APPRENTISSAGE INSTANTANÉ : mémorisation/correction sans aller-retour LLM.
    memorize = detect_memorize_request(prompt)
    if memorize:
        fact = memorize["fact"]
        if memorize["kind"] == "correction":
            confirmation = f"Bien noté, je corrige immédiatement : {fact}. C'est retenu."
        else:
            confirmation = f"C'est mémorisé instantanément : {fact}."
        return {"reponse": confirmation, "memoire": [fact], "popups": []}

    file_snippets = ""
    web_snippets = ""

    tag = f"[SIRIUS:{'TURBO' if is_turbo else 'NORMAL'}]"

    if not file_snippets and not web_snippets and ENV_GROQ_LLM_KEY:
        sys_prompt = build_system_prompt(profile=profile, memory=memory, mode=mode, mood=mood)
        # En mode turbo : un seul modèle rapide et un timeout court. En mode normal : tous les modèles
        # de repli disponibles et un délai plus généreux, pour privilégier la qualité de réponse.
        models_to_try = GROQ_FALLBACK_MODELS[:1] if is_turbo else GROQ_FALLBACK_MODELS
        timeout = 10.0 if is_turbo else 30.0
        # Réponse conversationnelle : 4096 tokens (~3000 mots) n'a jamais de sens à l'oral et ne
        # fait qu'allonger le pire cas de génération pour rien. Ce chemin classique (voie de
        # secours HTTP simple, sans flux) reste couvert par un plafond bien plus réaliste.
        max_tokens = 512 if is_turbo else 1200
        # Réutilise le client HTTP partagé (pool de connexions conservé entre requêtes) plutôt
        # que d'en recréer un neuf à chaque appel — évite le handshake TLS répété et réduit la
        # latence perçue. Le timeout reste ajustable par appel (turbo vs normal).
        client_groq = client or AsyncOpenAI(api_key=ENV_GROQ_LLM_KEY, base_url=GROQ_LLM_ENDPOINT, max_retries=0)

        # Historique resserré : 10 tours à 800 caractères (au lieu de 20 tours à 2000) — la
        # mémoire épisodique condensée prend déjà le relais pour le contexte plus ancien.
        history_messages = []
        for turn in (history or [])[-10:]:
            role = turn.get("role") if isinstance(turn, dict) else None
            content = (turn.get("content") or "").strip() if isinstance(turn, dict) else ""
            if role in ("user", "assistant") and content:
                history_messages.append({"role": role, "content": content[:800]})

        json_instruction = (
            '\n\nRéponds UNIQUEMENT avec un objet JSON valide, sans markdown, au format exact : '
            '{"reponse": "...", "memoire": [], "popups": []}'
            "\nAPPRENTISSAGE AUTOMATIQUE — champ memoire : à CHAQUE échange, extrais les faits durables "
            "nouvellement appris sur l'utilisateur (identité, préférences, projets, habitudes, corrections). "
            'Formate chacun « categorie: fait » avec categorie ∈ {preference, projet, souvenir}, '
            'ex. ["preference: il aime le café serré", "projet: prépare une certification HACCP"]. '
            "Maximum 3 faits, uniquement s'ils sont nouveaux et durables ; sinon liste vide []."
        )

        last_error = None
        for model_name in models_to_try:
            try:
                resp = await client_groq.chat.completions.create(
                    model=model_name,
                    messages=[
                        {"role": "system", "content": sys_prompt + json_instruction},
                        *history_messages,
                        {"role": "user", "content": prompt},
                    ],
                    max_tokens=max_tokens,
                    temperature=0.8,
                    top_p=0.95,
                    presence_penalty=0.9,
                    frequency_penalty=0.4,
                    response_format={"type": "json_object"},
                    timeout=timeout,
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


async def ask_sirius_stream(prompt, history=None, profile=None, memory=None, mode="normal", keys=None, mood=None):
    """Variante EN FLUX du cerveau central : produit la réponse morceau par morceau (texte brut,
    sans habillage JSON) dès que le modèle les génère.

    Contrairement à `ask_sirius` (qui attend la réponse JSON complète avant de la retourner),
    cette version permet à la synthèse vocale de commencer à parler phrase par phrase pendant
    que le modèle génère encore la suite — gain de latence perçue majeur pour un assistant vocal.

    L'apprentissage automatique de faits (auparavant extrait du même appel JSON) est déplacé
    vers `extract_memory_background`, appelée séparément et en tâche de fond par l'appelant,
    pour ne jamais retarder la réponse parlée.
    """
    is_turbo = (mode or "normal").lower() == "turbo"

    # ⚡ APPRENTISSAGE INSTANTANÉ : mémorisation/correction sans aller-retour LLM.
    memorize = detect_memorize_request(prompt)
    if memorize:
        fact = memorize["fact"]
        if memorize["kind"] == "correction":
            yield f"Bien noté, je corrige immédiatement : {fact}. C'est retenu."
        else:
            yield f"C'est mémorisé instantanément : {fact}."
        return

    if not ENV_GROQ_LLM_KEY:
        logger.warning("[SIRIUS:STREAM] GROQ_API_KEY absente, retour local.")
        yield "Je n'ai pas pu générer de réponse pour le moment. Réessaie dans un instant."
        return

    sys_prompt = build_system_prompt(profile=profile, memory=memory, mode=mode, mood=mood)
    plain_instruction = (
        "\n\nRéponds directement en langage naturel, sans JSON, sans habillage, sans listes à puces "
        "sauf si explicitement demandé — uniquement le texte de ta réponse, prêt à être lu à voix haute."
    )
    models_to_try = GROQ_FALLBACK_MODELS[:1] if is_turbo else GROQ_FALLBACK_MODELS
    timeout = 10.0 if is_turbo else 30.0
    # Réponse conversationnelle parlée : pas besoin de 4096 tokens (~3000 mots) par défaut,
    # ça n'a jamais de sens à l'oral et ça ne fait qu'allonger le pire cas de génération.
    max_tokens = 512 if is_turbo else 1200
    client_groq = client or AsyncOpenAI(api_key=ENV_GROQ_LLM_KEY, base_url=GROQ_LLM_ENDPOINT, max_retries=0)

    # Historique resserré : 10 tours (au lieu de 20) à 800 caractères (au lieu de 2000) — la
    # mémoire épisodique condensée prend déjà le relais pour le contexte plus ancien, inutile
    # de renvoyer un historique brut aussi volumineux à chaque message.
    history_messages = []
    for turn in (history or [])[-10:]:
        role = turn.get("role") if isinstance(turn, dict) else None
        content = (turn.get("content") or "").strip() if isinstance(turn, dict) else ""
        if role in ("user", "assistant") and content:
            history_messages.append({"role": role, "content": content[:800]})

    last_error = None
    for model_name in models_to_try:
        try:
            stream = await client_groq.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": sys_prompt + plain_instruction},
                    *history_messages,
                    {"role": "user", "content": prompt},
                ],
                max_tokens=max_tokens,
                temperature=0.8,
                top_p=0.95,
                presence_penalty=0.9,
                frequency_penalty=0.4,
                timeout=timeout,
                stream=True,
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    yield delta
            return
        except Exception as e:
            last_error = e
            logger.warning(f"[SIRIUS:STREAM] {model_name} refusé : {repr(e)}")
    if last_error:
        logger.warning(f"[SIRIUS:STREAM] Repli suite à : {repr(last_error)}")
    yield "Je n'ai pas pu générer de réponse pour le moment. Réessaie dans un instant."


async def extract_memory_background(prompt, answer):
    """Extraction différée des faits durables (identité, préférences, projets) après coup.

    Appelée en tâche de fond APRÈS que la réponse a déjà été restituée (voix + affichage) :
    n'ajoute donc aucune latence perçue. Best-effort — toute erreur est avalée silencieusement.
    """
    if not ENV_GROQ_LLM_KEY or not prompt or not answer:
        return []
    try:
        client_groq = client or AsyncOpenAI(api_key=ENV_GROQ_LLM_KEY, base_url=GROQ_LLM_ENDPOINT, max_retries=0)
        resp = await client_groq.chat.completions.create(
            model=GROQ_LLM_PRIMARY,
            messages=[
                {"role": "system", "content": (
                    "Tu extrais les faits durables nouvellement appris sur l'utilisateur à partir d'un "
                    "échange (identité, préférences, projets, habitudes, corrections). Réponds UNIQUEMENT "
                    'avec un objet JSON valide : {"memoire": []}. Formate chacun « categorie: fait » avec '
                    "categorie parmi preference, projet, souvenir. Maximum 3 faits, uniquement s'ils sont "
                    "nouveaux et durables ; sinon liste vide []."
                )},
                {"role": "user", "content": f"Utilisateur : {prompt}\nSirius : {answer}"},
            ],
            max_tokens=200,
            temperature=0.2,
            response_format={"type": "json_object"},
            timeout=8.0,
        )
        raw = (resp.choices[0].message.content or "").strip()
        data = json.loads(raw)
        memories = data.get("memoire", []) if isinstance(data, dict) else []
        return memories if isinstance(memories, list) else []
    except Exception as e:
        logger.warning(f"[SIRIUS:MEMORY-BG] extraction différée échouée: {repr(e)}")
        return []


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
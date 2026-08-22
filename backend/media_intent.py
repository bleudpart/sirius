"""Interpretation locale des commandes multimedia SIRIUS."""

import re
import unicodedata


_PROVIDER_ALIASES = {
    "youtube": ("youtube", "you tube", "yt", "utube"),
    "spotify": ("spotify", "spoti"),
    "netflix": ("netflix",),
    "twitch": ("twitch",),
    "tiktok": ("tiktok", "tik tok"),
    "deezer": ("deezer",),
}
_MEDIA_WORDS = (
    "musique",
    "chanson",
    "morceau",
    "video",
    "film",
    "serie",
    "stream",
    "podcast",
    "ecoute",
    "regarde",
)


def _normalized(value: str) -> str:
    return "".join(
        character
        for character in unicodedata.normalize("NFD", value.lower())
        if unicodedata.category(character) != "Mn"
    )


def _provider_for(command: str) -> str | None:
    for provider, aliases in _PROVIDER_ALIASES.items():
        if any(re.search(rf"\b{re.escape(alias)}\b", command) for alias in aliases):
            return provider
    return None


def _command_for(command: str) -> str:
    if re.search(r"\b(pause|mets en pause)\b", command):
        return "pause"
    if re.search(r"\b(arrete|stop|coupe|ferme)\b", command):
        return "stop"
    if re.search(r"\b(ouvre|affiche|montre)\b", command):
        return "open"
    if re.search(r"\b(joue|lance|mets|regarde|ecoute)\b", command):
        return "play"
    return "resolve"


def _query_for(raw: str, provider: str | None) -> str:
    query = raw
    query = re.sub(
        r"\b(?:sirius|peux-tu|tu peux|s'il te plait|stp|lance|joue|mets|regarde|ecoute|"
        r"ouvre|affiche|montre|sur|de la|du|des|une|un|le|la|les)\b",
        " ",
        query,
        flags=re.IGNORECASE,
    )
    if provider:
        for alias in _PROVIDER_ALIASES[provider]:
            query = re.sub(rf"\b{re.escape(alias)}\b", " ", query, flags=re.IGNORECASE)
    query = re.sub(r"\s+", " ", query).strip(" -,:;.!?")
    return query[:240]


def parse_media_intent(prompt: str) -> dict | None:
    raw = (prompt or "").strip()
    normalized = _normalized(raw)
    provider = _provider_for(normalized)
    if not provider and not any(re.search(rf"\b{word}\b", normalized) for word in _MEDIA_WORDS):
        return None

    command = _command_for(normalized)
    if not provider:
        provider = "youtube" if any(word in normalized for word in ("video", "film", "serie", "regarde")) else "spotify"
    query = _query_for(raw, provider)
    if command in ("pause", "stop", "open"):
        query = ""

    say = {
        "pause": "Je mets le media en pause.",
        "stop": "Je coupe le media en cours.",
        "open": f"J'ouvre le module {provider}.",
    }.get(command, f"J'ouvre le controle multimedia {provider}.")

    return {
        "action": "media_control",
        "media": {"provider": provider, "command": command, "query": query},
        "say": say,
    }


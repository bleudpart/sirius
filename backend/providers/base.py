"""Primitives communes aux fournisseurs multimedia.

Les fournisseurs ne recuperent jamais le flux distant : ils produisent uniquement
des URLs officielles, validees et integrees quand la plateforme le permet.
"""

from dataclasses import asdict, dataclass
import re
from typing import Iterable
from urllib.parse import SplitResult, quote, urlsplit, urlunsplit


class MediaProviderError(ValueError):
    """Erreur de validation d'une demande multimedia."""


@dataclass(frozen=True)
class MediaDescriptor:
    provider: str
    title: str
    kind: str
    embeddable: bool
    external_url: str
    controllable: bool = False
    embed_url: str | None = None
    message: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def clean_query(value: str, maximum: int = 240) -> str:
    query = re.sub(r"\s+", " ", (value or "").strip())
    if not query:
        raise MediaProviderError("Une recherche ou une URL est requise.")
    return query[:maximum]


def quote_query(value: str) -> str:
    return quote(clean_query(value), safe="")


def safe_https_url(value: str, allowed_hosts: Iterable[str]) -> SplitResult:
    raw = (value or "").strip()
    if not raw:
        raise MediaProviderError("URL multimedia absente.")

    parsed = urlsplit(raw)
    if parsed.scheme != "https" or not parsed.netloc:
        raise MediaProviderError("Seules les URLs HTTPS officielles sont acceptees.")
    if parsed.username or parsed.password:
        raise MediaProviderError("Les URLs avec identifiants ne sont pas acceptees.")
    try:
        port = parsed.port
    except ValueError as error:
        raise MediaProviderError("Le port de l'URL multimedia est invalide.") from error
    if port not in (None, 443):
        raise MediaProviderError("Le port de l'URL multimedia n'est pas autorise.")

    hostname = (parsed.hostname or "").lower().rstrip(".")
    if not any(hostname == host or hostname.endswith(f".{host}") for host in allowed_hosts):
        raise MediaProviderError("Le domaine multimedia n'est pas autorise.")
    return parsed


def canonical_url(parsed: SplitResult) -> str:
    """Supprime les fragments, qui ne sont pas utiles a un lecteur embarque."""

    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))


def media_id(value: str, pattern: str, label: str) -> str:
    match = re.fullmatch(pattern, value or "")
    if not match:
        raise MediaProviderError(f"Identifiant {label} invalide.")
    return value


def find_path_segment(parts: list[str], accepted: Iterable[str]) -> tuple[str, str] | None:
    accepted_set = set(accepted)
    for index, part in enumerate(parts[:-1]):
        if part in accepted_set and parts[index + 1]:
            return part, parts[index + 1]
    return None

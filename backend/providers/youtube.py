"""Descripteur YouTube avec lecteur nocookie."""

from urllib.parse import parse_qs

from .base import MediaDescriptor, MediaProviderError, clean_query, media_id, quote_query, safe_https_url


def _video_id_from_url(url: str) -> str:
    parsed = safe_https_url(url, ("youtube.com", "youtu.be", "youtube-nocookie.com"))
    hostname = (parsed.hostname or "").lower()
    parts = [part for part in parsed.path.split("/") if part]
    identifier = ""
    if hostname.endswith("youtu.be") and parts:
        identifier = parts[0]
    elif parts[:1] == ["watch"]:
        identifier = parse_qs(parsed.query).get("v", [""])[0]
    elif len(parts) >= 2 and parts[0] in ("embed", "shorts", "live"):
        identifier = parts[1]
    if not identifier:
        raise MediaProviderError("Lien YouTube non pris en charge.")
    return media_id(identifier, r"[A-Za-z0-9_-]{6,32}", "YouTube")


def resolve(query: str = "", url: str = "", parent_host: str = "localhost") -> MediaDescriptor:
    del parent_host
    if url:
        identifier = _video_id_from_url(url)
        return MediaDescriptor(
            provider="youtube",
            title="Video YouTube",
            kind="video",
            embeddable=True,
            external_url=f"https://www.youtube.com/watch?v={identifier}",
            embed_url=f"https://www.youtube-nocookie.com/embed/{identifier}",
        )

    cleaned_query = clean_query(query)
    return MediaDescriptor(
        provider="youtube",
        title=cleaned_query,
        kind="search",
        embeddable=False,
        external_url=f"https://www.youtube.com/results?search_query={quote_query(cleaned_query)}",
        message="La recherche YouTube est ouverte dans un onglet pour respecter les regles d'integration de la plateforme.",
    )


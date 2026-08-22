"""Descripteur Spotify officiel pour le HUD."""

import re
from urllib.parse import urlsplit

from .base import (
    MediaDescriptor,
    MediaProviderError,
    canonical_url,
    clean_query,
    find_path_segment,
    media_id,
    quote_query,
    safe_https_url,
)

_KINDS = ("album", "episode", "playlist", "track")
_URI = re.compile(r"^spotify:(album|episode|playlist|track):([A-Za-z0-9]+)$")


def resolve(query: str = "", url: str = "", parent_host: str = "localhost") -> MediaDescriptor:
    del parent_host
    if url:
        uri_match = _URI.fullmatch(url.strip())
        if uri_match:
            kind, identifier = uri_match.groups()
            media_id(identifier, r"[A-Za-z0-9]{8,64}", "Spotify")
            external_url = f"https://open.spotify.com/{kind}/{identifier}"
        else:
            parsed = safe_https_url(url, ("spotify.com",))
            match = find_path_segment([part for part in parsed.path.split("/") if part], _KINDS)
            if not match:
                raise MediaProviderError("Lien Spotify non pris en charge.")
            kind, identifier = match
            media_id(identifier, r"[A-Za-z0-9]{8,64}", "Spotify")
            external_url = canonical_url(parsed)

        return MediaDescriptor(
            provider="spotify",
            title=f"Spotify {kind}",
            kind=kind,
            embeddable=True,
            external_url=external_url,
            embed_url=f"https://open.spotify.com/embed/{kind}/{identifier}",
        )

    cleaned_query = clean_query(query)
    return MediaDescriptor(
        provider="spotify",
        title=cleaned_query,
        kind="search",
        embeddable=False,
        external_url=f"https://open.spotify.com/search/{quote_query(cleaned_query)}",
        message="Ouvrez le resultat Spotify pour choisir un titre, un album ou une playlist.",
    )


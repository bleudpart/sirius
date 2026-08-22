"""Descripteur Deezer officiel."""

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

_KINDS = ("album", "playlist", "track")


def resolve(query: str = "", url: str = "", parent_host: str = "localhost") -> MediaDescriptor:
    del parent_host
    if url:
        parsed = safe_https_url(url, ("deezer.com",))
        match = find_path_segment([part for part in parsed.path.split("/") if part], _KINDS)
        if not match:
            raise MediaProviderError("Lien Deezer non pris en charge.")
        kind, identifier = match
        media_id(identifier, r"\d{1,20}", "Deezer")
        return MediaDescriptor(
            provider="deezer",
            title=f"Deezer {kind}",
            kind=kind,
            embeddable=True,
            external_url=canonical_url(parsed),
            embed_url=f"https://widget.deezer.com/widget/dark/{kind}/{identifier}",
        )

    cleaned_query = clean_query(query)
    return MediaDescriptor(
        provider="deezer",
        title=cleaned_query,
        kind="search",
        embeddable=False,
        external_url=f"https://www.deezer.com/search/{quote_query(cleaned_query)}",
        message="Ouvrez la recherche Deezer pour selectionner un contenu.",
    )


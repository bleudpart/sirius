"""Descripteur Netflix.

Netflix ne fournit pas de lecteur iframe public. Le HUD conserve donc un lien
officiel externe au lieu de tenter de contourner les protections de la plateforme.
"""

from .base import MediaDescriptor, canonical_url, clean_query, quote_query, safe_https_url


def resolve(query: str = "", url: str = "", parent_host: str = "localhost") -> MediaDescriptor:
    del parent_host
    if url:
        parsed = safe_https_url(url, ("netflix.com",))
        return MediaDescriptor(
            provider="netflix",
            title="Netflix",
            kind="external",
            embeddable=False,
            external_url=canonical_url(parsed),
            message="Netflix protege son lecteur : le contenu est ouvert dans le navigateur officiel.",
        )

    cleaned_query = clean_query(query)
    return MediaDescriptor(
        provider="netflix",
        title=cleaned_query,
        kind="search",
        embeddable=False,
        external_url=f"https://www.netflix.com/search?q={quote_query(cleaned_query)}",
        message="La recherche Netflix est ouverte dans le navigateur officiel.",
    )


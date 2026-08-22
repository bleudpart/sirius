"""Descripteur TikTok officiel."""

import re

from .base import MediaDescriptor, MediaProviderError, canonical_url, clean_query, quote_query, safe_https_url


def resolve(query: str = "", url: str = "", parent_host: str = "localhost") -> MediaDescriptor:
    del parent_host
    if url:
        parsed = safe_https_url(url, ("tiktok.com",))
        match = re.search(r"/video/(\d{10,24})(?:/|$)", parsed.path)
        if not match:
            return MediaDescriptor(
                provider="tiktok",
                title="TikTok",
                kind="external",
                embeddable=False,
                external_url=canonical_url(parsed),
                message="Ce lien TikTok est ouvert dans le navigateur pour conserver les controles officiels.",
            )
        identifier = match.group(1)
        return MediaDescriptor(
            provider="tiktok",
            title="Video TikTok",
            kind="video",
            embeddable=True,
            external_url=canonical_url(parsed),
            embed_url=f"https://www.tiktok.com/embed/v2/{identifier}",
        )

    cleaned_query = clean_query(query)
    return MediaDescriptor(
        provider="tiktok",
        title=cleaned_query,
        kind="search",
        embeddable=False,
        external_url=f"https://www.tiktok.com/search?q={quote_query(cleaned_query)}",
        message="La recherche TikTok est ouverte dans un onglet officiel.",
    )


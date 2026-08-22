"""Descripteur Twitch avec le parametre parent exige par Twitch."""

import re

from .base import MediaDescriptor, MediaProviderError, canonical_url, clean_query, quote_query, safe_https_url

_CHANNEL = re.compile(r"^[a-zA-Z0-9_]{4,25}$")
_PARENT = re.compile(r"^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$")


def _valid_parent(value: str) -> str:
    parent = (value or "localhost").lower().strip().rstrip(".")
    if not _PARENT.fullmatch(parent):
        return "localhost"
    return parent


def resolve(query: str = "", url: str = "", parent_host: str = "localhost") -> MediaDescriptor:
    if url:
        parsed = safe_https_url(url, ("twitch.tv",))
        parts = [part for part in parsed.path.split("/") if part]
        if not parts or parts[0] in ("directory", "downloads", "p", "search", "videos"):
            return MediaDescriptor(
                provider="twitch",
                title="Twitch",
                kind="external",
                embeddable=False,
                external_url=canonical_url(parsed),
                message="Ce lien Twitch est ouvert dans le navigateur pour conserver les controles officiels.",
            )
        channel = parts[0]
        if not _CHANNEL.fullmatch(channel):
            raise MediaProviderError("Nom de chaine Twitch invalide.")
        parent = _valid_parent(parent_host)
        return MediaDescriptor(
            provider="twitch",
            title=f"Twitch - {channel}",
            kind="stream",
            embeddable=True,
            external_url=f"https://www.twitch.tv/{channel}",
            embed_url=f"https://player.twitch.tv/?channel={channel}&parent={parent}",
        )

    cleaned_query = clean_query(query)
    return MediaDescriptor(
        provider="twitch",
        title=cleaned_query,
        kind="search",
        embeddable=False,
        external_url=f"https://www.twitch.tv/search?term={quote_query(cleaned_query)}",
        message="Selectionnez une chaine Twitch dans la recherche officielle.",
    )


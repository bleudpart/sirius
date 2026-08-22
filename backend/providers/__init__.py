"""Fournisseurs de liens multimedia integres au HUD SIRIUS."""

from .deezer import resolve as resolve_deezer
from .netflix import resolve as resolve_netflix
from .spotify import resolve as resolve_spotify
from .tiktok import resolve as resolve_tiktok
from .twitch import resolve as resolve_twitch
from .youtube import resolve as resolve_youtube

PROVIDERS = {
    "deezer": resolve_deezer,
    "netflix": resolve_netflix,
    "spotify": resolve_spotify,
    "tiktok": resolve_tiktok,
    "twitch": resolve_twitch,
    "youtube": resolve_youtube,
}


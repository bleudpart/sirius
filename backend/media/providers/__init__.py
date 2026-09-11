"""Providers multimedia disponibles dans le HUD ΣIRIUS."""

from .deezer import MEDIA_PROVIDER as DEEZER
from .netflix import MEDIA_PROVIDER as NETFLIX
from .spotify import MEDIA_PROVIDER as SPOTIFY
from .tiktok import MEDIA_PROVIDER as TIKTOK
from .twitch import MEDIA_PROVIDER as TWITCH
from .youtube import MEDIA_PROVIDER as YOUTUBE

MEDIA_PROVIDERS = (YOUTUBE, NETFLIX, SPOTIFY, DEEZER, TWITCH, TIKTOK)

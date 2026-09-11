"""MediaProxy ΣIRIUS.

Le proxy ne telecharge et ne relaye jamais de medias tiers. Il normalise les
liens officiels et choisit seulement les lecteurs iframe autorises par chaque
plateforme, ce qui evite le contournement de DRM et les risques SSRF.
"""

from providers import PROVIDERS
from providers.base import MediaDescriptor, MediaProviderError


PROVIDER_CAPABILITIES = (
    {"id": "youtube", "label": "YouTube", "embeddable": True, "controllable": True},
    {"id": "spotify", "label": "Spotify", "embeddable": True, "controllable": True},
    {"id": "twitch", "label": "Twitch", "embeddable": True, "controllable": True},
    {"id": "tiktok", "label": "TikTok", "embeddable": True, "controllable": False},
    {"id": "deezer", "label": "Deezer", "embeddable": True, "controllable": False},
    {"id": "netflix", "label": "Netflix", "embeddable": False, "controllable": False},
)


class MediaProxy:
    """Resout un fournisseur multimedia vers un descripteur sans appel reseau."""

    def providers(self) -> list[dict]:
        return [dict(provider) for provider in PROVIDER_CAPABILITIES]

    def resolve(
        self,
        provider: str,
        query: str = "",
        url: str = "",
        parent_host: str = "localhost",
    ) -> MediaDescriptor:
        key = (provider or "").lower().strip()
        resolver = PROVIDERS.get(key)
        if not resolver:
            raise MediaProviderError("Fournisseur multimedia non pris en charge.")
        return resolver(query=query, url=url, parent_host=parent_host)

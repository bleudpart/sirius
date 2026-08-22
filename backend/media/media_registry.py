"""Registre public des modules multimedia exposes par SIRIUS."""

from .providers import MEDIA_PROVIDERS


MEDIA_MODULES = tuple(provider.to_payload() for provider in MEDIA_PROVIDERS)


def list_media_modules() -> list[dict[str, str | bool]]:
    """Retourne une copie du catalogue afin de proteger le registre immuable."""

    return [module.copy() for module in MEDIA_MODULES]

"""Route publique du catalogue des plateformes multimedia."""

from fastapi import APIRouter

from media.media_registry import list_media_modules


router = APIRouter(tags=["modules"])


@router.get("/modules/media")
async def get_media_modules() -> dict[str, list[dict[str, str | bool]]]:
    """Expose les modules multimedia utilisables par l'interface ΣIRIUS."""

    return {"modules": list_media_modules()}

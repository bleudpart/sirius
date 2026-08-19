from fastapi import APIRouter
from fastapi.responses import RedirectResponse

router = APIRouter()


def setup(db):
    """If modules_api is available, include its router to expose mythos endpoints.
    This keeps personnages compatibility by redirecting to mythos characters.
    """
    try:
        from modules_api import make_modules_router
    except Exception:
        return
    r = make_modules_router(db)
    router.include_router(r)


@router.get("/api/personnages")
async def personnages_root():
    return RedirectResponse(url="/api/mythos/characters")

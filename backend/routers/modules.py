from fastapi import APIRouter
from fastapi.responses import RedirectResponse

router = APIRouter()


def setup(db):
    """Attach the real modules router from modules_api into this router using the provided db."""
    try:
        from modules_api import make_modules_router
    except Exception:
        return
    r = make_modules_router(db)
    # include the actual modules router under its own paths
    router.include_router(r)


# Backwards-compatible simple redirect for GET /api/modules
@router.get("/api/modules")
async def modules_root():
    return RedirectResponse(url="/api/mythos")

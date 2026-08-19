from fastapi import APIRouter
from fastapi.responses import RedirectResponse

router = APIRouter()


def setup(db):
    # No dedicated tasks module; keep compatibility by providing redirect
    return


@router.get("/api/tasks")
async def tasks_root():
    return RedirectResponse(url="/api/task/image")

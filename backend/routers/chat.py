from fastapi import APIRouter
from fastapi.responses import RedirectResponse

router = APIRouter()


def setup(db):
    return


@router.get("/api/chat")
async def chat_root():
    return RedirectResponse(url="/api/chat")

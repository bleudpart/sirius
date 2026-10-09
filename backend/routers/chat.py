from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()


def setup(db):
    return


@router.get("/api/chat")
async def chat_root():
    return JSONResponse(
        status_code=405,
        content={"detail": "Use POST /api/chat to send a message."},
        headers={"Allow": "POST"},
    )

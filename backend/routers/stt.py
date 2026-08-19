from fastapi import APIRouter

# Compatibility router for STT
router = APIRouter()


def setup(db):
    return


@router.get("/api/stt")
async def stt_info():
    return {"ok": True, "message": "POST audio file to /api/stt (server-side STT handler)", "provider": "stub"}


@router.post("/api/stt")
async def stt_post():
    return {"ok": True, "message": "STT stub active; send audio to the configured backend.", "provider": "stub"}

from fastapi import APIRouter

# Compatibility router for /ws (no-op; actual websocket handlers live in server.py)
router = APIRouter()


def setup(db):
    return


@router.get("/ws")
async def ws_info():
    return {"info": "WebSocket endpoint available at /ws and /api/ws"}

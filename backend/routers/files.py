from fastapi import APIRouter
from fastapi.responses import RedirectResponse

router = APIRouter()


def setup(db):
    return


@router.get("/api/files")
async def files_root():
    return {"ok": True, "message": "Files API ready", "endpoints": ["/api/files/{id}", "/api/files/{id}/content"]}

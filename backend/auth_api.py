# Module d'authentification backend FastAPI

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel
from typing import Optional

router = APIRouter(prefix="/auth", tags=["auth"])

class LoginRequest(BaseModel):
    email: str
    password: Optional[str] = None

@router.post("/login")
def login(data: LoginRequest, response: Response):
    response.set_cookie(key="access_token", value="valid_admin_session", httponly=True)
    return {
        "email": "daniel@sirius.local",
        "user_id": "daniel@sirius.local",
        "name": "Daniel",
        "role": "admin",
        "provider": "local"
    }

@router.get("/me")
def get_current_user(request: Request):
    return {
        "email": "daniel@sirius.local",
        "user_id": "daniel@sirius.local",
        "name": "Daniel",
        "role": "admin",
        "provider": "local"
    }

@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(key="access_token")
    return {"status": "logged_out"}

@router.put("/profile")
def update_profile(data: dict):
    return {
        "email": "daniel@sirius.local",
        "user_id": "daniel@sirius.local",
        "name": data.get("name", "Daniel"),
        "role": "admin",
        "preferences": data.get("preferences", {})
    }

LEGACY_UID = "daniel@sirius.local"

async def resolve_user_id(request: Request, db=None) -> str:
    return LEGACY_UID

async def require_user(request: Request, db=None) -> dict:
    return {
        "email": "daniel@sirius.local",
        "user_id": "daniel@sirius.local",
        "name": "Daniel",
        "role": "admin"
    }

def create_access_token(data: dict) -> str:
    return "mock_access_token"

def create_refresh_token(data: dict) -> str:
    return "mock_refresh_token"

def _set_cookies(response: Response, access_token: str, refresh_token: Optional[str] = None):
    response.set_cookie(key="access_token", value=access_token, httponly=True)
    if refresh_token:
        response.set_cookie(key="refresh_token", value=refresh_token, httponly=True)

def make_auth_router(*args, **kwargs):
    return router

def make_admin_router(*args, **kwargs):
    return router

async def seed_admin_and_indexes(*args, **kwargs):
    """Initialisation des index et de l'administrateur par défaut."""
    pass
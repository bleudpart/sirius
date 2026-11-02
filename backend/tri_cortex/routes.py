"""Transport prive, reautorisation des flux et relais explicite vers la meme instance Cloud."""
import asyncio
import logging
import sqlite3
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from contextlib import contextmanager
from typing import Annotated, Iterator, Literal

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from pymongo.errors import PyMongoError
from sqlalchemy.exc import SQLAlchemyError
from starlette.requests import HTTPConnection

import cloud_link
from auth_api import is_direct_local_request, websocket_subprotocol
from enterprise import effective_permissions
from services.haccp_images import MAX_IMAGE_BYTES, validate_source_image
from tri_cortex.runtime import TriCortexOrchestrator
from tri_cortex.schemas import (
    CortexFrame, Job, PriceAuditInput, PriceInput, QueueUnavailable, TASK_AGENTS,
    TaskConflict, TaskContext,
)
from tri_cortex.services import DocumentDatabase
from tri_cortex.store import run_io

logger = logging.getLogger(__name__)
STORAGE_ERRORS = (sqlite3.Error, SQLAlchemyError, PyMongoError, OSError)
Auth = Callable[[HTTPConnection, DocumentDatabase], Awaitable[Mapping[str, object]]]


@contextmanager
def api_errors() -> Iterator[None]:
    try:
        yield
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except TaskConflict as error:
        raise HTTPException(409, str(error)) from error
    except QueueUnavailable as error:
        raise HTTPException(503, str(error)) from error
    except STORAGE_ERRORS as error:
        logger.exception("[SENTINEL API] Stockage ou droits indisponibles")
        raise HTTPException(503, "Sentinel indisponible ; aucune confirmation de traitement.") from error
    except ValueError as error:
        logger.error("[SENTINEL API] Contrat incoherent (%s)", type(error).__name__)
        raise HTTPException(422, "Donnees Sentinel invalides ; aucune donnee partielle affichee.") from error


def make_cortex_router(db: DocumentDatabase, require_user: Auth, runtime: TriCortexOrchestrator,
                       *, allowed_origins: frozenset[str]) -> APIRouter:
    router = APIRouter(prefix="/cortex/tri", tags=["tri-cortex"])

    async def authorization(connection: HTTPConnection) -> tuple[str, frozenset[str], str | None]:
        if cloud_link.relay_allowed() and not is_direct_local_request(connection):
            raise HTTPException(403, "Le relais Sentinel Cloud est reserve a ce PC.")
        user = await require_user(connection, db)
        actor = user.get("user_id")
        if not isinstance(actor, str) or not actor:
            raise HTTPException(401, "Session invalide.")
        scopes = {f"user:{actor}"}
        query = {"user_id": actor}
        company = user.get("company_id")
        if isinstance(company, str) and company:
            query["company_id"] = company
        member = await db.enterprise_members.find_one(query)
        haccp_scope = f"user:{actor}" if not company and not member else None
        if member:
            company_id = member.get("company_id")
            if isinstance(company_id, str) and company_id:
                if "haccp" in effective_permissions(member):
                    haccp_scope = f"company:{company_id}"
                    scopes.add(haccp_scope)
                if member.get("role") in {"admin", "manager"}:
                    scopes.add(f"finance:{company_id}")
        return actor, frozenset(scopes), haccp_scope

    async def snapshot(scopes: frozenset[str]) -> CortexFrame:
        if cloud_link.relay_allowed():
            return CortexFrame.model_validate(await cloud_link.relay_cortex("GET")).model_copy(update={"source": "cloud"})
        return runtime.telemetry.frame(scopes)

    def private(response: Response) -> None:
        response.headers["Cache-Control"] = "private, no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"

    @router.get("", response_model=CortexFrame)
    async def state(request: Request, response: Response) -> CortexFrame:
        private(response)
        with api_errors():
            _, scopes, _ = await authorization(request)
            return await snapshot(scopes)

    @router.get("/jobs")
    async def jobs(request: Request, response: Response) -> dict:
        private(response)
        with api_errors():
            _, scopes, _ = await authorization(request)
            if cloud_link.relay_allowed():
                return await cloud_link.relay_cortex("GET", "/jobs")
            rows = await run_io(runtime.store.recent, scopes)
            return {"items": [{
                "id": job.id, "kind": job.input.kind, "state": job.state, "attempts": job.attempts,
                "updated_at": job.updated_at.isoformat(), "error_message": job.error_message,
                "requires_human_review": job.input.kind in {"vision_label", "vision_invoice", "price_audit"},
            } for job in rows]}

    @router.get("/jobs/{job_id}", response_model=Job)
    async def job_detail(job_id: uuid.UUID, request: Request, response: Response) -> Job:
        private(response)
        with api_errors():
            _, scopes, _ = await authorization(request)
            if cloud_link.relay_allowed():
                return Job.model_validate(await cloud_link.relay_cortex("GET", "/jobs/" + job_id.hex))
            return await run_io(runtime.store.get, job_id.hex, scopes)

    @router.post("/jobs/{job_id}/retry", response_model=Job, status_code=202)
    async def retry(job_id: uuid.UUID, request: Request, response: Response) -> Job:
        private(response)
        with api_errors():
            actor, scopes, _ = await authorization(request)
            if cloud_link.relay_allowed():
                return Job.model_validate(await cloud_link.relay_cortex("POST", f"/jobs/{job_id.hex}/retry"))
            if not runtime.brain3.active:
                raise QueueUnavailable("Sentinel est arrete ; reprise non acceptee.")
            job = await run_io(runtime.store.retry, job_id.hex, scopes, actor)
            runtime.brain3.agents[TASK_AGENTS[job.input.kind]].offer(job.id)
            return job

    @router.post("/vision", response_model=Job, status_code=202)
    async def vision(
        request: Request, response: Response, file: UploadFile = File(...),
        kind: Annotated[Literal["label", "invoice"], Form()] = "label",
        request_id: Annotated[uuid.UUID | None, Form()] = None,
    ) -> Job:
        private(response)
        with api_errors():
            actor, scopes, haccp_scope = await authorization(request)
            content = await file.read(MAX_IMAGE_BYTES + 1)
            mime_type = (file.content_type or "").split(";", 1)[0].strip().lower()
            await run_io(validate_source_image, content, mime_type)
            if cloud_link.relay_allowed():
                return Job.model_validate(await cloud_link.relay_cortex(
                    "POST", "/vision", files={"file": ("document", content, mime_type)},
                    data={"kind": kind, "request_id": str(request_id or uuid.uuid4())},
                ))
            scope = next((scope for scope in scopes if scope.startswith("finance:")), None) if kind == "invoice" else haccp_scope
            if scope is None:
                raise HTTPException(403, "Droits financiers entreprise requis pour lire une facture." if kind == "invoice"
                                    else "Droits HACCP requis pour analyser une etiquette.")
            return await runtime.vision(
                TaskContext(scope=scope, actor_id=actor), content, mime_type,
                "vision_invoice" if kind == "invoice" else "vision_label", (request_id or uuid.uuid4()).hex,
            )

    @router.post("/price-audit", response_model=Job, status_code=202)
    async def prices(body: PriceAuditInput, request: Request, response: Response) -> Job:
        private(response)
        with api_errors():
            actor, scopes, _ = await authorization(request)
            if cloud_link.relay_allowed():
                return Job.model_validate(await cloud_link.relay_cortex("POST", "/price-audit", json=body.model_dump(mode="json")))
            scope = next((scope for scope in scopes if scope.startswith("finance:")), None)
            if scope is None:
                raise HTTPException(403, "Droits financiers entreprise requis.")
            return await runtime.brain3.submit(
                TaskContext(scope=scope, actor_id=actor), PriceInput(values=body), uuid.uuid4().hex,
            )

    @router.websocket("/stream")
    async def stream(websocket: WebSocket) -> None:
        origin = websocket.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            await websocket.close(code=4403, reason="Origine non autorisee")
            return
        accepted = False
        try:
            _, scopes, _ = await authorization(websocket)
            await websocket.accept(subprotocol=websocket_subprotocol(websocket))
            accepted = True
            checked = time.monotonic()
            while True:
                if time.monotonic() - checked >= 5:
                    _, current_scopes, _ = await authorization(websocket)
                    if current_scopes != scopes:
                        await websocket.close(code=4403, reason="Perimetre modifie ; reconnectez le graphe")
                        return
                    checked = time.monotonic()
                frame = await snapshot(scopes)
                await asyncio.wait_for(websocket.send_json(frame.model_dump(mode="json")), timeout=5)
                try:
                    message = await asyncio.wait_for(websocket.receive(), timeout=1)
                except TimeoutError:
                    continue
                if message["type"] == "websocket.disconnect":
                    break
                await asyncio.sleep(1)
        except WebSocketDisconnect:
            return
        except HTTPException as error:
            logger.warning("[SENTINEL WS] Flux refuse ou revoque (%s)", error.status_code)
            await websocket.close(code={401: 4401, 402: 4402, 403: 4403}.get(error.status_code, 1013),
                                  reason="Acces ou service indisponible")
        except (*STORAGE_ERRORS, ValidationError, TimeoutError) as error:
            logger.error("[SENTINEL WS] Flux indisponible (%s)", type(error).__name__)
            await websocket.close(code=1013 if accepted else 1011, reason="Telemetrie indisponible")

    return router

"""Routes FastAPI du module Productivite & Travail."""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from auth_api import require_user

from .code_assist import CodeAssist
from .doc_analyzer import DocAnalyzer
from .oracle_productivite import build_productivity_oracle
from .report_builder import ReportBuilder
from .smart_notes import SmartNotes
from .store import ProductivityStore
from .task_master import TaskMaster


class DocumentAnalyzeRequest(BaseModel):
    title: str = Field(default="Document", max_length=180)
    content: str = Field(min_length=1, max_length=120000)


class CodeAnalyzeRequest(BaseModel):
    code: str = Field(min_length=1, max_length=120000)
    language: str = Field(default="text", max_length=32)


class NoteCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    content: str = Field(min_length=1, max_length=50000)
    tags: list[str] = Field(default_factory=list)
    pinned: bool = False


class NoteUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=180)
    content: str | None = Field(default=None, max_length=50000)
    tags: list[str] | None = None
    pinned: bool | None = None


class TaskCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    description: str = Field(default="", max_length=4000)
    status: str = Field(default="todo", max_length=32)
    priority: str = Field(default="medium", max_length=32)
    due_at: str = Field(default="", max_length=40)


class TaskUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=180)
    description: str | None = Field(default=None, max_length=4000)
    status: str | None = Field(default=None, max_length=32)
    priority: str | None = Field(default=None, max_length=32)
    due_at: str | None = Field(default=None, max_length=40)


class ReportBuildRequest(BaseModel):
    title: str = Field(default="Rapport Productivite", max_length=180)
    report_type: str = Field(default="work", max_length=40)


def make_productivity_router(db, store: ProductivityStore | None = None) -> APIRouter:
    router = APIRouter(prefix="/productivity", tags=["productivity"])
    storage = store or ProductivityStore()
    notes = SmartNotes(storage)
    tasks = TaskMaster(storage)
    reports = ReportBuilder(storage)
    documents = DocAnalyzer()
    code = CodeAssist()

    async def user_id_for(request: Request) -> str:
        return (await require_user(request, db))["user_id"]

    @router.post("/documents/analyze")
    async def analyze_document(payload: DocumentAnalyzeRequest, request: Request):
        await user_id_for(request)
        try:
            return documents.analyze(payload.title, payload.content)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/code/analyze")
    async def analyze_code(payload: CodeAnalyzeRequest, request: Request):
        await user_id_for(request)
        try:
            return code.analyze(payload.code, payload.language)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.get("/notes")
    async def list_notes(request: Request, query: str = "", limit: int = 100):
        return {"notes": notes.list(await user_id_for(request), query=query, limit=limit)}

    @router.post("/notes")
    async def create_note(payload: NoteCreateRequest, request: Request):
        try:
            return notes.create(
                await user_id_for(request),
                payload.title,
                payload.content,
                tags=payload.tags,
                pinned=payload.pinned,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.put("/notes/{note_id}")
    async def update_note(note_id: str, payload: NoteUpdateRequest, request: Request):
        try:
            note = notes.update(await user_id_for(request), note_id, **payload.model_dump())
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        if not note:
            raise HTTPException(status_code=404, detail="Note introuvable.")
        return note

    @router.delete("/notes/{note_id}")
    async def delete_note(note_id: str, request: Request):
        if not notes.delete(await user_id_for(request), note_id):
            raise HTTPException(status_code=404, detail="Note introuvable.")
        return {"ok": True}

    @router.get("/tasks")
    async def list_tasks(request: Request, status: str = "", limit: int = 200):
        try:
            return {"tasks": tasks.list(await user_id_for(request), status=status, limit=limit)}
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.post("/tasks")
    async def create_task(payload: TaskCreateRequest, request: Request):
        try:
            return tasks.create(await user_id_for(request), **payload.model_dump())
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.put("/tasks/{task_id}")
    async def update_task(task_id: str, payload: TaskUpdateRequest, request: Request):
        try:
            task = tasks.update(await user_id_for(request), task_id, **payload.model_dump())
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        if not task:
            raise HTTPException(status_code=404, detail="Tache introuvable.")
        return task

    @router.delete("/tasks/{task_id}")
    async def delete_task(task_id: str, request: Request):
        if not tasks.delete(await user_id_for(request), task_id):
            raise HTTPException(status_code=404, detail="Tache introuvable.")
        return {"ok": True}

    @router.get("/reports")
    async def list_reports(request: Request, limit: int = 50):
        return {"reports": reports.list(await user_id_for(request), limit=limit)}

    @router.post("/reports/build")
    async def build_report(payload: ReportBuildRequest, request: Request):
        try:
            return reports.build(await user_id_for(request), payload.title, payload.report_type)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @router.get("/oracle")
    async def productivity_oracle(request: Request):
        return build_productivity_oracle(tasks.summary(await user_id_for(request)))

    return router

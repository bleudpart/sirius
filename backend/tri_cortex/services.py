"""Adaptateurs vers les registres existants ; aucune mutation de preuve ou de comptabilite."""
import io
import logging
import os
import re
import tempfile
import time
import uuid
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageOps
from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from brain_analytical.orchestrator import AnalyticalOrchestrator, Signal
from brain_analytical.schemas import TypeDeclencheur
from haccp_database import get_engine
from models.haccp_reception import AllergenObservation, ReceptionSource, StockLot
from runtime_paths import data_dir, data_file
from schemas.haccp import EtiquetteVisionOutput
from services.haccp_reception import charger_source, lire_image_verifiee
from services.haccp_vision import VisionAnalysisError, VisionServiceError
from tri_cortex.runtime import TriCortexOrchestrator
from tri_cortex.schemas import (
    ArchiveInput, FinancialInput, Job, JsonObject, PriceInput, PurgeInput, QueueUnavailable,
    SanitaryAlert, SanitaryInput, SanitaryResult, TaskContext, TaskFailed, TaskPending, TaskPermissionError,
    VisionInput, VisionResult,
)
from tri_cortex.store import OfflineStore, run_io, utc_now
from tri_cortex.vision import read_vision

logger = logging.getLogger(__name__)


class Collection(Protocol):
    async def find_one(self, query: dict[str, object]) -> dict[str, object] | None: ...


class DocumentDatabase(Protocol):
    users: Collection
    enterprise_members: Collection
    enterprise_companies: Collection


def sanitary_report(engine: Engine, scope: str, now: datetime) -> SanitaryResult:
    stamp = now.astimezone(timezone.utc).replace(tzinfo=None)
    alerts: list[SanitaryAlert] = []
    total = 0
    groups = (
        ("expired_dlc", (StockLot.date_type == "DLC") & (StockLot.deadline < stamp), "DLC depassee : isoler et verifier."),
        ("rotation", (StockLot.deadline.is_not(None)) & (StockLot.deadline <= stamp + timedelta(hours=48))
         & ((StockLot.deadline >= stamp) | (StockLot.date_type == "DDM")),
         "Rotation a verifier : FEFO puis FIFO. Une DDM depassee n'est pas une DLC depassee."),
        ("date_unknown", StockLot.deadline.is_(None), "Date inconnue : controle humain immediat."),
        ("reading", StockLot.label_compliant.is_(False), "Lecture non conforme : verification humaine requise."),
    )
    with Session(engine) as session:
        for kind, predicate, message in groups:
            query = select(StockLot).where(StockLot.scope_key == scope, predicate)
            total += session.scalar(select(func.count()).select_from(query.subquery())) or 0
            rows = session.scalars(query.order_by(
                StockLot.deadline.is_(None), StockLot.deadline, StockLot.received_at, StockLot.reception_id,
            ).limit(50))
            for row in rows:
                alerts.append(SanitaryAlert(
                    reception_id=row.reception_id, kind=kind, message=message,
                    deadline=row.deadline.replace(tzinfo=timezone.utc) if row.deadline else None,
                ))
        query = select(AllergenObservation).where(
            AllergenObservation.scope_key == scope, AllergenObservation.review_required.is_(True),
        )
        total += session.scalar(select(func.count()).select_from(query.subquery())) or 0
        for row in session.scalars(query.order_by(AllergenObservation.reception_id.desc()).limit(50)):
            details = list(dict.fromkeys(row.new_allergens + row.new_traces))
            alerts.append(SanitaryAlert(
                reception_id=row.reception_id, kind="allergens",
                message=("Nouvelle presence ou trace : " + ", ".join(details) + ".") if details else
                "Declaration allergenes a verifier ; absence non certifiee.",
            ))
    return SanitaryResult(checked_at=now, alerts=alerts, total_alerts=total, truncated=total > len(alerts))


class ArchiveService:
    def __init__(self, *, engine_factory: Callable[[], Engine] = get_engine, root: Path | None = None):
        self.engine_factory = engine_factory
        self.root = root

    def _bucket(self, scope: str) -> Path:
        import hashlib

        base = (self.root or data_dir()).resolve(strict=True)
        root = base / "cortex_cache"
        root.mkdir(exist_ok=True)
        if root.resolve(strict=True).parent != base:
            raise ValueError("Cache redirige hors du repertoire autorise.")
        bucket = root / hashlib.sha256(scope.encode()).hexdigest()[:24]
        bucket.mkdir(exist_ok=True)
        if bucket.resolve(strict=True).parent != root.resolve(strict=True):
            raise ValueError("Cache d'etablissement redirige.")
        return bucket

    def compress(self, scope: str, reception_id: int) -> JsonObject:
        with Session(self.engine_factory()) as session:
            _, document = charger_source(session, scope, reception_id)
            content = lire_image_verifiee(document.image, scope)
        bucket = self._bucket(scope)
        name = f"preview_{reception_id}_{document.image.sha256}.jpg"
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(dir=bucket, prefix=f".{name}.", suffix=".tmp", delete=False) as target:
                temporary = Path(target.name)
                with Image.open(io.BytesIO(content)) as original:
                    image = ImageOps.exif_transpose(original).convert("RGB")
                    image.thumbnail((1280, 1280))
                    image.save(target, "JPEG", quality=82, optimize=True)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temporary, bucket / name)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return {
            "reception_id": reception_id, "original_sha256": document.image.sha256,
            "original_modified": False, "preview_bytes": (bucket / name).stat().st_size,
            "cache_name": name, "cache_lifetime_days": 7,
        }

    def purge_caches(self, scope: str, now: datetime) -> JsonObject:
        bucket = self._bucket(scope)
        cutoff = (now - timedelta(days=7)).timestamp()
        deleted = 0
        names = re.compile(r"(?:preview_\d+_[a-f0-9]{64}\.jpg|\.(?:preview_\d+_[a-f0-9]{64}\.jpg)\.[\w-]+\.tmp)")
        for entry in bucket.iterdir():
            if not names.fullmatch(entry.name) or entry.is_symlink():
                continue
            if entry.resolve(strict=True).parent != bucket.resolve(strict=True):
                raise ValueError("Fichier de cache redirige ; purge refusee.")
            if entry.is_file() and entry.stat().st_mtime < cutoff:
                entry.unlink()
                deleted += 1
        return {"deleted_cache_files": deleted, "originals_deleted": 0, "policy": "originals_preserved"}

    async def handle(self, job: Job) -> JsonObject:
        if isinstance(job.input, ArchiveInput):
            return await run_io(self.compress, job.context.scope, job.input.reception_id)
        if isinstance(job.input, PurgeInput):
            return await run_io(self.purge_caches, job.context.scope, utc_now())
        raise ValueError("Operation d'archivage inconnue.")


class RuntimeServices:
    def __init__(self, db: DocumentDatabase, analytical: AnalyticalOrchestrator,
                 *, engine_factory: Callable[[], Engine] = get_engine, root: Path | None = None):
        self.db, self.analytical, self.engine_factory = db, analytical, engine_factory
        self.archives = ArchiveService(engine_factory=engine_factory, root=root)
        self.runtime: TriCortexOrchestrator | None = None
        self._receipt_cursor = 0
        self._scope_cursor: str | None = None

    async def authorize(self, job: Job) -> None:
        if job.context.actor_id is None and isinstance(job.input, (SanitaryInput, ArchiveInput, PurgeInput)):
            return
        actor = job.context.actor_id
        if not actor:
            raise TaskPermissionError("Une identite autorisee est requise pour cette analyse.")
        user = await self.db.users.find_one({"user_id": actor})
        if not user or user.get("disabled"):
            raise TaskPermissionError("Compte indisponible ; reprise annulee.")
        scope_type, identity = job.context.scope.split(":", 1)
        needs_finance = isinstance(job.input, (FinancialInput, PriceInput)) or (
            isinstance(job.input, VisionInput) and job.input.kind == "vision_invoice"
        )
        if needs_finance and scope_type != "finance":
            raise TaskPermissionError("Une analyse financiere exige son propre perimetre autorise.")
        if scope_type == "user":
            if identity != actor or isinstance(job.input, FinancialInput):
                raise TaskPermissionError("Perimetre utilisateur invalide.")
        else:
            membership = await self.db.enterprise_members.find_one({"company_id": identity, "user_id": actor})
            if not membership:
                raise TaskPermissionError("Acces a l'etablissement revoque ; reprise annulee.")
            if scope_type == "finance":
                if membership.get("role") not in {"admin", "manager"}:
                    raise TaskPermissionError("Droits financiers insuffisants ; reprise annulee.")
            else:
                from enterprise import effective_permissions
                if "haccp" not in effective_permissions(membership):
                    raise TaskPermissionError("Droits HACCP insuffisants ; reprise annulee.")
        from access_gate import access_status
        from auth_api import _public_user
        from provider_access import bind_user

        public_user = _public_user(user)
        if not (await access_status(self.db, public_user))["allowed"]:
            raise TaskPermissionError("Acces au logiciel indisponible ; reprise annulee.")
        bind_user(public_user)

    async def analyse_label(
        self, content: bytes, mime_type: str, scope: str, request_key: str, actor: str | None,
    ) -> EtiquetteVisionOutput:
        if self.runtime is None:
            raise VisionServiceError("Sentinel non initialise.")
        context = TaskContext(scope=scope, actor_id=actor)
        try:
            job = await self.runtime.vision(context, content, mime_type, "vision_label", request_key)
            report = VisionResult.model_validate(await self.runtime.brain3.wait(job))
            # Une reprise le lendemain doit recontroler la DLC, sans relancer le modele ni modifier l'archive.
            report = await self.runtime.brain2.validate_vision(context, report, job.id)
        except (QueueUnavailable, TaskPending) as error:
            raise VisionServiceError(str(error)) from error
        except TaskFailed as error:
            raise VisionAnalysisError(str(error)) from error
        if not isinstance(report.document, EtiquetteVisionOutput):
            raise VisionAnalysisError("Le resultat Sentinel n'est pas une etiquette.")
        return report.document

    async def sanitary(self, scope: str) -> JsonObject:
        def read() -> SanitaryResult:
            return sanitary_report(self.engine_factory(), scope, utc_now())
        return (await run_io(read)).model_dump(mode="json")

    async def financial(self, job: Job) -> JsonObject:
        if not isinstance(job.input, FinancialInput) or job.context.scope != f"finance:{job.input.company_id}":
            raise TaskPermissionError("Perimetre financier incoherent.")
        signal = Signal(
            job.input.company_id, job.context.actor_id, TypeDeclencheur(job.input.trigger),
            time.monotonic(), 0, essai=job.input.attempt,
        )
        if not await self.analytical.executer(signal, job.input.signals):
            raise TaskFailed("Analyse financiere interrompue ; consulter son journal et ses reprises.")
        return {"published": True, "accounting_written": False}

    async def delegate_financial(self, signal: Signal, number: int) -> None:
        if self.runtime is None:
            raise QueueUnavailable("Sentinel financier non initialise.")
        actor = signal.acteur
        if not actor:
            company = await self.db.enterprise_companies.find_one({"id": signal.company_id})
            owner = company.get("owner_user_id") if company else None
            actor = owner if isinstance(owner, str) else None
        try:
            job = await self.runtime.brain3.submit(
                TaskContext(scope=f"finance:{signal.company_id}", actor_id=actor),
                FinancialInput(company_id=signal.company_id, trigger=signal.declencheur.value,
                               signals=number, attempt=signal.essai),
                "finance:" + uuid.uuid4().hex,
            )
        except QueueUnavailable:
            logger.warning("[SENTINEL FINANCE] Analyse differee : file indisponible ; nouveau signal dans une minute")
            self.analytical.notify(signal.company_id, signal.acteur, signal.declencheur,
                                   delai=60, essai=signal.essai)
            return
        try:
            await self.runtime.brain3.wait(job, timeout=125)
        except (TaskPending, TaskFailed) as error:
            logger.warning("[SENTINEL FINANCE] Analyse %s non confirmee (%s)", job.id, type(error).__name__)

    async def received(self, scope: str, reception_id: int) -> None:
        if self.runtime is None:
            raise QueueUnavailable("Sentinel non initialise.")
        context = TaskContext(scope=scope)
        await self.runtime.brain3.submit(context, SanitaryInput(), f"receipt:{reception_id}")
        await self.runtime.brain3.submit(context, ArchiveInput(reception_id=reception_id), f"receipt:{reception_id}")

    async def periodic(self) -> None:
        if self.runtime is None:
            raise QueueUnavailable("Sentinel non initialise.")

        def read() -> tuple[list[str], list[tuple[str, int]]]:
            with Session(self.engine_factory()) as session:
                query = select(StockLot.scope_key).distinct().order_by(StockLot.scope_key).limit(64)
                scopes = list(session.scalars(query.where(StockLot.scope_key > self._scope_cursor))) if self._scope_cursor else []
                if not scopes:
                    scopes = list(session.scalars(query))
                receipts = list(session.execute(select(ReceptionSource.scope_key, ReceptionSource.reception_id).where(
                    ReceptionSource.reception_id > self._receipt_cursor,
                ).order_by(ReceptionSource.reception_id).limit(64)))
            return scopes, [(scope, reference) for scope, reference in receipts]

        scopes, receipts = await run_io(read)
        now = utc_now()
        archive_full = False
        for scope in scopes:
            context = TaskContext(scope=scope)
            try:
                await self.runtime.brain3.submit(context, SanitaryInput(), f"minute:{int(now.timestamp() // 60)}")
            except QueueUnavailable:
                logger.warning("[SENTINEL] Verification periodique differee : file pleine")
                break
            self._scope_cursor = scope
            if not archive_full:
                try:
                    await self.runtime.brain3.submit(context, PurgeInput(), f"day:{now.date().isoformat()}")
                except QueueUnavailable:
                    logger.warning("[SENTINEL] Nettoyage differe : file pleine")
                    archive_full = True
        for scope, reference in receipts:
            try:
                await self.runtime.brain3.submit(
                    TaskContext(scope=scope), ArchiveInput(reception_id=reference), f"receipt:{reference}",
                )
            except QueueUnavailable:
                logger.warning("[SENTINEL] Compression differee : file pleine")
                break
            self._receipt_cursor = reference


def create_runtime(db: DocumentDatabase, analytical: AnalyticalOrchestrator) -> tuple[TriCortexOrchestrator, RuntimeServices]:
    services = RuntimeServices(db, analytical)
    runtime = TriCortexOrchestrator(
        OfflineStore(data_file("tri_cortex.sqlite3")), authorize=services.authorize, vision_reader=read_vision,
        sanitary_reader=services.sanitary, archive_handler=services.archives.handle,
        financial_handler=services.financial,
    )
    services.runtime = runtime
    runtime.brain3.periodic = services.periodic
    analytical.execution_delegate = services.delegate_financial
    runtime.brain3.agents["margin_audit"].scheduler = analytical.loop
    analytical.executor_available = lambda: runtime.brain3.agents["margin_audit"].running
    return runtime, services

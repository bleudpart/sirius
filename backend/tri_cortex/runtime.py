"""Workers isoles, reservations durables et supervision asyncio bornee."""
import asyncio
import logging
import sqlite3
import time
import uuid
from abc import ABC, abstractmethod
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence

from tri_cortex.brain1_agents import HERMES, IRIS, Brain1Agent
from tri_cortex.brains import Brain1FastStream, Brain2DeepReasoning
from tri_cortex.schemas import (
    AGENT_IDS, BRAIN1_AGENT_IDS, TASK_AGENTS, AgentId, CortexError, Job, JsonObject, QueueUnavailable,
    RetryableTaskError, TaskContext, TaskFailed, TaskInput, TaskPending, VisionInput, VisionResult,
)
from tri_cortex.store import OfflineStore, run_io, utc_now
from tri_cortex.telemetry import EventBus, Telemetry

logger = logging.getLogger(__name__)
Authorize = Callable[[Job], Awaitable[None]]


class AttemptFailed(RuntimeError):
    def __init__(self, unexpected: bool):
        self.unexpected = unexpected
        super().__init__("Traitement du subagent interrompu.")


class BaseSubAgent(ABC):
    def __init__(self, node_id: AgentId, store: OfflineStore, telemetry: Telemetry, authorize: Authorize,
                 *, timeout: float = 120, retry_delay: float = 10):
        if timeout <= 0 or retry_delay < 0:
            raise ValueError("Delais de worker invalides.")
        self.node_id = node_id
        self.store, self.telemetry, self.authorize = store, telemetry, authorize
        self.timeout, self.retry_delay = timeout, retry_delay
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=store.capacity)
        self._queued: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self.scheduler: Callable[[], Awaitable[None]] | None = None
        self._scheduler: asyncio.Task[None] | None = None
        self._owner = uuid.uuid4().hex
        self._stopping = True
        self._restarts: deque[float] = deque()
        self._next_restart = 0.0
        self._reported_failure = False

    @property
    def running(self) -> bool:
        return (self._task is not None and not self._task.done()
                and (self.scheduler is None or self._scheduler is not None and not self._scheduler.done()))

    async def start(self) -> None:
        if self.running:
            return
        if self._task is not None or self._scheduler is not None:
            await self.stop()
        self.queue = asyncio.Queue(maxsize=self.store.capacity)
        self._queued.clear()
        self._stopping = False
        self._reported_failure = False
        self.telemetry.states[self.node_id] = "idle"
        self._task = asyncio.create_task(self._consume(), name=f"sentinel:{self.node_id}")
        if self.scheduler is not None:
            self._scheduler = asyncio.create_task(self.scheduler(), name=f"sentinel:{self.node_id}:scheduler")
        await asyncio.sleep(0)

    async def stop(self) -> None:
        self._stopping = True
        tasks = [task for task in (self._task, self._scheduler) if task is not None]
        for task in tasks:
            if task.done() and not task.cancelled() and task.exception() is not None and not self._reported_failure:
                logger.error("[SENTINEL] Arret de %s apres une erreur (%s)", self.node_id,
                             type(task.exception()).__name__)
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._task = self._scheduler = None
        self.telemetry.states[self.node_id] = "stopped"

    async def restart_on_failure(self) -> None:
        failed = next((task for task in (self._task, self._scheduler) if task is not None and task.done()), None)
        if self._stopping or failed is None:
            return
        error = None if failed.cancelled() else failed.exception()
        self.telemetry.states[self.node_id] = "failed"
        now = time.monotonic()
        if not self._reported_failure:
            logger.error("[SENTINEL] Worker %s arrete (%s)", self.node_id,
                         type(error).__name__ if error else "arret inattendu")
            self._reported_failure = True
            self._next_restart = now + min(30, 2 ** len(self._restarts))
        while self._restarts and self._restarts[0] < now - 60:
            self._restarts.popleft()
        if now < self._next_restart or len(self._restarts) >= 3:
            return
        self._restarts.append(now)
        self.telemetry.restarts[self.node_id] += 1
        await self.start()

    def offer(self, job_id: str) -> None:
        if not self.running or job_id in self._queued or self.queue.full():
            return  # La source durable reste en attente ; aucun acquittement de travail ici.
        self.queue.put_nowait(job_id)
        self._queued.add(job_id)

    @abstractmethod
    async def process(self, job: Job) -> JsonObject:
        raise NotImplementedError

    async def _invoke(self, job: Job) -> JsonObject:
        await self.authorize(job)
        return await self.process(job)

    async def _execute(self, job: Job) -> None:
        with self.telemetry.measure(job.context.scope, self.node_id, job.input.kind):
            operation = asyncio.create_task(self._invoke(job))
            try:
                done, _ = await asyncio.wait({operation}, timeout=self.timeout)
                if not done:
                    operation.cancel()
                    await asyncio.gather(operation, return_exceptions=True)
                    error: BaseException | None = RetryableTaskError("Delai de traitement depasse.")
                elif operation.cancelled():
                    error = RetryableTaskError("Operation interrompue.")
                else:
                    error = operation.exception()
                if error is not None:
                    retry = isinstance(error, (RetryableTaskError, OSError, sqlite3.Error))
                    code = type(error).__name__
                    message = str(error) if isinstance(error, CortexError) else (
                        "Analyse refusee ou interrompue ; consulter le journal serveur."
                    )
                    await run_io(self.store.fail, job, self._owner, code, message, retry,
                                 self.retry_delay * 2 ** (job.attempts - 1))
                    self.telemetry.flow(job.context.scope, self.node_id, "brain_3", job.id, "task_failed")
                    logger.error("[SENTINEL] Tache %s / %s en echec (%s), tentative %s",
                                 job.id, self.node_id, code, job.attempts)
                    raise AttemptFailed(not isinstance(error, (CortexError, ValueError, OSError, sqlite3.Error)))
                await run_io(self.store.finish, job.id, self._owner, operation.result())
                self.telemetry.flow(job.context.scope, self.node_id, "brain_3", job.id, "task_completed")
            except asyncio.CancelledError:
                operation.cancel()
                await asyncio.gather(operation, return_exceptions=True)
                raise

    async def _consume(self) -> None:
        while True:
            job_id = await self.queue.get()
            try:
                job = await run_io(self.store.claim, job_id, self._owner, self.timeout * 2 + 30)
                if job is None:
                    continue
                self.telemetry.flow(job.context.scope, "brain_3", self.node_id, job.id, "task_started")
                try:
                    await self._execute(job)
                except AttemptFailed as failure:
                    if failure.unexpected:
                        raise
                finally:
                    await run_io(self.store.release, job_id, self._owner)
            finally:
                self.queue.task_done()
                self._queued.discard(job_id)


class Brain3SentinelMaster:
    def __init__(self, store: OfflineStore, telemetry: Telemetry, agents: Sequence[BaseSubAgent],
                 *, heartbeat_interval: float = 1):
        if {agent.node_id for agent in agents} != set(AGENT_IDS) or len(agents) != 4:
            raise ValueError("Sentinel exige exactement ses quatre subagents specialises.")
        if heartbeat_interval <= 0:
            raise ValueError("Intervalle de heartbeat invalide.")
        self.store, self.telemetry = store, telemetry
        self.agents = {agent.node_id: agent for agent in agents}
        self.heartbeat_interval = heartbeat_interval
        self._heartbeat: asyncio.Task[None] | None = None
        self._periodic: asyncio.Task[None] | None = None
        self.periodic: Callable[[], Awaitable[None]] | None = None
        self.offline_recovery: Callable[[], Awaitable[dict[AgentId, list[str]]]] | None = None
        self._next_periodic = 0.0
        self._periodic_error = False
        self._active = False

    @property
    def active(self) -> bool:
        return self._active

    async def start(self) -> None:
        if self._active:
            return
        await run_io(self.store.initialize)
        for agent in self.agents.values():
            await agent.start()
        self._active = True
        self.telemetry.states["brain_3"] = "idle"
        self.telemetry.heartbeat_at = utc_now()
        self._next_periodic = time.monotonic()
        self._heartbeat = asyncio.create_task(self._loop(), name="sentinel:heartbeat")

    async def stop(self) -> None:
        self._active = False
        for task in (self._heartbeat, self._periodic):
            if task is not None:
                task.cancel()
        await asyncio.gather(*(task for task in (self._heartbeat, self._periodic) if task is not None),
                             return_exceptions=True)
        self._heartbeat = self._periodic = None
        await asyncio.gather(*(agent.stop() for agent in self.agents.values()))
        self.telemetry.states["brain_3"] = "stopped"

    async def submit(self, context: TaskContext, payload: TaskInput, request_key: str) -> Job:
        if not self._active:
            raise QueueUnavailable("Sentinel est arrete ; aucune tache acceptee.")
        job = await run_io(self.store.put, context, payload, request_key)
        agent = self.agents[TASK_AGENTS[payload.kind]]
        if job.state in ("pending", "retry"):
            agent.offer(job.id)
            self.telemetry.flow(context.scope, "brain_3", agent.node_id, job.id, "task_queued")
        return job

    async def wait(self, job: Job, *, timeout: float = 45) -> JsonObject:
        started = time.monotonic()
        while True:
            current = await run_io(self.store.get, job.id, frozenset({job.context.scope}))
            if current.state == "done":
                if current.result is None:
                    raise TaskFailed("Resultat termine absent ; controle d'integrite requis.")
                return current.result
            if current.state == "failed":
                raise TaskFailed(current.error_message or "Analyse non aboutie.")
            if current.state == "retry" or time.monotonic() - started >= timeout:
                raise TaskPending(job.id)
            await asyncio.sleep(0.1)

    async def _tick(self) -> None:
        ready = await self.offline_recovery() if self.offline_recovery is not None else {
            agent: await run_io(self.store.due, agent) for agent in AGENT_IDS
        }
        for agent in self.agents.values():
            await agent.restart_on_failure()
            for job_id in ready[agent.node_id]:
                agent.offer(job_id)
        self.telemetry.backlog = {
            (scope, agent): count for scope, agent, count in await run_io(self.store.backlog)
        }
        self.telemetry.prune()
        self.telemetry.heartbeat_at = utc_now()
        if self._periodic is not None and self._periodic.done():
            self._periodic_error = not self._periodic.cancelled() and self._periodic.exception() is not None
            if self._periodic_error:
                logger.error("[SENTINEL] Planification periodique interrompue (%s)",
                             type(self._periodic.exception()).__name__)
                self.telemetry.states["brain_3"] = "degraded"
            self._periodic = None
        if self.periodic is not None and self._periodic is None and time.monotonic() >= self._next_periodic:
            self._next_periodic = time.monotonic() + 60
            self._periodic = asyncio.create_task(self.periodic(), name="sentinel:periodic")

    async def _loop(self) -> None:
        while True:
            step = asyncio.create_task(self._tick())
            try:
                await asyncio.wait({step})
                error = None if step.cancelled() else step.exception()
                if error:
                    logger.error("[SENTINEL] Heartbeat indisponible (%s)", type(error).__name__)
                    self.telemetry.states["brain_3"] = "degraded"
                else:
                    self.telemetry.states["brain_3"] = "degraded" if self._periodic_error else "idle"
                await asyncio.sleep(self.heartbeat_interval)
            except asyncio.CancelledError:
                step.cancel()
                await asyncio.gather(step, return_exceptions=True)
                raise


class TriCortexOrchestrator:
    def __init__(self, store: OfflineStore, *, authorize: Authorize,
                 vision_reader: Callable[[bytes, str, str], Awaitable[VisionResult]],
                 sanitary_reader: Callable[[str], Awaitable[JsonObject]],
                 archive_handler: Callable[[Job], Awaitable[JsonObject]],
                 financial_handler: Callable[[Job], Awaitable[JsonObject]],
                 heartbeat_interval: float = 1, retry_delay: float = 10):
        from tri_cortex.agents import SubagentArchivist, SubagentMarginAudit, SubagentSanitaryGuard, SubagentVision

        self.store = store
        self.bus = EventBus()
        self.telemetry = Telemetry(self.bus)
        self.brain1 = Brain1FastStream(self.telemetry)
        self.brain2 = Brain2DeepReasoning(self.telemetry)
        self.hermes = Brain1Agent(HERMES, self.telemetry, window=3)
        self.iris = Brain1Agent(IRIS, self.telemetry, window=4)
        options = {"retry_delay": retry_delay}
        archivist = SubagentArchivist(store, self.telemetry, authorize, archive_handler, **options)
        self.brain3 = Brain3SentinelMaster(store, self.telemetry, [
            SubagentVision(store, self.telemetry, authorize, vision_reader, self.brain1, self.brain2, **options),
            SubagentSanitaryGuard(store, self.telemetry, authorize, sanitary_reader, **options),
            SubagentMarginAudit(store, self.telemetry, authorize, financial_handler, self.brain1, self.brain2, **options),
            archivist,
        ], heartbeat_interval=heartbeat_interval)
        self.brain3.offline_recovery = archivist.due_offline

    async def start(self) -> None:
        for node in ("brain_1", "brain_2", *BRAIN1_AGENT_IDS):
            self.telemetry.states[node] = "idle"
        try:
            await self.brain3.start()
        except (OSError, sqlite3.Error) as error:
            logger.error("[SENTINEL] Demarrage impossible (%s) ; processeurs directs conserves",
                         type(error).__name__)
            self.telemetry.states["brain_3"] = "failed"

    async def stop(self) -> None:
        await self.brain3.stop()
        for node in ("brain_1", "brain_2", *BRAIN1_AGENT_IDS):
            self.telemetry.states[node] = "stopped"

    async def stream(self, scope: str, source: AsyncIterator[str], *, deep: bool = False) -> AsyncIterator[str]:
        stream = self.brain2.stream(scope, source) if deep else source
        async for chunk in self.brain1.stream(scope, stream):
            yield chunk

    async def vision(self, context: TaskContext, content: bytes, mime_type: str, kind: str,
                     request_key: str) -> Job:
        if not self.brain3.active:
            raise QueueUnavailable("Sentinel est arrete ; aucune image mise en file.")
        digest = await run_io(self.store.put_image, context.scope, content, mime_type)
        payload = VisionInput(kind=kind, image_digest=digest, mime_type=mime_type)
        return await self.brain3.submit(context, payload, request_key)

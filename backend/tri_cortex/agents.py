"""Les quatre satellites du Cerveau 3 ; les regles metier restent dans le Cerveau 2."""
from collections.abc import Awaitable, Callable

from tri_cortex.brains import Brain1FastStream, Brain2DeepReasoning
from tri_cortex.runtime import Authorize, BaseSubAgent
from tri_cortex.schemas import (
    AgentId, ArchiveInput, FinancialInput, Job, JsonObject, PriceInput, PurgeInput, SanitaryInput, VisionInput, VisionResult,
)
from tri_cortex.store import OfflineStore, run_io
from tri_cortex.telemetry import Telemetry


class SubagentVision(BaseSubAgent):
    def __init__(self, store: OfflineStore, telemetry: Telemetry, authorize: Authorize,
                 reader: Callable[[bytes, str, str], Awaitable[VisionResult]],
                 brain1: Brain1FastStream, brain2: Brain2DeepReasoning, *, retry_delay: float = 10):
        super().__init__("vision", store, telemetry, authorize, retry_delay=retry_delay)
        self.reader, self.brain1, self.brain2 = reader, brain1, brain2

    async def process(self, job: Job) -> JsonObject:
        if not isinstance(job.input, VisionInput):
            raise ValueError("Tache incompatible avec Vision.")
        content = await run_io(self.store.image, job.context.scope, job.input.image_digest, job.input.mime_type)
        extracted = await self.reader(content, job.input.mime_type, job.input.kind)
        validated = await self.brain2.validate_vision(job.context, extracted, job.id)
        return await self.brain1.publish(job.context, job.id, validated.model_dump(mode="json"))


class SubagentSanitaryGuard(BaseSubAgent):
    def __init__(self, store: OfflineStore, telemetry: Telemetry, authorize: Authorize,
                 reader: Callable[[str], Awaitable[JsonObject]], *, retry_delay: float = 10):
        super().__init__("sanitary_guard", store, telemetry, authorize, retry_delay=retry_delay)
        self.reader = reader

    async def process(self, job: Job) -> JsonObject:
        if not isinstance(job.input, SanitaryInput):
            raise ValueError("Tache incompatible avec SanitaryGuard.")
        result = await self.reader(job.context.scope)
        self.telemetry.flow(job.context.scope, "sanitary_guard", "brain_1", job.id, "hud_result")
        return result


class SubagentMarginAudit(BaseSubAgent):
    def __init__(self, store: OfflineStore, telemetry: Telemetry, authorize: Authorize,
                 handler: Callable[[Job], Awaitable[JsonObject]],
                 brain1: Brain1FastStream, brain2: Brain2DeepReasoning, *, retry_delay: float = 10):
        super().__init__("margin_audit", store, telemetry, authorize, retry_delay=retry_delay)
        self.handler, self.brain1, self.brain2 = handler, brain1, brain2

    async def process(self, job: Job) -> JsonObject:
        if isinstance(job.input, PriceInput):
            report = await self.brain2.audit_prices(job.context, job.input.values, job.id)
            result = report.model_dump(mode="json")
        elif isinstance(job.input, FinancialInput):
            self.telemetry.flow(job.context.scope, "margin_audit", "brain_2", job.id)
            result = await self.brain2.run(job.context.scope, "analyse_financiere", lambda: self.handler(job))
        else:
            raise ValueError("Tache incompatible avec MarginAudit.")
        return await self.brain1.publish(job.context, job.id, result)


class SubagentArchivist(BaseSubAgent):
    def __init__(self, store: OfflineStore, telemetry: Telemetry, authorize: Authorize,
                 handler: Callable[[Job], Awaitable[JsonObject]], *, retry_delay: float = 10):
        super().__init__("archivist", store, telemetry, authorize, retry_delay=retry_delay)
        self.handler = handler

    async def process(self, job: Job) -> JsonObject:
        if not isinstance(job.input, (ArchiveInput, PurgeInput)):
            raise ValueError("Tache incompatible avec Archivist.")
        return await self.handler(job)

    async def due_offline(self) -> dict[AgentId, list[str]]:
        """Les donnees sont dans SQLite ; le Cerveau 3 seul repartit la reprise vers chaque specialiste."""
        from tri_cortex.schemas import AGENT_IDS

        return {agent: await run_io(self.store.due, agent) for agent in AGENT_IDS}

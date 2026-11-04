"""Bus borne et metriques de travail, jamais de texte utilisateur ni de document sur le graphe."""
import asyncio
import time
import uuid
from collections import Counter, deque
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime

from tri_cortex.schemas import (
    AGENT_IDS, BRAIN1_AGENT_IDS, NODE_IDS, AgentId, CortexEvent, CortexFrame, EdgeFlow, EventKind, NodeId,
    NodeMetrics, NodeStatus,
)
from tri_cortex.store import utc_now


@dataclass
class Activity:
    tasks: Counter[str] = field(default_factory=Counter)
    completed: int = 0
    failures: int = 0
    latency_ms: float | None = None
    first_token_ms: float | None = None
    touched: float = field(default_factory=time.monotonic)


class EventBus:
    def __init__(self, *, capacity: int = 32):
        self.capacity = capacity
        self._subscriptions: dict[asyncio.Queue[CortexEvent], frozenset[str]] = {}
        self.dropped: Counter[str] = Counter()
        self.flows: deque[CortexEvent] = deque(maxlen=1024)

    @contextmanager
    def subscribe(self, scopes: frozenset[str]) -> Iterator[asyncio.Queue[CortexEvent]]:
        if not scopes:
            raise ValueError("Un abonnement exige un perimetre explicite.")
        queue: asyncio.Queue[CortexEvent] = asyncio.Queue(maxsize=self.capacity)
        self._subscriptions[queue] = scopes
        try:
            yield queue
        finally:
            del self._subscriptions[queue]

    def publish(self, event: CortexEvent) -> None:
        self.flows.append(event)
        for queue, scopes in self._subscriptions.items():
            if event.scope not in scopes:
                continue
            if queue.full():
                dropped = queue.get_nowait()
                queue.task_done()
                self.dropped[dropped.scope] += 1
            queue.put_nowait(event)


class Telemetry:
    def __init__(self, bus: EventBus):
        self.bus = bus
        self.runtime_id = uuid.uuid4().hex
        self.sequence = 0
        self.heartbeat_at: datetime | None = None
        self.states: dict[NodeId, NodeStatus] = {node: "stopped" for node in (*NODE_IDS, *BRAIN1_AGENT_IDS)}
        self.restarts: Counter[NodeId] = Counter()
        self.activity: dict[tuple[str, NodeId], Activity] = {}
        self.backlog: dict[tuple[str, AgentId], int] = {}
        self.duplicates: Counter[tuple[str, NodeId]] = Counter()

    def duplicate(self, scope: str, node: NodeId) -> None:
        self.duplicates[(scope, node)] += 1

    def _activity(self, scope: str, node: NodeId) -> Activity:
        key = (scope, node)
        if key not in self.activity:
            self.prune()
            self.activity[key] = Activity()
        return self.activity[key]

    def prune(self) -> None:
        cutoff = time.monotonic() - 3600
        for key, value in list(self.activity.items()):
            if not value.tasks and value.touched < cutoff:
                del self.activity[key]

    @contextmanager
    def measure(self, scope: str, node: NodeId, task: str) -> Iterator[Activity]:
        activity = self._activity(scope, node)
        activity.tasks[task] += 1
        start, success = time.perf_counter(), False
        try:
            yield activity
            success = True
        finally:
            activity.tasks[task] -= 1
            if not activity.tasks[task]:
                del activity.tasks[task]
            activity.latency_ms = max(0, (time.perf_counter() - start) * 1000)
            activity.touched = time.monotonic()
            activity.completed += int(success)
            activity.failures += int(not success)

    def flow(self, scope: str, source: NodeId, target: NodeId, task_id: str | None = None,
             kind: EventKind = "flow") -> None:
        self.bus.publish(CortexEvent(
            kind=kind, scope=scope, source=source, target=target, task_id=task_id, at=utc_now(),
        ))

    def frame(self, scopes: frozenset[str]) -> CortexFrame:
        if not scopes:
            raise ValueError("Metriques sans perimetre interdites.")
        self.sequence += 1
        now = utc_now()
        metrics = [self._node_metrics(node, scopes) for node in NODE_IDS]
        satellites = metrics[3:]
        master = metrics[2]
        if master.status == "idle":
            load = sum(node.load for node in satellites) / 4
            master = master.model_copy(update={
                "load": load, "pulse_level": load,
                "status": "busy" if any(node.current_task for node in satellites) else "idle",
                "queued": sum(node.queued for node in satellites),
            })
        flows: dict[tuple[NodeId, NodeId], EdgeFlow] = {}
        for event in self.bus.flows:
            if event.scope not in scopes or event.source == event.target or (now - event.at).total_seconds() > 2:
                continue
            if event.source not in NODE_IDS or event.target not in NODE_IDS:
                continue
            pair = (event.source, event.target)
            flows[pair] = EdgeFlow(
                source=event.source, target=event.target,
                count=flows[pair].count + 1 if pair in flows else 1, last_at=event.at,
            )
        return CortexFrame(
            runtime_id=self.runtime_id, sequence=self.sequence, emitted_at=now,
            heartbeat_at=self.heartbeat_at, nodes=[metrics[0], metrics[1], master],
            satellites=satellites, edge_flows=list(flows.values()),
            dropped_events=sum(self.bus.dropped[scope] for scope in scopes),
            brain1_agents=[self._node_metrics(node, scopes) for node in BRAIN1_AGENT_IDS],
        )

    def _node_metrics(self, node: NodeId, scopes: frozenset[str]) -> NodeMetrics:
        rows = [value for (scope, key), value in self.activity.items() if scope in scopes and key == node]
        tasks = Counter()
        for row in rows:
            tasks.update(row.tasks)
        queued = sum(count for (scope, key), count in self.backlog.items() if scope in scopes and key == node)
        latest = max(rows, key=lambda row: row.touched, default=None)
        state = self.states[node]
        status = state if state != "idle" else "busy" if tasks else "idle"
        load = min(1.0, sum(tasks.values()) + queued / 64)
        parent = "brain_3" if node in AGENT_IDS else "brain_1" if node in BRAIN1_AGENT_IDS else None
        return NodeMetrics(
            id=node, parent=parent, status=status,
            latency_ms=latest.latency_ms if latest else None,
            first_token_ms=latest.first_token_ms if latest else None,
            load=load, pulse_level=load, current_task=next(iter(tasks), None),
            queued=queued, completed=sum(row.completed for row in rows),
            failures=sum(row.failures for row in rows), restarts=self.restarts[node],
            duplicates_blocked=sum(count for (scope, key), count in self.duplicates.items()
                                   if scope in scopes and key == node),
        )

"""Les agents du Cerveau 1 et leur garde-fou contre les requetes en double.

HERMES (aiguilleur) traite seul /intent : il transforme une commande en action d'interface
(ouvrir, fermer, reduire un module...) et ne converse jamais.
IRIS (messagere) traite seule /chat et /chat/stream : elle produit les reponses parlees et le
texte de SIRIUS Display, sans jamais executer d'action d'interface.

Chaque requete appartient a un seul agent. Une requete identique (meme utilisateur, meme
texte normalise, memes options) deja en cours ou terminee depuis quelques secondes n'est pas
relancee : elle rejoint le resultat existant, ou reste silencieuse pour un flux.
"""
import asyncio
import copy
import hashlib
import json
import re
import time
import unicodedata
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from tri_cortex.schemas import Brain1AgentId
from tri_cortex.telemetry import Telemetry

_WAKE_WORD = re.compile(r"^(?:(?:dis|hey|ok|eh)\s+)?(?:sigma\s*)?(?:sirius|zirius|sirus|zirus)\s+")


def normalize_request(text: str) -> str:
    value = (text or "").lower().replace("σ", "s").replace("ς", "s")
    value = "".join(char for char in unicodedata.normalize("NFD", value) if not unicodedata.combining(char))
    value = re.sub(r"[^a-z0-9]+", " ", value).strip()
    return _WAKE_WORD.sub("", value).strip()


@dataclass(frozen=True)
class Brain1AgentSpec:
    id: Brain1AgentId
    name: str
    role: str
    endpoints: tuple[str, ...]


HERMES = Brain1AgentSpec(
    id="hermes", name="HERMES",
    role="Aiguilleur : comprend les commandes et choisit l'action d'interface, sans converser.",
    endpoints=("/api/intent",),
)
IRIS = Brain1AgentSpec(
    id="iris", name="IRIS",
    role="Messagere : redige les reponses parlees et le texte du Display, sans executer d'action.",
    endpoints=("/api/chat", "/api/chat/stream"),
)


class RequestGuard:
    """Une seule execution par requete identique pendant son traitement et `window` secondes apres."""

    def __init__(self, *, window: float, capacity: int = 512):
        self.window = window
        self.capacity = capacity
        self._inflight: dict[str, asyncio.Future] = {}
        self._recent: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._streams: dict[str, float] = {}

    def _prune(self, now: float) -> None:
        for key, (expires, _) in list(self._recent.items()):
            if expires <= now:
                del self._recent[key]
        while len(self._recent) > self.capacity:
            self._recent.popitem(last=False)
        for key, expires in list(self._streams.items()):
            if expires <= now:
                del self._streams[key]

    async def run(self, key: str, operation: Callable[[], Awaitable[Any]]) -> tuple[Any, bool]:
        now = time.monotonic()
        self._prune(now)
        if key in self._recent:
            return copy.deepcopy(self._recent[key][1]), True
        if key in self._inflight:
            return copy.deepcopy(await asyncio.shield(self._inflight[key])), True
        future = asyncio.get_running_loop().create_future()
        self._inflight[key] = future
        try:
            result = await operation()
        except BaseException as error:
            if isinstance(error, asyncio.CancelledError):
                future.cancel()
            else:
                future.set_exception(error)
                future.exception()
            raise
        else:
            future.set_result(result)
            self._recent[key] = (time.monotonic() + self.window, result)
            return copy.deepcopy(result), False
        finally:
            self._inflight.pop(key, None)

    def claim_stream(self, key: str) -> bool:
        self._prune(time.monotonic())
        if key in self._streams or key in self._inflight or key in self._recent:
            return False
        self._streams[key] = float("inf")
        return True

    def stream_duplicate(self, key: str) -> bool:
        self._prune(time.monotonic())
        return key in self._streams

    def release_stream(self, key: str, *, success: bool) -> None:
        if success:
            self._streams[key] = time.monotonic() + self.window
        else:
            self._streams.pop(key, None)


class Brain1Agent:
    def __init__(self, spec: Brain1AgentSpec, telemetry: Telemetry, *, window: float):
        self.spec = spec
        self.telemetry = telemetry
        self.guard = RequestGuard(window=window)

    def key(self, scope: str, task: str, text: str, *options: Any) -> str:
        material = json.dumps(
            (self.spec.id, scope, task, normalize_request(text), options),
            ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str,
        )
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    async def handle(self, scope: str, task: str, key: str, operation: Callable[[], Awaitable[Any]]) -> Any:
        self.telemetry.flow(scope, "brain_1", self.spec.id)
        if self.guard.stream_duplicate(key):
            self.telemetry.duplicate(scope, self.spec.id)
            return {"ignored": True, "answer": "", "response": "", "text": ""}

        async def measured():
            with self.telemetry.measure(scope, self.spec.id, task):
                return await operation()

        result, duplicate = await self.guard.run(key, measured)
        if duplicate:
            self.telemetry.duplicate(scope, self.spec.id)
        return result

    def claim_stream(self, scope: str, key: str) -> bool:
        self.telemetry.flow(scope, "brain_1", self.spec.id)
        if self.guard.claim_stream(key):
            return True
        self.telemetry.duplicate(scope, self.spec.id)
        return False

    async def track_stream(self, scope: str, key: str, source: AsyncIterator[Any]) -> AsyncIterator[Any]:
        success = False
        try:
            with self.telemetry.measure(scope, self.spec.id, "dialogue_stream"):
                failed = False
                async for chunk in source:
                    text = chunk.decode("utf-8", "ignore") if isinstance(chunk, (bytes, bytearray)) else str(chunk)
                    failed = failed or '"type": "error"' in text
                    yield chunk
                success = not failed
        finally:
            self.guard.release_stream(key, success=success)

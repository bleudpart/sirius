"""Les agents du Cerveau 1 et leur garde-fou contre les requetes en double.

HERMES (aiguilleur) traite seul /intent : il transforme une commande en action d'interface
(ouvrir, fermer, reduire un module...) et ne converse jamais.
IRIS (messagere) traite seule /chat et /chat/stream : elle produit les reponses parlees et le
texte de SIRIUS Display, sans jamais executer d'action d'interface.

Chaque requete appartient a un seul agent. Une requete identique (meme utilisateur, meme
texte normalise, memes options) deja en cours n'est pas relancee : elle rejoint le resultat
existant, ou reste silencieuse pour un flux. Une nouvelle demande apres la fin est recalculee.
"""
import asyncio
import copy
import hashlib
import json
import re
import unicodedata
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
    """Une seule execution par requete identique pendant son traitement."""

    def __init__(self):
        self._inflight: dict[str, asyncio.Future] = {}
        self._streams: dict[str, asyncio.Task] = {}

    async def run(self, key: str, operation: Callable[[], Awaitable[Any]]) -> tuple[Any, bool]:
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
            return copy.deepcopy(result), False
        finally:
            self._inflight.pop(key, None)

    def claim_stream(self, key: str) -> bool:
        if key in self._streams or key in self._inflight:
            return False
        owner = asyncio.current_task()
        if owner is None:
            raise RuntimeError("Un flux doit etre rattache a une tache active.")
        self._streams[key] = owner
        owner.add_done_callback(lambda task: self._release_stream_owner(key, task))
        return True

    def stream_duplicate(self, key: str) -> bool:
        return key in self._streams

    def release_stream(self, key: str) -> None:
        self._streams.pop(key, None)

    def _release_stream_owner(self, key: str, owner: asyncio.Task) -> None:
        if self._streams.get(key) is owner:
            self.release_stream(key)


class Brain1Agent:
    def __init__(self, spec: Brain1AgentSpec, telemetry: Telemetry):
        self.spec = spec
        self.telemetry = telemetry
        self.guard = RequestGuard()

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
        try:
            with self.telemetry.measure(scope, self.spec.id, "dialogue_stream"):
                async for chunk in source:
                    yield chunk
        finally:
            self.guard.release_stream(key)

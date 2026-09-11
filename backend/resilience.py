"""Couche de résilience ΣIRIUS : timeout, retries exponentiels et disjoncteur.

Chaque service externe (SerpAPI, stockage cloud, etc.) possède son propre
disjoncteur nommé : après `failure_threshold` échecs consécutifs, les appels
sont court-circuités pendant `reset_timeout` secondes (échec immédiat, sans
réseau), puis un appel d'essai est autorisé (demi-ouvert). Un succès referme
le circuit.
"""

import asyncio
import logging
import random
import threading
import time

logger = logging.getLogger("sirius.resilience")


class CircuitOpenError(RuntimeError):
    """Le disjoncteur du service est ouvert : appel refusé sans tentative réseau."""

    def __init__(self, service: str, retry_in: float):
        super().__init__(
            f"Service '{service}' temporairement coupé (nouvel essai dans {retry_in:.0f}s)."
        )
        self.service = service
        self.retry_in = retry_in


class CircuitBreaker:
    def __init__(self, name: str, failure_threshold: int = 5, reset_timeout: float = 30.0):
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_timeout = reset_timeout
        self._failures = 0
        self._opened_at: float | None = None
        self._lock = threading.Lock()

    def allow(self) -> bool:
        with self._lock:
            if self._opened_at is None:
                return True
            # Fenêtre écoulée : autorise un appel d'essai (état demi-ouvert).
            return time.monotonic() - self._opened_at >= self.reset_timeout

    def retry_in(self) -> float:
        with self._lock:
            if self._opened_at is None:
                return 0.0
            return max(0.0, self.reset_timeout - (time.monotonic() - self._opened_at))

    def record_success(self) -> None:
        with self._lock:
            if self._opened_at is not None:
                logger.info("[RESILIENCE] Circuit '%s' refermé", self.name)
            self._failures = 0
            self._opened_at = None

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= self.failure_threshold:
                if self._opened_at is None:
                    logger.warning(
                        "[RESILIENCE] Circuit '%s' ouvert après %d échecs (pause %.0fs)",
                        self.name, self._failures, self.reset_timeout,
                    )
                # En demi-ouvert, un nouvel échec repousse la fenêtre.
                self._opened_at = time.monotonic()

    def state(self) -> str:
        with self._lock:
            if self._opened_at is None:
                return "closed"
        return "half-open" if self.allow() else "open"


_breakers: dict[str, CircuitBreaker] = {}
_registry_lock = threading.Lock()


def get_breaker(service: str, failure_threshold: int = 5, reset_timeout: float = 30.0) -> CircuitBreaker:
    with _registry_lock:
        breaker = _breakers.get(service)
        if breaker is None:
            breaker = CircuitBreaker(service, failure_threshold, reset_timeout)
            _breakers[service] = breaker
        return breaker


def breakers_snapshot() -> dict:
    """État de tous les disjoncteurs, pour /health et ARGUS."""
    with _registry_lock:
        breakers = list(_breakers.values())
    return {b.name: b.state() for b in breakers}


def _backoff_delay(attempt: int, base_delay: float) -> float:
    return base_delay * (2 ** attempt) + random.uniform(0, base_delay / 2)


async def resilient_call(
    factory,
    *,
    service: str,
    attempts: int = 3,
    base_delay: float = 0.5,
    timeout: float = 10.0,
    retry_on: tuple = (Exception,),
    failure_threshold: int = 5,
    reset_timeout: float = 30.0,
):
    """Exécute `factory()` (coroutine) avec timeout, retries et disjoncteur.

    Lève CircuitOpenError si le circuit est ouvert, sinon la dernière exception
    après épuisement des tentatives.
    """
    breaker = get_breaker(service, failure_threshold, reset_timeout)
    if not breaker.allow():
        raise CircuitOpenError(service, breaker.retry_in())
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            result = await asyncio.wait_for(factory(), timeout=timeout)
            breaker.record_success()
            return result
        except retry_on as error:
            last_error = error
            breaker.record_failure()
            logger.warning(
                "[RESILIENCE] %s tentative %d/%d échouée: %r",
                service, attempt + 1, attempts, error,
            )
            if attempt + 1 < attempts and breaker.allow():
                await asyncio.sleep(_backoff_delay(attempt, base_delay))
    raise last_error


def resilient_call_sync(
    factory,
    *,
    service: str,
    attempts: int = 3,
    base_delay: float = 0.5,
    retry_on: tuple = (Exception,),
    failure_threshold: int = 5,
    reset_timeout: float = 30.0,
):
    """Variante synchrone (appels `requests`). Le timeout reste à la charge de l'appelant."""
    breaker = get_breaker(service, failure_threshold, reset_timeout)
    if not breaker.allow():
        raise CircuitOpenError(service, breaker.retry_in())
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            result = factory()
            breaker.record_success()
            return result
        except retry_on as error:
            last_error = error
            breaker.record_failure()
            logger.warning(
                "[RESILIENCE] %s tentative %d/%d échouée: %r",
                service, attempt + 1, attempts, error,
            )
            if attempt + 1 < attempts and breaker.allow():
                time.sleep(_backoff_delay(attempt, base_delay))
    raise last_error

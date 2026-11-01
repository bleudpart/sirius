"""Worker asynchrone unique : signaux bornés, anti-rebond, reprise périodique et aucune attente côté saisie."""
import asyncio
import logging
import sqlite3
import time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from pymongo.errors import PyMongoError
from sqlalchemy import Engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from brain_analytical.collecte import collecter, entreprises_suivies
from brain_analytical.regles import analyser
from brain_analytical.schemas import (
    BusinessHealthSnapshot, EtatCerveau, EtatOrchestrateur, EvenementOperationnel, SourceSynthese,
    StatutExecution, TypeDeclencheur, TypeEvenement,
)
from brain_analytical.store import (
    dernier_appel_ia, ensure_brain_schema, journaliser, lire_etat, publier, sauver_synthese,
)
from brain_analytical.strategic_advisor import Redacteur, conseiller, repli
from finance_database import get_engine
from routers.finance import FinanceChange

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Signal:
    company_id: str
    acteur: str | None
    declencheur: TypeDeclencheur
    recu: float
    delai: float
    nombre: int = 1
    essai: int = 0


@dataclass
class Attente:
    signal: Signal
    premier: float
    echeance: float
    nombre: int


class AnalyticalOrchestrator:
    def __init__(self, db, *, engine_factory: Callable[[], Engine] = get_engine,
                 clock: Callable[[], datetime] | None = None, redacteur: Redacteur | None = None,
                 debounce: float = 20, max_delay: float = 120, periodic_start: float = 300,
                 periodic_interval: float = 3600):
        self.db = db
        self.engine_factory = engine_factory
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.redacteur = redacteur
        self.debounce, self.max_delay = debounce, max_delay
        self.periodic_start, self.periodic_interval = periodic_start, periodic_interval
        self._queue: asyncio.Queue[Signal] | None = None
        self._pending: dict[str, Attente] = {}
        self._queued: dict[str, int] = defaultdict(int)
        self._counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self._last: dict[str, datetime] = {}
        self._last_ia: dict[str, datetime] = {}
        self._periodic: datetime | None = None
        self._current: str | None = None

    def statut(self, company_id: str) -> EtatOrchestrateur:
        counts = self._counts[company_id]
        return EtatOrchestrateur(
            actif=self._queue is not None,
            en_attente=self._queued[company_id] + int(company_id in self._pending) + int(self._current == company_id),
            evenements_recus=counts["recus"], evenements_rejetes=counts["rejetes"],
            analyses_terminees=counts["terminees"], analyses_en_echec=counts["echecs"],
            syntheses_ia=counts["ia"], derniere_analyse=self._last.get(company_id),
            dernier_cycle_periodique=self._periodic,
        )

    def notify(self, company_id: str, acteur: str | None, declencheur: TypeDeclencheur = TypeDeclencheur.EVENEMENT,
               *, delai: float | None = None, essai: int = 0) -> bool:
        if self._queue is None or self._queue.qsize() + len(self._pending) >= 256:
            self._counts[company_id]["rejetes"] += 1
            logger.warning("[CERVEAU] Signal refusé : worker arrêté ou file pleine ; reprise périodique prévue")
            return False
        delay = self.debounce if declencheur == TypeDeclencheur.EVENEMENT else 0
        self._queue.put_nowait(Signal(company_id, acteur, declencheur, time.monotonic(),
                                    delay if delai is None else delai, essai=essai))
        self._queued[company_id] += 1
        self._counts[company_id]["recus"] += 1
        return True

    async def on_finance_change(self, change: FinanceChange) -> None:
        event = EvenementOperationnel(
            company_id=change.company_id, type=TypeEvenement(change.action), source=change.source,
            reference=change.reference, acteur=change.user_id or "systeme", survenu_le=self.clock(),
            nombre_ecritures=change.nombre_ecritures,
        )
        self.notify(event.company_id, change.user_id)

    async def demander_analyse(self, company_id: str, user_id: str) -> bool:
        return self.notify(company_id, user_id, TypeDeclencheur.MANUEL)

    def _recevoir(self, signal: Signal) -> None:
        self._queued[signal.company_id] -= 1
        pending = self._pending.get(signal.company_id)
        if pending is None:
            self._pending[signal.company_id] = Attente(signal, signal.recu, signal.recu + signal.delai, signal.nombre)
        else:
            pending.nombre += signal.nombre
            if pending.signal.declencheur == TypeDeclencheur.MANUEL:
                return
            # Une demande immédiate ne doit jamais être repoussée par les tickets suivants.
            due = min(pending.premier + self.max_delay, signal.recu + signal.delai)
            pending.echeance = min(pending.echeance, due) if pending.signal.declencheur != TypeDeclencheur.EVENEMENT else due
            priority = {TypeDeclencheur.PERIODIQUE: 0, TypeDeclencheur.EVENEMENT: 1,
                        TypeDeclencheur.SEUIL: 2, TypeDeclencheur.MANUEL: 3}
            if priority[signal.declencheur] >= priority[pending.signal.declencheur]:
                pending.signal = signal

    async def lire(self, company_id: str) -> EtatCerveau:
        status = self.statut(company_id)
        return await asyncio.to_thread(lambda: lire_etat(self.engine_factory(), company_id, status))

    def _calculer(self, engine: Engine, company_id: str, now: datetime,
                  declencheur: TypeDeclencheur) -> BusinessHealthSnapshot:
        ensure_brain_schema(engine)
        with Session(engine) as session:
            donnees = collecter(session, company_id, now.date())
        return analyser(donnees, now, declencheur)

    async def executer(self, signal: Signal, nombre: int = 1) -> None:
        start, now = time.monotonic(), self.clock()
        self._current = signal.company_id
        engine = None
        mode = signal.declencheur
        try:
            engine = await asyncio.to_thread(self.engine_factory)
            snapshot = await asyncio.to_thread(self._calculer, engine, signal.company_id, now, signal.declencheur)
            previous = await asyncio.to_thread(lire_etat, engine, signal.company_id, self.statut(signal.company_id))
            evolution = await asyncio.to_thread(publier, engine, snapshot)
            mode = TypeDeclencheur.SEUIL if evolution.seuil_franchi else signal.declencheur
            synthesis = previous.synthese
            last_ia = self._last_ia.get(signal.company_id)
            if last_ia is None:
                last_ia = await asyncio.to_thread(dernier_appel_ia, engine, signal.company_id)
            weekly = last_ia is None or now - last_ia >= timedelta(days=7)
            should_write = weekly or signal.declencheur in {TypeDeclencheur.MANUEL, TypeDeclencheur.SEUIL} or evolution.seuil_franchi
            cooldown = last_ia is not None and now - last_ia < timedelta(minutes=15)
            identical_ia = bool(synthesis and synthesis.source == SourceSynthese.IA and synthesis.empreinte_snapshot == snapshot.empreinte)
            if should_write and not cooldown and (not identical_ia or weekly):
                actor = signal.acteur
                if mode in {TypeDeclencheur.SEUIL, TypeDeclencheur.PERIODIQUE} or not actor:
                    company = await self.db.enterprise_companies.find_one({"id": signal.company_id})
                    actor = company.get("owner_user_id") if company else None
                self._last_ia[signal.company_id] = now
                synthesis = await conseiller(self.db, actor, snapshot, mode, now, self.redacteur)
                await asyncio.to_thread(sauver_synthese, engine, synthesis, True)
                self._counts[signal.company_id]["ia"] += int(synthesis.source == SourceSynthese.IA)
            elif evolution.change or synthesis is None or synthesis.empreinte_snapshot != snapshot.empreinte:
                motif = "Temporisation IA de 15 minutes." if cooldown else "Synthèse des règles déterministes."
                await asyncio.to_thread(sauver_synthese, engine, repli(snapshot, mode, now, motif))
            if mode == TypeDeclencheur.SEUIL and cooldown and last_ia is not None and not identical_ia:
                delay = max(1, (last_ia + timedelta(minutes=15) - now).total_seconds())
                self.notify(signal.company_id, None, TypeDeclencheur.SEUIL, delai=delay)
            detail = (f"{nombre} signal(aux) regroupé(s) ; {len(evolution.nouvelles)} nouvelle(s) alerte(s), "
                      f"{len(evolution.escaladees)} aggravée(s), {evolution.resolues} résolue(s).")
            await asyncio.to_thread(journaliser, engine, signal.company_id, mode,
                                   StatutExecution.TERMINEE if evolution.change else StatutExecution.INCHANGEE,
                                   now, int((time.monotonic() - start) * 1000), detail)
            self._counts[signal.company_id]["terminees"] += 1
            self._last[signal.company_id] = now
        except (SQLAlchemyError, sqlite3.Error, PyMongoError, OSError, ValueError):
            self._counts[signal.company_id]["echecs"] += 1
            logger.exception("[CERVEAU] Analyse non aboutie")
            if engine is not None:
                try:
                    await asyncio.to_thread(journaliser, engine, signal.company_id, signal.declencheur,
                                           StatutExecution.ECHEC, now, int((time.monotonic() - start) * 1000),
                                           "Analyse interrompue : données incohérentes ou service indisponible. Consulter le journal serveur.")
                except SQLAlchemyError:
                    logger.exception("[CERVEAU] Journal d'échec indisponible")
            if signal.essai < 2:
                self.notify(signal.company_id, signal.acteur, mode, delai=60, essai=signal.essai + 1)
        finally:
            self._current = None

    async def verifier_periodique(self) -> None:
        def companies():
            with Session(self.engine_factory()) as session:
                return entreprises_suivies(session)
        for company in await asyncio.to_thread(companies):
            state = await self.lire(company)
            if state.verifie_le is None or self.clock() - state.verifie_le >= timedelta(days=1):
                self.notify(company, None, TypeDeclencheur.PERIODIQUE)
        self._periodic = self.clock()

    async def loop(self) -> None:
        try:
            self._queue = asyncio.Queue(maxsize=256)
            self._pending.clear()
            self._queued.clear()
            next_periodic = time.monotonic() + self.periodic_start
            while True:
                try:
                    while not self._queue.empty():
                        signal = self._queue.get_nowait()
                        self._recevoir(signal)
                        self._queue.task_done()
                    now = time.monotonic()
                    if now >= next_periodic:
                        next_periodic = now + self.periodic_interval
                        await self.verifier_periodique()
                    ready = min(self._pending.values(), key=lambda item: item.echeance, default=None)
                    if ready is not None and ready.echeance <= time.monotonic():
                        self._pending.pop(ready.signal.company_id)
                        await self.executer(ready.signal, ready.nombre)
                        continue
                    timeout = max(0.01, min(next_periodic, ready.echeance if ready else next_periodic) - time.monotonic())
                    try:
                        signal = await asyncio.wait_for(self._queue.get(), timeout=timeout)
                    except TimeoutError:
                        continue
                    self._recevoir(signal)
                    self._queue.task_done()
                except (SQLAlchemyError, sqlite3.Error, PyMongoError, OSError, ValueError):
                    logger.exception("[CERVEAU] Vérification périodique indisponible ; nouvelle tentative dans une minute")
                    next_periodic = time.monotonic() + 60
                    await asyncio.sleep(1)
        finally:
            self._queue = None
            self._pending.clear()
            self._queued.clear()

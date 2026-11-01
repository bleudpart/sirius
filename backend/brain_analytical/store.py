"""État analytique local, isolé par entreprise ; transactions courtes dans finance.sqlite3."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import overload
from weakref import WeakSet

from sqlalchemy import Boolean, DateTime, Engine, Index, String, Text, delete, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

from brain_analytical.schemas import (
    AlerteSuivie, BusinessHealthSnapshot, EtatCerveau, EtatOrchestrateur, JournalExecution,
    SeveriteAlerte, StatutAlerte, StatutExecution, StrategicAlert, SyntheseStrategique, TypeDeclencheur,
)
from brain_analytical.collecte import ProfilIntrouvable
from models.finance import CompanyProfile


class BrainBase(DeclarativeBase):
    pass


class SnapshotRow(BrainBase):
    __tablename__ = "brain_snapshots"
    __table_args__ = (Index("ix_brain_snapshot_company", "company_id", "id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[str] = mapped_column(String(128))
    empreinte: Mapped[str] = mapped_column(String(64))
    contenu: Mapped[str] = mapped_column(Text)
    calcule_le: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    verifie_le: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AlertRow(BrainBase):
    __tablename__ = "brain_alerts"
    __table_args__ = (
        Index("ix_brain_alert_company", "company_id", "id"),
        Index("uq_brain_alert_open", "company_id", "code", unique=True,
              sqlite_where=text("statut != 'RESOLUE'")),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[str] = mapped_column(String(128))
    code: Mapped[str] = mapped_column(String(64))
    statut: Mapped[str] = mapped_column(String(16))
    contenu: Mapped[str] = mapped_column(Text)
    premiere_detection: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    derniere_detection: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    occurrences: Mapped[int]
    acquittee_le: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acquittee_par: Mapped[str | None] = mapped_column(String(128))
    resolue_le: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    commentaire: Mapped[str | None] = mapped_column(String(300))


class SynthesisRow(BrainBase):
    __tablename__ = "brain_syntheses"
    __table_args__ = (Index("ix_brain_synthesis_company", "company_id", "id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[str] = mapped_column(String(128))
    contenu: Mapped[str] = mapped_column(Text)
    ia_sollicitee: Mapped[bool] = mapped_column(Boolean, default=False)


class RunRow(BrainBase):
    __tablename__ = "brain_runs"
    __table_args__ = (Index("ix_brain_run_company", "company_id", "id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[str] = mapped_column(String(128))
    declencheur: Mapped[str] = mapped_column(String(16))
    statut: Mapped[str] = mapped_column(String(16))
    demarre_le: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    duree_ms: Mapped[int]
    detail: Mapped[str] = mapped_column(String(600))


_initialized: WeakSet[Engine] = WeakSet()
_schema_lock = Lock()


def ensure_brain_schema(engine: Engine) -> None:
    with _schema_lock:
        if engine not in _initialized:
            BrainBase.metadata.create_all(engine)
            _initialized.add(engine)


@overload
def utc(value: datetime) -> datetime: ...


@overload
def utc(value: None) -> None: ...


def utc(value: datetime | None) -> datetime | None:
    return value.replace(tzinfo=timezone.utc) if value is not None and value.tzinfo is None else value


def _alert(row: AlertRow) -> AlerteSuivie:
    return AlerteSuivie(
        id=row.id, statut=StatutAlerte(row.statut), alerte=StrategicAlert.model_validate_json(row.contenu),
        premiere_detection=utc(row.premiere_detection), derniere_detection=utc(row.derniere_detection),
        occurrences=row.occurrences, acquittee_le=utc(row.acquittee_le), acquittee_par=row.acquittee_par,
        resolue_le=utc(row.resolue_le), commentaire=row.commentaire,
    )


def _prune(session: Session, model: type[SnapshotRow] | type[SynthesisRow] | type[RunRow],
           company_id: str, keep: int) -> None:
    ids = select(model.id).where(model.company_id == company_id).order_by(model.id.desc()).offset(keep)
    session.execute(delete(model).where(model.id.in_(ids)))


@dataclass(frozen=True)
class Evolution:
    nouvelles: tuple[StrategicAlert, ...]
    escaladees: tuple[StrategicAlert, ...]
    resolues: int
    change: bool

    @property
    def seuil_franchi(self) -> bool:
        return any(a.severite.rang >= SeveriteAlerte.WARNING.rang for a in self.nouvelles + self.escaladees)


def publier(engine: Engine, snapshot: BusinessHealthSnapshot) -> Evolution:
    ensure_brain_schema(engine)
    now, company = snapshot.calcule_le, snapshot.company_id
    nouvelles, escaladees = [], []
    with Session(engine) as session, session.begin():
        latest = session.scalar(select(SnapshotRow).where(SnapshotRow.company_id == company).order_by(SnapshotRow.id.desc()).limit(1))
        changed = latest is None or latest.empreinte != snapshot.empreinte
        if latest is None or changed or now - utc(latest.calcule_le) >= timedelta(days=1):
            session.add(SnapshotRow(company_id=company, empreinte=snapshot.empreinte, contenu=snapshot.model_dump_json(),
                                    calcule_le=now, verifie_le=now))
        else:
            latest.verifie_le = now
        opened = {a.code: a for a in session.scalars(select(AlertRow).where(
            AlertRow.company_id == company, AlertRow.statut != StatutAlerte.RESOLUE.value,
        ))}
        for alert in snapshot.alertes:
            row = opened.pop(alert.code, None)
            if row is None:
                nouvelles.append(alert)
                session.add(AlertRow(
                    company_id=company, code=alert.code, statut=StatutAlerte.OUVERTE.value,
                    contenu=alert.model_dump_json(), premiere_detection=now, derniere_detection=now, occurrences=1,
                ))
                continue
            previous = StrategicAlert.model_validate_json(row.contenu)
            if alert.severite.rang > previous.severite.rang:
                escaladees.append(alert)
                row.statut = StatutAlerte.OUVERTE.value
                row.acquittee_le = row.acquittee_par = row.commentaire = None
            row.contenu, row.derniere_detection = alert.model_dump_json(), now
            row.occurrences += 1
        for row in opened.values():
            row.statut, row.resolue_le = StatutAlerte.RESOLUE.value, now
        session.flush()
        _prune(session, SnapshotRow, company, 400)
        resolved = select(AlertRow.id).where(
            AlertRow.company_id == company, AlertRow.statut == StatutAlerte.RESOLUE.value,
        ).order_by(AlertRow.id.desc()).offset(300)
        session.execute(delete(AlertRow).where(AlertRow.id.in_(resolved)))
    return Evolution(tuple(nouvelles), tuple(escaladees), len(opened), changed)


def sauver_synthese(engine: Engine, synthesis: SyntheseStrategique, ia_sollicitee: bool = False) -> None:
    with Session(engine) as session, session.begin():
        session.add(SynthesisRow(company_id=synthesis.company_id, contenu=synthesis.model_dump_json(),
                                 ia_sollicitee=ia_sollicitee))
        session.flush()
        _prune(session, SynthesisRow, synthesis.company_id, 100)


def dernier_appel_ia(engine: Engine, company_id: str) -> datetime | None:
    with Session(engine) as session:
        row = session.scalar(select(SynthesisRow).where(
            SynthesisRow.company_id == company_id, SynthesisRow.ia_sollicitee.is_(True),
        ).order_by(SynthesisRow.id.desc()).limit(1))
        return SyntheseStrategique.model_validate_json(row.contenu).generee_le if row else None


def journaliser(engine: Engine, company_id: str, declencheur: TypeDeclencheur, statut: StatutExecution,
                debut: datetime, duree_ms: int, detail: str) -> None:
    ensure_brain_schema(engine)
    with Session(engine) as session, session.begin():
        session.add(RunRow(company_id=company_id, declencheur=declencheur.value, statut=statut.value,
                           demarre_le=debut, duree_ms=duree_ms, detail=detail[:600]))
        session.flush()
        _prune(session, RunRow, company_id, 200)


def lire_etat(engine: Engine, company_id: str, orchestrateur: EtatOrchestrateur) -> EtatCerveau:
    ensure_brain_schema(engine)
    with Session(engine) as session:
        if session.get(CompanyProfile, company_id) is None:
            raise ProfilIntrouvable("Créez le profil financier dans NUMMARIUS → Saisie & imports.")
        row = session.scalar(select(SnapshotRow).where(SnapshotRow.company_id == company_id).order_by(SnapshotRow.id.desc()).limit(1))
        snapshot = BusinessHealthSnapshot.model_validate_json(row.contenu) if row else None
        synthesis_row = session.scalar(select(SynthesisRow).where(SynthesisRow.company_id == company_id).order_by(SynthesisRow.id.desc()).limit(1))
        synthesis = SyntheseStrategique.model_validate_json(synthesis_row.contenu) if synthesis_row else None
        opened = list(session.scalars(select(AlertRow).where(
            AlertRow.company_id == company_id, AlertRow.statut != StatutAlerte.RESOLUE.value,
        ).order_by(AlertRow.id.desc())))
        resolved = list(session.scalars(select(AlertRow).where(
            AlertRow.company_id == company_id, AlertRow.statut == StatutAlerte.RESOLUE.value,
        ).order_by(AlertRow.id.desc()).limit(20)))
        alerts = [_alert(a) for a in opened]
        alerts.sort(key=lambda a: -a.alerte.severite.rang)
        alerts.extend(_alert(a) for a in resolved)
        runs = [JournalExecution(
            id=r.id, declencheur=TypeDeclencheur(r.declencheur), statut=StatutExecution(r.statut),
            demarre_le=utc(r.demarre_le), duree_ms=r.duree_ms, detail=r.detail,
        ) for r in session.scalars(select(RunRow).where(RunRow.company_id == company_id).order_by(RunRow.id.desc()).limit(20))]
        return EtatCerveau(
            company_id=company_id, snapshot=snapshot, synthese=synthesis,
            synthese_a_jour=bool(snapshot and synthesis and synthesis.empreinte_snapshot == snapshot.empreinte),
            alertes=alerts, executions=runs, orchestrateur=orchestrateur,
            verifie_le=utc(row.verifie_le) if row else None,
        )


def acquitter(engine: Engine, company_id: str, alert_id: int, user_id: str, now: datetime, commentaire: str) -> AlerteSuivie:
    ensure_brain_schema(engine)
    with Session(engine) as session, session.begin():
        row = session.scalar(select(AlertRow).where(AlertRow.id == alert_id, AlertRow.company_id == company_id))
        if row is None:
            raise LookupError("Alerte introuvable pour cette entreprise.")
        if row.statut == StatutAlerte.RESOLUE.value:
            raise ValueError("Cette alerte est déjà résolue.")
        if row.statut != StatutAlerte.ACQUITTEE.value:
            row.statut, row.acquittee_le, row.acquittee_par = StatutAlerte.ACQUITTEE.value, now, user_id
            row.commentaire = commentaire or None
        return _alert(row)

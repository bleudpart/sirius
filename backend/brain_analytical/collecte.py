"""Lecture SQL cohérente et bornée ; aucune transaction ne reste ouverte pendant les calculs ou l'IA."""
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from kpi_engine import FinanceDataset, add_months, comparison_period, month_end
from models.finance import (
    CashBalance, CashMovement, CompanyProfile, PurchaseExpense, TransactionRevenue,
)
from routers.finance import load_dataset
from schemas.finance import ComparisonMode, Period


class ProfilIntrouvable(ValueError):
    """Aucun profil financier pour cette entreprise."""


@dataclass(frozen=True)
class DonneesCollectees:
    dataset: FinanceDataset
    periode: Period
    derniere_activite: date | None


def fenetre_analyse(aujourd_hui: date, derniere_vente: date | None, derniere_activite: date | None) -> Period:
    fin = min(derniere_vente or derniere_activite or aujourd_hui, aujourd_hui)
    try:
        debut = (
            add_months(fin.replace(day=1), -2)
            if fin == month_end(fin) else add_months(fin, -3) + timedelta(days=1)
        )
    except ValueError:
        debut = date.min
    return Period(start_date=debut, end_date=fin)


def collecter(session: Session, company_id: str, aujourd_hui: date) -> DonneesCollectees:
    if session.get(CompanyProfile, company_id) is None:
        raise ProfilIntrouvable("Créez le profil financier dans NUMMARIUS → Saisie & imports.")
    dates = [
        session.scalar(select(func.max(model.date)).where(
            model.company_id == company_id, model.date <= aujourd_hui,
        ))
        for model in (TransactionRevenue, PurchaseExpense, CashMovement, CashBalance)
    ]
    derniere = max((d for d in dates if d is not None), default=None)
    periode = fenetre_analyse(aujourd_hui, dates[0], derniere)
    periods = [periode, Period(start_date=aujourd_hui, end_date=aujourd_hui)]
    for mode in (ComparisonMode.PREVIOUS, ComparisonMode.YEAR_AGO):
        reference = comparison_period(periode, mode)
        if reference is not None:
            periods.append(reference)
    return DonneesCollectees(load_dataset(session, company_id, periods), periode, derniere)


def entreprises_suivies(session: Session) -> list[str]:
    return list(session.scalars(select(CompanyProfile.id).order_by(CompanyProfile.id)))

"""Contrats du stress test : leviers du scénario, situation de référence et résultats, sans aucun stockage."""
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BeforeValidator, Field

from schemas.finance import (
    Alert, CompanyId, CompanyProfileIn, Money, NonNegativeMoney, Period, StrictModel, ZERO, decimal_value,
)

MAX_SIMULATION_MONTHS = 36
DEFAULT_OPENING_DAYS = Decimal("30")

SignedPercent = Annotated[Decimal, BeforeValidator(decimal_value), Field(
    decimal_places=2, ge=Decimal("-100"), le=Decimal("1000"),
)]
OpeningDays = Annotated[Decimal, BeforeValidator(decimal_value), Field(
    decimal_places=2, gt=ZERO, le=Decimal("31"),
)]

# Libellés des messages de validation 422, affichés tels quels dans l'interface.
SIMULATION_FIELD_LABELS = {
    "id_entreprise": "Entreprise",
    "delta_ca_percent": "Variation du chiffre d’affaires",
    "delta_cout_matiere_percent": "Variation du coût matière",
    "charge_fixe_additionnelle_mensuelle": "Charge fixe additionnelle mensuelle",
    "investissement_emprunt_mensualite": "Mensualité du nouvel emprunt",
    "duree_mois": "Durée de projection",
    "jours_ouverture_mois": "Jours d’ouverture par mois",
    "solde_tresorerie_actuel": "Solde de trésorerie actuel",
}


class SimulationRequest(StrictModel):
    """Leviers d'un scénario. Montants HT mensuels ; pourcentages signés (−15 signifie −15 %)."""
    id_entreprise: CompanyId
    delta_ca_percent: SignedPercent = ZERO
    delta_cout_matiere_percent: SignedPercent = ZERO
    # Négative pour une économie (départ non remplacé, loyer renégocié).
    charge_fixe_additionnelle_mensuelle: Money = ZERO
    investissement_emprunt_mensualite: NonNegativeMoney = ZERO
    duree_mois: int = Field(default=12, ge=1, le=MAX_SIMULATION_MONTHS)
    # Diviseur du point mort journalier : 30 = tous les jours, 26 = fermé le dimanche, 21 = cinq jours par semaine.
    jours_ouverture_mois: OpeningDays = DEFAULT_OPENING_DAYS
    # Solde bancaire du jour ; à défaut, la trésorerie reconstituée en fin de période de référence.
    solde_tresorerie_actuel: Money | None = None


class BaseFinancialSnapshot(StrictModel):
    """Situation de référence en moyennes mensuelles HT, tirée du moteur du tableau de bord."""
    entreprise: CompanyProfileIn
    periode_reference: Period
    demo: bool = False
    # Mois calendaires proratisés, comme les charges récurrentes : 12 pour une année civile.
    mois_reference: Decimal = Field(gt=ZERO)
    chiffre_affaires_ht: Decimal
    # Matières premières et marchandises consommées : achats nets de TVA déductible et variation de stocks.
    achats_matieres: Decimal
    # Sous-traitance et fournitures.
    autres_charges_variables: Decimal
    # Loyers, salaires chargés, assurances, autres charges récurrentes et frais généraux ; hors emprunts.
    charges_fixes: Decimal
    interets_emprunts: Decimal
    capital_rembourse: Decimal
    # Solde d'ouverture plus mouvements saisis, en fin de période ; None sans solde d'ouverture.
    tresorerie_cloture: Decimal | None = None
    # Variation nette moyenne des mouvements bancaires saisis ; None sans aucun mouvement sur la période.
    flux_bancaire_reel: Decimal | None = None
    alertes_reference: tuple[Alert, ...] = ()


class IndicateursSimulation(StrictModel):
    """Indicateurs mensuels d'une situation, avant ou après le scénario, en euros HT par mois."""
    chiffre_affaires_ht: Decimal
    achats_matieres: Decimal
    autres_charges_variables: Decimal
    marge_sur_couts_variables: Decimal
    taux_marge_sur_couts_variables: Decimal | None
    charges_fixes: Decimal
    ebe: Decimal
    taux_ebe: Decimal | None
    interets_emprunts: Decimal
    capital_rembourse: Decimal
    nouvelle_mensualite: Decimal
    service_dette: Decimal
    couverture_service_dette: Decimal | None
    # EBE − annuités d'emprunt : variation mensuelle de trésorerie retenue pour la projection.
    flux_tresorerie: Decimal
    seuil_rentabilite: Decimal | None
    # CA HT mensuel couvrant charges fixes et annuités d'emprunt.
    point_mort_tresorerie: Decimal | None
    seuil_rentabilite_journalier: Decimal | None
    point_mort_journalier: Decimal | None


class PointTresorerie(StrictModel):
    """Trésorerie à la fin d'un mois projeté, sans et avec le scénario ; soldes None si le solde de départ est inconnu."""
    mois: int
    jour: int
    flux_cumule_sans_projet: Decimal
    flux_cumule_avec_projet: Decimal
    solde_sans_projet: Decimal | None
    solde_avec_projet: Decimal | None


class AlerteRuptureTresorerie(StrictModel):
    """rupture vaut None quand le solde de départ est inconnu ; mois_estime 0 signale un solde déjà négatif."""
    rupture: bool | None
    mois_estime: int | None
    # Mois de trésorerie au rythme simulé ; None si le flux mensuel est positif ou nul.
    autonomie_mois: Decimal | None
    message: str


class SimulationResponse(StrictModel):
    """Résultat du stress test, calculé en mémoire ; aucune donnée enregistrée n'est modifiée."""
    version_calcul: Literal["1"] = "1"
    demo: bool
    entreprise: CompanyProfileIn
    periode_reference: Period
    mois_reference: Decimal
    scenario: SimulationRequest
    hypotheses: list[str]
    avant: IndicateursSimulation
    apres: IndicateursSimulation
    point_mort_journalier_avant: Decimal | None
    point_mort_journalier_apres: Decimal | None
    ca_supplementaire_requis_pour_equilibre: Decimal | None
    ebe_projete_mensuel: Decimal
    variation_ebe_mensuelle: Decimal
    solde_depart: Decimal | None
    source_solde_depart: Literal["declare", "cloture_reference"] | None
    flux_bancaire_reel_mensuel: Decimal | None
    jalons_tresorerie: list[PointTresorerie]
    projection: list[PointTresorerie]
    tresorerie_residuelle_fin_periode: Decimal | None
    variation_tresorerie_periode: Decimal
    besoin_financement_max: Decimal | None
    alerte_rupture_tresorerie: AlerteRuptureTresorerie
    alertes: list[Alert]

"""Stress test et scénarios d'investissement : projection en mémoire, sans aucune écriture en base.

La situation de référence est lue par le moteur du tableau de bord (kpi_engine), puis ramenée en moyennes
mensuelles. run_stress_test applique ensuite les leviers du scénario : fonction pure et déterministe, en Decimal,
sans horloge, sans aléa et sans accès au stockage.
"""
from calendar import monthrange
from decimal import Decimal, ROUND_FLOOR, localcontext
from typing import Literal

from kpi_engine import FinanceDataset, MIN_DEBT_SERVICE_COVERAGE, build_dashboard, expense_cost, month_periods, ratio
from schemas.finance import Alert, CategorieExpense, FINANCE_CONTEXT, HUNDRED, Period, ZERO, money
from schemas.finance_simulation import (
    AlerteRuptureTresorerie, BaseFinancialSnapshot, IndicateursSimulation, PointTresorerie, SimulationRequest,
    SimulationResponse,
)

ONE = Decimal("1")
MONTHS_QUANTUM = Decimal("0.01")
AUTONOMY_QUANTUM = Decimal("0.1")
SHORT_REFERENCE_MONTHS = Decimal("3")
# Écart, en % du CA mensuel, à partir duquel le flux bancaire réel est signalé comme divergent du flux de gestion.
CASH_FLOW_GAP_PCT = Decimal("10")
DAYS_PER_MONTH = 30
MILESTONE_MONTHS = (1, 2, 3)
# Alertes de complétude du tableau de bord qui fragilisent aussi la base de la simulation.
REFERENCE_ALERT_CODES = frozenset({"NO_EXPENSE_DATA", "NO_OVERHEAD_DATA"})
HYPOTHESES = (
    "Base : moyennes mensuelles HT de la période de référence (mois calendaires proratisés), arrondies au centime.",
    "Variation du CA appliquée en volume : achats matières et autres charges variables (sous-traitance, fournitures) "
    "suivent l’activité.",
    "Variation du coût matière appliquée aux seuls achats de matières premières et de marchandises consommés, "
    "variation de stocks comprise.",
    "Charges fixes de référence (loyers, salaires chargés, assurances, frais généraux) inchangées, "
    "augmentées de la charge additionnelle saisie.",
    "Investissement financé en totalité par l’emprunt ; sa mensualité (capital et intérêts non distingués) "
    "s’ajoute au service de la dette, sans effet sur l’EBE.",
    "Seuil de rentabilité = charges fixes ÷ taux de marge sur coûts variables ; point mort de trésorerie = "
    "(charges fixes + annuités d’emprunt) ÷ ce même taux.",
    "Flux de trésorerie mensuel = EBE − annuités d’emprunt, constant chaque mois (sans saisonnalité) ; "
    "jalons J+30, J+60 et J+90 = fins des mois 1, 2 et 3.",
    "Hors TVA (supposée neutre), variation du BFR, impôt sur les sociétés, autres investissements, apports et prélèvements.",
)
StartSource = Literal["declare", "cloture_reference"]


class SimulationError(ValueError):
    """Scénario incompatible avec la situation de référence ; message en français, directement affichable."""


def _fr(value: Decimal) -> str:
    return f"{value:f}".replace(".", ",").replace("-", "−")


def reference_months(period: Period) -> Decimal:
    """Mois de la période en fractions de mois calendaires, comme la proratisation des charges récurrentes."""
    with localcontext(FINANCE_CONTEXT):
        return sum((
            Decimal((month.end_date - month.start_date).days + 1)
            / Decimal(monthrange(month.start_date.year, month.start_date.month)[1])
            for month in month_periods(period)
        ), ZERO)


def snapshot_from_dataset(dataset: FinanceDataset, period: Period, *, demo: bool = False) -> BaseFinancialSnapshot:
    """Situation de référence calculée par le moteur du tableau de bord ; pure, en mémoire, sans accès au stockage."""
    inputs = dataset.select(period)
    dashboard = build_dashboard(**inputs, demo=demo, monthly=False)
    common, banking = dashboard.common, dashboard.banking
    months = reference_months(period)
    with localcontext(FINANCE_CONTEXT):
        materials = sum((
            expense_cost(e) for e in inputs["expenses"] if e.category == CategorieExpense.MATIERE_PREMIERE
        ), ZERO) + (common.stock_variation or ZERO)
        monthly_materials = money(materials / months)
        has_movements = any(period.start_date <= m.date <= period.end_date for m in inputs["cash_movements"])
        return BaseFinancialSnapshot(
            entreprise=dashboard.company, periode_reference=period, demo=demo,
            mois_reference=months.quantize(MONTHS_QUANTUM),
            chiffre_affaires_ht=money(common.revenue_ht / months),
            achats_matieres=monthly_materials,
            # Par différence, pour que matières + autres égalent exactement les charges variables mensuelles.
            autres_charges_variables=money(common.variable_costs / months) - monthly_materials,
            charges_fixes=money(common.fixed_costs / months),
            interets_emprunts=money(common.financial_expenses / months),
            capital_rembourse=money(banking.loan_principal_repaid / months),
            tresorerie_cloture=common.closing_cash,
            flux_bancaire_reel=money(common.cash_net_flow / months) if has_movements else None,
            alertes_reference=tuple(alert for alert in dashboard.alerts if alert.code in REFERENCE_ALERT_CODES),
        )


def _indicators(
    base: BaseFinancialSnapshot, *, revenue: Decimal, materials: Decimal, other: Decimal, fixed: Decimal,
    installment: Decimal, structural_margin: Decimal, opening_days: Decimal,
) -> IndicateursSimulation:
    """structural_margin : marge sur coûts variables au volume de référence ; le taux et les seuils ne dépendent pas
    du volume, ils restent donc calculables même pour une activité simulée nulle. Les composantes sont arrondies au
    centime avant les soldes, pour que le tableau affiché tombe juste."""
    with localcontext(FINANCE_CONTEXT):
        revenue, materials, other, fixed = money(revenue), money(materials), money(other), money(fixed)
        interest, principal, installment = money(base.interets_emprunts), money(base.capital_rembourse), money(installment)
        margin = revenue - materials - other
        ebe = margin - fixed
        debt_service = interest + principal + installment
        reference = base.chiffre_affaires_ht
        computable = reference > ZERO and structural_margin > ZERO
        break_even = fixed * reference / structural_margin if computable else None
        cash_break_even = (fixed + debt_service) * reference / structural_margin if computable else None
        return IndicateursSimulation(
            chiffre_affaires_ht=revenue, achats_matieres=materials, autres_charges_variables=other,
            marge_sur_couts_variables=margin, taux_marge_sur_couts_variables=ratio(structural_margin, reference),
            charges_fixes=fixed, ebe=ebe, taux_ebe=ratio(ebe, revenue),
            interets_emprunts=interest, capital_rembourse=principal,
            nouvelle_mensualite=installment, service_dette=debt_service,
            couverture_service_dette=ratio(ebe, debt_service, percent=False),
            flux_tresorerie=ebe - debt_service,
            seuil_rentabilite=money(break_even) if break_even is not None else None,
            point_mort_tresorerie=money(cash_break_even) if cash_break_even is not None else None,
            seuil_rentabilite_journalier=money(break_even / opening_days) if break_even is not None else None,
            point_mort_journalier=money(cash_break_even / opening_days) if cash_break_even is not None else None,
        )


def _cash_point(month: int, start: Decimal | None, flow_before: Decimal, flow_after: Decimal) -> PointTresorerie:
    with localcontext(FINANCE_CONTEXT):
        cumulated_before, cumulated_after = money(flow_before * month), money(flow_after * month)
        return PointTresorerie(
            mois=month, jour=month * DAYS_PER_MONTH,
            flux_cumule_sans_projet=cumulated_before, flux_cumule_avec_projet=cumulated_after,
            solde_sans_projet=money(start + cumulated_before) if start is not None else None,
            solde_avec_projet=money(start + cumulated_after) if start is not None else None,
        )


def _cash_rupture(start: Decimal | None, flow: Decimal, horizon: int) -> AlerteRuptureTresorerie:
    """Premier mois dont la trésorerie de fin de mois devient strictement négative, au rythme simulé."""
    if start is None:
        return AlerteRuptureTresorerie(
            rupture=None, mois_estime=None, autonomie_mois=None,
            message="Rupture non évaluable : solde de trésorerie de départ inconnu.",
        )
    if start < ZERO:
        return AlerteRuptureTresorerie(
            rupture=True, mois_estime=0, autonomie_mois=ZERO.quantize(AUTONOMY_QUANTUM),
            message="Trésorerie de départ déjà négative : découvert à combler dès maintenant.",
        )
    if flow >= ZERO:
        return AlerteRuptureTresorerie(
            rupture=False, mois_estime=None, autonomie_mois=None,
            message="Flux mensuel positif ou nul : la trésorerie ne s’épuise pas dans ce scénario.",
        )
    with localcontext(FINANCE_CONTEXT):
        month = int((start / -flow).to_integral_value(rounding=ROUND_FLOOR)) + 1
    autonomy = ratio(start, -flow, percent=False, quantum=AUTONOMY_QUANTUM)
    if month <= horizon:
        return AlerteRuptureTresorerie(
            rupture=True, mois_estime=month, autonomie_mois=autonomy,
            message=f"Trésorerie négative au mois {month} (vers J+{month * DAYS_PER_MONTH}) au rythme simulé.",
        )
    return AlerteRuptureTresorerie(
        rupture=False, mois_estime=None, autonomie_mois=autonomy,
        message=f"Pas de rupture sur {horizon} mois ; au rythme simulé, la trésorerie s’épuiserait "
                f"en {_fr(autonomy)} mois environ.",
    )


def _alerts(
    base: BaseFinancialSnapshot, before: IndicateursSimulation, after: IndicateursSimulation,
    start: Decimal | None, rupture: AlerteRuptureTresorerie,
) -> list[Alert]:
    alerts: list[Alert] = []

    def add(code: str, severity: Literal["info", "warning", "critical"], message: str) -> None:
        alerts.append(Alert(code=code, severity=severity, message=message))

    if base.demo:
        add("DEMO_DATA", "info", "Données fictives de démonstration : aucune entreprise réelle, aucun chiffre client.")
    add("SIMULATION_ONLY", "info",
        "Simulation en mémoire : aucune donnée enregistrée n’est modifiée. Projection de gestion indicative, "
        "à hypothèses constantes.")
    alerts.extend(base.alertes_reference)
    if base.mois_reference < SHORT_REFERENCE_MONTHS:
        add("SHORT_REFERENCE", "warning",
            "Période de référence de moins de trois mois : moyennes mensuelles peu représentatives (saisonnalité).")
    if base.chiffre_affaires_ht <= ZERO:
        add("NO_REVENUE_BASE", "critical",
            "Aucun chiffre d’affaires positif sur la période de référence : taux de marge, seuil et point mort "
            "non calculables.")
    elif after.seuil_rentabilite is None:
        add("NON_POSITIVE_MARGIN", "critical",
            "Marge sur coûts variables nulle ou négative dans ce scénario : aucun niveau d’activité ne couvre les charges.")
    if after.ebe < ZERO:
        add("NEGATIVE_EBE_PROJECTED", "critical", "EBE mensuel projeté négatif : l’exploitation ne couvre plus ses charges.")
    coverage = after.couverture_service_dette
    if coverage is not None and coverage < ONE:
        add("DEBT_SERVICE_NOT_COVERED", "critical",
            "L’EBE projeté ne couvre pas les annuités d’emprunt, nouvelle mensualité comprise (couverture inférieure à 1).")
    elif coverage is not None and coverage < MIN_DEBT_SERVICE_COVERAGE:
        add("DEBT_SERVICE_TIGHT", "warning",
            f"Couverture projetée des annuités par l’EBE inférieure à {_fr(MIN_DEBT_SERVICE_COVERAGE)} : "
            "marge de sécurité faible pour le service de la dette.")
    if after.point_mort_tresorerie is not None and after.chiffre_affaires_ht < after.point_mort_tresorerie:
        add("BELOW_CASH_BREAK_EVEN", "warning",
            "CA projeté inférieur au point mort de trésorerie : charges et annuités d’emprunt non couvertes.")
    if start is None:
        add("MISSING_START_CASH", "warning",
            "Solde de trésorerie inconnu : saisissez le solde bancaire actuel, ou un solde d’ouverture dans le registre, "
            "pour projeter la trésorerie.")
    if rupture.rupture:
        add("CASH_RUPTURE", "critical", rupture.message)
    real = base.flux_bancaire_reel
    if real is not None and base.chiffre_affaires_ht > ZERO:
        with localcontext(FINANCE_CONTEXT):
            gap = abs(real - before.flux_tresorerie) * HUNDRED > base.chiffre_affaires_ht * CASH_FLOW_GAP_PCT
        if gap:
            add("CASH_FLOW_GAP", "info",
                "Le flux bancaire réel moyen s’écarte du flux de gestion de référence (EBE − annuités) de plus de 10 % "
                "du CA mensuel : TVA, BFR, investissements, apports ou prélèvements non modélisés.")
    return alerts


def run_stress_test(base_kpis: BaseFinancialSnapshot, scenario: SimulationRequest) -> SimulationResponse:
    """Applique le scénario à la situation de référence. Fonction pure et déterministe : ni horloge, ni stockage, ni aléa."""
    base = base_kpis
    if scenario.id_entreprise != base.entreprise.id:
        raise SimulationError("Le scénario vise une autre entreprise que la situation de référence.")
    with localcontext(FINANCE_CONTEXT):
        volume = ONE + scenario.delta_ca_percent / HUNDRED
        material_price = ONE + scenario.delta_cout_matiere_percent / HUNDRED
        fixed_after = base.charges_fixes + scenario.charge_fixe_additionnelle_mensuelle
        if fixed_after < ZERO:
            raise SimulationError(
                "Charge fixe additionnelle mensuelle : l’économie dépasse les charges fixes de la période de référence."
            )
        before = _indicators(
            base, revenue=base.chiffre_affaires_ht, materials=base.achats_matieres,
            other=base.autres_charges_variables, fixed=base.charges_fixes, installment=ZERO,
            structural_margin=base.chiffre_affaires_ht - base.achats_matieres - base.autres_charges_variables,
            opening_days=scenario.jours_ouverture_mois,
        )
        after = _indicators(
            base, revenue=base.chiffre_affaires_ht * volume,
            materials=base.achats_matieres * volume * material_price,
            other=base.autres_charges_variables * volume, fixed=fixed_after,
            installment=scenario.investissement_emprunt_mensualite,
            structural_margin=(
                base.chiffre_affaires_ht - base.achats_matieres * material_price - base.autres_charges_variables
            ),
            opening_days=scenario.jours_ouverture_mois,
        )
        start: Decimal | None = None
        source: StartSource | None = None
        if scenario.solde_tresorerie_actuel is not None:
            start, source = money(scenario.solde_tresorerie_actuel), "declare"
        elif base.tresorerie_cloture is not None:
            start, source = money(base.tresorerie_cloture), "cloture_reference"
        flows = (before.flux_tresorerie, after.flux_tresorerie)
        projection = [_cash_point(month, start, *flows) for month in range(1, scenario.duree_mois + 1)]
        end = projection[-1]
        rupture = _cash_rupture(start, after.flux_tresorerie, scenario.duree_mois)
        need = None
        if start is not None and end.solde_avec_projet is not None:
            need = money(max(ZERO, -min(start, end.solde_avec_projet)))
        additional = None
        if after.point_mort_tresorerie is not None:
            additional = money(max(ZERO, after.point_mort_tresorerie - after.chiffre_affaires_ht))
        return SimulationResponse(
            demo=base.demo, entreprise=base.entreprise, periode_reference=base.periode_reference,
            mois_reference=base.mois_reference, scenario=scenario, hypotheses=list(HYPOTHESES),
            avant=before, apres=after,
            point_mort_journalier_avant=before.point_mort_journalier,
            point_mort_journalier_apres=after.point_mort_journalier,
            ca_supplementaire_requis_pour_equilibre=additional,
            ebe_projete_mensuel=after.ebe, variation_ebe_mensuelle=money(after.ebe - before.ebe),
            solde_depart=start, source_solde_depart=source, flux_bancaire_reel_mensuel=base.flux_bancaire_reel,
            jalons_tresorerie=[_cash_point(month, start, *flows) for month in MILESTONE_MONTHS],
            projection=projection,
            tresorerie_residuelle_fin_periode=end.solde_avec_projet,
            variation_tresorerie_periode=end.flux_cumule_avec_projet,
            besoin_financement_max=need,
            alerte_rupture_tresorerie=rupture,
            alertes=_alerts(base, before, after, start, rupture),
        )

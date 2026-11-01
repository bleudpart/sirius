"""Analyse pure de ΣIRIUS : réutilisation du moteur financier et seuils indicatifs en Decimal."""
import hashlib
import json
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_FLOOR, localcontext

from brain_analytical.collecte import DonneesCollectees
from brain_analytical.schemas import (
    BusinessHealthSnapshot, IndicateurSante, NiveauSante, PointProjection,
    ProjectionTresorerie, SeveriteAlerte, StrategicAlert, TypeDeclencheur, Unite,
)
from kpi_engine import (
    build_dashboard, build_report, comparison_period, expense_cost, ratio,
)
from schemas.finance import (
    CategorieExpense, ComparisonMode, ConstructionKPIs, FINANCE_CONTEXT, FinanceDashboard,
    HospitalityKPIs, Period, RetailKPIs, ZERO, money,
)
from simulation_service import reference_months

D = Decimal
METHODE_INDICE = "Repère interne : 100 − 25 par alerte critique − 10 par vigilance, plancher 0. Pas une notation bancaire."


def fr(value: Decimal, decimals: int = 0) -> str:
    with localcontext(FINANCE_CONTEXT):
        rounded = value.quantize(D(1).scaleb(-decimals))
    return f"{rounded:,.{decimals}f}".replace(",", "\u202f").replace(".", ",").replace("-", "−")


def projeter(donnees: DonneesCollectees, dashboard: FinanceDashboard, aujourd_hui: date) -> ProjectionTresorerie | None:
    inputs = donnees.dataset.select(Period(start_date=aujourd_hui, end_date=aujourd_hui))
    balance = inputs["cash_balance"]
    if balance is None:
        return None
    months = reference_months(donnees.periode)
    with localcontext(FINANCE_CONTEXT):
        solde = balance.amount + sum((m.amount for m in inputs["cash_movements"]), ZERO)
        date_solde = max([balance.date] + [m.date for m in inputs["cash_movements"]])
        gestion = money(dashboard.banking.caf_after_principal / months) if dashboard.common.revenue_ht > ZERO else None
        bancaire = money(dashboard.common.cash_net_flow / months) if any(
            donnees.periode.start_date <= m.date <= donnees.periode.end_date
            for m in donnees.dataset.cash_movements
        ) else None
        candidates = [(v, source) for v, source in ((gestion, "gestion"), (bancaire, "bancaire")) if v is not None]
        flux, source = min(candidates, default=(None, None), key=lambda item: item[0])
        daily = flux / D(30) if flux is not None else None
        ecart = (aujourd_hui - date_solde).days
        points = [
            PointProjection(jour=j, echeance=aujourd_hui + timedelta(days=j), solde=money(solde + daily * D(ecart + j)))
            for j in (0, 15, 30, 60, 90)
        ] if daily is not None else []
        rupture = None
        solde_estime = solde + daily * D(ecart) if daily is not None else solde
        if solde_estime < ZERO:
            rupture = 0
        elif daily is not None and daily < ZERO:
            # Zéro n'est pas une rupture : premier jour de solde strictement négatif.
            rupture = max(0, int((solde / -daily).to_integral_value(rounding=ROUND_FLOOR)) + 1 - ecart)
        remaining = (date.max - aujourd_hui).days
        return ProjectionTresorerie(
            solde_depart=money(solde), date_depart=date_solde,
            flux_mensuel_gestion=gestion, flux_mensuel_bancaire=bancaire,
            flux_mensuel_retenu=flux, source_flux=source, points=points,
            jour_rupture=rupture,
            date_rupture=aujourd_hui + timedelta(days=rupture) if rupture is not None and rupture <= remaining else None,
            methode="Projection indicative : minimum des flux mensuels disponibles (CAF après capital et flux bancaire), "
                    "réparti sur 30 jours depuis la dernière observation. Hors saisonnalité, TVA, variation du BFR, "
                    "IS et nouveaux investissements ; un flux absent n'est jamais remplacé par zéro.",
        )


def analyser(donnees: DonneesCollectees, maintenant: datetime, declencheur: TypeDeclencheur) -> BusinessHealthSnapshot:
    with localcontext(FINANCE_CONTEXT):
        return _analyser(donnees, maintenant, declencheur)


def _analyser(donnees: DonneesCollectees, maintenant: datetime, declencheur: TypeDeclencheur) -> BusinessHealthSnapshot:
    dataset, period = donnees.dataset, donnees.periode
    board = build_report(dataset, period)
    common, bank, specific = board.common, board.banking, board.specific
    sales = common.revenue_ht > ZERO
    alerts: list[StrategicAlert] = []

    def add(code: str, severity: SeveriteAlerte, metric: str, label: str, value: Decimal | None,
            threshold: Decimal | None, unit: Unite, explanation: str, action: str, codes: list[str] | None = None) -> None:
        alerts.append(StrategicAlert(
            code=code, severite=severity, metrique=metric, libelle_metrique=label, valeur=value,
            seuil=threshold, unite=unit, explication=explanation[:600], plan_action=[action],
            codes_tableau_de_bord=codes or [],
        ))

    info, warning, critical = SeveriteAlerte.INFO, SeveriteAlerte.WARNING, SeveriteAlerte.CRITICAL
    currency = dataset.company.currency
    if sales and common.approximate_ebe < ZERO:
        gap = f" Le CA manque de {fr(common.break_even_revenue_ht - common.revenue_ht)} {currency} pour atteindre le seuil." if common.break_even_revenue_ht is not None else ""
        add("EBE_NEGATIF", critical, "approximate_ebe", "EBE approché", common.approximate_ebe, ZERO, "eur",
            f"EBE de {fr(common.approximate_ebe)} {currency} sur la période.{gap}",
            "Revoir les prix, consommations et charges fixes avec l'expert-comptable.",
            ["NEGATIVE_EBE", "BELOW_BREAK_EVEN"])
    if sales and common.contribution_margin_pct is not None and common.contribution_margin_pct <= ZERO:
        add("MARGE_NEGATIVE", critical, "contribution_margin_pct", "Marge sur coûts variables",
            common.contribution_margin_pct, ZERO, "pct", "Les coûts variables absorbent au moins la totalité du CA.",
            "Vérifier les achats, les inventaires et les prix avant toute augmentation d'activité.", ["NO_BREAK_EVEN"])

    # Les repères bancaires restent ceux du tableau de bord, jamais des seuils recalculés par l'IA.
    banking_rules = {
        "DEBT_SERVICE_NOT_COVERED": ("COUVERTURE_ANNUITES", "debt_service_coverage", "Couverture des annuités", D("1"), "ratio", "Revoir le service de la dette et préparer un échange avec la banque.", True),
        "DEBT_SERVICE_TIGHT": ("COUVERTURE_ANNUITES", "debt_service_coverage", "Couverture des annuités", D("1.2"), "ratio", "Renforcer la marge de sécurité avant de souscrire un emprunt.", True),
        "NO_REPAYMENT_CAPACITY": ("CAPACITE_REMBOURSEMENT", "approximate_caf", "CAF approchée", ZERO, "eur", "Établir un plan de redressement de la CAF avec l'expert-comptable.", True),
        "LONG_REPAYMENT": ("CAPACITE_REMBOURSEMENT", "debt_repayment_years", "Durée de remboursement", D("4"), "ans", "Examiner la soutenabilité de la dette avec la banque.", True),
        "HIGH_FINANCIAL_EXPENSES": ("FRAIS_FINANCIERS_ELEVES", "financial_expenses_to_ebe_pct", "Frais financiers / EBE", D("30"), "pct", "Réexaminer les conditions et le coût des financements.", True),
        "NEGATIVE_EQUITY": ("CAPITAUX_PROPRES_NEGATIFS", "equity", "Capitaux propres", ZERO, "eur", "Consulter l'expert-comptable sur la reconstitution des fonds propres et les obligations applicables.", False),
        "LOW_EQUITY_RATIO": ("AUTONOMIE_FINANCIERE_FAIBLE", "equity_ratio_pct", "Autonomie financière", D("20"), "pct", "Étudier le renforcement des fonds propres avant un nouvel endettement.", False),
        "HIGH_GEARING": ("ENDETTEMENT_NET_ELEVE", "gearing", "Endettement net / capitaux propres", D("1"), "ratio", "Rééquilibrer dette et fonds propres avec le conseil financier.", False),
        "LOW_CASH_DAYS": ("JOURS_TRESORERIE_FAIBLES", "cash_days", "Trésorerie en jours", D("30"), "jours", "Actualiser le plan des encaissements et décaissements à court terme.", False),
    }
    consumed = set(banking_rules) | {
        "NEGATIVE_EBE", "BELOW_BREAK_EVEN", "NO_BREAK_EVEN", "NEGATIVE_CASH", "MISSING_OPENING_CASH",
        "LOSS_MAKING_PROJECT", "NO_REVENUE_DATA",
    }
    completeness = []
    for item in board.alerts:
        if item.code in banking_rules:
            code, metric, label, threshold, unit, action, needs_sales = banking_rules[item.code]
            if needs_sales and not sales:
                continue
            value = getattr(bank, metric)
            add(code, critical if item.severity == "critical" else warning, metric, label, value,
                threshold, unit, item.message + (f" Valeur : {fr(value, 2)}." if value is not None else ""),
                action, [item.code])
        elif item.code.startswith(("MISSING_STOCK", "UNALLOCATED", "INCONSISTENT_STOCK", "UNAVAILABLE_")) or item.code in {
            "MISSING_TICKET_COUNTS", "MISSING_HOURS", "MISSING_DAYS", "NO_EXPENSE_DATA",
            "NO_OVERHEAD_DATA", "BALANCE_SHEET_MISSING", "BALANCE_SHEET_STALE",
        }:
            completeness.append(item)
        elif item.code not in consumed and item.severity != "info":
            add(item.code, critical if item.severity == "critical" else warning, "qualite_donnees",
                "Contrôle du registre", None, None, "nombre", item.message,
                "Vérifier les pièces à l'origine du contrôle dans le tableau de bord.", [item.code])

    if sales:
        if isinstance(specific, HospitalityKPIs):
            for key, code, label, low, high in (
                ("food_cost_pct", "FOOD_COST_ELEVE", "Coût des aliments / ventes alimentaires", D("33"), D("38")),
                ("beverage_cost_pct", "BEVERAGE_COST_ELEVE", "Coût des boissons / ventes boissons", D("30"), None),
                ("prime_cost_pct", "PRIME_COST_ELEVE", "Matières et personnel / CA", D("65"), D("70")),
            ):
                value = getattr(specific, key)
                if value is not None and value > low:
                    severe = high is not None and value > high
                    add(code, critical if severe else warning, key, label, value, high if severe else low, "pct",
                        f"{label} : {fr(value, 1)} %, au-dessus du repère indicatif.",
                        "Vérifier les portions, pertes, prix d'achat et prix de vente.")
            if specific.food_cost_pct is None:
                materials = sum((expense_cost(e) for e in dataset.select(period)["expenses"]
                                 if e.category == CategorieExpense.MATIERE_PREMIERE), ZERO)
                value = ratio(materials, common.revenue_ht)
                if value is not None and value > D("33"):
                    add("COUT_MATIERE_ELEVE", critical if value > D("38") else warning, "achats_matieres_pct",
                        "Achats matières / CA", value, D("38") if value > D("38") else D("33"), "pct",
                        f"Achats matières / CA : {fr(value, 1)} %, hors variation de stocks ; ce n'est pas un coût consommé.",
                        "Compléter les inventaires et la ventilation aliments/boissons avant de confirmer la dérive.")
        if isinstance(specific, ConstructionKPIs):
            losses = [p for p in specific.projects if p.margin < ZERO]
            if losses:
                add("CHANTIERS_DEFICITAIRES", warning, "chantiers_deficitaires", "Chantiers déficitaires",
                    D(len(losses)), ZERO, "nombre",
                    f"{len(losses)} chantier(s) avec coûts supérieurs au CA reconnu : "
                    + ", ".join(p.business_reference for p in losses[:5])[:350] + ". Un chantier en cours peut ne pas être encore facturé.",
                    "Rapprocher l'avancement, les situations facturées et le reste à engager.", ["LOSS_MAKING_PROJECT"])
        if isinstance(specific, RetailKPIs) and specific.commercial_margin is not None and specific.commercial_margin < ZERO:
            add("MARGE_COMMERCIALE_NEGATIVE", critical, "commercial_margin", "Marge commerciale",
                specific.commercial_margin, ZERO, "eur", f"Marge commerciale de {fr(specific.commercial_margin)} {currency}.",
                "Contrôler les inventaires, démarques et prix de vente.")
        if bank.safety_margin_pct is not None and ZERO <= bank.safety_margin_pct < D("10"):
            add("MARGE_SECURITE_FAIBLE", warning, "safety_margin_pct", "Marge de sécurité",
                bank.safety_margin_pct, D("10"), "pct", f"Marge de sécurité : {fr(bank.safety_margin_pct, 1)} %.",
                "Tester une baisse d'activité dans la simulation avant tout nouvel engagement.")
        previous = {v.key: v for v in board.comparison.variations} if board.comparison and board.comparison.has_data else {}
        margin = previous.get("contribution_margin_pct")
        if margin and margin.change is not None and margin.change <= D("-3"):
            add("DERIVE_MARGE", critical if margin.change <= D("-6") else warning, "contribution_margin_pct",
                "Variation du taux de marge", margin.change, D("-6") if margin.change <= D("-6") else D("-3"), "pts",
                f"Taux de marge en recul de {fr(-margin.change, 1)} points par rapport à la période précédente.",
                "Comparer prix, mix des ventes, coûts et inventaires des deux périodes.")

    reference = comparison_period(period, ComparisonMode.YEAR_AGO)
    reference_name = "la période précédente"
    before = None
    if reference is not None:
        year = build_dashboard(**dataset.select(reference), monthly=False)
        if year.common.revenue_ht > ZERO:
            before, reference_name = year.common.revenue_ht, "la même période de l'année précédente"
    if before is None and board.comparison and board.comparison.has_data:
        before = next(v.previous for v in board.comparison.variations if v.key == "revenue_ht")
    if sales and before is not None and before > ZERO:
        decline = ratio(common.revenue_ht - before, before)
        if decline is not None and decline <= D("-15"):
            add("BAISSE_CA", critical if decline <= D("-30") else warning, "revenue_ht",
                "Variation du CA", decline, D("-30") if decline <= D("-30") else D("-15"), "pct",
                f"CA en baisse de {fr(-decline, 1)} % par rapport à {reference_name}.",
                "Identifier les causes de la baisse et tester leur impact sur la trésorerie.")

    projection = projeter(donnees, board, maintenant.date())
    if projection is None:
        add("SOLDE_TRESORERIE_INCONNU", info, "closing_cash", "Solde de trésorerie", None, None, "eur",
            "Aucun solde bancaire utilisable : projection de trésorerie indisponible.",
            "Saisir un solde daté et rapprocher les mouvements du relevé bancaire.")
    else:
        current = projection.points[0].solde if projection.points else projection.solde_depart
        if current < ZERO:
            add("TRESORERIE_NEGATIVE", critical, "tresorerie_actuelle", "Trésorerie estimée", current, ZERO, "eur",
                f"Trésorerie estimée de {fr(current)} {currency} à la date d'analyse.",
                "Vérifier le solde bancaire et prioriser immédiatement les échéances.")
        elif projection.jour_rupture is not None and projection.jour_rupture <= 90:
            days = projection.jour_rupture
            limit = 15 if days <= 15 else 30 if days <= 30 else 90
            add("TENSION_TRESORERIE", critical if limit == 15 else warning if limit == 30 else info,
                "jours_autonomie", "Rupture de trésorerie estimée", D(days), D(limit), "jours",
                f"Premier solde négatif estimé dans {days} jour(s), à flux constant.",
                "Actualiser le calendrier des règlements et encaissements, puis préparer les solutions de financement.")
    if completeness:
        add("COMPLETUDE_DONNEES", info, "completude", "Complétude des données", D(len(completeness)), ZERO, "nombre",
            f"{len(completeness)} contrôle(s) de données sur la fenêtre du {period.start_date:%d/%m/%Y} au {period.end_date:%d/%m/%Y}.",
            "Compléter les pièces avant toute décision bancaire.", [a.code for a in completeness])
        alerts[-1] = alerts[-1].model_copy(update={"plan_action": [a.message[:300] for a in completeness[:6]]})
    if not sales:
        add("DONNEES_INSUFFISANTES", info, "revenue_ht", "CA HT", common.revenue_ht, ZERO, "eur",
            "Aucun CA positif sur la fenêtre : la rentabilité et l'indice de santé ne sont pas interprétables.",
            "Vérifier la complétude des ventes avant d'évaluer la rentabilité.")
    if donnees.derniere_activite is None or (maintenant.date() - donnees.derniere_activite).days > 45:
        add("DONNEES_ANCIENNES", info, "fraicheur", "Actualité des pièces", None, D(45), "jours",
            "Aucune activité datée des 45 derniers jours. L'analyse ne décrit pas nécessairement la situation actuelle.",
            "Importer les ventes, achats et relevés bancaires récents.")

    metrics: list[IndicateurSante] = []
    previous = {v.key: v for v in board.comparison.variations} if board.comparison and board.comparison.has_data else {}
    for key, label, value, unit in [
        ("revenue_ht", "CA HT", common.revenue_ht, "eur"),
        ("ca_mensuel", "CA mensuel moyen", money(common.revenue_ht / reference_months(period)), "eur"),
        ("contribution_margin_pct", "Marge sur coûts variables", common.contribution_margin_pct, "pct"),
        ("approximate_ebe", "EBE approché", common.approximate_ebe, "eur"),
        ("ebe_margin_pct", "Taux d'EBE", bank.ebe_margin_pct, "pct"),
        ("break_even_revenue_ht", "Seuil de rentabilité", common.break_even_revenue_ht, "eur"),
        ("debt_service_coverage", "Couverture des annuités", bank.debt_service_coverage, "ratio"),
    ]:
        variation = previous.get(key)
        metrics.append(IndicateurSante(cle=key, libelle=label, valeur=value, unite=unit,
                                      precedent=variation.previous if variation else None,
                                      variation=variation.change if variation else None))
    for key, label in {
        "food_cost_pct": "Coût aliments / ventes", "beverage_cost_pct": "Coût boissons / ventes",
        "prime_cost_pct": "Matières et personnel / CA", "margin_pct": "Marge sur déboursé sec",
        "commercial_margin_pct": "Marge commerciale", "estimated_stock_turnover": "Rotation des stocks",
        "average_basket_ht": "Panier moyen HT", "average_hourly_rate_ht": "Taux horaire HT",
        "average_daily_rate_ht": "Taux journalier HT", "structure_cost_ratio_pct": "Charges de structure / CA",
    }.items():
        if hasattr(specific, key):
            metrics.append(IndicateurSante(cle=key, libelle=label, valeur=getattr(specific, key),
                                          unite="pct" if key.endswith("_pct") else "ratio" if "turnover" in key else "eur"))
    alerts.sort(key=lambda a: -a.severite.rang)
    critical_count = sum(a.severite == critical for a in alerts)
    warning_count = sum(a.severite == warning for a in alerts)
    snapshot = BusinessHealthSnapshot(
        company_id=dataset.company.id, entreprise=dataset.company.name, secteur=dataset.company.sector,
        devise=currency, periode=period, periode_comparee=board.comparison.period if board.comparison else None,
        date_analyse=maintenant.date(), derniere_donnee=donnees.derniere_activite, calcule_le=maintenant,
        declencheur=declencheur, niveau=NiveauSante.CRITIQUE if critical_count else NiveauSante.INDETERMINE if not sales
        else NiveauSante.VIGILANCE if warning_count else NiveauSante.SAIN,
        indice=max(0, 100 - critical_count * 25 - warning_count * 10) if sales else None,
        methode_indice=METHODE_INDICE, indicateurs=metrics, alertes=alerts, projection=projection, empreinte="0" * 64,
    )
    encoded = json.dumps(snapshot.model_dump(mode="json", exclude={"calcule_le", "declencheur", "empreinte"}),
                         sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return snapshot.model_copy(update={"empreinte": hashlib.sha256(encoded.encode("utf-8")).hexdigest()})

"""Tableaux analytiques décisionnels de la finance d'entreprise : Decimal exact, sans I/O, sans IA.

Chaque méthode publique renvoie un HudPayload triable par colonne, diffusable tel quel au HUD (Cerveau 1)
ou interrogeable par le Cerveau 2 grâce au champ `speech`.
"""
import calendar
import json
from collections import defaultdict
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, ROUND_CEILING, localcontext

from pydantic import BaseModel

from kpi_engine import ratio as exact_ratio
from schemas.finance import Alert, FINANCE_CONTEXT, HUNDRED, ZERO, money as exact_money
from schemas.finance_analytics import (
    BreakEvenGauge, BreakEvenRequest, BreakEvenSummary, DailyRow, FoodCostVarianceRequest, GaugeMode, HudColumn,
    HudPayload, HudSort, ImpactRow, ImpactSummary, ImpactTrigger, Ingredient, JsonScalar, MenuEngineeringRequest,
    MenuRow, MenuSummary, Quadrant, Recipe, SupplierImpactRequest, SupplierPriceIncrease, VarianceRow,
    VarianceStatus, VarianceSummary,
)
from tri_cortex.schemas import PriceAuditInput

CENT = Decimal("0.01")
MICRO = Decimal("0.000001")
DEFAULT_PRICE_STEP = Decimal("0.10")
RECOMMENDATIONS: dict[Quadrant, str] = {
    Quadrant.STAR: "Sanctuariser et promouvoir.",
    Quadrant.PLOWHORSE: "Augmenter le prix ou réduire le grammage.",
    Quadrant.PUZZLE: "Repositionner, inciter en salle.",
    Quadrant.DOG: "Éliminer de la carte.",
}
STATUS_SPEECH = {VarianceStatus.GREEN: "vert", VarianceStatus.ORANGE: "orange", VarianceStatus.RED: "rouge"}
QUADRANT_ORDER = tuple(item.value for item in Quadrant)
STATUS_ORDER = tuple(item.value for item in VarianceStatus)
NUMERIC_TYPES = {"money", "percent", "number", "coefficient"}


class AnalyticsError(ValueError):
    """Message en français, directement affichable : les données fournies ne permettent pas le calcul."""


def _unsigned(value: Decimal) -> Decimal:
    """Un résultat arrondi à zéro s'affiche 0.00 : jamais de -0.00 dans un tableau."""
    return value.copy_abs() if value.is_zero() else value


def money(value: Decimal) -> Decimal:
    return _unsigned(exact_money(value))


def ratio(numerator: Decimal | None, denominator: Decimal, *, percent: bool = True) -> Decimal | None:
    result = exact_ratio(numerator, denominator, percent=percent)
    return None if result is None else _unsigned(result)


def _points(numerator: Decimal, denominator: Decimal) -> Decimal:
    """Points de pourcentage arrondis au centième ; le dénominateur est supposé strictement positif."""
    return _unsigned((numerator / denominator * HUNDRED).quantize(CENT))


@dataclass(frozen=True)
class VarianceThresholds:
    """Seuils d'écart, en points de pourcentage du chiffre d'affaires, inclusifs vers le bas."""
    green_max_pp: Decimal = Decimal("1.5")
    orange_max_pp: Decimal = Decimal("3")

    def status(self, variance_pp: Decimal) -> VarianceStatus:
        if variance_pp <= self.green_max_pp:
            return VarianceStatus.GREEN
        return VarianceStatus.ORANGE if variance_pp <= self.orange_max_pp else VarianceStatus.RED


def _col(key: str, label: str, kind: str, *, order: tuple[str, ...] | None = None, sortable: bool = True) -> HudColumn:
    return HudColumn(key=key, label=label, type=kind, order=order, sortable=sortable)  # type: ignore[arg-type]


MENU_COLUMNS = (
    _col("name", "Plat", "text"), _col("category", "Catégorie", "text"),
    _col("price_ht", "Prix HT", "money"), _col("price_ttc", "Prix TTC", "money"),
    _col("food_cost_ht", "Coût matière HT", "money"), _col("food_cost_pct", "Food cost %", "percent"),
    _col("coefficient", "Coefficient", "coefficient"), _col("unit_margin_ht", "Marge unitaire HT", "money"),
    _col("margin_rate_pct", "Taux de marge %", "percent"), _col("units_sold", "Ventes", "number"),
    _col("sales_mix_pct", "Mix des ventes %", "percent"), _col("total_margin_ht", "Marge globale HT", "money"),
    _col("margin_share_pct", "Part de marge %", "percent"),
    _col("quadrant", "Quadrant", "status", order=QUADRANT_ORDER), _col("recommendation", "Préconisation", "text", sortable=False),
    _col("target_price_ttc", "Prix cible TTC", "money"),
)
VARIANCE_COLUMNS = (
    _col("name", "Ingrédient", "text"), _col("theoretical_cost_ht", "Théorique HT", "money"),
    _col("real_cost_ht", "Réel HT", "money"), _col("variance_ht", "Écart HT", "money"),
    _col("variance_pct_of_theoretical", "Écart / théorique %", "percent"), _col("variance_pp", "Écart (pts de CA)", "percent"),
    _col("status", "Statut", "status", order=STATUS_ORDER),
)
IMPACT_COLUMNS = (
    _col("name", "Plat", "text"), _col("category", "Catégorie", "text"), _col("triggers", "Ingrédients en hausse", "text"),
    _col("current_price_ttc", "Prix TTC actuel", "money"), _col("cost_before_ht", "Coût avant HT", "money"),
    _col("cost_after_ht", "Coût après HT", "money"), _col("margin_before_ht", "Marge avant HT", "money"),
    _col("margin_after_ht", "Marge après HT", "money"), _col("erosion_ht", "Érosion HT", "money"),
    _col("erosion_pct_of_margin", "Érosion / marge %", "percent"), _col("margin_rate_before_pct", "Taux de marge avant %", "percent"),
    _col("margin_rate_after_pct", "Taux de marge après %", "percent"), _col("coefficient_before", "Coefficient avant", "coefficient"),
    _col("coefficient_after", "Coefficient après", "coefficient"), _col("target_coefficient", "Coefficient cible", "coefficient"),
    _col("recommended_price_ttc", "Prix TTC recommandé", "money"), _col("price_increase_ttc", "Hausse TTC", "money"),
    _col("price_increase_pct", "Hausse %", "percent"), _col("units_sold", "Ventes", "number"),
    _col("monthly_impact_ht", "Impact sur la période HT", "money"),
)
BREAK_EVEN_COLUMNS = (
    _col("date", "Jour", "date"), _col("revenue_ht", "CA HT", "money"), _col("variable_costs_ht", "Charges variables HT", "money"),
    _col("contribution_ht", "Marge sur coûts variables HT", "money"), _col("cumulative_revenue_ht", "CA cumulé HT", "money"),
    _col("cumulative_contribution_ht", "Marge cumulée HT", "money"), _col("coverage_pct", "Charges fixes couvertes %", "percent"),
    _col("break_even_reached", "Seuil franchi", "boolean"),
)


def _fr(value: Decimal, decimals: int = 2) -> str:
    return f"{value:,.{decimals}f}".replace(",", " ").replace(".", ",")


def _median(values: Sequence[Decimal]) -> Decimal:
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def _vat_factor(recipe: Recipe) -> Decimal:
    return 1 + recipe.vat_rate / HUNDRED


def _price_ht(recipe: Recipe) -> Decimal:
    if recipe.selling_price_ht is not None:
        return recipe.selling_price_ht
    assert recipe.selling_price_ttc is not None
    return recipe.selling_price_ttc / _vat_factor(recipe)


def _line_quantities(recipe: Recipe) -> Iterator[tuple[str, Decimal]]:
    """Quantité brute achetée par portion : la quantité nette majorée de la perte."""
    for line in recipe.lines:
        yield line.ingredient_id, line.quantity / (1 - line.waste_pct / HUNDRED)


def _recipe_cost(recipe: Recipe, unit_costs: Mapping[str, Decimal]) -> Decimal:
    total = ZERO
    for ingredient_id, gross in _line_quantities(recipe):
        total += gross * unit_costs[ingredient_id]
    return total


def _ceil_to_step(value: Decimal, step: Decimal) -> Decimal:
    # L'arrondi à 6 décimales écarte le bruit de division avant de monter au pas supérieur.
    return ((value.quantize(MICRO) / step).to_integral_value(ROUND_CEILING) * step).quantize(CENT)


def _price_ttc(recipe: Recipe) -> Decimal:
    return recipe.selling_price_ttc if recipe.selling_price_ttc is not None else money(_price_ht(recipe) * _vat_factor(recipe))


def increase_from_price_audit(
    values: PriceAuditInput, ingredients: Sequence[Ingredient], ingredient_id: str | None = None,
) -> SupplierPriceIncrease:
    """Convertit l'alerte de SubagentMarginAudit en hausse analysable, en refusant toute unité différente."""
    target = ingredient_id or values.product_id
    ingredient = next((item for item in ingredients if item.id == target), None)
    if ingredient is None:
        raise AnalyticsError(f"Hausse fournisseur : ingrédient {target} absent du catalogue.")
    if ingredient.unit != values.unit:
        raise AnalyticsError(
            f"Hausse fournisseur : prix audité par {values.unit}, ingrédient géré par {ingredient.unit}.",
        )
    return SupplierPriceIncrease(
        ingredient_id=ingredient.id, previous_unit_cost_ht=values.previous_unit_price_ht,
        new_unit_cost_ht=values.current_unit_price_ht, supplier_id=values.supplier_id, reference=values.current_reference,
    )


class AnalyticsEngine:
    """Agrégations rapides et déterministes : mêmes entrées, mêmes montants, aucun flottant."""

    def __init__(self, *, thresholds: VarianceThresholds = VarianceThresholds(), price_step: Decimal = DEFAULT_PRICE_STEP):
        if price_step <= ZERO:
            raise ValueError("Le pas de prix doit être positif.")
        self.thresholds = thresholds
        self.price_step = price_step

    # 1. Menu engineering ---------------------------------------------------------------------------------------

    def menu_engineering(
        self, request: MenuEngineeringRequest, *, sort_by: str = "total_margin_ht", descending: bool = True,
    ) -> HudPayload:
        with localcontext(FINANCE_CONTEXT):
            units = {item.recipe_id: item.units_sold for item in request.sales}
            costs = {item.id: item.unit_cost_ht for item in request.ingredients}
            total_units = sum(units.values())
            if total_units == 0:
                raise AnalyticsError("Aucune vente enregistrée : le mix des ventes n'est pas calculable.")
            entries = []
            for recipe in request.recipes:
                price, cost = _price_ht(recipe), _recipe_cost(recipe, costs)
                entries.append((recipe, price, cost, price - cost, units.get(recipe.id, 0)))
            margin_median = _median([entry[3] for entry in entries])
            volume_median = _median([Decimal(entry[4]) for entry in entries])
            revenue = sum((price * sold for _, price, _, _, sold in entries), ZERO)
            total_cost = sum((cost * sold for _, _, cost, _, sold in entries), ZERO)
            total_margin = revenue - total_cost
            rows: list[MenuRow] = []
            for recipe, price, cost, margin, sold in entries:
                high_margin = margin >= margin_median
                # Une médiane de volume nulle ferait passer un plat invendu pour un plat populaire.
                high_volume = sold >= volume_median and sold > 0
                quadrant = (
                    Quadrant.STAR if high_margin and high_volume else Quadrant.PLOWHORSE if high_volume
                    else Quadrant.PUZZLE if high_margin else Quadrant.DOG
                )
                target = None
                if quadrant == Quadrant.PLOWHORSE:
                    target = _ceil_to_step((cost + margin_median) * _vat_factor(recipe), self.price_step)
                rows.append(MenuRow(
                    recipe_id=recipe.id, name=recipe.name, category=recipe.category,
                    price_ht=money(price), price_ttc=_price_ttc(recipe), food_cost_ht=money(cost),
                    food_cost_pct=ratio(cost, price), coefficient=ratio(price, cost, percent=False),
                    unit_margin_ht=money(margin), margin_rate_pct=ratio(margin, price), units_sold=sold,
                    sales_mix_pct=ratio(Decimal(sold), Decimal(total_units)) or ZERO.quantize(CENT),
                    total_margin_ht=money(margin * sold), margin_share_pct=ratio(margin * sold, total_margin),
                    quadrant=quadrant, recommendation=RECOMMENDATIONS[quadrant], target_price_ttc=target,
                ))
            counts = {item.value: sum(1 for row in rows if row.quadrant == item) for item in Quadrant}
            summary = MenuSummary(
                dishes=len(rows), units_sold=total_units, revenue_ht=money(revenue), total_margin_ht=money(total_margin),
                food_cost_pct=ratio(total_cost, revenue), median_unit_margin_ht=money(margin_median),
                median_units_sold=volume_median.quantize(CENT), quadrant_counts=counts,
            )
            alerts: list[Alert] = []
            if len(rows) < 4:
                alerts.append(Alert(code="SMALL_MENU", severity="info",
                                    message="Moins de quatre plats : les quadrants sont indicatifs."))
            unsold = [row.name for row in rows if row.units_sold == 0]
            if unsold:
                alerts.append(Alert(code="UNSOLD_DISHES", severity="warning",
                                    message=f"Aucune vente sur la période : {', '.join(unsold[:5])}."))
            loss = [row.name for row in rows if row.unit_margin_ht <= ZERO]
            if loss:
                alerts.append(Alert(code="NEGATIVE_MARGIN", severity="critical",
                                    message=f"Marge unitaire nulle ou négative : {', '.join(loss[:5])}."))
            return self._payload(
                "menu_engineering", "Matrice Menu Engineering", MENU_COLUMNS, rows, summary, alerts,
                self._menu_speech(rows, summary), sort_by, descending,
            )

    @staticmethod
    def _menu_speech(rows: Sequence[MenuRow], summary: MenuSummary) -> str:
        counts = summary.quadrant_counts

        def count(quadrant: str, label: str) -> str:
            return f"{counts[quadrant]} {label}{'s' if counts[quadrant] > 1 else ''}"

        text = (
            f"Menu engineering sur {summary.dishes} plat{'s' if summary.dishes > 1 else ''} : {count('STAR', 'star')}, "
            f"{count('PLOWHORSE', 'plowhorse')}, {count('PUZZLE', 'puzzle')} et {count('DOG', 'dog')}. "
            f"Marge globale {_fr(summary.total_margin_ht)} euros HT."
        )
        for quadrant, label in ((Quadrant.STAR, "À sanctuariser"), (Quadrant.DOG, "À éliminer")):
            names = [row.name for row in sorted(rows, key=lambda row: row.total_margin_ht, reverse=quadrant == Quadrant.STAR)
                     if row.quadrant == quadrant][:3]
            if names:
                text += f" {label} : {', '.join(names)}."
        return text

    # 2. Food cost réel contre théorique ------------------------------------------------------------------------

    def food_cost_variance(
        self, request: FoodCostVarianceRequest, *, sort_by: str = "variance_ht", descending: bool = True,
    ) -> HudPayload:
        with localcontext(FINANCE_CONTEXT):
            units = {item.recipe_id: item.units_sold for item in request.sales}
            costs = {item.id: item.unit_cost_ht for item in request.ingredients}
            names = {item.id: item.name for item in request.ingredients}
            theoretical: dict[str, Decimal] = defaultdict(lambda: ZERO)
            revenue = ZERO
            for recipe in request.recipes:
                sold = Decimal(units.get(recipe.id, 0))
                revenue += _price_ht(recipe) * sold
                for ingredient_id, gross in _line_quantities(recipe):
                    theoretical[ingredient_id] += gross * costs[ingredient_id] * sold
            if revenue <= ZERO:
                raise AnalyticsError("Chiffre d'affaires théorique nul : l'écart de food cost n'est pas calculable.")
            opening = {item.ingredient_id: item.value_ht for item in request.opening_stock}
            closing = {item.ingredient_id: item.value_ht for item in request.closing_stock}
            purchases: dict[str, Decimal] = defaultdict(lambda: ZERO)
            for line in request.purchases:
                purchases[line.ingredient_id] += line.amount_ht
            moved = set(opening) | set(closing) | set(purchases)
            incomplete = sorted(names[item] for item in moved if item not in opening or item not in closing)
            if incomplete:
                raise AnalyticsError(
                    "Inventaire d'ouverture et de clôture requis (0 si le stock est vide) pour : "
                    + ", ".join(incomplete[:8]) + ".",
                )
            real = {item: opening[item] + purchases[item] - closing[item] for item in moved}
            theoretical_total = sum(theoretical.values(), ZERO)
            real_total = sum(real.values(), ZERO)
            variance = real_total - theoretical_total
            variance_pp = _points(variance, revenue)
            status = self.thresholds.status(variance_pp)
            rows: list[VarianceRow] = []
            for ingredient_id in sorted(set(theoretical) | set(real), key=lambda item: names[item].casefold()):
                expected, actual = theoretical.get(ingredient_id, ZERO), real.get(ingredient_id, ZERO)
                gap = actual - expected
                gap_pp = _points(gap, revenue)
                rows.append(VarianceRow(
                    ingredient_id=ingredient_id, name=names[ingredient_id], theoretical_cost_ht=money(expected),
                    real_cost_ht=money(actual), variance_ht=money(gap), variance_pct_of_theoretical=ratio(gap, expected),
                    variance_pp=gap_pp, status=self.thresholds.status(gap_pp),
                ))
            diagnosis = {
                VarianceStatus.GREEN: "Écart maîtrisé.",
                VarianceStatus.ORANGE: "Écart à surveiller : contrôler portions, inventaires et casse.",
                VarianceStatus.RED: "Suspicion de coulage, de sur-portionnage ou de perte non enregistrée.",
            }[status]
            summary = VarianceSummary(
                period=request.period, revenue_ht=money(revenue), theoretical_cost_ht=money(theoretical_total),
                real_cost_ht=money(real_total), opening_stock_ht=money(sum(opening.values(), ZERO)),
                purchases_ht=money(sum(purchases.values(), ZERO)), closing_stock_ht=money(sum(closing.values(), ZERO)),
                theoretical_food_cost_pct=_points(theoretical_total, revenue),
                real_food_cost_pct=_points(real_total, revenue),
                variance_ht=money(variance), variance_pp=variance_pp, status=status, diagnosis=diagnosis,
            )
            alerts: list[Alert] = []
            if variance_pp < -self.thresholds.orange_max_pp:
                alerts.append(Alert(code="REAL_BELOW_THEORY", severity="warning",
                                    message="Coût réel nettement inférieur au théorique : vérifier inventaires et fiches techniques."))
            negative = [row.name for row in rows if row.real_cost_ht < ZERO]
            if negative:
                alerts.append(Alert(code="NEGATIVE_CONSUMPTION", severity="critical",
                                    message=f"Consommation réelle négative (inventaire ou réception à corriger) : {', '.join(negative[:5])}."))
            unflowed = [row.name for row in rows if row.theoretical_cost_ht > ZERO and row.ingredient_id not in moved]
            if unflowed:
                alerts.append(Alert(code="NO_STOCK_DATA", severity="warning",
                                    message=f"Ingrédients vendus sans achat ni inventaire, écart sous-estimé : {', '.join(unflowed[:5])}."))
            uncovered = [row.name for row in rows if row.theoretical_cost_ht == ZERO and row.real_cost_ht > ZERO]
            if uncovered:
                alerts.append(Alert(code="NOT_IN_RECIPES", severity="info",
                                    message=f"Consommés sans fiche technique : {', '.join(uncovered[:5])}."))
            speech = (
                f"Food cost réel {_fr(summary.real_food_cost_pct)} pour cent contre {_fr(summary.theoretical_food_cost_pct)} "
                f"en théorie, soit {_fr(variance_pp)} points d'écart et {_fr(money(variance))} euros. "
                f"Statut {STATUS_SPEECH[status]}. {diagnosis}"
            )
            return self._payload(
                "food_cost_variance", "Food cost réel contre théorique", VARIANCE_COLUMNS, rows, summary, alerts,
                speech, sort_by, descending,
            )

    # 3. Impact d'une hausse fournisseur ------------------------------------------------------------------------

    def supplier_impact(
        self, request: SupplierImpactRequest, *, sort_by: str = "erosion_ht", descending: bool = True,
    ) -> HudPayload:
        with localcontext(FINANCE_CONTEXT):
            catalogue = {item.id: item for item in request.ingredients}
            before = {key: item.unit_cost_ht for key, item in catalogue.items()}
            after = dict(before)
            triggers: list[ImpactTrigger] = []
            for increase in request.increases:
                ingredient = catalogue[increase.ingredient_id]
                baseline = increase.previous_unit_cost_ht if increase.previous_unit_cost_ht is not None else ingredient.unit_cost_ht
                if increase.new_unit_cost_ht <= baseline:
                    raise AnalyticsError(f"{ingredient.name} : le nouveau coût doit dépasser le coût de référence.")
                before[ingredient.id], after[ingredient.id] = baseline, increase.new_unit_cost_ht
                triggers.append(ImpactTrigger(
                    ingredient_id=ingredient.id, name=ingredient.name, unit=ingredient.unit,
                    supplier_id=increase.supplier_id, reference=increase.reference, previous_unit_cost_ht=baseline,
                    new_unit_cost_ht=increase.new_unit_cost_ht,
                    change_pct=ratio(increase.new_unit_cost_ht - baseline, baseline),
                ))
            units = {item.recipe_id: item.units_sold for item in request.sales}
            increased = {item.ingredient_id for item in request.increases}
            rows: list[ImpactRow] = []
            for recipe in request.recipes:
                hit = [catalogue[line.ingredient_id].name for line in recipe.lines if line.ingredient_id in increased]
                if hit:
                    sold = units.get(recipe.id, 0) if request.sales else None
                    rows.append(self._impact_row(recipe, hit, before, after, sold))
            unprofitable = [row.name for row in rows if row.margin_after_ht <= ZERO]
            monthly = [row.monthly_impact_ht for row in rows if row.monthly_impact_ht is not None]
            worst = max(rows, key=lambda row: row.erosion_ht).name if rows else None
            summary = ImpactSummary(
                triggers=triggers, impacted_dishes=len(rows), unprofitable_dishes=len(unprofitable),
                total_monthly_impact_ht=money(sum(monthly, ZERO)) if request.sales else None,
                worst_dish=worst, price_step=self.price_step,
            )
            alerts: list[Alert] = []
            if not rows:
                alerts.append(Alert(code="NO_RECIPE_IMPACTED", severity="info",
                                    message="Aucune fiche technique n'utilise les ingrédients en hausse."))
            if unprofitable:
                alerts.append(Alert(code="SOLD_AT_A_LOSS", severity="critical",
                                    message=f"Plats vendus à perte au prix actuel : {', '.join(unprofitable[:5])}."))
            if any(row.recommended_price_ttc is None for row in rows):
                alerts.append(Alert(code="NO_TARGET_COEFFICIENT", severity="warning",
                                    message="Coefficient cible indéterminable pour certains plats : prix recommandé non calculé."))
            first = triggers[0]
            speech = (
                f"Hausse de {first.name}" + (f" et {len(triggers) - 1} autre(s) ingrédient(s)" if len(triggers) > 1 else "")
                + f" : {len(rows)} plat(s) touché(s)."
            )
            if worst is not None:
                speech += f" Plus forte érosion : {worst}, {_fr(max(row.erosion_ht for row in rows))} euros HT par assiette."
            if summary.total_monthly_impact_ht is not None and rows:
                speech += f" Impact estimé sur la période : {_fr(summary.total_monthly_impact_ht)} euros HT."
            if unprofitable:
                speech += f" {len(unprofitable)} plat(s) deviennent déficitaires."
            return self._payload(
                "supplier_impact", "Impact d'une hausse fournisseur", IMPACT_COLUMNS, rows, summary, alerts,
                speech, sort_by, descending,
            )

    def _impact_row(
        self, recipe: Recipe, hit: list[str], before: Mapping[str, Decimal], after: Mapping[str, Decimal], sold: int | None,
    ) -> ImpactRow:
        price = _price_ht(recipe)
        cost_before, cost_after = _recipe_cost(recipe, before), _recipe_cost(recipe, after)
        erosion = cost_after - cost_before
        margin_before = price - cost_before
        coefficient_before = price / cost_before if cost_before > ZERO else None
        target = recipe.target_coefficient or coefficient_before
        current_ttc = _price_ttc(recipe)
        recommended = increase = increase_pct = None
        if target is not None:
            recommended = max(_ceil_to_step(cost_after * target * _vat_factor(recipe), self.price_step), current_ttc)
            increase = recommended - current_ttc
            increase_pct = ratio(increase, current_ttc)
        return ImpactRow(
            recipe_id=recipe.id, name=recipe.name, category=recipe.category, triggers=", ".join(hit),
            current_price_ttc=current_ttc, cost_before_ht=money(cost_before), cost_after_ht=money(cost_after),
            margin_before_ht=money(margin_before), margin_after_ht=money(price - cost_after), erosion_ht=money(erosion),
            erosion_pct_of_margin=ratio(erosion, margin_before), margin_rate_before_pct=ratio(margin_before, price),
            margin_rate_after_pct=ratio(price - cost_after, price), coefficient_before=ratio(price, cost_before, percent=False),
            coefficient_after=ratio(price, cost_after, percent=False),
            target_coefficient=target.quantize(CENT) if target is not None else None,
            recommended_price_ttc=recommended, price_increase_ttc=increase, price_increase_pct=increase_pct,
            units_sold=sold, monthly_impact_ht=money(erosion * sold) if sold is not None else None,
        )

    # 4. Point mort dynamique ------------------------------------------------------------------------------------

    def break_even(
        self, request: BreakEvenRequest, *, sort_by: str = "date", descending: bool = False,
    ) -> HudPayload:
        with localcontext(FINANCE_CONTEXT):
            start, end = request.period.start_date, request.period.end_date
            month_days = calendar.monthrange(start.year, start.month)[1]
            as_of = request.as_of or max((item.date for item in request.daily), default=start)
            elapsed = (as_of - start).days + 1
            fixed_month = sum((item.monthly_amount_ht for item in request.fixed_charges), ZERO)
            if fixed_month <= ZERO:
                raise AnalyticsError("Charges fixes nulles : aucun point mort à calculer.")
            by_category: dict[str, Decimal] = defaultdict(lambda: ZERO)
            for charge in request.fixed_charges:
                by_category[charge.category] += charge.monthly_amount_ht
            rows: list[DailyRow] = []
            revenue = raw = consumables = ZERO
            contribution = ZERO
            reached_on = None
            for day in sorted(request.daily, key=lambda item: item.date):
                variable = day.raw_materials_ht + day.consumables_ht
                revenue, raw, consumables = revenue + day.revenue_ht, raw + day.raw_materials_ht, consumables + day.consumables_ht
                contribution += day.revenue_ht - variable
                reached = contribution >= fixed_month
                if reached and reached_on is None:
                    reached_on = day.date
                rows.append(DailyRow(
                    date=day.date, revenue_ht=money(day.revenue_ht), variable_costs_ht=money(variable),
                    contribution_ht=money(day.revenue_ht - variable), cumulative_revenue_ht=money(revenue),
                    cumulative_contribution_ht=money(contribution),
                    coverage_pct=_points(contribution, fixed_month), break_even_reached=reached,
                ))
            variable_total = raw + consumables
            rate = contribution / revenue if revenue > ZERO else None
            critical = fixed_month / rate if rate is not None and rate > ZERO else None
            profit_mode = contribution >= fixed_month
            activity_days = sum(1 for day in request.daily if day.revenue_ht > ZERO)
            average = revenue / activity_days if activity_days else None
            shortfall = max(critical - revenue, ZERO) if critical is not None else None
            remaining_days = break_even_days = None
            if critical is not None and average:
                break_even_days = (critical / average).quantize(Decimal("0.1"))
                remaining_days = 0 if profit_mode else int((shortfall / average).to_integral_value(ROUND_CEILING))
            remaining_open = None if request.planned_open_days is None else max(request.planned_open_days - activity_days, 0)
            required_daily = None
            if shortfall and remaining_open and not profit_mode:
                required_daily = money(shortfall / remaining_open)
            on_track = None if remaining_days is None or remaining_open is None else remaining_days <= remaining_open
            profit = contribution - fixed_month if profit_mode else None
            gauge = BreakEvenGauge(
                mode=GaugeMode.PROFIT if profit_mode else GaugeMode.SURVIVAL, revenue_ht=money(revenue),
                critical_revenue_ht=money(critical) if critical is not None else None,
                progress_pct=_points(contribution, fixed_month),
                shortfall_ht=None if profit_mode or shortfall is None else money(shortfall),
                net_profit_ht=money(profit) if profit is not None else None,
                net_margin_pct=ratio(profit, revenue) if profit is not None else None,
            )
            summary = BreakEvenSummary(
                period=request.period, as_of=as_of, month_days=month_days, elapsed_days=elapsed,
                fixed_charges_month_ht=money(fixed_month), fixed_charges_accrued_ht=money(fixed_month * elapsed / month_days),
                fixed_by_category={key: money(value) for key, value in by_category.items()},
                raw_materials_ht=money(raw), consumables_ht=money(consumables), variable_costs_ht=money(variable_total),
                contribution_margin_rate_pct=ratio(contribution, revenue) if revenue > ZERO else None,
                critical_revenue_ht=money(critical) if critical is not None else None,
                critical_daily_revenue_ht=money(critical / request.planned_open_days)
                if critical is not None and request.planned_open_days else None,
                break_even_activity_days=break_even_days, break_even_reached_on=reached_on, activity_days=activity_days,
                remaining_activity_days=remaining_days, remaining_open_days=remaining_open,
                required_daily_revenue_ht=required_daily, on_track=on_track,
            )
            alerts: list[Alert] = []
            if revenue <= ZERO:
                alerts.append(Alert(code="NO_REVENUE", severity="warning",
                                    message="Aucun chiffre d'affaires : taux de marge et point mort non calculables."))
            elif rate is not None and rate <= ZERO:
                alerts.append(Alert(code="NO_FINITE_BREAK_EVEN", severity="critical",
                                    message="Les charges variables absorbent tout le chiffre d'affaires : aucun point mort fini."))
            if on_track is False:
                alerts.append(Alert(code="BREAK_EVEN_AT_RISK", severity="warning",
                                    message="Au rythme actuel, le point mort ne sera pas atteint avant la fin des jours d'ouverture prévus."))
            return self._payload(
                "break_even", "Seuil de rentabilité dynamique", BREAK_EVEN_COLUMNS, rows, summary, alerts,
                self._break_even_speech(gauge, summary), sort_by, descending, gauge=gauge,
            )

    @staticmethod
    def _break_even_speech(gauge: BreakEvenGauge, summary: BreakEvenSummary) -> str:
        if gauge.critical_revenue_ht is None:
            return "Point mort non calculable : chiffre d'affaires insuffisant ou charges variables trop élevées."
        text = f"Point mort mensuel : {_fr(gauge.critical_revenue_ht)} euros de chiffre d'affaires HT. "
        if gauge.mode == GaugeMode.PROFIT:
            day = summary.break_even_reached_on
            return text + (
                f"Seuil franchi le {day:%d/%m}" if day else "Seuil franchi"
            ) + f" ; bénéfice net à ce jour {_fr(gauge.net_profit_ht or ZERO)} euros HT."
        text += f"Réalisé {_fr(gauge.revenue_ht)} euros, soit {_fr(gauge.progress_pct or ZERO, 0)} pour cent."
        if summary.remaining_activity_days is not None:
            text += f" Il reste environ {summary.remaining_activity_days} jour(s) d'activité."
        return text

    # Tri et diffusion -------------------------------------------------------------------------------------------

    @staticmethod
    def _payload(
        kind: str, title: str, columns: Sequence[HudColumn], rows: Sequence[BaseModel], summary: BaseModel,
        alerts: Sequence[Alert], speech: str, sort_by: str, descending: bool, *, gauge: BaseModel | None = None,
    ) -> HudPayload:
        dumped: list[dict[str, JsonScalar]] = [row.model_dump(mode="json") for row in rows]
        payload = HudPayload(
            kind=kind, title=title, columns=tuple(columns), rows=tuple(dumped),  # type: ignore[arg-type]
            summary=summary.model_dump(mode="json"), gauge=gauge.model_dump(mode="json") if gauge else None,
            alerts=tuple(alerts), sort=HudSort(key=sort_by, descending=descending), speech=speech,
        )
        return AnalyticsEngine.sort(payload, sort_by, descending)

    @staticmethod
    def sort(payload: HudPayload, sort_by: str, descending: bool = False) -> HudPayload:
        """Tri stable sur une colonne triable ; les valeurs absentes restent en fin de liste dans les deux sens."""
        column = next((item for item in payload.columns if item.key == sort_by), None)
        if column is None or not column.sortable:
            allowed = ", ".join(item.key for item in payload.columns if item.sortable)
            raise AnalyticsError(f"Colonne de tri inconnue ou non triable : {sort_by}. Colonnes disponibles : {allowed}.")

        def key(row: Mapping[str, JsonScalar]) -> object:
            value = row[sort_by]
            if column.order is not None:
                return column.order.index(str(value))
            if column.type in NUMERIC_TYPES:
                return Decimal(str(value))
            if column.type == "boolean":
                return int(bool(value))
            return str(value).casefold()

        identity = payload.columns[0].key
        ordered = sorted(payload.rows, key=lambda row: str(row[identity]).casefold())
        present = sorted((row for row in ordered if row[sort_by] is not None), key=key, reverse=descending)
        missing = [row for row in ordered if row[sort_by] is None]
        return payload.model_copy(update={"rows": tuple(present + missing), "sort": HudSort(key=sort_by, descending=descending)})

    @staticmethod
    def ndjson(payload: HudPayload) -> Iterator[str]:
        """Flux ligne à ligne : l'en-tête permet au HUD de dessiner le tableau avant l'arrivée des lignes."""
        header = payload.model_dump(mode="json", exclude={"rows"})
        yield json.dumps({"type": "header", **header}, ensure_ascii=False, separators=(",", ":"))
        for row in payload.rows:
            yield json.dumps({"type": "row", "data": row}, ensure_ascii=False, separators=(",", ":"))
        yield json.dumps({"type": "end", "rows": len(payload.rows)}, separators=(",", ":"))

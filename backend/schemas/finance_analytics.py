"""Contrats des tableaux analytiques décisionnels : entrées strictes, sorties typées, aucun stockage."""
from calendar import monthrange
from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Annotated, Literal, Self

from pydantic import Field, JsonValue, model_validator

from schemas.finance import (
    Alert, HUNDRED, IsoDate, Money, NonNegativeMoney, Percent, Period, Quantity, StrictModel, ZERO,
)

EntityId = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:-]+$")]
Label = Annotated[str, Field(min_length=1, max_length=160)]
Portions = Annotated[int, Field(ge=0, le=10_000_000)]
PositiveQuantity = Annotated[Quantity, Field(gt=ZERO)]
PositiveMoney = Annotated[Money, Field(gt=ZERO)]
Unit = Literal["kg", "g", "l", "piece"]
FixedChargeCategory = Literal["RENT", "INSURANCE", "SUBSCRIPTION", "PAYROLL", "LOAN", "OTHER"]
JsonScalar = str | int | bool | None

MAX_INGREDIENTS = 1000
MAX_RECIPES = 500
MAX_LINES_PER_RECIPE = 60
MAX_PURCHASE_LINES = 3000

ANALYTICS_FIELD_LABELS = {
    "ingredients": "Ingrédients", "recipes": "Fiches techniques", "sales": "Ventes",
    "period": "Période", "opening_stock": "Stock d’ouverture", "closing_stock": "Stock de clôture",
    "purchases": "Achats réceptionnés", "increases": "Hausses fournisseur", "as_of": "Date d’analyse",
    "fixed_charges": "Charges fixes", "daily": "Activité quotidienne", "planned_open_days": "Jours d’ouverture prévus",
}


class Ingredient(StrictModel):
    """Coût unitaire HT dans l'unité déclarée : les quantités des fiches techniques utilisent la même unité."""
    id: EntityId
    name: Label
    unit: Unit
    unit_cost_ht: Quantity


class RecipeLine(StrictModel):
    ingredient_id: EntityId
    # Quantité nette servie dans l'assiette, dans l'unité de l'ingrédient.
    quantity: PositiveQuantity
    # Perte à l'épluchage, à la cuisson ou au parage : le coût porte sur la quantité brute achetée.
    waste_pct: Annotated[Percent, Field(lt=HUNDRED)] = ZERO


class Recipe(StrictModel):
    """Fiche technique d'un plat. Le prix est saisi HT ou TTC, jamais les deux."""
    id: EntityId
    name: Label
    category: Label = "Plat"
    vat_rate: Percent = Decimal("10")
    selling_price_ht: PositiveMoney | None = None
    selling_price_ttc: PositiveMoney | None = None
    # Coefficient multiplicateur visé (prix HT / coût matière) ; à défaut, celui de la carte actuelle.
    target_coefficient: PositiveQuantity | None = None
    lines: list[RecipeLine] = Field(min_length=1, max_length=MAX_LINES_PER_RECIPE)

    @model_validator(mode="after")
    def one_price(self) -> Self:
        if (self.selling_price_ht is None) == (self.selling_price_ttc is None):
            raise ValueError("Renseigner le prix de vente HT ou TTC, un seul des deux.")
        return self


class DishSales(StrictModel):
    recipe_id: EntityId
    units_sold: Portions


class CostBase(StrictModel):
    ingredients: list[Ingredient] = Field(min_length=1, max_length=MAX_INGREDIENTS)
    recipes: list[Recipe] = Field(min_length=1, max_length=MAX_RECIPES)

    @model_validator(mode="after")
    def coherent_catalogue(self) -> Self:
        ingredient_ids = [item.id for item in self.ingredients]
        if len(set(ingredient_ids)) != len(ingredient_ids):
            raise ValueError("Ingrédient en double dans le catalogue.")
        recipe_ids = [recipe.id for recipe in self.recipes]
        if len(set(recipe_ids)) != len(recipe_ids):
            raise ValueError("Fiche technique en double.")
        known = set(ingredient_ids)
        for recipe in self.recipes:
            unknown = {line.ingredient_id for line in recipe.lines} - known
            if unknown:
                raise ValueError(f"La fiche {recipe.id} cite des ingrédients inconnus : {', '.join(sorted(unknown))}.")
        return self

    def check_sales(self, sales: list[DishSales]) -> None:
        known = {recipe.id for recipe in self.recipes}
        seen: set[str] = set()
        for item in sales:
            if item.recipe_id not in known:
                raise ValueError(f"Ventes : fiche technique inconnue {item.recipe_id}.")
            if item.recipe_id in seen:
                raise ValueError(f"Ventes : plat {item.recipe_id} indiqué deux fois.")
            seen.add(item.recipe_id)


class MenuEngineeringRequest(CostBase):
    sales: list[DishSales] = Field(max_length=MAX_RECIPES)

    @model_validator(mode="after")
    def coherent_sales(self) -> Self:
        self.check_sales(self.sales)
        return self


class StockValue(StrictModel):
    ingredient_id: EntityId
    value_ht: NonNegativeMoney


class PurchaseLine(StrictModel):
    """Ligne de réception confirmée ; un avoir fournisseur est un montant négatif."""
    ingredient_id: EntityId
    amount_ht: Money
    reception_ref: Label | None = None


class FoodCostVarianceRequest(CostBase):
    period: Period
    sales: list[DishSales] = Field(min_length=1, max_length=MAX_RECIPES)
    opening_stock: list[StockValue] = Field(max_length=MAX_INGREDIENTS)
    closing_stock: list[StockValue] = Field(max_length=MAX_INGREDIENTS)
    purchases: list[PurchaseLine] = Field(max_length=MAX_PURCHASE_LINES)

    @model_validator(mode="after")
    def coherent_flows(self) -> Self:
        self.check_sales(self.sales)
        known = {item.id for item in self.ingredients}
        for label, stock in (("ouverture", self.opening_stock), ("clôture", self.closing_stock)):
            ids = [item.ingredient_id for item in stock]
            if len(set(ids)) != len(ids):
                raise ValueError(f"Stock de {label} : ingrédient indiqué deux fois.")
            if set(ids) - known:
                raise ValueError(f"Stock de {label} : ingrédient inconnu.")
        if {item.ingredient_id for item in self.purchases} - known:
            raise ValueError("Achats : ingrédient inconnu.")
        return self


class SupplierPriceIncrease(StrictModel):
    """Hausse confirmée d'un ingrédient, par exemple issue d'une alerte de SubagentMarginAudit."""
    ingredient_id: EntityId
    # Coût de référence avant hausse ; à défaut, celui du catalogue.
    previous_unit_cost_ht: Quantity | None = None
    new_unit_cost_ht: Quantity
    supplier_id: Label | None = None
    reference: Label | None = None


class SupplierImpactRequest(CostBase):
    sales: list[DishSales] = Field(default_factory=list, max_length=MAX_RECIPES)
    increases: list[SupplierPriceIncrease] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def coherent_increases(self) -> Self:
        self.check_sales(self.sales)
        ids = [item.ingredient_id for item in self.increases]
        if len(set(ids)) != len(ids):
            raise ValueError("Hausse fournisseur : ingrédient indiqué deux fois.")
        if set(ids) - {item.id for item in self.ingredients}:
            raise ValueError("Hausse fournisseur : ingrédient inconnu du catalogue.")
        return self


class FixedCharge(StrictModel):
    category: FixedChargeCategory
    label: Label
    monthly_amount_ht: NonNegativeMoney


class DailyActivity(StrictModel):
    date: IsoDate
    revenue_ht: NonNegativeMoney
    raw_materials_ht: NonNegativeMoney = ZERO
    consumables_ht: NonNegativeMoney = ZERO


class BreakEvenRequest(StrictModel):
    """Un mois civil entier ; les charges fixes sont mensuelles et proratisées au jour."""
    period: Period
    as_of: IsoDate | None = None
    fixed_charges: list[FixedCharge] = Field(min_length=1, max_length=100)
    daily: list[DailyActivity] = Field(max_length=31)
    # Jours d'ouverture prévus sur le mois, pour le CA critique quotidien et le reste à ouvrir.
    planned_open_days: int | None = Field(default=None, ge=1, le=31)

    @model_validator(mode="after")
    def coherent_month(self) -> Self:
        start, end = self.period.start_date, self.period.end_date
        if start.day != 1 or end != date(start.year, start.month, monthrange(start.year, start.month)[1]):
            raise ValueError("La période doit être un mois civil entier.")
        if self.as_of is not None and not start <= self.as_of <= end:
            raise ValueError("La date d'analyse doit appartenir au mois.")
        limit = self.as_of or end
        dates = [item.date for item in self.daily]
        if len(set(dates)) != len(dates):
            raise ValueError("Activité quotidienne : date indiquée deux fois.")
        if any(not start <= item <= limit for item in dates):
            raise ValueError("Activité quotidienne hors du mois ou postérieure à la date d'analyse.")
        if self.planned_open_days is not None and self.planned_open_days > (end - start).days + 1:
            raise ValueError("Plus de jours d'ouverture prévus que de jours dans le mois.")
        return self


class Quadrant(str, Enum):
    STAR = "STAR"
    PLOWHORSE = "PLOWHORSE"
    PUZZLE = "PUZZLE"
    DOG = "DOG"


class VarianceStatus(str, Enum):
    GREEN = "GREEN"
    ORANGE = "ORANGE"
    RED = "RED"


class GaugeMode(str, Enum):
    SURVIVAL = "SURVIVAL"
    PROFIT = "PROFIT"


class MenuRow(StrictModel):
    recipe_id: str
    name: str
    category: str
    price_ht: Decimal
    price_ttc: Decimal
    food_cost_ht: Decimal
    food_cost_pct: Decimal | None
    coefficient: Decimal | None
    unit_margin_ht: Decimal
    margin_rate_pct: Decimal | None
    units_sold: int
    sales_mix_pct: Decimal
    total_margin_ht: Decimal
    margin_share_pct: Decimal | None
    quadrant: Quadrant
    recommendation: str
    # Prix TTC qui amènerait un PLOWHORSE à la marge médiane, arrondi au pas de prix supérieur.
    target_price_ttc: Decimal | None


class MenuSummary(StrictModel):
    dishes: int
    units_sold: int
    revenue_ht: Decimal
    total_margin_ht: Decimal
    food_cost_pct: Decimal | None
    median_unit_margin_ht: Decimal
    median_units_sold: Decimal
    quadrant_counts: dict[str, int]


class VarianceRow(StrictModel):
    ingredient_id: str
    name: str
    theoretical_cost_ht: Decimal
    real_cost_ht: Decimal
    variance_ht: Decimal
    variance_pct_of_theoretical: Decimal | None
    variance_pp: Decimal | None
    status: VarianceStatus


class VarianceSummary(StrictModel):
    period: Period
    revenue_ht: Decimal
    theoretical_cost_ht: Decimal
    real_cost_ht: Decimal
    opening_stock_ht: Decimal
    purchases_ht: Decimal
    closing_stock_ht: Decimal
    theoretical_food_cost_pct: Decimal
    real_food_cost_pct: Decimal
    variance_ht: Decimal
    variance_pp: Decimal
    status: VarianceStatus
    diagnosis: str


class ImpactRow(StrictModel):
    recipe_id: str
    name: str
    category: str
    triggers: str
    current_price_ttc: Decimal
    cost_before_ht: Decimal
    cost_after_ht: Decimal
    margin_before_ht: Decimal
    margin_after_ht: Decimal
    erosion_ht: Decimal
    erosion_pct_of_margin: Decimal | None
    margin_rate_before_pct: Decimal | None
    margin_rate_after_pct: Decimal | None
    coefficient_before: Decimal | None
    coefficient_after: Decimal | None
    target_coefficient: Decimal | None
    recommended_price_ttc: Decimal | None
    price_increase_ttc: Decimal | None
    price_increase_pct: Decimal | None
    units_sold: int | None
    monthly_impact_ht: Decimal | None


class ImpactTrigger(StrictModel):
    ingredient_id: str
    name: str
    unit: str
    supplier_id: str | None
    reference: str | None
    previous_unit_cost_ht: Decimal
    new_unit_cost_ht: Decimal
    change_pct: Decimal | None


class ImpactSummary(StrictModel):
    triggers: list[ImpactTrigger]
    impacted_dishes: int
    unprofitable_dishes: int
    total_monthly_impact_ht: Decimal | None
    worst_dish: str | None
    price_step: Decimal


class DailyRow(StrictModel):
    date: date
    revenue_ht: Decimal
    variable_costs_ht: Decimal
    contribution_ht: Decimal
    cumulative_revenue_ht: Decimal
    cumulative_contribution_ht: Decimal
    coverage_pct: Decimal
    break_even_reached: bool


class BreakEvenGauge(StrictModel):
    mode: GaugeMode
    revenue_ht: Decimal
    critical_revenue_ht: Decimal | None
    progress_pct: Decimal | None
    shortfall_ht: Decimal | None
    net_profit_ht: Decimal | None
    net_margin_pct: Decimal | None


class BreakEvenSummary(StrictModel):
    period: Period
    as_of: date
    month_days: int
    elapsed_days: int
    fixed_charges_month_ht: Decimal
    fixed_charges_accrued_ht: Decimal
    fixed_by_category: dict[str, Decimal]
    raw_materials_ht: Decimal
    consumables_ht: Decimal
    variable_costs_ht: Decimal
    contribution_margin_rate_pct: Decimal | None
    critical_revenue_ht: Decimal | None
    critical_daily_revenue_ht: Decimal | None
    break_even_activity_days: Decimal | None
    break_even_reached_on: date | None
    activity_days: int
    remaining_activity_days: int | None
    remaining_open_days: int | None
    required_daily_revenue_ht: Decimal | None
    on_track: bool | None


ColumnType = Literal["text", "money", "percent", "number", "coefficient", "date", "status", "boolean"]


class HudColumn(StrictModel):
    key: str
    label: str
    type: ColumnType
    sortable: bool = True
    # Rang explicite pour les colonnes d'état (GREEN avant ORANGE avant RED).
    order: tuple[str, ...] | None = None


class HudSort(StrictModel):
    key: str
    descending: bool


class HudPayload(StrictModel):
    """Enveloppe commune : montants et pourcentages en chaînes décimales exactes, jamais en flottants."""
    schema_version: Literal[1] = 1
    kind: Literal["menu_engineering", "food_cost_variance", "supplier_impact", "break_even"]
    title: str
    columns: tuple[HudColumn, ...]
    rows: tuple[dict[str, JsonScalar], ...]
    summary: dict[str, JsonValue]
    gauge: dict[str, JsonValue] | None = None
    alerts: tuple[Alert, ...]
    sort: HudSort
    # Phrase prête à être dite par Brain 2 ou affichée en bandeau par Brain 1.
    speech: str

"""Démonstration autonome des tableaux analytiques, sans clé ni réseau : python -m analytics_demo.

Un bistrot fictif (TVA 10 % sur place) sert de jeu de données : matrice Menu Engineering, alerte hausse du
faux-filet issue de MarginAudit, écart de food cost du mois et point mort d'octobre 2026.
"""
import argparse
import json
import sys
from collections.abc import Sequence
from datetime import date, timedelta
from decimal import Decimal as D

from analytics_engine import AnalyticsEngine, increase_from_price_audit
from schemas.finance import Period
from schemas.finance_analytics import (
    BreakEvenRequest, DailyActivity, DishSales, FixedCharge, FoodCostVarianceRequest, HudPayload, Ingredient,
    MenuEngineeringRequest, PurchaseLine, Recipe, RecipeLine, StockValue, SupplierImpactRequest,
)
from tri_cortex.schemas import PriceAuditInput

OCTOBER = Period(start_date=date(2026, 10, 1), end_date=date(2026, 10, 31))


def _ingredient(identifier: str, name: str, unit: str, cost: str) -> Ingredient:
    return Ingredient(id=identifier, name=name, unit=unit, unit_cost_ht=D(cost))


def _line(identifier: str, quantity: str, waste: str = "0") -> RecipeLine:
    return RecipeLine(ingredient_id=identifier, quantity=D(quantity), waste_pct=D(waste))


def _recipe(identifier: str, name: str, category: str, price_ttc: str, *lines: RecipeLine) -> Recipe:
    return Recipe(id=identifier, name=name, category=category, selling_price_ttc=D(price_ttc), lines=list(lines))


def catalogue() -> list[Ingredient]:
    return [
        _ingredient("faux_filet", "Faux-filet de boeuf", "kg", "24.50"),
        _ingredient("paleron", "Paleron de boeuf", "kg", "16.50"),
        _ingredient("saumon", "Filet de saumon", "kg", "26.00"),
        _ingredient("poulet", "Suprême de poulet", "kg", "13.50"),
        _ingredient("pommes_de_terre", "Pommes de terre", "kg", "1.40"),
        _ingredient("haricots", "Haricots verts", "kg", "4.20"),
        _ingredient("creme", "Crème liquide", "l", "6.20"),
        _ingredient("beurre", "Beurre", "kg", "9.50"),
        _ingredient("oeufs", "Oeufs", "piece", "0.28"),
        _ingredient("chocolat", "Chocolat noir", "kg", "14.50"),
        _ingredient("sucre", "Sucre", "kg", "1.30"),
        _ingredient("farine", "Farine", "kg", "1.10"),
        _ingredient("pates", "Pâtes fraîches", "kg", "6.50"),
        _ingredient("tomates", "Tomates", "kg", "4.20"),
        _ingredient("mozzarella", "Mozzarella", "kg", "11.00"),
        _ingredient("salade", "Salade", "kg", "6.00"),
    ]


def recipes() -> list[Recipe]:
    return [
        _recipe("entrecote", "Entrecôte frites", "Viandes", "24.00",
                _line("faux_filet", "0.22"), _line("pommes_de_terre", "0.30", "20"), _line("beurre", "0.02")),
        _recipe("bourguignon", "Boeuf bourguignon", "Viandes", "19.50",
                _line("paleron", "0.25", "10"), _line("pommes_de_terre", "0.20", "20")),
        _recipe("saumon", "Pavé de saumon", "Poissons", "22.50",
                _line("saumon", "0.18", "5"), _line("haricots", "0.15"), _line("creme", "0.04")),
        _recipe("poulet", "Suprême de poulet", "Viandes", "18.00",
                _line("poulet", "0.22", "8"), _line("pommes_de_terre", "0.20", "20"), _line("creme", "0.05")),
        _recipe("tagliatelles", "Tagliatelles à la crème", "Pâtes", "13.00",
                _line("pates", "0.15"), _line("creme", "0.08")),
        _recipe("caprese", "Salade caprese", "Entrées", "11.50",
                _line("tomates", "0.15"), _line("mozzarella", "0.12"), _line("salade", "0.05")),
        _recipe("fondant", "Fondant au chocolat", "Desserts", "8.50",
                _line("chocolat", "0.06"), _line("beurre", "0.05"), _line("oeufs", "2"),
                _line("sucre", "0.05"), _line("farine", "0.02")),
        _recipe("tartare", "Tartare de boeuf", "Viandes", "18.50",
                _line("faux_filet", "0.18"), _line("oeufs", "1")),
    ]


def sales() -> list[DishSales]:
    volumes = {
        "entrecote": 410, "bourguignon": 150, "saumon": 190, "poulet": 260,
        "tagliatelles": 320, "caprese": 85, "fondant": 300, "tartare": 70,
    }
    return [DishSales(recipe_id=key, units_sold=value) for key, value in volumes.items()]


def menu_request() -> MenuEngineeringRequest:
    return MenuEngineeringRequest(ingredients=catalogue(), recipes=recipes(), sales=sales())


def variance_request() -> FoodCostVarianceRequest:
    """Octobre : stocks comptés au 30/09 et au 31/10, réceptions scannées en deux livraisons par produit."""
    opening = {
        "faux_filet": "420.00", "paleron": "150.00", "saumon": "210.00", "poulet": "180.00",
        "pommes_de_terre": "60.00", "haricots": "25.00", "creme": "90.00", "beurre": "110.00",
        "oeufs": "40.00", "chocolat": "70.00", "sucre": "12.00", "farine": "10.00",
        "pates": "55.00", "tomates": "18.00", "mozzarella": "40.00", "salade": "12.00",
    }
    closing = {
        "faux_filet": "380.00", "paleron": "170.00", "saumon": "190.00", "poulet": "200.00",
        "pommes_de_terre": "55.00", "haricots": "28.00", "creme": "85.00", "beurre": "120.00",
        "oeufs": "45.00", "chocolat": "65.00", "sucre": "10.00", "farine": "9.00",
        "pates": "60.00", "tomates": "20.00", "mozzarella": "35.00", "salade": "10.00",
    }
    purchased = {
        "faux_filet": ("1480.00", "1470.00"), "paleron": ("360.00", "360.00"), "saumon": ("475.00", "460.00"),
        "poulet": ("440.00", "440.00"), "pommes_de_terre": ("190.00", "175.00"), "haricots": ("63.00", "62.00"),
        "creme": ("150.00", "140.00"), "beurre": ("120.00", "118.00"), "oeufs": ("100.00", "97.00"),
        "chocolat": ("133.00", "130.00"), "sucre": ("9.00", "9.00"), "farine": ("3.00", "3.00"),
        "pates": ("165.00", "162.00"), "tomates": ("29.00", "28.00"), "mozzarella": ("57.00", "53.00"),
        "salade": ("13.00", "12.00"),
    }
    return FoodCostVarianceRequest(
        ingredients=catalogue(), recipes=recipes(), sales=sales(), period=OCTOBER,
        opening_stock=[StockValue(ingredient_id=key, value_ht=D(value)) for key, value in opening.items()],
        closing_stock=[StockValue(ingredient_id=key, value_ht=D(value)) for key, value in closing.items()],
        purchases=[
            PurchaseLine(ingredient_id=key, amount_ht=D(amount), reception_ref=f"REC-2026-10-{key}-{index}")
            for key, amounts in purchased.items() for index, amount in enumerate(amounts, 1)
        ],
    )


def beef_price_alert() -> PriceAuditInput:
    """Alerte que produirait MarginAudit : faux-filet de 24,50 à 27,40 euros le kilo."""
    return PriceAuditInput(
        supplier_id="boucherie-martin", product_id="faux_filet", baseline_reference="BL-2026-09-118",
        current_reference="BL-2026-10-092", currency="EUR", unit="kg",
        period=Period(start_date=date(2026, 10, 1), end_date=date(2026, 10, 31)),
        previous_unit_price_ht=D("24.50"), current_unit_price_ht=D("27.40"), quantity=D("102.8"),
        revenue_ht=D("27800.00"), food_cost_before_ht=D("6300.00"), other_variable_costs_ht=D("700.00"),
        fixed_costs_ht=D("18770.00"), sources_confirmed=True,
    )


def impact_request() -> SupplierImpactRequest:
    items = catalogue()
    return SupplierImpactRequest(
        ingredients=items, recipes=recipes(), sales=sales(),
        increases=[increase_from_price_audit(beef_price_alert(), items)],
    )


def break_even_request(as_of: date = date(2026, 10, 31)) -> BreakEvenRequest:
    """Fermé le dimanche ; chiffre d'affaires par jour de semaine, matières à 31 % et consommables à 2,5 %."""
    by_weekday = {0: "1500", 1: "1700", 2: "1900", 3: "2100", 4: "2900", 5: "3300"}
    days: list[DailyActivity] = []
    day = OCTOBER.start_date
    while day <= as_of:
        if day.weekday() in by_weekday:
            revenue = D(by_weekday[day.weekday()])
            days.append(DailyActivity(
                date=day, revenue_ht=revenue, raw_materials_ht=(revenue * D("0.31")).quantize(D("0.01")),
                consumables_ht=(revenue * D("0.025")).quantize(D("0.01")),
            ))
        day += timedelta(days=1)
    return BreakEvenRequest(
        period=OCTOBER, as_of=as_of, daily=days, planned_open_days=26,
        fixed_charges=[
            FixedCharge(category="RENT", label="Loyer et charges", monthly_amount_ht=D("3800.00")),
            FixedCharge(category="INSURANCE", label="Assurances", monthly_amount_ht=D("280.00")),
            FixedCharge(category="SUBSCRIPTION", label="Caisse, logiciels, musique", monthly_amount_ht=D("190.00")),
            FixedCharge(category="PAYROLL", label="Masse salariale chargée", monthly_amount_ht=D("14500.00")),
        ],
    )


def render(payload: HudPayload, keys: Sequence[str]) -> str:
    """Tableau en texte aligné, limité aux colonnes demandées."""
    columns = [column for column in payload.columns if column.key in keys]
    cells = [[str(row[column.key]) if row[column.key] is not None else "-" for column in columns] for row in payload.rows]
    widths = [max(len(column.label), *(len(line[index]) for line in cells)) for index, column in enumerate(columns)]
    lines = ["  ".join(column.label.ljust(widths[index]) for index, column in enumerate(columns))]
    lines += ["  ".join(value.ljust(widths[index]) for index, value in enumerate(line)) for line in cells]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Tableaux analytiques décisionnels sur un bistrot fictif.")
    parser.add_argument("--json", action="store_true", help="affiche les quatre payloads HUD en JSON compact")
    options = parser.parse_args(argv)
    engine = AnalyticsEngine()
    reports = [
        engine.menu_engineering(menu_request()),
        engine.food_cost_variance(variance_request()),
        engine.supplier_impact(impact_request()),
        engine.break_even(break_even_request(date(2026, 10, 9))),
        engine.break_even(break_even_request()),
    ]
    if options.json:
        for report in reports:
            print(report.model_dump_json())
        return 0
    menu, variance, impact, mid_month, month_end = reports
    print(f"== {menu.title} ==")
    print(render(menu, ["name", "unit_margin_ht", "units_sold", "sales_mix_pct", "total_margin_ht", "quadrant", "recommendation"]))
    print(f"\n{menu.speech}\n\n== {variance.title} ==")
    print(render(variance, ["name", "theoretical_cost_ht", "real_cost_ht", "variance_ht", "variance_pp", "status"]))
    print(f"\n{variance.speech}\n\n== {impact.title} : faux-filet à 27,40 EUR/kg ==")
    print(render(impact, ["name", "cost_before_ht", "cost_after_ht", "erosion_ht", "erosion_pct_of_margin",
                          "current_price_ttc", "recommended_price_ttc", "monthly_impact_ht"]))
    print(f"\n{impact.speech}\n\n== {mid_month.title} : situation au 09/10 ==\n{mid_month.speech}")
    print(f"\n== {month_end.title} : fin de mois ==\n{month_end.speech}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

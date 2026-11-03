"""Tableaux analytiques décisionnels : chiffres vérifiés à la main, cas limites, tri, flux NDJSON, API et démonstration."""
import json
from contextlib import contextmanager
from datetime import date, timedelta
from decimal import Decimal as D
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import analytics_demo
from analytics_engine import AnalyticsEngine, AnalyticsError, VarianceThresholds, increase_from_price_audit
from routers.finance_analytics import MAX_ANALYTICS_PAYLOAD_BYTES, make_finance_analytics_router
from schemas.finance import Period
from schemas.finance_analytics import (
    BreakEvenRequest, DailyActivity, DishSales, FixedCharge, FoodCostVarianceRequest, Ingredient,
    MenuEngineeringRequest, PurchaseLine, Recipe, RecipeLine, StockValue, SupplierImpactRequest, SupplierPriceIncrease,
)

ENGINE = AnalyticsEngine()
JSON = {"content-type": "application/json"}
JANUARY = Period(start_date=date(2026, 1, 1), end_date=date(2026, 1, 31))
FEBRUARY = Period(start_date=date(2026, 2, 1), end_date=date(2026, 2, 28))


def ingredient(identifier, unit, cost):
    return Ingredient(id=identifier, name=identifier.capitalize(), unit=unit, unit_cost_ht=D(cost))


def use(identifier, quantity, waste="0"):
    return RecipeLine(ingredient_id=identifier, quantity=D(quantity), waste_pct=D(waste))


def dish(identifier, price_ht, *lines, **extra):
    return Recipe(id=identifier, name=identifier.capitalize(), selling_price_ht=D(price_ht), lines=list(lines), **extra)


def sold(**volumes):
    return [DishSales(recipe_id=key, units_sold=value) for key, value in volumes.items()]


def by_id(payload, key="recipe_id"):
    return {row[key]: row for row in payload.rows}


def codes(payload):
    return {alert.code for alert in payload.alerts}


def catalogue():
    return [ingredient("beef", "kg", "20.00"), ingredient("fries", "kg", "2.00"),
            ingredient("cream", "l", "5.00"), ingredient("choc", "kg", "10.00")]


def menu(**volumes):
    """Marges unitaires 16, 8, 13 et 5 : médiane 10,50 ; volumes 100, 120, 20 et 10 : médiane 60."""
    return MenuEngineeringRequest(
        ingredients=catalogue(),
        recipes=[
            dish("steak", "20.00", use("beef", "0.2")),
            dish("pasta", "10.00", use("cream", "0.4")),
            dish("salad", "15.00", use("fries", "0.5", "50")),
            dish("dessert", "6.00", use("choc", "0.1")),
        ],
        sales=sold(**(volumes or {"steak": 100, "pasta": 120, "salad": 20, "dessert": 10})),
    )


# --- 1. Menu engineering -------------------------------------------------------------------------------------

def test_menu_engineering_matches_the_hand_calculation():
    payload = ENGINE.menu_engineering(menu())
    rows = by_id(payload)
    assert [row["recipe_id"] for row in payload.rows] == ["steak", "pasta", "salad", "dessert"]
    assert (rows["steak"]["price_ht"], rows["steak"]["price_ttc"], rows["steak"]["food_cost_ht"]) == ("20.00", "22.00", "4.00")
    assert (rows["steak"]["food_cost_pct"], rows["steak"]["coefficient"], rows["steak"]["unit_margin_ht"]) == ("20.00", "5.00", "16.00")
    assert (rows["steak"]["sales_mix_pct"], rows["steak"]["total_margin_ht"], rows["steak"]["margin_share_pct"]) == (
        "40.00", "1600.00", "55.75",
    )
    # 0,5 kg net avec 50 % de perte : 1 kg acheté à 2,00 euros.
    assert (rows["salad"]["food_cost_ht"], rows["salad"]["unit_margin_ht"]) == ("2.00", "13.00")
    assert {key: row["quadrant"] for key, row in rows.items()} == {
        "steak": "STAR", "pasta": "PLOWHORSE", "salad": "PUZZLE", "dessert": "DOG",
    }
    assert rows["steak"]["recommendation"] == "Sanctuariser et promouvoir."
    assert rows["pasta"]["recommendation"] == "Augmenter le prix ou réduire le grammage."
    assert rows["salad"]["recommendation"] == "Repositionner, inciter en salle."
    assert rows["dessert"]["recommendation"] == "Éliminer de la carte."
    # (coût 2,00 + marge médiane 10,50) x 1,10 = 13,75 euros, arrondi au pas de 0,10.
    assert rows["pasta"]["target_price_ttc"] == "13.80"
    assert rows["steak"]["target_price_ttc"] is None
    assert payload.summary["units_sold"] == 250
    assert (payload.summary["revenue_ht"], payload.summary["total_margin_ht"], payload.summary["food_cost_pct"]) == (
        "3560.00", "2870.00", "19.38",
    )
    assert (payload.summary["median_unit_margin_ht"], payload.summary["median_units_sold"]) == ("10.50", "60.00")
    assert payload.summary["quadrant_counts"] == {"STAR": 1, "PLOWHORSE": 1, "PUZZLE": 1, "DOG": 1}


def test_price_may_be_entered_with_vat_included():
    request = MenuEngineeringRequest(
        ingredients=catalogue(), sales=sold(x=1),
        recipes=[Recipe(id="x", name="X", vat_rate=D("5.5"), selling_price_ttc=D("10.55"), lines=[use("beef", "0.1")])],
    )
    row = ENGINE.menu_engineering(request).rows[0]
    assert (row["price_ht"], row["price_ttc"], row["unit_margin_ht"], row["coefficient"]) == ("10.00", "10.55", "8.00", "5.00")


@pytest.mark.parametrize("prices", [{}, {"selling_price_ht": D("10"), "selling_price_ttc": D("11")}])
def test_a_recipe_needs_exactly_one_price(prices):
    with pytest.raises(ValidationError, match="HT ou TTC"):
        Recipe(id="x", name="X", lines=[use("beef", "0.1")], **prices)


def test_a_median_volume_of_zero_does_not_make_unsold_dishes_popular():
    payload = ENGINE.menu_engineering(menu(steak=100))
    quadrants = {key: row["quadrant"] for key, row in by_id(payload).items()}
    assert quadrants == {"steak": "STAR", "pasta": "DOG", "salad": "PUZZLE", "dessert": "DOG"}
    assert payload.summary["median_units_sold"] == "0.00"
    assert "UNSOLD_DISHES" in codes(payload)


def test_menu_engineering_needs_at_least_one_sale():
    with pytest.raises(AnalyticsError, match="Aucune vente"):
        ENGINE.menu_engineering(menu(steak=0))


def test_a_dish_sold_at_a_loss_is_flagged():
    request = MenuEngineeringRequest(
        ingredients=catalogue(), sales=sold(loss=10, ok=10),
        recipes=[dish("loss", "3.00", use("beef", "0.2")), dish("ok", "20.00", use("beef", "0.2"))],
    )
    payload = ENGINE.menu_engineering(request)
    assert "NEGATIVE_MARGIN" in codes(payload)
    assert "SMALL_MENU" in codes(payload)
    assert by_id(payload)["loss"]["unit_margin_ht"] == "-1.00"


def test_unknown_references_and_duplicates_are_refused():
    base = menu()
    with pytest.raises(ValidationError, match="inconnus"):
        MenuEngineeringRequest(ingredients=base.ingredients, recipes=[dish("x", "10.00", use("ghost", "1"))], sales=[])
    with pytest.raises(ValidationError, match="fiche technique inconnue"):
        MenuEngineeringRequest(ingredients=base.ingredients, recipes=base.recipes, sales=sold(ghost=1))
    with pytest.raises(ValidationError, match="deux fois"):
        MenuEngineeringRequest(ingredients=base.ingredients, recipes=base.recipes, sales=sold(steak=1) + sold(steak=2))
    with pytest.raises(ValidationError, match="Ingrédient en double"):
        MenuEngineeringRequest(ingredients=base.ingredients + base.ingredients[:1], recipes=base.recipes, sales=[])


# --- 2. Food cost réel contre théorique ---------------------------------------------------------------------

def variance(purchases="4000.00", opening="1000.00", closing="1000.00", **changes):
    """1 000 steaks à 20,00 euros HT : 20 000 euros de chiffre d'affaires, 4 000 euros de matière théorique (20 %)."""
    values = {
        "ingredients": catalogue(), "recipes": [dish("steak", "20.00", use("beef", "0.2"))], "sales": sold(steak=1000),
        "period": JANUARY, "opening_stock": [StockValue(ingredient_id="beef", value_ht=D(opening))],
        "closing_stock": [StockValue(ingredient_id="beef", value_ht=D(closing))],
        "purchases": [PurchaseLine(ingredient_id="beef", amount_ht=D(purchases))],
    }
    return FoodCostVarianceRequest(**(values | changes))


@pytest.mark.parametrize(("purchases", "points", "status"), [
    ("4000.00", "0.00", "GREEN"),
    ("4300.00", "1.50", "GREEN"),
    ("4320.00", "1.60", "ORANGE"),
    ("4600.00", "3.00", "ORANGE"),
    ("4620.00", "3.10", "RED"),
    ("3300.00", "-3.50", "GREEN"),
])
def test_variance_thresholds_are_inclusive_upwards(purchases, points, status):
    payload = ENGINE.food_cost_variance(variance(purchases))
    assert (payload.summary["variance_pp"], payload.summary["status"]) == (points, status)
    assert payload.rows[0]["status"] == status
    assert payload.summary["theoretical_food_cost_pct"] == "20.00"


def test_real_cost_is_opening_plus_purchases_minus_closing():
    payload = ENGINE.food_cost_variance(variance("4400.00", opening="1000.00", closing="1200.00"))
    assert (payload.summary["theoretical_cost_ht"], payload.summary["real_cost_ht"], payload.summary["variance_ht"]) == (
        "4000.00", "4200.00", "200.00",
    )
    assert (payload.summary["real_food_cost_pct"], payload.summary["variance_pp"]) == ("21.00", "1.00")
    assert payload.rows[0]["variance_pct_of_theoretical"] == "5.00"
    assert payload.summary["status"] == "GREEN"


def test_a_supplier_credit_note_reduces_the_real_cost():
    request = variance().model_copy(update={"purchases": [
        PurchaseLine(ingredient_id="beef", amount_ht=D("4500.00")),
        PurchaseLine(ingredient_id="beef", amount_ht=D("-500.00"), reception_ref="AV-12"),
    ]})
    assert ENGINE.food_cost_variance(request).summary["real_cost_ht"] == "4000.00"


def test_variance_alerts_for_missing_data_and_negative_consumption():
    payload = ENGINE.food_cost_variance(variance("100.00", closing="2000.00"))
    assert "NEGATIVE_CONSUMPTION" in codes(payload)
    assert "REAL_BELOW_THEORY" in codes(payload)
    flowless = variance().model_copy(update={"opening_stock": [], "closing_stock": [], "purchases": []})
    assert "NO_STOCK_DATA" in codes(ENGINE.food_cost_variance(flowless))


def test_an_ingredient_counted_only_once_needs_both_inventories():
    with pytest.raises(AnalyticsError, match="Inventaire d'ouverture et de clôture requis.*Beef"):
        ENGINE.food_cost_variance(variance().model_copy(update={"closing_stock": []}))


def test_variance_needs_revenue():
    with pytest.raises(AnalyticsError, match="Chiffre d'affaires théorique nul"):
        ENGINE.food_cost_variance(variance().model_copy(update={"sales": sold(steak=0)}))


def test_a_rounded_zero_is_never_displayed_as_negative():
    row = ENGINE.food_cost_variance(variance("3999.99")).rows[0]
    assert (row["variance_ht"], row["variance_pp"], row["variance_pct_of_theoretical"]) == ("-0.01", "0.00", "0.00")


def test_variance_thresholds_can_be_tightened():
    strict = AnalyticsEngine(thresholds=VarianceThresholds(green_max_pp=D("0.5"), orange_max_pp=D("1")))
    assert strict.food_cost_variance(variance("4300.00")).summary["status"] == "RED"


def test_flows_must_reference_the_catalogue():
    with pytest.raises(ValidationError, match="Achats : ingrédient inconnu"):
        FoodCostVarianceRequest.model_validate({
            **variance().model_dump(mode="json"), "purchases": [{"ingredient_id": "ghost", "amount_ht": "1.00"}],
        })


# --- 3. Impact d'une hausse fournisseur ---------------------------------------------------------------------

def impact(*increases, **changes):
    values = {
        "ingredients": catalogue(),
        "recipes": [
            dish("steak", "20.00", use("beef", "0.2")),
            dish("burger", "15.00", use("beef", "0.1"), target_coefficient=D("7")),
            dish("wrap", "4.00", use("beef", "0.19")),
            dish("pasta", "10.00", use("cream", "0.4")),
        ],
        "sales": sold(steak=100, burger=50, wrap=10, pasta=80),
        "increases": list(increases) or [SupplierPriceIncrease(ingredient_id="beef", new_unit_cost_ht=D("25.00"))],
    }
    return SupplierImpactRequest(**(values | changes))


def test_supplier_increase_matches_the_hand_calculation():
    payload = ENGINE.supplier_impact(impact())
    rows = by_id(payload)
    assert [row["recipe_id"] for row in payload.rows] == ["steak", "wrap", "burger"]
    assert "pasta" not in rows
    steak = rows["steak"]
    assert (steak["cost_before_ht"], steak["cost_after_ht"], steak["erosion_ht"]) == ("4.00", "5.00", "1.00")
    assert (steak["margin_before_ht"], steak["margin_after_ht"], steak["erosion_pct_of_margin"]) == ("16.00", "15.00", "6.25")
    assert (steak["coefficient_before"], steak["coefficient_after"], steak["target_coefficient"]) == ("5.00", "4.00", "5.00")
    # 5,00 x coefficient 5 x TVA 1,10 = 27,50 : l'ancien coefficient est rétabli.
    assert (steak["current_price_ttc"], steak["recommended_price_ttc"]) == ("22.00", "27.50")
    assert (steak["price_increase_ttc"], steak["price_increase_pct"], steak["monthly_impact_ht"]) == ("5.50", "25.00", "100.00")
    burger = rows["burger"]
    # Coefficient cible 7 : 2,50 x 7 x 1,10 = 19,25 euros, arrondi au pas supérieur.
    assert (burger["target_coefficient"], burger["current_price_ttc"], burger["recommended_price_ttc"]) == ("7.00", "16.50", "19.30")
    assert (burger["price_increase_ttc"], burger["price_increase_pct"], burger["monthly_impact_ht"]) == ("2.80", "16.97", "25.00")
    assert payload.summary["impacted_dishes"] == 3
    assert payload.summary["worst_dish"] == "Steak"
    assert payload.summary["total_monthly_impact_ht"] == "134.50"
    assert payload.summary["triggers"][0]["change_pct"] == "25.00"
    assert "Hausse de Beef : 3 plat(s) touché(s)" in payload.speech


def test_a_dish_made_unprofitable_by_the_increase_is_reported_with_a_viable_price():
    payload = ENGINE.supplier_impact(impact())
    wrap = by_id(payload)["wrap"]
    assert (wrap["margin_before_ht"], wrap["margin_after_ht"]) == ("0.20", "-0.75")
    # Le coefficient du jour (4,00 / 3,80) donne exactement 5,00 HT, soit 5,50 TTC, sans bruit de division.
    assert (wrap["current_price_ttc"], wrap["recommended_price_ttc"]) == ("4.40", "5.50")
    assert payload.summary["unprofitable_dishes"] == 1
    assert "SOLD_AT_A_LOSS" in codes(payload)


def test_the_baseline_is_the_declared_previous_cost_when_given():
    request = impact(SupplierPriceIncrease(ingredient_id="beef", previous_unit_cost_ht=D("18.00"), new_unit_cost_ht=D("25.00")))
    steak = by_id(ENGINE.supplier_impact(request))["steak"]
    assert (steak["cost_before_ht"], steak["cost_after_ht"]) == ("3.60", "5.00")


@pytest.mark.parametrize("new_cost", ["20.00", "19.00"])
def test_an_increase_must_exceed_the_baseline(new_cost):
    with pytest.raises(AnalyticsError, match="dépasser le coût de référence"):
        ENGINE.supplier_impact(impact(SupplierPriceIncrease(ingredient_id="beef", new_unit_cost_ht=D(new_cost))))


def test_impact_without_sales_has_no_monthly_figure():
    payload = ENGINE.supplier_impact(impact(sales=[]))
    assert payload.summary["total_monthly_impact_ht"] is None
    assert all(row["monthly_impact_ht"] is None and row["units_sold"] is None for row in payload.rows)


def test_an_ingredient_used_by_no_recipe_is_reported():
    payload = ENGINE.supplier_impact(impact(SupplierPriceIncrease(ingredient_id="choc", new_unit_cost_ht=D("12.00"))))
    assert payload.rows == ()
    assert codes(payload) == {"NO_RECIPE_IMPACTED"}


def test_the_price_step_is_configurable():
    coarse = AnalyticsEngine(price_step=D("0.50"))
    assert by_id(coarse.supplier_impact(impact()))["burger"]["recommended_price_ttc"] == "19.50"
    with pytest.raises(ValueError, match="pas de prix"):
        AnalyticsEngine(price_step=D("0"))


def test_price_audit_alert_becomes_an_analysable_increase():
    alert = analytics_demo.beef_price_alert()
    increase = increase_from_price_audit(alert, analytics_demo.catalogue())
    assert (increase.ingredient_id, increase.previous_unit_cost_ht, increase.new_unit_cost_ht) == (
        "faux_filet", D("24.50"), D("27.40"),
    )
    assert increase.supplier_id == "boucherie-martin"
    payload = ENGINE.supplier_impact(analytics_demo.impact_request())
    assert {row["recipe_id"] for row in payload.rows} == {"entrecote", "tartare"}


def test_price_audit_adapter_refuses_another_unit_or_an_unknown_ingredient():
    alert = analytics_demo.beef_price_alert()
    with pytest.raises(AnalyticsError, match="prix audité par l, ingrédient géré par kg"):
        increase_from_price_audit(alert.model_copy(update={"unit": "l"}), analytics_demo.catalogue())
    with pytest.raises(AnalyticsError, match="absent du catalogue"):
        increase_from_price_audit(alert, analytics_demo.catalogue(), ingredient_id="ghost")


# --- 4. Seuil de rentabilité dynamique ----------------------------------------------------------------------

def february(days, revenue="1000.00", raw="300.00", consumables="50.00", **extra):
    """Charges fixes de 10 000 euros par mois, charges variables à 35 % : taux de marge de 65 %."""
    start = FEBRUARY.start_date
    return BreakEvenRequest(
        period=FEBRUARY,
        daily=[DailyActivity(date=start + timedelta(days=index), revenue_ht=D(revenue), raw_materials_ht=D(raw),
                             consumables_ht=D(consumables)) for index in range(days)],
        fixed_charges=[FixedCharge(category="RENT", label="Loyer", monthly_amount_ht=D("4000.00")),
                       FixedCharge(category="PAYROLL", label="Salaires", monthly_amount_ht=D("6000.00"))],
        **extra,
    )


def test_break_even_gauge_in_survival_mode():
    payload = ENGINE.break_even(february(10, planned_open_days=24))
    summary, gauge = payload.summary, payload.gauge
    assert (summary["contribution_margin_rate_pct"], summary["critical_revenue_ht"]) == ("65.00", "15384.62")
    assert (summary["raw_materials_ht"], summary["consumables_ht"], summary["variable_costs_ht"]) == ("3000.00", "500.00", "3500.00")
    assert summary["fixed_by_category"] == {"RENT": "4000.00", "PAYROLL": "6000.00"}
    assert (summary["fixed_charges_month_ht"], summary["fixed_charges_accrued_ht"]) == ("10000.00", "3571.43")
    assert (gauge["mode"], gauge["revenue_ht"], gauge["progress_pct"], gauge["shortfall_ht"]) == (
        "SURVIVAL", "10000.00", "65.00", "5384.62",
    )
    assert gauge["net_profit_ht"] is None
    assert (summary["break_even_activity_days"], summary["remaining_activity_days"]) == ("15.4", 6)
    assert (summary["critical_daily_revenue_ht"], summary["remaining_open_days"], summary["required_daily_revenue_ht"]) == (
        "641.03", 14, "384.62",
    )
    assert summary["on_track"] is True
    assert summary["break_even_reached_on"] is None
    assert len(payload.rows) == 10
    assert (payload.rows[0]["contribution_ht"], payload.rows[0]["coverage_pct"]) == ("650.00", "6.50")
    assert payload.rows[-1]["cumulative_contribution_ht"] == "6500.00"
    assert "soit 65 pour cent" in payload.speech


def test_gauge_switches_to_net_profit_when_the_threshold_is_crossed():
    day_before = ENGINE.break_even(february(15))
    assert day_before.gauge["mode"] == "SURVIVAL"
    assert day_before.gauge["progress_pct"] == "97.50"
    payload = ENGINE.break_even(february(16))
    gauge, summary = payload.gauge, payload.summary
    # 16 jours à 650 euros de marge = 10 400 euros, soit 400 euros au-dessus des charges fixes du mois.
    assert (gauge["mode"], gauge["net_profit_ht"], gauge["net_margin_pct"], gauge["progress_pct"]) == (
        "PROFIT", "400.00", "2.50", "104.00",
    )
    assert gauge["shortfall_ht"] is None
    assert (summary["break_even_reached_on"], summary["remaining_activity_days"]) == ("2026-02-16", 0)
    assert [row["break_even_reached"] for row in payload.rows][13:] == [False, False, True]
    assert "Seuil franchi le 16/02" in payload.speech
    assert "bénéfice net à ce jour 400,00 euros HT" in payload.speech


def test_break_even_flags_a_month_that_cannot_be_saved():
    payload = ENGINE.break_even(february(10, planned_open_days=12))
    assert payload.summary["on_track"] is False
    assert "BREAK_EVEN_AT_RISK" in codes(payload)


def test_break_even_is_not_computable_without_margin_or_revenue():
    no_margin = ENGINE.break_even(february(5, raw="900.00", consumables="100.00"))
    assert no_margin.summary["critical_revenue_ht"] is None
    assert no_margin.gauge["mode"] == "SURVIVAL"
    assert "non calculable" in no_margin.speech
    idle = ENGINE.break_even(february(0))
    assert (idle.rows, idle.gauge["revenue_ht"], idle.gauge["progress_pct"], idle.summary["critical_revenue_ht"]) == (
        (), "0.00", "0.00", None,
    )
    assert idle.summary["elapsed_days"] == 1


def test_break_even_needs_fixed_charges():
    request = february(3).model_copy(update={"fixed_charges": [FixedCharge(category="OTHER", label="Rien", monthly_amount_ht=D("0"))]})
    with pytest.raises(AnalyticsError, match="Charges fixes nulles"):
        ENGINE.break_even(request)


@pytest.mark.parametrize(("changes", "message"), [
    ({"period": Period(start_date=date(2026, 2, 2), end_date=date(2026, 2, 28))}, "mois civil entier"),
    ({"period": Period(start_date=date(2026, 2, 1), end_date=date(2026, 3, 1))}, "mois civil entier"),
    ({"as_of": date(2026, 3, 2)}, "appartenir au mois"),
    ({"as_of": date(2026, 2, 3)}, "postérieure à la date d'analyse"),
    ({"planned_open_days": 29}, "jours d'ouverture prévus"),
])
def test_break_even_request_is_validated(changes, message):
    with pytest.raises(ValidationError, match=message):
        BreakEvenRequest(**(february(5).model_dump() | changes))


def test_break_even_refuses_duplicate_days():
    body = february(2).model_dump(mode="json")
    body["daily"].append(body["daily"][0])
    with pytest.raises(ValidationError, match="date indiquée deux fois"):
        BreakEvenRequest.model_validate(body)


# --- Tri, flux et déterminisme ------------------------------------------------------------------------------

def test_payload_sorts_on_any_sortable_column_with_stable_ties_and_nulls_last():
    payload = ENGINE.menu_engineering(menu())
    ascending = ENGINE.sort(payload, "units_sold")
    assert [row["recipe_id"] for row in ascending.rows] == ["dessert", "salad", "steak", "pasta"]
    assert ascending.sort.model_dump() == {"key": "units_sold", "descending": False}
    assert [row["recipe_id"] for row in ENGINE.sort(payload, "units_sold", True).rows] == ["pasta", "steak", "salad", "dessert"]
    by_quadrant = ENGINE.sort(payload, "quadrant")
    assert [row["quadrant"] for row in by_quadrant.rows] == ["STAR", "PLOWHORSE", "PUZZLE", "DOG"]
    by_name = ENGINE.sort(payload, "name", True)
    assert [row["name"] for row in by_name.rows] == ["Steak", "Salad", "Pasta", "Dessert"]
    # Plat sans prix cible : en fin de liste dans les deux sens.
    for descending in (False, True):
        ordered = ENGINE.sort(payload, "target_price_ttc", descending).rows
        assert ordered[0]["recipe_id"] == "pasta"
        assert [row["recipe_id"] for row in ordered[1:]] == ["dessert", "salad", "steak"]


def test_money_columns_sort_by_value_not_by_text():
    request = MenuEngineeringRequest(
        ingredients=catalogue(), sales=sold(a=1, b=1, c=1),
        recipes=[dish("a", "100.00", use("beef", "0.1")), dish("b", "9.00", use("beef", "0.1")), dish("c", "20.00", use("beef", "0.1"))],
    )
    payload = ENGINE.menu_engineering(request, sort_by="price_ht", descending=False)
    assert [row["price_ht"] for row in payload.rows] == ["9.00", "20.00", "100.00"]


@pytest.mark.parametrize("key", ["ghost", "recommendation"])
def test_sorting_refuses_unknown_and_non_sortable_columns(key):
    with pytest.raises(AnalyticsError, match="Colonne de tri inconnue ou non triable"):
        ENGINE.menu_engineering(menu(), sort_by=key)


def test_default_sorts_put_the_decision_first():
    assert ENGINE.menu_engineering(menu()).sort.model_dump() == {"key": "total_margin_ht", "descending": True}
    assert ENGINE.food_cost_variance(variance("4600.00")).sort.model_dump() == {"key": "variance_ht", "descending": True}
    assert ENGINE.supplier_impact(impact()).sort.model_dump() == {"key": "erosion_ht", "descending": True}
    assert ENGINE.break_even(february(3)).sort.model_dump() == {"key": "date", "descending": False}


def test_payloads_are_deterministic_and_carry_no_floats():
    first, second = ENGINE.menu_engineering(menu()), ENGINE.menu_engineering(menu())
    assert first == second
    text = first.model_dump_json()
    assert json.loads(text, parse_float=lambda value: pytest.fail(f"flottant {value}")) == json.loads(text)
    assert first.schema_version == 1


def test_ndjson_streams_header_rows_and_end_marker():
    payload = ENGINE.menu_engineering(menu())
    lines = [json.loads(line) for line in ENGINE.ndjson(payload)]
    assert lines[0]["type"] == "header"
    assert "rows" not in lines[0]
    assert [column["key"] for column in lines[0]["columns"]] == [column.key for column in payload.columns]
    assert lines[0]["speech"] == payload.speech
    assert [line["data"] for line in lines[1:-1]] == list(payload.rows)
    assert lines[-1] == {"type": "end", "rows": 4}


# --- API ---------------------------------------------------------------------------------------------------

MEMBERS = {("u1", "a"): "admin", ("u2", "a"): "viewer", ("u3", "b"): "manager"}
MENU_URL = "/api/finance/a/analytics/menu-engineering"


def post(client, url, body, *, user="u1", headers=JSON):
    content = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
    return client.post(url, content=content, headers=headers | ({"x-test-user": user} if user else {}))


@pytest.fixture
def activity():
    return []


@pytest.fixture
def client(activity):
    def member(query):
        role = MEMBERS.get((query["user_id"], query["company_id"]))
        return {"role": role} if role else None

    database = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(side_effect=member)))

    async def require_user(request, _database):
        user = request.headers.get("x-test-user")
        if not user:
            raise HTTPException(401, "Authentification requise.")
        return {"user_id": user}

    @contextmanager
    def business_activity(key, label):
        activity.append((key, label))
        yield

    app = FastAPI()
    app.include_router(make_finance_analytics_router(database, require_user, business_activity=business_activity), prefix="/api")
    with TestClient(app) as test_client:
        yield test_client


def test_menu_engineering_endpoint_returns_the_hud_payload(client, activity):
    response = post(client, MENU_URL, menu().model_dump(mode="json"))
    assert response.status_code == 200, response.text
    data = json.loads(response.content, parse_float=lambda value: pytest.fail(f"flottant {value}"))
    assert (data["kind"], data["schema_version"], data["sort"]) == (
        "menu_engineering", 1, {"key": "total_margin_ht", "descending": True},
    )
    assert [row["recipe_id"] for row in data["rows"]] == ["steak", "pasta", "salad", "dessert"]
    assert data["rows"][0]["total_margin_ht"] == "1600.00"
    assert "Sanctuariser" in data["rows"][0]["recommendation"]
    assert activity == [("finance:a", "analytics")]


def test_json_floats_are_read_exactly(client):
    body = menu().model_dump(mode="json")
    body["ingredients"][0]["unit_cost_ht"] = 20.0
    body["recipes"][0]["selling_price_ht"] = 20.0
    response = post(client, MENU_URL, body)
    assert response.status_code == 200, response.text
    assert response.json()["rows"][0]["food_cost_ht"] == "4.00"


def test_sorting_through_query_parameters(client):
    body = menu().model_dump(mode="json")
    ascending = post(client, MENU_URL + "?sort_by=units_sold", body).json()
    assert [row["recipe_id"] for row in ascending["rows"]] == ["dessert", "salad", "steak", "pasta"]
    descending = post(client, MENU_URL + "?sort_by=units_sold&descending=true", body).json()
    assert [row["recipe_id"] for row in descending["rows"]] == ["pasta", "steak", "salad", "dessert"]
    assert descending["sort"] == {"key": "units_sold", "descending": True}
    reversed_default = post(client, MENU_URL + "?descending=false", body).json()
    assert [row["recipe_id"] for row in reversed_default["rows"]] == ["dessert", "salad", "pasta", "steak"]
    refused = post(client, MENU_URL + "?sort_by=recommendation", body)
    assert refused.status_code == 422
    assert "Colonne de tri inconnue ou non triable" in refused.json()["detail"]


@pytest.mark.parametrize(("suffix", "request_model", "kind"), [
    ("food-cost-variance", variance, "food_cost_variance"),
    ("supplier-impact", impact, "supplier_impact"),
    ("break-even", lambda: february(10, planned_open_days=24), "break_even"),
])
def test_every_table_has_an_endpoint(client, suffix, request_model, kind):
    response = post(client, f"/api/finance/a/analytics/{suffix}", request_model().model_dump(mode="json"))
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == kind


def test_break_even_endpoint_exposes_the_gauge(client):
    data = post(client, "/api/finance/a/analytics/break-even", february(16).model_dump(mode="json")).json()
    assert data["gauge"]["mode"] == "PROFIT"
    assert data["gauge"]["net_profit_ht"] == "400.00"


def test_access_is_reserved_to_company_admins_and_managers(client, activity):
    body = menu().model_dump(mode="json")
    assert post(client, MENU_URL, body, user=None).status_code == 401
    assert post(client, MENU_URL, body, user="u2").status_code == 403
    assert post(client, MENU_URL, body, user="u3").status_code == 404
    assert post(client, "/api/finance/b/analytics/menu-engineering", body, user="u3").status_code == 200
    assert activity == [("finance:b", "analytics")]


def test_invalid_bodies_get_precise_french_errors(client):
    body = menu().model_dump(mode="json")
    body["recipes"][0]["lines"][0]["ingredient_id"] = "ghost"
    unknown = post(client, MENU_URL, body)
    assert unknown.status_code == 422
    assert "inconnus : ghost" in unknown.json()["detail"]
    missing = post(client, MENU_URL, {"ingredients": []})
    assert missing.status_code == 422
    assert "Fiches techniques" in missing.json()["detail"]
    assert post(client, MENU_URL, {**menu().model_dump(mode="json"), "sales": []}).json()["detail"].startswith("Aucune vente")


def test_business_rule_errors_are_422_not_500(client):
    body = variance().model_dump(mode="json")
    body["closing_stock"] = []
    response = post(client, "/api/finance/a/analytics/food-cost-variance", body)
    assert response.status_code == 422
    assert "Inventaire d'ouverture et de clôture requis" in response.json()["detail"]


def test_transport_guards(client):
    body = menu().model_dump(mode="json")
    assert post(client, MENU_URL, body, headers={"content-type": "text/plain"}).status_code == 415
    assert post(client, MENU_URL, b"{").status_code == 400
    assert post(client, MENU_URL, b"[]").status_code == 422
    assert post(client, MENU_URL, b"x" * (MAX_ANALYTICS_PAYLOAD_BYTES + 1)).status_code == 413
    assert post(client, MENU_URL, b'{"a":1,"a":2}').status_code == 400


# --- Démonstration -----------------------------------------------------------------------------------------

def test_demo_dataset_covers_every_quadrant_and_status():
    menu_payload = ENGINE.menu_engineering(analytics_demo.menu_request())
    assert menu_payload.summary["quadrant_counts"] == {"STAR": 2, "PLOWHORSE": 2, "PUZZLE": 2, "DOG": 2}
    quadrants = {row["recipe_id"]: row["quadrant"] for row in menu_payload.rows}
    assert quadrants["entrecote"] == "STAR"
    assert quadrants["caprese"] == "DOG"
    drift = ENGINE.food_cost_variance(analytics_demo.variance_request())
    assert drift.summary["status"] == "ORANGE"
    assert drift.rows[0]["name"] == "Faux-filet de boeuf"
    mid_month = ENGINE.break_even(analytics_demo.break_even_request(date(2026, 10, 9)))
    assert mid_month.gauge["mode"] == "SURVIVAL"
    assert ENGINE.break_even(analytics_demo.break_even_request()).gauge["mode"] == "PROFIT"


def test_demo_script_prints_the_tables_and_streams_json(capsys):
    assert analytics_demo.main([]) == 0
    text = capsys.readouterr().out
    assert "Matrice Menu Engineering" in text and "Sanctuariser et promouvoir." in text
    assert "Faux-filet de boeuf" in text and "Seuil franchi le 15/10" in text
    assert analytics_demo.main(["--json"]) == 0
    payloads = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert [item["kind"] for item in payloads] == [
        "menu_engineering", "food_cost_variance", "supplier_impact", "break_even", "break_even",
    ]

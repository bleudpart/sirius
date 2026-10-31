"""Stress test : formules vérifiées à la main, cas limites, snapshot du moteur, API en lecture seule, fixture partagée.

Régénérer la fixture partagée avec l'interface, depuis backend/ :
    $env:SIRIUS_UPDATE_FIXTURES="1"; python -m pytest tests/test_finance_simulation.py -k fixture
"""
import json
import os
from datetime import date
from decimal import Decimal as D
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import URL, event, func, select
from sqlalchemy.orm import Session

from finance_database import create_finance_engine, get_db
from finance_demo import demo_company
from kpi_engine import build_report
from models.finance import Base, CompanyProfile
from routers.finance import make_company_finance_router
from schemas.finance import Alert, ComparisonMode, CompanyProfileIn, Period, SectorEnum, money
from schemas.finance_simulation import BaseFinancialSnapshot, SimulationRequest
from simulation_service import HYPOTHESES, SimulationError, reference_months, run_stress_test, snapshot_from_dataset

FIXTURE = Path(__file__).resolve().parents[2] / "frontend" / "src" / "__fixtures__" / "financeSimulation.json"
COMPANY = CompanyProfileIn(id="company_a", name="Entreprise test", sector=SectorEnum.HOSPITALITY)
YEAR_2025 = Period(start_date=date(2025, 1, 1), end_date=date(2025, 12, 31))
# Restaurant calculé à la main : CA 40 000 € HT par mois, marge sur coûts variables 70 %, EBE 6 000 €, annuités 1 500 €.
RESTAURANT = {
    "entreprise": COMPANY, "periode_reference": YEAR_2025, "mois_reference": D("12.00"),
    "chiffre_affaires_ht": D("40000.00"), "achats_matieres": D("11200.00"), "autres_charges_variables": D("800.00"),
    "charges_fixes": D("22000.00"), "interets_emprunts": D("300.00"), "capital_rembourse": D("1200.00"),
}
# Baisse d'activité, hausse matière, embauche et crédit matériel : le scénario de la demande.
STRESS = {
    "delta_ca_percent": D("-15"), "delta_cout_matiere_percent": D("5"),
    "charge_fixe_additionnelle_mensuelle": D("2800.00"), "investissement_emprunt_mensualite": D("450.00"),
    "duree_mois": 6, "solde_tresorerie_actuel": D("15000.00"),
}
DEMO_LEVERS = STRESS | {"jours_ouverture_mois": D("26"), "solde_tresorerie_actuel": None}


def snapshot(**changes):
    return BaseFinancialSnapshot(**(RESTAURANT | changes))


def scenario(**changes):
    return SimulationRequest(id_entreprise=COMPANY.id, **changes)


def codes(result):
    return [alert.code for alert in result.alertes]


def balances(result):
    return [(point.mois, point.jour, point.solde_sans_projet, point.solde_avec_projet) for point in result.projection]


def test_restaurant_stress_test_matches_the_hand_calculation():
    result = run_stress_test(snapshot(), scenario(**STRESS))
    data = result.model_dump(mode="json")
    assert data["avant"] == {
        "chiffre_affaires_ht": "40000.00", "achats_matieres": "11200.00", "autres_charges_variables": "800.00",
        "marge_sur_couts_variables": "28000.00", "taux_marge_sur_couts_variables": "70.00",
        "charges_fixes": "22000.00", "ebe": "6000.00", "taux_ebe": "15.00",
        "interets_emprunts": "300.00", "capital_rembourse": "1200.00", "nouvelle_mensualite": "0.00",
        "service_dette": "1500.00", "couverture_service_dette": "4.00", "flux_tresorerie": "4500.00",
        "seuil_rentabilite": "31428.57", "point_mort_tresorerie": "33571.43",
        "seuil_rentabilite_journalier": "1047.62", "point_mort_journalier": "1119.05",
    }
    # Volume −15 % sur CA et charges variables ; prix matière +5 % ; taux de marge au volume de référence.
    assert data["apres"] == {
        "chiffre_affaires_ht": "34000.00", "achats_matieres": "9996.00", "autres_charges_variables": "680.00",
        "marge_sur_couts_variables": "23324.00", "taux_marge_sur_couts_variables": "68.60",
        "charges_fixes": "24800.00", "ebe": "-1476.00", "taux_ebe": "-4.34",
        "interets_emprunts": "300.00", "capital_rembourse": "1200.00", "nouvelle_mensualite": "450.00",
        "service_dette": "1950.00", "couverture_service_dette": "-0.76", "flux_tresorerie": "-3426.00",
        "seuil_rentabilite": "36151.60", "point_mort_tresorerie": "38994.17",
        "seuil_rentabilite_journalier": "1205.05", "point_mort_journalier": "1299.81",
    }
    assert {key: data[key] for key in (
        "point_mort_journalier_avant", "point_mort_journalier_apres", "ca_supplementaire_requis_pour_equilibre",
        "ebe_projete_mensuel", "variation_ebe_mensuelle", "solde_depart", "source_solde_depart",
        "flux_bancaire_reel_mensuel", "tresorerie_residuelle_fin_periode", "variation_tresorerie_periode",
        "besoin_financement_max",
    )} == {
        "point_mort_journalier_avant": "1119.05", "point_mort_journalier_apres": "1299.81",
        "ca_supplementaire_requis_pour_equilibre": "4994.17", "ebe_projete_mensuel": "-1476.00",
        "variation_ebe_mensuelle": "-7476.00", "solde_depart": "15000.00", "source_solde_depart": "declare",
        "flux_bancaire_reel_mensuel": None, "tresorerie_residuelle_fin_periode": "-5556.00",
        "variation_tresorerie_periode": "-20556.00", "besoin_financement_max": "5556.00",
    }
    assert balances(result) == [
        (1, 30, D("19500.00"), D("11574.00")), (2, 60, D("24000.00"), D("8148.00")),
        (3, 90, D("28500.00"), D("4722.00")), (4, 120, D("33000.00"), D("1296.00")),
        (5, 150, D("37500.00"), D("-2130.00")), (6, 180, D("42000.00"), D("-5556.00")),
    ]
    assert result.jalons_tresorerie == result.projection[:3]
    assert data["alerte_rupture_tresorerie"] == {
        "rupture": True, "mois_estime": 5, "autonomie_mois": "4.4",
        "message": "Trésorerie négative au mois 5 (vers J+150) au rythme simulé.",
    }
    assert codes(result) == [
        "SIMULATION_ONLY", "NEGATIVE_EBE_PROJECTED", "DEBT_SERVICE_NOT_COVERED", "BELOW_CASH_BREAK_EVEN", "CASH_RUPTURE",
    ]
    assert result.alertes[-1].message == result.alerte_rupture_tresorerie.message
    assert result.demo is False and result.version_calcul == "1" and result.hypotheses == list(HYPOTHESES)
    assert result.entreprise == COMPANY and result.periode_reference == YEAR_2025 and result.scenario == scenario(**STRESS)


def test_neutral_scenario_reproduces_the_reference_and_projects_flows_without_start_cash():
    result = run_stress_test(snapshot(), scenario())
    assert result.apres == result.avant
    assert (result.variation_ebe_mensuelle, result.ca_supplementaire_requis_pour_equilibre) == (D("0"), D("0"))
    assert (result.solde_depart, result.source_solde_depart) == (None, None)
    assert [(p.mois, p.flux_cumule_sans_projet, p.flux_cumule_avec_projet) for p in result.projection] == [
        (month, D(4500 * month), D(4500 * month)) for month in range(1, 13)
    ]
    assert all(p.solde_sans_projet is None and p.solde_avec_projet is None for p in result.projection)
    assert (result.tresorerie_residuelle_fin_periode, result.besoin_financement_max) == (None, None)
    assert result.variation_tresorerie_periode == D("54000.00")
    assert result.alerte_rupture_tresorerie.model_dump() == {
        "rupture": None, "mois_estime": None, "autonomie_mois": None,
        "message": "Rupture non évaluable : solde de trésorerie de départ inconnu.",
    }
    assert codes(result) == ["SIMULATION_ONLY", "MISSING_START_CASH"]


def test_start_cash_is_the_declared_balance_otherwise_the_reference_closing_cash():
    closing = snapshot(tresorerie_cloture=D("8000.004"))
    from_closing = run_stress_test(closing, scenario())
    assert (from_closing.solde_depart, from_closing.source_solde_depart) == (D("8000.00"), "cloture_reference")
    declared = run_stress_test(closing, scenario(solde_tresorerie_actuel=D("-250.00")))
    assert (declared.solde_depart, declared.source_solde_depart) == (D("-250.00"), "declare")


def test_short_horizon_keeps_the_three_milestones():
    result = run_stress_test(snapshot(), scenario(duree_mois=1, solde_tresorerie_actuel=D("100.00")))
    assert [p.mois for p in result.projection] == [1]
    assert [(p.mois, p.jour, p.solde_avec_projet) for p in result.jalons_tresorerie] == [
        (1, 30, D("4600.00")), (2, 60, D("9100.00")), (3, 90, D("13600.00")),
    ]
    assert result.tresorerie_residuelle_fin_periode == D("4600.00") and result.variation_tresorerie_periode == D("4500.00")


def test_opening_days_divide_the_daily_break_even():
    result = run_stress_test(snapshot(), scenario(**STRESS, jours_ouverture_mois=D("26")))
    assert (result.avant.seuil_rentabilite_journalier, result.avant.point_mort_journalier) == (D("1208.79"), D("1291.21"))
    assert (result.apres.seuil_rentabilite_journalier, result.apres.point_mort_journalier) == (D("1390.45"), D("1499.78"))
    assert (result.point_mort_journalier_avant, result.point_mort_journalier_apres) == (D("1291.21"), D("1499.78"))


def test_activity_stopped_keeps_rates_and_thresholds_computable():
    result = run_stress_test(snapshot(), scenario(delta_ca_percent=D("-100"), solde_tresorerie_actuel=D("15000.00")))
    after = result.apres
    assert (after.chiffre_affaires_ht, after.achats_matieres, after.autres_charges_variables) == (D("0"), D("0"), D("0"))
    assert (after.ebe, after.taux_ebe, after.taux_marge_sur_couts_variables) == (D("-22000.00"), None, D("70.00"))
    assert (after.seuil_rentabilite, after.point_mort_tresorerie) == (D("31428.57"), D("33571.43"))
    assert result.ca_supplementaire_requis_pour_equilibre == D("33571.43")
    assert (after.couverture_service_dette, after.flux_tresorerie) == (D("-14.67"), D("-23500.00"))
    assert result.alerte_rupture_tresorerie.model_dump() == {
        "rupture": True, "mois_estime": 1, "autonomie_mois": D("0.6"),
        "message": "Trésorerie négative au mois 1 (vers J+30) au rythme simulé.",
    }
    assert result.besoin_financement_max == D("267000.00")


def test_material_shock_that_absorbs_the_margin_disables_thresholds():
    result = run_stress_test(snapshot(), scenario(delta_cout_matiere_percent=D("250")))
    after = result.apres
    assert (after.achats_matieres, after.taux_marge_sur_couts_variables) == (D("39200.00"), D("0.00"))
    assert (after.seuil_rentabilite, after.point_mort_tresorerie, after.point_mort_journalier) == (None, None, None)
    assert result.ca_supplementaire_requis_pour_equilibre is None and result.point_mort_journalier_apres is None
    assert "NON_POSITIVE_MARGIN" in codes(result) and "BELOW_CASH_BREAK_EVEN" not in codes(result)
    nearly = run_stress_test(snapshot(), scenario(delta_cout_matiere_percent=D("249.99")))
    assert nearly.apres.seuil_rentabilite is not None and "NON_POSITIVE_MARGIN" not in codes(nearly)


def test_missing_revenue_base_is_reported_once():
    result = run_stress_test(snapshot(
        chiffre_affaires_ht=D("0.00"), achats_matieres=D("0.00"), autres_charges_variables=D("0.00"),
    ), scenario())
    assert result.avant.taux_marge_sur_couts_variables is None and result.avant.seuil_rentabilite is None
    assert result.ca_supplementaire_requis_pour_equilibre is None
    assert codes(result) == [
        "SIMULATION_ONLY", "NO_REVENUE_BASE", "NEGATIVE_EBE_PROJECTED", "DEBT_SERVICE_NOT_COVERED", "MISSING_START_CASH",
    ]


@pytest.mark.parametrize("request_changes, message", [
    ({"charge_fixe_additionnelle_mensuelle": D("-22000.01")},
     "Charge fixe additionnelle mensuelle : l’économie dépasse les charges fixes de la période de référence."),
    ({"id_entreprise": "autre"}, "Le scénario vise une autre entreprise que la situation de référence."),
], ids=["savings-above-fixed-costs", "other-company"])
def test_incompatible_scenarios_are_refused_with_a_french_message(request_changes, message):
    request = SimulationRequest(**({"id_entreprise": COMPANY.id} | request_changes))
    with pytest.raises(SimulationError) as error:
        run_stress_test(snapshot(), request)
    assert str(error.value) == message


def test_savings_may_cancel_all_fixed_costs():
    result = run_stress_test(snapshot(), scenario(charge_fixe_additionnelle_mensuelle=D("-22000.00")))
    assert (result.apres.charges_fixes, result.apres.seuil_rentabilite, result.apres.ebe) == (
        D("0.00"), D("0.00"), D("28000.00"),
    )


# CA 10 000 €, charges fixes 13 200 €, ni charges variables ni emprunt : la trésorerie perd 3 200 € par mois.
LOSING = {
    "chiffre_affaires_ht": D("10000.00"), "achats_matieres": D("0.00"), "autres_charges_variables": D("0.00"),
    "charges_fixes": D("13200.00"), "interets_emprunts": D("0.00"), "capital_rembourse": D("0.00"),
}


def test_a_balance_reaching_exactly_zero_is_not_yet_a_rupture():
    result = run_stress_test(snapshot(**LOSING), scenario(duree_mois=6, solde_tresorerie_actuel=D("12800.00")))
    assert [p.solde_avec_projet for p in result.projection][3:5] == [D("0.00"), D("-3200.00")]
    assert result.alerte_rupture_tresorerie.model_dump() == {
        "rupture": True, "mois_estime": 5, "autonomie_mois": D("4.0"),
        "message": "Trésorerie négative au mois 5 (vers J+150) au rythme simulé.",
    }
    assert result.apres.couverture_service_dette is None
    assert codes(result) == ["SIMULATION_ONLY", "NEGATIVE_EBE_PROJECTED", "BELOW_CASH_BREAK_EVEN", "CASH_RUPTURE"]


def test_rupture_beyond_the_horizon_reports_the_autonomy_without_alert():
    result = run_stress_test(snapshot(**LOSING), scenario(duree_mois=4, solde_tresorerie_actuel=D("12800.00")))
    assert result.alerte_rupture_tresorerie.model_dump() == {
        "rupture": False, "mois_estime": None, "autonomie_mois": D("4.0"),
        "message": "Pas de rupture sur 4 mois ; au rythme simulé, la trésorerie s’épuiserait en 4,0 mois environ.",
    }
    assert result.tresorerie_residuelle_fin_periode == D("0.00") and result.besoin_financement_max == D("0.00")
    assert "CASH_RUPTURE" not in codes(result)


def test_negative_start_cash_is_an_immediate_rupture():
    result = run_stress_test(snapshot(), scenario(solde_tresorerie_actuel=D("-500.00")))
    assert result.alerte_rupture_tresorerie.model_dump() == {
        "rupture": True, "mois_estime": 0, "autonomie_mois": D("0.0"),
        "message": "Trésorerie de départ déjà négative : découvert à combler dès maintenant.",
    }
    assert result.besoin_financement_max == D("500.00") and codes(result) == ["SIMULATION_ONLY", "CASH_RUPTURE"]


def test_positive_flow_never_exhausts_cash():
    result = run_stress_test(snapshot(), scenario(solde_tresorerie_actuel=D("0.00")))
    assert result.alerte_rupture_tresorerie.model_dump() == {
        "rupture": False, "mois_estime": None, "autonomie_mois": None,
        "message": "Flux mensuel positif ou nul : la trésorerie ne s’épuise pas dans ce scénario.",
    }
    assert result.besoin_financement_max == D("0.00") and codes(result) == ["SIMULATION_ONLY"]


@pytest.mark.parametrize("installment, coverage, alert", [
    (D("3500.00"), D("1.20"), None),
    (D("3600.00"), D("1.18"), "DEBT_SERVICE_TIGHT"),
    (D("4600.00"), D("0.98"), "DEBT_SERVICE_NOT_COVERED"),
])
def test_debt_service_coverage_thresholds(installment, coverage, alert):
    result = run_stress_test(snapshot(), scenario(
        investissement_emprunt_mensualite=installment, solde_tresorerie_actuel=D("50000.00"),
    ))
    assert result.apres.couverture_service_dette == coverage
    assert [code for code in codes(result) if code.startswith("DEBT_SERVICE")] == ([alert] if alert else [])
    if alert == "DEBT_SERVICE_TIGHT":
        assert "inférieure à 1,2 :" in result.alertes[-1].message


@pytest.mark.parametrize("months, short", [(D("2.99"), True), (D("3.00"), False)])
def test_short_reference_period_is_flagged(months, short):
    assert ("SHORT_REFERENCE" in codes(run_stress_test(snapshot(mois_reference=months), scenario()))) is short


# Flux de gestion de référence 4 500 € ; seuil d'écart 10 % du CA mensuel, soit 4 000 €.
@pytest.mark.parametrize("real_flow, gap", [
    (D("500.00"), False), (D("499.99"), True), (D("8500.00"), False), (D("8500.01"), True),
])
def test_bank_flow_gap_above_ten_percent_of_revenue_is_flagged(real_flow, gap):
    result = run_stress_test(snapshot(flux_bancaire_reel=real_flow), scenario())
    assert result.flux_bancaire_reel_mensuel == real_flow
    assert ("CASH_FLOW_GAP" in codes(result)) is gap


def test_demo_flag_and_reference_alerts_lead_the_list():
    missing = Alert(code="NO_OVERHEAD_DATA", severity="warning", message="Aucune charge récurrente saisie.")
    result = run_stress_test(
        snapshot(demo=True, alertes_reference=(missing,)), scenario(solde_tresorerie_actuel=D("1000.00")),
    )
    assert result.demo is True
    assert codes(result) == ["DEMO_DATA", "SIMULATION_ONLY", "NO_OVERHEAD_DATA"] and result.alertes[2] == missing


def test_stress_test_is_pure_and_deterministic():
    base, request = snapshot(tresorerie_cloture=D("1000.00")), scenario(**STRESS)
    inputs = (base.model_dump(), request.model_dump())
    assert run_stress_test(base, request).model_dump_json() == run_stress_test(base, request).model_dump_json()
    assert (base.model_dump(), request.model_dump()) == inputs
    assert len(HYPOTHESES) == 8 and all(sentence.endswith(".") for sentence in HYPOTHESES)


def test_reference_months_prorate_calendar_months():
    assert reference_months(YEAR_2025) == 12
    assert reference_months(Period(start_date=date(2024, 2, 1), end_date=date(2024, 2, 29))) == 1
    partial = reference_months(Period(start_date=date(2025, 1, 15), end_date=date(2025, 3, 10)))
    assert abs(partial - (1 + D(27) / D(31))) < D("1e-25")


@pytest.mark.parametrize("sector", list(SectorEnum))
def test_snapshot_is_the_dashboard_engine_in_monthly_averages(sector):
    dataset = demo_company(sector).dataset
    report = build_report(dataset, YEAR_2025, ComparisonMode.NONE, demo=True)
    base = snapshot_from_dataset(dataset, YEAR_2025, demo=True)
    common, months = report.common, D(12)
    assert (base.entreprise, base.periode_reference, base.demo, base.mois_reference) == (
        dataset.company, YEAR_2025, True, D("12.00"),
    )
    assert base.chiffre_affaires_ht == money(common.revenue_ht / months)
    assert base.achats_matieres + base.autres_charges_variables == money(common.variable_costs / months)
    assert base.charges_fixes == money(common.fixed_costs / months)
    assert base.interets_emprunts == money(common.financial_expenses / months)
    assert base.capital_rembourse == money(report.banking.loan_principal_repaid / months)
    assert base.tresorerie_cloture == common.closing_cash
    assert base.flux_bancaire_reel == money(common.cash_net_flow / months)
    reference = run_stress_test(base, SimulationRequest(id_entreprise=dataset.company.id)).avant
    # Moyennes arrondies au centime : quelques centimes d'écart au plus avec le tableau de bord annuel divisé par 12.
    assert abs(reference.ebe - common.approximate_ebe / months) <= D("0.03")
    assert abs(reference.seuil_rentabilite - common.break_even_revenue_ht / months) < D("1")
    assert abs(reference.couverture_service_dette - report.banking.debt_service_coverage) <= D("0.01")


MEMBERS = {("u1", "a"): "manager", ("u1", "c"): "admin", ("u2", "b"): "admin", ("viewer", "a"): "viewer"}
USER = {"x-test-user": "u1"}
JSON = {"Content-Type": "application/json"}
A = {"id_entreprise": "a"}
QUARTER = "start_date=2026-01-01&end_date=2026-03-31"
STRESS_URL = f"/api/finance/a/stress-test?{QUARTER}"
DEMO_URL = "/api/finance/demo/HOSPITALITY/stress-test?start_date=2025-01-01&end_date=2025-12-31"
# Services sur un trimestre, par mois : CA 12 000 €, matières 300 €, sous-traitance 500 €, charges fixes 6 200 €,
# échéance d'emprunt 1 000 € dont 800 € de capital ; 20 000 € en banque au 1er janvier, puis 5 000 € encaissés.
LEDGER = [
    *(("revenues", {
        "date": f"2026-0{month}-15", "amount_ht": "12000.00", "vat_rate": "20", "payment_method": "TRANSFER",
    }) for month in (1, 2, 3)),
    ("expenses", {
        "date": "2026-01-20", "supplier": "Sous-traitant", "amount_ht": "1500.00", "vat_rate": "20",
        "category": "SOUS_TRAITANCE",
    }),
    ("expenses", {
        "date": "2026-02-10", "supplier": "Grossiste", "amount_ht": "900.00", "vat_rate": "20",
        "category": "MATIERE_PREMIERE",
    }),
    ("overheads", {"label": "Loyer", "category": "RENT", "monthly_amount_ht": "2000.00", "active_from": "2026-01-01"}),
    ("overheads", {
        "label": "Salaires", "category": "PAYROLL", "monthly_amount_ht": "3000.00", "employer_charges": "1200.00",
        "active_from": "2026-01-01",
    }),
    ("overheads", {
        "label": "Prêt matériel", "category": "LOAN", "monthly_amount_ht": "1000.00", "loan_principal": "800.00",
        "active_from": "2026-01-01",
    }),
    ("cash_balances", {"date": "2026-01-01", "amount": "20000.00"}),
    ("cash_movements", {"date": "2026-01-31", "amount": "5000.00", "label": "Encaissements clients"}),
]


def raw(payload):
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def reject_float(text):
    raise AssertionError(f"Nombre JSON flottant inattendu : {text}")


def simulate(client, payload, *, url=STRESS_URL, user="u1"):
    return client.post(url, content=raw(payload), headers=JSON | ({"x-test-user": user} if user else {}))


def table_counts(engine):
    with Session(engine) as session:
        return {table.name: session.scalar(select(func.count()).select_from(table)) for table in Base.metadata.sorted_tables}


@pytest.fixture
def engine(tmp_path):
    engine = create_finance_engine(URL.create("sqlite", database=str(tmp_path / "finance.sqlite3")))
    with Session(engine) as session:
        session.add_all([
            CompanyProfile(id="a", name="Entreprise A", sector=SectorEnum.SERVICES, currency="EUR"),
            CompanyProfile(id="b", name="Entreprise B", sector=SectorEnum.RETAIL, currency="EUR"),
        ])
        session.commit()
    yield engine
    engine.dispose()


@pytest.fixture
def client(engine):
    def member(query):
        role = MEMBERS.get((query["user_id"], query["company_id"]))
        return {"role": role} if role else None

    database = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(side_effect=member)))

    async def require_user(request, _database):
        user = request.headers.get("x-test-user")
        if not user:
            raise HTTPException(401, "Authentification requise.")
        return {"user_id": user}

    def session_dependency():
        with Session(engine) as session:
            yield session

    app = FastAPI()
    app.include_router(make_company_finance_router(database, require_user), prefix="/api")
    app.dependency_overrides[get_db] = session_dependency
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def ledger(client):
    for kind, payload in LEDGER:
        response = client.post(f"/api/finance/a/entries/{kind}", content=raw(payload), headers=JSON | USER)
        assert response.status_code == 201, response.text


@pytest.fixture
def statements(engine):
    executed = []

    def capture(_connection, _cursor, statement, *_args):
        executed.append(statement)

    event.listen(engine, "before_cursor_execute", capture)
    yield executed
    event.remove(engine, "before_cursor_execute", capture)


def test_stress_test_reads_the_ledger_without_writing_anything(client, engine, ledger, statements):
    before = table_counts(engine)
    statements.clear()
    response = simulate(client, A | {
        "delta_ca_percent": "-20", "charge_fixe_additionnelle_mensuelle": "1500.00",
        "investissement_emprunt_mensualite": "400.00",
    })
    executed = list(statements)
    assert response.status_code == 200, response.text
    assert executed and all(sql.lstrip().upper().startswith(("SELECT", "BEGIN")) for sql in executed)
    assert table_counts(engine) == before
    data = json.loads(response.content, parse_float=reject_float)
    assert (data["demo"], data["entreprise"]["id"], data["entreprise"]["sector"], data["mois_reference"]) == (
        False, "a", "SERVICES", "3.00",
    )
    assert data["periode_reference"] == {"start_date": "2026-01-01", "end_date": "2026-03-31"}
    assert data["avant"] == {
        "chiffre_affaires_ht": "12000.00", "achats_matieres": "300.00", "autres_charges_variables": "500.00",
        "marge_sur_couts_variables": "11200.00", "taux_marge_sur_couts_variables": "93.33",
        "charges_fixes": "6200.00", "ebe": "5000.00", "taux_ebe": "41.67",
        "interets_emprunts": "200.00", "capital_rembourse": "800.00", "nouvelle_mensualite": "0.00",
        "service_dette": "1000.00", "couverture_service_dette": "5.00", "flux_tresorerie": "4000.00",
        "seuil_rentabilite": "6642.86", "point_mort_tresorerie": "7714.29",
        "seuil_rentabilite_journalier": "221.43", "point_mort_journalier": "257.14",
    }
    assert data["apres"] == {
        "chiffre_affaires_ht": "9600.00", "achats_matieres": "240.00", "autres_charges_variables": "400.00",
        "marge_sur_couts_variables": "8960.00", "taux_marge_sur_couts_variables": "93.33",
        "charges_fixes": "7700.00", "ebe": "1260.00", "taux_ebe": "13.13",
        "interets_emprunts": "200.00", "capital_rembourse": "800.00", "nouvelle_mensualite": "400.00",
        "service_dette": "1400.00", "couverture_service_dette": "0.90", "flux_tresorerie": "-140.00",
        "seuil_rentabilite": "8250.00", "point_mort_tresorerie": "9750.00",
        "seuil_rentabilite_journalier": "275.00", "point_mort_journalier": "325.00",
    }
    assert {key: data[key] for key in (
        "ca_supplementaire_requis_pour_equilibre", "variation_ebe_mensuelle", "solde_depart", "source_solde_depart",
        "flux_bancaire_reel_mensuel", "tresorerie_residuelle_fin_periode", "variation_tresorerie_periode",
        "besoin_financement_max", "alerte_rupture_tresorerie",
    )} == {
        "ca_supplementaire_requis_pour_equilibre": "150.00", "variation_ebe_mensuelle": "-3740.00",
        "solde_depart": "25000.00", "source_solde_depart": "cloture_reference", "flux_bancaire_reel_mensuel": "1666.67",
        "tresorerie_residuelle_fin_periode": "23320.00", "variation_tresorerie_periode": "-1680.00",
        "besoin_financement_max": "0.00", "alerte_rupture_tresorerie": {
            "rupture": False, "mois_estime": None, "autonomie_mois": "178.6",
            "message": "Pas de rupture sur 12 mois ; au rythme simulé, la trésorerie s’épuiserait en 178,6 mois environ.",
        },
    }
    assert [alert["code"] for alert in data["alertes"]] == [
        "SIMULATION_ONLY", "DEBT_SERVICE_NOT_COVERED", "BELOW_CASH_BREAK_EVEN", "CASH_FLOW_GAP",
    ]
    dashboard = client.get(f"/api/finance/a/dashboard?{QUARTER}&comparison=none", headers=USER).json()
    assert dashboard["common"]["approximate_ebe"] == "15000.00" and dashboard["common"]["closing_cash"] == "25000.00"


def test_json_numbers_are_read_as_exact_decimals(client, ledger):
    response = client.post(STRESS_URL, headers=JSON | USER, content=(
        b'{"id_entreprise":"a","delta_ca_percent":-20.0,"charge_fixe_additionnelle_mensuelle":1500,'
        b'"investissement_emprunt_mensualite":400.00,"solde_tresorerie_actuel":1000.10,"duree_mois":3}'
    ))
    assert response.status_code == 200, response.text
    data = response.json()
    assert (data["apres"]["ebe"], data["solde_depart"], data["source_solde_depart"]) == ("1260.00", "1000.10", "declare")
    assert data["scenario"]["delta_ca_percent"] == "-20.0" and data["tresorerie_residuelle_fin_periode"] == "580.10"


@pytest.mark.parametrize("user, company, status, detail", [
    (None, "a", 401, "Authentification requise."),
    ("viewer", "a", 403, "La finance d’entreprise est réservée aux administrateurs et gestionnaires."),
    ("u2", "a", 404, "Entreprise inaccessible."),
    ("u1", "c", 404, "Profil financier d’entreprise introuvable : créez-le dans « Saisie & imports »."),
], ids=["anonymous", "viewer", "not-a-member", "no-profile"])
def test_stress_test_enforces_company_rights(client, user, company, status, detail):
    response = simulate(client, {"id_entreprise": company}, url=f"/api/finance/{company}/stress-test?{QUARTER}", user=user)
    assert (response.status_code, response.json()["detail"]) == (status, detail)


@pytest.mark.parametrize("payload, detail", [
    ({}, "Entreprise : champ obligatoire"),
    ({"id_entreprise": "b"}, "Entreprise : l’identifiant du scénario ne correspond pas à l’entreprise demandée."),
    (A | {"delta_ca_percent": "-150"}, "Variation du chiffre d’affaires : doit être supérieur ou égal à -100"),
    (A | {"delta_ca_percent": "-15.125"}, "Variation du chiffre d’affaires : 2 décimales au maximum"),
    (A | {"delta_cout_matiere_percent": "1000.01"}, "Variation du coût matière : doit être inférieur ou égal à 1000"),
    (A | {"investissement_emprunt_mensualite": "-1"},
     "Mensualité du nouvel emprunt : doit être supérieur ou égal à 0"),
    (A | {"duree_mois": 0}, "Durée de projection : doit être supérieur ou égal à 1"),
    (A | {"duree_mois": 37}, "Durée de projection : doit être inférieur ou égal à 36"),
    (A | {"duree_mois": "6"}, "Durée de projection : nombre entier attendu"),
    (A | {"jours_ouverture_mois": "0"}, "Jours d’ouverture par mois : doit être supérieur à 0"),
    (A | {"pirate": True}, "pirate : champ non autorisé (calculé ou imposé par le serveur)"),
    (A | {"charge_fixe_additionnelle_mensuelle": "-6200.01"},
     "Charge fixe additionnelle mensuelle : l’économie dépasse les charges fixes de la période de référence."),
])
def test_invalid_scenarios_are_refused_in_french(client, ledger, payload, detail):
    response = simulate(client, payload)
    assert (response.status_code, response.json()["detail"]) == (422, detail)


@pytest.mark.parametrize("query, content, headers, status, detail", [
    (QUARTER, b"{}", {"Content-Type": "text/plain"}, 415, "Content-Type requis : application/json."),
    (QUARTER, b'{"id_entreprise": ', JSON, 400, "JSON invalide (ligne 1, colonne 19)."),
    (QUARTER, b"[]", JSON, 422, "Un objet JSON est attendu."),
    (QUARTER, b"", JSON, 400, "Charge utile vide."),
    ("start_date=2026-03-31&end_date=2026-01-01", raw(A), JSON, 422,
     "Période invalide : dates ISO ordonnées, fin antérieure au 9999-12-31."),
    ("start_date=2010-01-01&end_date=2026-03-31", raw(A), JSON, 422, "Période limitée à 10 ans."),
], ids=["content-type", "syntax", "array", "empty", "inverted-period", "period-too-long"])
def test_transport_and_period_errors(client, query, content, headers, status, detail):
    response = client.post(f"/api/finance/a/stress-test?{query}", content=content, headers=headers | USER)
    assert (response.status_code, response.json()["detail"]) == (status, detail)


def fixture_cases():
    demo = demo_company(SectorEnum.HOSPITALITY).dataset
    cases = {
        "demo": (
            snapshot_from_dataset(demo, YEAR_2025, demo=True),
            SimulationRequest(id_entreprise=demo.company.id, **DEMO_LEVERS),
        ),
        "rupture": (snapshot(), scenario(**STRESS)),
        "sans_solde": (snapshot(), scenario(delta_ca_percent=D("5"), charge_fixe_additionnelle_mensuelle=D("2800.00"))),
    }
    return {
        name: {
            "snapshot": base.model_dump(mode="json"), "scenario": request.model_dump(mode="json"),
            "response": run_stress_test(base, request).model_dump(mode="json"),
        }
        for name, (base, request) in cases.items()
    }


def test_demo_stress_test_needs_a_session_but_never_touches_the_database(client, statements):
    case = fixture_cases()["demo"]
    statements.clear()
    response = simulate(client, case["scenario"], url=DEMO_URL, user="banquier")
    assert response.status_code == 200, response.text
    assert statements == []
    data = json.loads(response.content, parse_float=reject_float)
    assert data == case["response"]
    assert [alert["code"] for alert in data["alertes"]] == [
        "DEMO_DATA", "SIMULATION_ONLY", "DEBT_SERVICE_NOT_COVERED", "BELOW_CASH_BREAK_EVEN",
    ]
    assert [data["avant"][key] for key in ("chiffre_affaires_ht", "ebe", "couverture_service_dette", "flux_tresorerie")] == [
        "79000.00", "12901.91", "2.15", "6893.97",
    ]
    assert [data["apres"][key] for key in ("ebe", "couverture_service_dette", "flux_tresorerie")] == [
        "702.37", "0.11", "-5755.57",
    ]
    assert (data["solde_depart"], data["source_solde_depart"]) == ("181869.88", "cloture_reference")
    assert (data["alerte_rupture_tresorerie"]["rupture"], data["alerte_rupture_tresorerie"]["autonomie_mois"]) == (
        False, "31.6",
    )


@pytest.mark.parametrize("url, payload, user, status, detail", [
    (DEMO_URL, {"id_entreprise": "demo-hospitality"}, None, 401, "Authentification requise."),
    (DEMO_URL, A, "banquier", 422, "Entreprise : l’identifiant du scénario ne correspond pas à l’entreprise demandée."),
    ("/api/finance/demo/HOSPITALITY/stress-test?start_date=2022-01-01&end_date=2022-12-31",
     {"id_entreprise": "demo-hospitality"}, "banquier", 422,
     "La démonstration couvre les exercices 2023 à 2025 (du 01/01/2023 au 31/12/2025)."),
], ids=["anonymous", "other-company", "outside-window"])
def test_demo_stress_test_errors(client, url, payload, user, status, detail):
    response = simulate(client, payload, url=url, user=user)
    assert (response.status_code, response.json()["detail"]) == (status, detail)


def test_shared_fixture_is_the_engine_output_and_round_trips_through_json():
    expected = {
        "source": "Généré par backend/tests/test_finance_simulation.py à partir du moteur : ne pas modifier à la main.",
        "cases": fixture_cases(),
    }
    if os.environ.get("SIRIUS_UPDATE_FIXTURES") == "1":
        FIXTURE.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == expected
    for case in expected["cases"].values():
        base = BaseFinancialSnapshot.model_validate_json(json.dumps(case["snapshot"]))
        request = SimulationRequest.model_validate(case["scenario"])
        assert run_stress_test(base, request).model_dump(mode="json") == case["response"]

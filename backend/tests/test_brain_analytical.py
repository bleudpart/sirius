import asyncio
import hashlib
import hmac
import json
import time
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import URL, func, select
from sqlalchemy.orm import Session

from brain_analytical.repartition import (
    Cerveau,
    ETAT_PERIME_APRES,
    ECHANGES,
    REPARTITION,
    ModeExecution,
    attributions,
    etat_perime,
    responsable,
)
from brain_analytical.schemas import (
    BusinessHealthSnapshot, EvenementOperationnel, SeveriteAlerte, StatutAlerte, TypeDeclencheur, TypeEvenement,
    SourceSynthese, VueCortexAnalytique,
)
from brain_analytical.collecte import DonneesCollectees, collecter, fenetre_analyse
from brain_analytical.orchestrator import AnalyticalOrchestrator, Signal
from brain_analytical.regles import analyser
from brain_analytical.routes import make_analytical_router
from brain_analytical.store import AlertRow, SnapshotRow, acquitter, lire_etat, publier
from brain_analytical.strategic_advisor import RedactionIndisponible, conseiller, faits, repli, verifier_redaction
from finance_connectors import POSWebhookPayload, _canonical_json
from finance_database import create_finance_engine, get_db
from kpi_engine import FinanceDataset
from models.finance import CompanyProfile, TransactionRevenue
from routers.finance import make_company_finance_router
from schemas.finance import (
    CashBalanceIn, CategorieExpense, CompanyProfileIn, OverheadCategory, PaymentMethod, Period,
    PurchaseExpenseIn, RecurringOverheadIn, SectorEnum, TransactionRevenueIn, CashMovementIn,
    AllocationEnum, InventorySnapshotIn,
)

D = Decimal
NOW = datetime(2026, 3, 31, 12, tzinfo=timezone.utc)
PERIOD = Period(start_date=date(2026, 1, 1), end_date=date(2026, 3, 31))


def test_chaque_tache_est_attribuee_a_un_seul_cerveau_et_au_bon_mode():
    keys = [item.cle for item in REPARTITION]

    assert len(keys) == len(set(keys))
    assert {item.cerveau for item in REPARTITION} == set(Cerveau)
    assert all(
        item.mode == (
            ModeExecution.TEMPS_REEL
            if item.cerveau == Cerveau.OPERATIONNEL
            else ModeExecution.ARRIERE_PLAN
        )
        for item in REPARTITION
    )
    assert responsable("saisie") == Cerveau.OPERATIONNEL
    assert responsable("surveillance") == Cerveau.ANALYTIQUE
    with pytest.raises(KeyError):
        responsable("tache_inconnue")


def test_echanges_limites_aux_signaux_valides_et_a_etat_publie():
    assert [(item.de, item.vers) for item in ECHANGES] == [
        (Cerveau.OPERATIONNEL, Cerveau.ANALYTIQUE),
        (Cerveau.ANALYTIQUE, Cerveau.OPERATIONNEL),
    ]

    event = EvenementOperationnel(
        company_id="entreprise_1",
        type=TypeEvenement.SAISIE_VALIDEE,
        source="saisie_manuelle",
        reference="facture-42",
        acteur="utilisateur_1",
        nombre_ecritures=1,
        survenu_le=datetime(2026, 10, 31, 12, tzinfo=timezone.utc),
    )
    assert event.type == TypeEvenement.SAISIE_VALIDEE
    assert not {"montant", "montant_ht", "montant_ttc"} & set(EvenementOperationnel.model_fields)
    with pytest.raises(ValueError):
        EvenementOperationnel.model_validate({
            **event.model_dump(),
            "montant_ht": Decimal("12.34"),
        })


def test_etat_publie_perime_apres_24_heures_et_dates_avec_fuseau_requises():
    maintenant = datetime(2026, 10, 31, 12, tzinfo=timezone.utc)
    assert etat_perime(None, maintenant)
    assert not etat_perime(maintenant - ETAT_PERIME_APRES, maintenant)
    assert etat_perime(maintenant - ETAT_PERIME_APRES - timedelta(seconds=1), maintenant)
    assert etat_perime(maintenant + timedelta(seconds=1), maintenant)
    with pytest.raises(ValueError, match="fuseau horaire"):
        etat_perime(datetime(2026, 10, 31, 12), maintenant)
    with pytest.raises(ValueError, match="fuseau horaire"):
        etat_perime(maintenant, datetime(2026, 10, 31, 12))


def dataset():
    return FinanceDataset(
        company=CompanyProfileIn(id="a", name="Entreprise A", sector=SectorEnum.SERVICES),
        revenues=(TransactionRevenueIn(
            company_id="a", date=date(2026, 3, 31), amount_ht=D("36000"), amount_ttc=D("36000"),
            vat_rate=D("0"), payment_method=PaymentMethod.TRANSFER, hours=D("600"), days=D("75"),
        ),),
        expenses=(PurchaseExpenseIn(
            company_id="a", date=date(2026, 3, 31), supplier="Fournisseur", category=CategorieExpense.SOUS_TRAITANCE,
            amount_ht=D("27000"), amount_ttc=D("27000"), amount_vat=D("0"), deductible_vat=D("0"),
        ),),
        overheads=(RecurringOverheadIn(company_id="a", label="Loyer", category=OverheadCategory.RENT,
                                      monthly_amount_ht=D("4000"), active_from=date(2026, 1, 1)),),
        cash_balances=(CashBalanceIn(company_id="a", date=date(2026, 3, 31), amount=D("1500")),),
    )


def snapshot(now=NOW):
    return analyser(DonneesCollectees(dataset(), PERIOD, date(2026, 3, 31)), now, TypeDeclencheur.MANUEL)


def test_calcul_decimal_projection_et_empreinte_stable():
    state = snapshot()
    metrics = {m.cle: m.valeur for m in state.indicateurs}
    assert metrics["revenue_ht"] == D("36000")
    assert metrics["ca_mensuel"] == D("12000.00")
    assert metrics["approximate_ebe"] == D("-3000.00")
    assert state.projection.flux_mensuel_gestion == D("-1000.00")
    assert state.projection.flux_mensuel_bancaire is None
    assert state.projection.source_flux == "gestion"
    assert [p.solde for p in state.projection.points] == list(map(D, ["1500", "1000", "500", "-500", "-1500"]))
    assert state.projection.jour_rupture == 46
    assert state.projection.date_rupture == date(2026, 5, 16)
    assert state.empreinte == snapshot(NOW + timedelta(hours=1)).empreinte
    assert BusinessHealthSnapshot.model_validate_json(state.model_dump_json()) == state
    assert "EBE_NEGATIF" in {a.code for a in state.alertes}


def test_absence_donnees_n_est_pas_un_zero_sain():
    data = FinanceDataset(company=dataset().company)
    state = analyser(DonneesCollectees(data, PERIOD, None), NOW, TypeDeclencheur.PERIODIQUE)
    assert state.indice is None
    assert state.niveau.value == "INDETERMINE"
    assert state.projection is None
    codes = {a.code for a in state.alertes}
    assert {"DONNEES_INSUFFISANTES", "SOLDE_TRESORERIE_INCONNU", "DONNEES_ANCIENNES"} <= codes
    assert not {"EBE_NEGATIF", "NO_BREAK_EVEN", "DERIVE_MARGE"} & codes


def test_fenetre_mois_entiers_et_projection_actualisee():
    assert fenetre_analyse(NOW.date(), date(2026, 3, 31), None) == PERIOD
    assert fenetre_analyse(NOW.date(), date(2026, 3, 15), None).start_date == date(2025, 12, 16)
    state = snapshot(NOW + timedelta(days=31))
    assert state.projection.points[0].solde == D("466.67")
    assert state.projection.jour_rupture == 15
    alert = next(a for a in state.alertes if a.code == "TENSION_TRESORERIE")
    assert alert.severite == SeveriteAlerte.CRITICAL


@pytest.fixture
def engine(tmp_path):
    engine = create_finance_engine(URL.create("sqlite", database=str(tmp_path / "finance.sqlite3")))
    with Session(engine) as session, session.begin():
        session.add_all([
            CompanyProfile(id="a", name="Entreprise A", sector=SectorEnum.SERVICES, currency="EUR"),
            CompanyProfile(id="b", name="Entreprise B", sector=SectorEnum.RETAIL, currency="EUR"),
        ])
    yield engine
    engine.dispose()


def test_collecte_sql_dates_et_exclusion_du_futur(engine):
    with Session(engine) as session, session.begin():
        session.add_all([
            TransactionRevenue(**dataset().revenues[0].model_dump()),
            TransactionRevenue(**dataset().revenues[0].model_copy(update={"date": date(2027, 1, 1)}).model_dump()),
        ])
    with Session(engine) as session:
        result = collecter(session, "a", NOW.date())
        assert result.derniere_activite == date(2026, 3, 31)
        assert result.periode == PERIOD
        assert len(result.dataset.revenues) == 1


def test_store_reconciliation_acquittement_escalade_resolution(engine):
    worker = AnalyticalOrchestrator(None, engine_factory=lambda: engine)
    state = snapshot()
    alert = state.alertes[0].model_copy(update={"severite": SeveriteAlerte.WARNING})
    state = state.model_copy(update={"alertes": [alert]})
    assert len(publier(engine, state).nouvelles) == 1
    assert not publier(engine, state).change
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(SnapshotRow)) == 1
    row = lire_etat(engine, "a", worker.statut("a")).alertes[0]
    with pytest.raises(LookupError):
        acquitter(engine, "b", row.id, "u2", NOW, "")
    ack = acquitter(engine, "a", row.id, "u1", NOW, "Prise en compte")
    assert ack.statut == StatutAlerte.ACQUITTEE
    severe = state.model_copy(update={"alertes": [alert.model_copy(update={"severite": SeveriteAlerte.CRITICAL})]})
    assert len(publier(engine, severe).escaladees) == 1
    row = lire_etat(engine, "a", worker.statut("a")).alertes[0]
    assert row.statut == StatutAlerte.OUVERTE and row.acquittee_par is None and row.commentaire is None
    assert publier(engine, state.model_copy(update={"alertes": []})).resolues == 1
    assert len(publier(engine, state).nouvelles) == 1
    with Session(engine) as session:
        assert session.scalar(select(func.count()).select_from(AlertRow)) == 2


def test_redaction_refuse_chiffres_inventes_et_json_imbrique():
    state = snapshot()
    valid = json.dumps({"resume": "Le CA atteint 36 000,00.", "points_cles": [], "recommandations": []})
    assert verifier_redaction(valid, faits(state), state).resume == "Le CA atteint 36 000,00."
    with pytest.raises(RedactionIndisponible, match="Chiffre"):
        verifier_redaction(valid.replace("36 000", "123 456"), faits(state), state)
    with pytest.raises(RedactionIndisponible, match="imbriquée"):
        verifier_redaction("[" * 65 + "]" * 65, faits(state), state)


def test_anti_rebond_et_priorite_manuelle():
    worker = AnalyticalOrchestrator(None)
    worker._queued["a"] = 4
    worker._recevoir(Signal("a", "u1", TypeDeclencheur.EVENEMENT, 0, 20))
    worker._recevoir(Signal("a", "u1", TypeDeclencheur.EVENEMENT, 119, 20))
    assert worker._pending["a"].echeance == 120
    worker._recevoir(Signal("a", "u1", TypeDeclencheur.MANUEL, 119, 0))
    worker._recevoir(Signal("a", "u1", TypeDeclencheur.EVENEMENT, 120, 20))
    assert worker._pending["a"].echeance == 119
    assert worker._pending["a"].signal.declencheur == TypeDeclencheur.MANUEL


@pytest.fixture
def connected(engine):
    def member(query):
        uid = query["user_id"]
        company = "b" if uid == "u2" else "a"
        if uid == "none" or query.get("company_id", company) != company:
            return None
        return {"company_id": company, "role": "viewer" if uid == "viewer" else "manager"}

    db = SimpleNamespace(
        enterprise_members=SimpleNamespace(find_one=AsyncMock(side_effect=member)),
        enterprise_companies=SimpleNamespace(find_one=AsyncMock(return_value={"owner_user_id": "u1"})),
        users=SimpleNamespace(find_one=AsyncMock(return_value=None)),
    )
    worker = AnalyticalOrchestrator(db, engine_factory=lambda: engine, clock=lambda: NOW, debounce=0, periodic_start=3600)
    callback = AsyncMock(wraps=worker.on_finance_change)

    async def require_user(request, _db):
        uid = request.headers.get("x-test-user")
        if uid is None:
            raise HTTPException(401, "Session requise.")
        return {"user_id": uid}

    def session_dependency():
        with Session(engine) as session:
            yield session

    @asynccontextmanager
    async def lifespan(_app):
        task = asyncio.create_task(worker.loop())
        await asyncio.sleep(0)
        yield
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    app = FastAPI(lifespan=lifespan)
    app.dependency_overrides[get_db] = session_dependency
    app.include_router(make_company_finance_router(db, require_user, callback), prefix="/api")
    app.include_router(make_analytical_router(db, require_user, worker), prefix="/api")
    with TestClient(app) as client:
        yield client, worker, callback


def test_routes_droits_et_signal_finance_jusqua_cortex(connected):
    client, worker, callback = connected
    uri = "/api/finance/a/cerveau"
    assert client.get(uri).status_code == 401
    assert client.get(uri, headers={"x-test-user": "u2"}).status_code == 404
    assert client.get(uri, headers={"x-test-user": "viewer"}).status_code == 403
    headers = {"x-test-user": "u1"}
    assert client.post(uri + "/analyse", headers=headers, content="{}").status_code == 415
    assert client.post(uri + "/analyse", headers=headers, json={"chiffre": "12"}).status_code == 422
    response = client.post("/api/finance/a/entries/revenues", headers=headers, json={
        "date": "2026-03-31", "amount_ht": "36000", "vat_rate": "0", "payment_method": "TRANSFER",
    })
    assert response.status_code == 201, response.text
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        response = client.get("/api/cortex/analytique", headers=headers)
        assert response.status_code == 200, response.text
        state = response.json()["etat"]
        if state and state["executions"]:
            break
        time.sleep(0.02)
    assert state["snapshot"]["company_id"] == "a"
    assert state["snapshot"]["indicateurs"][0]["valeur"] == "36000.00"
    assert state["executions"][0]["statut"] == "TERMINEE"
    assert state["synthese"]["source"] == "DETERMINISTE"
    assert state["synthese_a_jour"]
    assert not worker._counts["a"]["echecs"]
    assert len(response.json()["repartition"]) == 12
    alert = state["alertes"][0]
    ack = client.post(f"{uri}/alertes/{alert['id']}/acquitter", headers=headers, json={"commentaire": "Vérifié"})
    assert ack.status_code == 200, ack.text
    assert ack.json()["statut"] == "ACQUITTEE"
    other = client.post(f"/api/finance/b/cerveau/alertes/{alert['id']}/acquitter",
                        headers={"x-test-user": "u2"}, json={})
    assert other.status_code == 404
    viewer = client.get("/api/cortex/analytique", headers={"x-test-user": "viewer"}).json()
    assert viewer["etat"] is None and "réservé" in viewer["message"]


def test_fixture_frontend_identique_au_moteur_et_au_contrat():
    path = Path(__file__).parents[2] / "frontend" / "src" / "__fixtures__" / "brainAnalytical.json"
    view = VueCortexAnalytique.model_validate_json(path.read_text(encoding="utf-8"))
    assert view.etat.snapshot == snapshot()
    assert view.etat.synthese_a_jour


def test_flux_bancaire_plus_prudent_et_jour_sans_projection_invente():
    original = dataset()
    data = FinanceDataset(
        company=original.company, revenues=original.revenues, expenses=original.expenses,
        overheads=original.overheads, cash_balances=original.cash_balances,
        cash_movements=(CashMovementIn(company_id="a", date=date(2026, 2, 1), amount=D("-6000"), label="Paiement"),),
    )
    state = analyser(DonneesCollectees(data, PERIOD, NOW.date()), NOW, TypeDeclencheur.MANUEL)
    assert state.projection.flux_mensuel_retenu == D("-2000")
    assert state.projection.source_flux == "bancaire"
    assert state.projection.solde_depart == D("1500")  # Le nouveau solde remplace les mouvements antérieurs.
    data = FinanceDataset(company=original.company, cash_balances=original.cash_balances)
    state = analyser(DonneesCollectees(data, PERIOD, NOW.date()), NOW, TypeDeclencheur.MANUEL)
    assert state.projection.points == []
    assert state.projection.flux_mensuel_retenu is None


def test_file_bornee_et_compteurs_isoles():
    worker = AnalyticalOrchestrator(None)
    assert not worker.notify("a", "u1")
    worker._queue = asyncio.Queue(maxsize=256)
    assert all(worker.notify(f"c{i}", "u1") for i in range(256))
    assert not worker.notify("a", "u1")
    assert worker.statut("a").en_attente == 0
    assert worker.statut("a").evenements_rejetes == 2
    assert worker.statut("c1").evenements_recus == 1
    assert worker.statut("b").evenements_recus == 0


def test_toutes_les_ecritures_signalent_apres_succes_sans_rejouer_import(connected, monkeypatch):
    client, worker, callback = connected
    monkeypatch.setattr(worker, "notify", lambda *args, **kwargs: True)
    headers = {"x-test-user": "u1"}
    assert client.put("/api/finance/a/profile", headers=headers, json={
        "name": "Entreprise A", "sector": "SERVICES", "currency": "EUR",
    }).status_code == 200
    entry = client.post("/api/finance/a/entries/cash_balances", headers=headers,
                        json={"date": "2026-03-31", "amount": "1500"})
    assert entry.status_code == 201
    assert client.delete(f"/api/finance/a/entries/cash_balances/{entry.json()['id']}", headers=headers).status_code == 204
    csv = "Date;Libellé;Débit;Crédit;Référence\n31/03/2026;Virement;;120,00;REF1\n".encode("utf-8")
    url = "/api/finance/a/ingestions/bank_statement_csv"
    imported = client.post(url, content=csv, headers=headers | {"Content-Type": "text/csv"})
    assert imported.status_code == 200, imported.text
    calls = callback.await_count
    replay = client.post(url, content=csv, headers=headers | {"Content-Type": "text/csv"})
    assert replay.status_code == 200 and replay.json()["replayed"]
    assert callback.await_count == calls
    assert client.delete("/api/finance/a/ingestions/" + imported.json()["batch_id"], headers=headers).status_code == 204
    pos = POSWebhookPayload.model_validate({
        "event_id": "event-test", "currency": "EUR",
        "transactions": [{"transaction_id": "ticket-test", "date": "2026-03-31",
                          "amount_ht": "100.00", "amount_vat": "20.00", "amount_ttc": "120.00",
                          "vat_rate": "20", "payment_method": "CARD"}],
        "totals": {"amount_ht": "100.00", "amount_vat": "20.00", "amount_ttc": "120.00"}, "checksum": "0" * 64,
    }).model_dump(mode="json", exclude={"checksum"})
    pos["checksum"] = hashlib.sha256(_canonical_json(pos)).hexdigest()
    raw = json.dumps(pos).encode("utf-8")
    secret = "x" * 32
    monkeypatch.setenv("SIRIUS_FINANCE_POS_SECRET_" + hashlib.sha256(b"a").hexdigest()[:20].upper(), secret)
    stamp = str(int(time.time()))
    signature = hmac.new(secret.encode(), stamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
    signed = {"Content-Type": "application/json", "X-Sirius-Timestamp": stamp, "X-Sirius-Signature": "sha256=" + signature}
    accepted = client.post("/api/finance/a/webhooks/pos", content=raw, headers=signed)
    assert accepted.status_code == 200, accepted.text
    assert [call.args[0].action for call in callback.await_args_list] == [
        "PROFIL_MODIFIE", "SAISIE_VALIDEE", "SAISIE_SUPPRIMEE", "IMPORT_VALIDE", "IMPORT_ANNULE", "TICKET_CAISSE",
    ]
    assert callback.await_args_list[-1].args[0].user_id is None
    assert client.post("/api/finance/a/webhooks/pos", content=raw, headers=signed).json()["replayed"]
    assert callback.await_count == 6
    invalid = client.post("/api/finance/a/entries/cash_balances", headers=headers,
                          json={"date": "2026-03-31", "amount": "1.001"})
    assert invalid.status_code == 422
    assert callback.await_count == 6


def test_synthese_hebdomadaire_survit_aux_etats_quotidiens_et_au_redemarrage(engine, monkeypatch):
    import brain_analytical.orchestrator as module
    calls = []

    async def writer(db, actor, state, mode, now, redacteur):
        calls.append((actor, now))
        return repli(state, mode, now, "Test").model_copy(update={"source": SourceSynthese.IA, "modele": "test"})

    monkeypatch.setattr(module, "conseiller", writer)
    db = SimpleNamespace(enterprise_companies=SimpleNamespace(find_one=AsyncMock(return_value={"owner_user_id": "owner"})))

    async def run():
        now = NOW
        worker = AnalyticalOrchestrator(db, engine_factory=lambda: engine, clock=lambda: now)
        for day in range(7):
            now = NOW + timedelta(days=day)
            await worker.executer(Signal("a", "manager", TypeDeclencheur.PERIODIQUE, 0, 0))
        assert len(calls) == 1
        now = NOW + timedelta(days=7)
        restarted = AnalyticalOrchestrator(db, engine_factory=lambda: engine, clock=lambda: now)
        await restarted.executer(Signal("a", "manager", TypeDeclencheur.PERIODIQUE, 0, 0))
        assert calls == [("owner", NOW), ("owner", now)]

    asyncio.run(run())


@pytest.mark.parametrize("trigger", [TypeDeclencheur.MANUEL, TypeDeclencheur.SEUIL])
def test_temporisation_differe_uniquement_les_seuils_sans_changer_le_payeur_manuel(engine, monkeypatch, trigger):
    import brain_analytical.orchestrator as module
    calls = []
    state = snapshot()
    publier(engine, state)

    async def writer(db, actor, current, mode, now, redacteur):
        calls.append(actor)
        return repli(current, mode, now, "Test").model_copy(update={"source": SourceSynthese.IA, "modele": "test"})

    monkeypatch.setattr(module, "conseiller", writer)
    db = SimpleNamespace(enterprise_companies=SimpleNamespace(find_one=AsyncMock(return_value={"owner_user_id": "owner"})))

    async def run():
        nonlocal state
        now = NOW
        worker = AnalyticalOrchestrator(db, engine_factory=lambda: engine, clock=lambda: now)
        monkeypatch.setattr(worker, "_calculer", lambda *args: state)
        worker._queue = asyncio.Queue(maxsize=256)
        await worker.executer(Signal("a", "manager", TypeDeclencheur.MANUEL, 0, 0))
        assert calls == ["manager"]
        now += timedelta(minutes=1)
        state = state.model_copy(update={"entreprise": "Entreprise A actualisée", "empreinte": "a" * 64, "calcule_le": now})
        await worker.executer(Signal("a", "manager", trigger, 0, 0))
        assert calls == ["manager"]
        if trigger == TypeDeclencheur.SEUIL:
            assert worker._queue.qsize() == 1
            delayed = worker._queue.get_nowait()
            assert delayed.declencheur == TypeDeclencheur.SEUIL
            assert delayed.acteur is None and delayed.delai == 840
        else:
            assert worker._queue.empty()
        latest = lire_etat(engine, "a", worker.statut("a"))
        assert latest.synthese.source == SourceSynthese.DETERMINISTE
        assert latest.synthese.empreinte_snapshot == state.empreinte
        assert "15 minutes" in latest.synthese.motif_repli
        db.enterprise_companies.find_one.assert_not_awaited()

    asyncio.run(run())


def test_conseiller_sous_quota_avec_repli_sur_chiffre_invente(monkeypatch):
    import provider_access
    entered = []

    @asynccontextmanager
    async def scope(db, user):
        entered.append(user["user_id"])
        yield {"blocked": None}

    monkeypatch.setattr(provider_access, "metered_scope", scope)
    db = SimpleNamespace(users=SimpleNamespace(find_one=AsyncMock(return_value={"user_id": "u1", "role": "admin"})))
    writer = AsyncMock(return_value=(json.dumps({"resume": "Le CA atteint 36 000.", "recommandations": [], "points_cles": []}), "test"))
    result = asyncio.run(conseiller(db, "u1", snapshot(), TypeDeclencheur.MANUEL, NOW, writer))
    assert result.source == SourceSynthese.IA and entered == ["u1"]
    writer.return_value = (json.dumps({"resume": "Le CA atteint 123 456."}), "test")
    result = asyncio.run(conseiller(db, "u1", snapshot(), TypeDeclencheur.MANUEL, NOW, writer))
    assert result.source == SourceSynthese.DETERMINISTE and "Chiffre non vérifiable" in result.motif_repli

    @asynccontextmanager
    async def blocked(db, user):
        yield {"blocked": "Quota"}

    monkeypatch.setattr(provider_access, "metered_scope", blocked)
    writer.reset_mock()
    result = asyncio.run(conseiller(db, "u1", snapshot(), TypeDeclencheur.MANUEL, NOW, writer))
    assert result.source == SourceSynthese.DETERMINISTE and "Quota" in result.motif_repli
    writer.assert_not_awaited()


def test_conversation_lit_etat_publie_sans_recalculer(engine, monkeypatch):
    from brain_analytical.conversation import est_question_strategique, repondre
    assert est_question_strategique("Quelle est la santé de mon entreprise ?")
    assert est_question_strategique("Comment va mon entreprise ?")
    assert not est_question_strategique("Quelle est ma tension artérielle ?")
    db = SimpleNamespace(enterprise_members=SimpleNamespace(find_one=AsyncMock(return_value={
        "company_id": "a", "role": "manager",
    })))
    worker = AnalyticalOrchestrator(db, engine_factory=lambda: engine, clock=lambda: NOW)
    publier(engine, snapshot())

    def forbidden(*args):
        raise AssertionError("La conversation ne doit pas calculer la finance.")

    monkeypatch.setattr(worker, "_calculer", forbidden)
    response = asyncio.run(repondre(SimpleNamespace(text="Quelle est la santé de mon entreprise ?"),
                                   {"user_id": "u1"}, db, worker))
    assert "EBE de −3\u202f000 EUR" in response["answer"]
    assert "ZEUS CORTEX" in response["answer"]


@pytest.mark.parametrize("cost,severity", [
    ("11880.00", None), ("11883.60", SeveriteAlerte.WARNING),
    ("13680.00", SeveriteAlerte.WARNING), ("13683.60", SeveriteAlerte.CRITICAL),
])
def test_seuils_alimentaires_exacts(cost, severity):
    original = dataset()
    data = FinanceDataset(
        company=original.company.model_copy(update={"sector": SectorEnum.HOSPITALITY}),
        revenues=(original.revenues[0].model_copy(update={"allocation": AllocationEnum.FOOD}),),
        expenses=(original.expenses[0].model_copy(update={
            "amount_ht": D(cost), "amount_ttc": D(cost), "category": CategorieExpense.MATIERE_PREMIERE,
            "allocation": AllocationEnum.FOOD,
        }),),
        overheads=original.overheads, cash_balances=original.cash_balances,
        inventories=tuple(InventorySnapshotIn(company_id="a", date=day, allocation=allocation, value=D("0"))
                          for day in (date(2026, 1, 1), date(2026, 4, 1))
                          for allocation in (AllocationEnum.FOOD, AllocationEnum.BEVERAGE)),
    )
    state = analyser(DonneesCollectees(data, PERIOD, NOW.date()), NOW, TypeDeclencheur.MANUEL)
    alert = next((a for a in state.alertes if a.code == "FOOD_COST_ELEVE"), None)
    assert (alert.severite if alert else None) == severity


@pytest.mark.parametrize("sector,code", [
    (SectorEnum.CONSTRUCTION, "CHANTIERS_DEFICITAIRES"),
    (SectorEnum.RETAIL, "MARGE_COMMERCIALE_NEGATIVE"),
])
def test_alertes_chantier_et_marge_commerciale(sector, code):
    original = dataset()
    data = FinanceDataset(
        company=original.company.model_copy(update={"sector": sector}),
        revenues=(original.revenues[0].model_copy(update={"business_reference": "Chantier A"}),),
        expenses=(original.expenses[0].model_copy(update={
            "amount_ht": D("40000"), "amount_ttc": D("40000"), "business_reference": "Chantier A",
            "category": CategorieExpense.MATIERE_PREMIERE, "allocation": AllocationEnum.MERCHANDISE,
        }),),
        inventories=tuple(InventorySnapshotIn(company_id="a", date=day, allocation=AllocationEnum.MERCHANDISE, value=D("0"))
                          for day in (date(2026, 1, 1), date(2026, 4, 1))),
    )
    state = analyser(DonneesCollectees(data, PERIOD, NOW.date()), NOW, TypeDeclencheur.MANUEL)
    assert code in {a.code for a in state.alertes}


def test_baisse_ca_privilegie_annee_precedente_et_derive_marge_est_en_points():
    original = dataset()
    revenue = original.revenues[0]
    previous = revenue.model_copy(update={"date": date(2025, 12, 31), "amount_ht": D("72000"), "amount_ttc": D("72000")})
    expense = original.expenses[0].model_copy(update={"date": date(2025, 12, 31), "amount_ht": D("48000"), "amount_ttc": D("48000")})

    def compute(revenues):
        data = FinanceDataset(company=original.company, revenues=revenues, expenses=original.expenses + (expense,))
        return analyser(DonneesCollectees(data, PERIOD, NOW.date()), NOW, TypeDeclencheur.MANUEL)

    state = compute((revenue, previous))
    assert next(a for a in state.alertes if a.code == "BAISSE_CA").valeur == D("-50")
    margin = next(a for a in state.alertes if a.code == "DERIVE_MARGE")
    assert margin.valeur == D("-8.33") and margin.unite == "pts" and margin.severite == SeveriteAlerte.CRITICAL
    year_ago = revenue.model_copy(update={"date": date(2025, 3, 31), "amount_ht": D("30000"), "amount_ttc": D("30000")})
    assert "BAISSE_CA" not in {a.code for a in compute((revenue, previous, year_ago)).alertes}


def test_calcul_lent_ne_bloque_ni_saisie_ni_lecture_cortex(connected, monkeypatch):
    client, worker, _callback = connected
    entered, release, timed_out = Event(), Event(), Event()
    original = worker._calculer

    def waiting(*args):
        entered.set()
        if not release.wait(60):
            timed_out.set()
        return original(*args)

    monkeypatch.setattr(worker, "_calculer", waiting)
    try:
        response = client.post("/api/finance/a/entries/cash_balances", headers={"x-test-user": "u1"},
                               json={"date": "2026-03-31", "amount": "1500"})
        assert response.status_code == 201
        assert entered.wait(30)
        state = client.get("/api/cortex/analytique", headers={"x-test-user": "u1"})
        assert state.status_code == 200
        assert state.json()["etat"]["orchestrateur"]["en_attente"] >= 1
        assert not timed_out.is_set()
    finally:
        release.set()


def test_erreur_de_calcul_persiste_et_planifie_une_reprise(engine, monkeypatch):
    worker = AnalyticalOrchestrator(None, engine_factory=lambda: engine, clock=lambda: NOW)

    def fail(*args):
        raise ValueError("Données volontairement incohérentes.")

    monkeypatch.setattr(worker, "_calculer", fail)

    async def run():
        worker._queue = asyncio.Queue(maxsize=256)
        await worker.executer(Signal("a", "u1", TypeDeclencheur.MANUEL, 0, 0))
        assert worker._queue.qsize() == 1
        retry = worker._queue.get_nowait()
        assert retry.essai == 1 and retry.delai == 60

    asyncio.run(run())
    state = lire_etat(engine, "a", worker.statut("a"))
    assert state.snapshot is None
    assert state.executions[0].statut.value == "ECHEC"

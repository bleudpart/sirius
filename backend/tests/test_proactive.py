"""Tests du moteur de proactivité (suggestions issues de la mémoire réelle)."""
from datetime import datetime, timezone, timedelta

import pytest

import local_memory
import proactive
from productivite.store import ProductivityStore


@pytest.fixture()
def memory_db(tmp_path, monkeypatch):
    monkeypatch.setattr(local_memory, "DB_PATH", tmp_path / "test_memory.db")
    monkeypatch.setenv("SIRIUS_PRODUCTIVITY_DB", str(tmp_path / "test_productivity.db"))
    local_memory.init_local_db()
    proactive.init_proactive_db()
    return local_memory


def _at_hour(hour):
    """Un instant UTC dont l'heure LOCALE vaut `hour`."""
    now_local = datetime.now(timezone.utc).astimezone().replace(
        hour=hour, minute=30, second=0, microsecond=0
    )
    return now_local.astimezone(timezone.utc)


# ---------- Sources de suggestions ----------

def test_projet_recent_genere_une_suggestion(memory_db):
    memory_db.add_fact("projet", "préparer l'audit HACCP d'octobre", user_id="u1")
    result = proactive.evaluate("u1", now=_at_hour(14))
    assert result["settings"]["mode"] == "proactif"
    assert any("audit HACCP" in s["description"] for s in result["suggestions"])

def test_taches_dues_proviennent_du_stockage_productivite(memory_db):
    store = ProductivityStore()
    store.create_task("u1", "Préparer le dossier", due_at="2020-01-01")
    store.create_task("u2", "Tâche d'un autre utilisateur", due_at="2020-01-01")
    store.create_task("u1", "Tâche terminée", status="done", due_at="2020-01-01")

    result = proactive.evaluate("u1", now=_at_hour(14))
    overdue = next(s for s in result["suggestions"] if s["source"] == "tache-retard")
    assert "Préparer le dossier" in overdue["description"]
    assert "autre utilisateur" not in overdue["description"]
    assert "Tâche terminée" not in overdue["description"]


def test_briefing_suggere_le_matin_seulement(memory_db):
    matin = proactive.evaluate("u1", now=_at_hour(8))
    soir = proactive.evaluate("u1", now=_at_hour(20))
    assert any(s["title"] == "Infos du jour" for s in matin["suggestions"])
    assert not any(s["title"] == "Infos du jour" for s in soir["suggestions"])


def test_briefing_pas_resuggere_apres_usage(memory_db):
    now = _at_hour(8)
    memory_db.log_event("mon briefing", intent="daily_briefing", user_id="u1")
    with local_memory._conn() as con:
        con.execute("UPDATE events SET created_at = ? WHERE user_id = 'u1'", (now.isoformat(),))
    result = proactive.evaluate("u1", now=now)
    assert not any(s["source"] == "briefing" for s in result["suggestions"])


def test_episode_recent_propose_une_reprise(memory_db):
    memory_db.add_episode("u1", "L'utilisateur préparait le menu de la semaine.", session_id="u1:x")
    result = proactive.evaluate("u1", now=_at_hour(14))
    assert any("menu de la semaine" in s["description"] for s in result["suggestions"])


def test_intervention_recente_genere_un_suivi(memory_db):
    memory_db.log_work_intervention(
        "Analyse du plan HACCP",
        project="HACCP",
        status="running",
        user_id="u1",
        entry_id="haccp-1",
    )
    result = proactive.evaluate("u1", now=_at_hour(14))
    suggestion = next(s for s in result["suggestions"] if s["title"] == "Suivi d'intervention")
    assert suggestion["source"] == "intervention"
    assert "HACCP" in suggestion["description"]
    assert suggestion["decision"] == "agir"


def test_habitude_horaire_detectee(memory_db):
    now = _at_hour(9)
    for _ in range(3):
        memory_db.log_event("quelle météo ?", intent="météo", user_id="u1")
    # log_event enregistre l'heure locale réelle : force l'heure des événements
    with local_memory._conn() as con:
        con.execute("UPDATE events SET hour = 9 WHERE user_id = 'u1'")
    result = proactive.evaluate("u1", now=now)
    assert any("météo" in s["description"] for s in result["suggestions"])


# ---------- Modes et plafonds ----------

def test_mode_proactif_expose_les_suggestions(memory_db):
    proactive.set_mode("u1", "discret")
    memory_db.add_fact("projet", "projet A", user_id="u1")
    memory_db.add_episode("u1", "conversation récente", session_id="u1:x")
    result = proactive.evaluate("u1", now=_at_hour(8))
    assert len(result["suggestions"]) >= 2
    assert result["settings"]["mode"] == "proactif"


def test_mode_est_toujours_proactif(memory_db):
    assert proactive.set_mode("u1", "n'importe quoi") == "proactif"


# ---------- Actions du panneau ----------

def test_executer_renvoie_une_commande(memory_db):
    memory_db.add_fact("projet", "certification HACCP", user_id="u1")
    result = proactive.evaluate("u1", now=_at_hour(14))
    sid = result["suggestions"][0]["id"]
    action = proactive.suggestion_action("u1", sid, "executer")
    assert action["executed"] is True
    assert action["proposed_action"]["type"] == "command"
    assert "HACCP" in action["proposed_action"]["text"]


def test_projet_recoit_un_plan_d_intervention_autonome(memory_db):
    memory_db.add_fact("projet", "certification HACCP", user_id="u1")

    suggestion = proactive.evaluate("u1", now=_at_hour(14))["suggestions"][0]

    assert suggestion["decision"] == "agir"
    assert "Je peux" in suggestion["intervention"]
    assert suggestion["alternative"]


def test_ne_plus_proposer_supprime_definitivement(memory_db):
    memory_db.add_fact("projet", "certification HACCP", user_id="u1")
    result = proactive.evaluate("u1", now=_at_hour(14))
    sid = result["suggestions"][0]["id"]
    proactive.suggestion_action("u1", sid, "ne_plus_proposer")
    again = proactive.evaluate("u1", now=_at_hour(14))
    assert all(s["id"] != sid for s in again["suggestions"])


def test_plus_tard_snooze_puis_revient(memory_db):
    memory_db.add_fact("projet", "certification HACCP", user_id="u1")
    now = _at_hour(14)
    result = proactive.evaluate("u1", now=now)
    sid = result["suggestions"][0]["id"]
    proactive.suggestion_action("u1", sid, "plus_tard", now=now)

    pendant_snooze = proactive.evaluate("u1", now=now + timedelta(hours=1))
    assert all(s["id"] != sid for s in pendant_snooze["suggestions"])

    apres_snooze = proactive.evaluate("u1", now=now + timedelta(hours=5))
    assert any(s["id"] == sid for s in apres_snooze["suggestions"])


def test_pourquoi_est_traceable(memory_db):
    memory_db.add_fact("projet", "certification HACCP", user_id="u1")
    result = proactive.evaluate("u1", now=_at_hour(14))
    sid = result["suggestions"][0]["id"]
    why = proactive.suggestion_why("u1", sid)
    assert "HACCP" in why["reason"]
    assert why["confidence"] > 0


def test_suggestion_expiree_ou_inconnue(memory_db):
    assert proactive.suggestion_action("u1", "inexistant", "executer")["mode"] == "noop"
    assert proactive.suggestion_why("u1", "inexistant")["confidence"] == 0.0


def test_isolation_entre_utilisateurs(memory_db):
    memory_db.add_fact("projet", "secret u1", user_id="u1")
    result = proactive.evaluate("u2", now=_at_hour(14))
    assert all("secret" not in s["description"] for s in result["suggestions"])


def test_news_updates_need_no_prior_task_and_keep_source_and_publication(memory_db):
    now = _at_hour(14)
    article = {"titre": "Résultat confirmé", "url": "https://www.franceinfo.fr/sports/resultat",
               "source": "Franceinfo", "date": (now - timedelta(hours=1)).isoformat()}
    sections = [
        {"label": "Sport", "status": "ok", "articles": [article]},
        {"label": "France", "status": "ok", "articles": [article]},
        {"label": "Culture", "status": "ok", "articles": [{**article, "url": "https://www.franceinfo.fr/ancien",
                                                          "date": (now - timedelta(hours=25)).isoformat()}]},
        {"label": "Santé", "status": "unavailable", "articles": []},
    ]
    result = proactive.evaluate("u1", now=now, news_sections=sections)
    updates = [s for s in result["suggestions"] if s["source"] == "actualite"]
    assert len(updates) == 1
    assert "Franceinfo" in updates[0]["description"]
    assert article["date"] in updates[0]["reason"]
    assert updates[0]["decision"] == "informer"
    proactive.suggestion_action("u1", updates[0]["id"], "plus_tard", now=now)
    assert not any(s["source"] == "actualite" for s in proactive.evaluate("u1", now=now, news_sections=sections)["suggestions"])


def test_conversation_prompt_allows_specific_followups_without_generic_pressure():
    import sirius_brain

    assert "une seule question de suivi liée à ce propos" in sirius_brain.SIRIUS_CORE_PROMPT
    assert "Respecte une conclusion, un refus, une pause" in sirius_brain.SIRIUS_CORE_PROMPT


def test_work_failure_is_not_announced_as_finished_and_status_change_has_new_id(memory_db):
    memory_db.log_work_intervention("Analyse HACCP", status="running", user_id="u1", entry_id="work-state")
    running = next(s for s in proactive.evaluate("u1", now=_at_hour(14))["suggestions"] if s["source"] == "intervention")
    memory_db.update_work_intervention("work-state", status="error", result="Document manquant", user_id="u1")
    failed = next(s for s in proactive.evaluate("u1", now=_at_hour(14))["suggestions"] if s["source"] == "intervention")
    assert running["id"] != failed["id"]
    assert "en erreur" in failed["description"]
    assert "Document manquant" in failed["description"]
    assert "terminée" not in failed["description"]
    assert failed["urgency"] == "haute"
    proactive.suggestion_action("u1", failed["id"], "ne_plus_proposer")
    memory_db.update_work_intervention("work-state", status="done", result="Vérification terminée", user_id="u1")
    assert not any(s["source"] == "intervention" for s in proactive.evaluate("u1", now=_at_hour(14))["suggestions"])


def test_proactive_route_fetches_news_for_authenticated_user(memory_db, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import proactive_routes

    async def require_user(request, db):
        return {"user_id": "u1"}

    async def news():
        return {"sections": [{"label": "Sport", "status": "ok", "articles": [{
            "titre": "Un résultat", "source": "Franceinfo",
            "url": "https://www.franceinfo.fr/sports/resultat",
            "date": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(),
        }]}]}

    monkeypatch.setattr(proactive_routes, "fetch_briefing_news", news)
    app = FastAPI()
    app.include_router(proactive_routes.make_proactive_router(None, require_user), prefix="/api")
    with TestClient(app) as client:
        response = client.post("/api/suggestions/evaluate", json={"trigger": "timer"})
    assert response.status_code == 200
    assert response.json()["news_status"] == "ok"
    assert any(s["source"] == "actualite" for s in response.json()["suggestions"])

"""Tests de l'apprentissage rapide du cerveau ΣIRIUS.

Couvre : mémorisation instantanée sans LLM, rappel par pertinence,
renforcement par usage, classification automatique et prompt mémoire.
"""
import asyncio

import pytest

import local_memory
from sirius_brain import ask_sirius, build_system_prompt, detect_memorize_request


@pytest.fixture()
def memory_db(tmp_path, monkeypatch):
    """Base SQLite isolée pour chaque test."""
    monkeypatch.setattr(local_memory, "DB_PATH", tmp_path / "test_memory.db")
    local_memory.init_local_db()
    return local_memory


# ---------- Mémorisation instantanée (fast-path sans LLM) ----------

def test_souviens_toi_detecte_le_fait():
    detected = detect_memorize_request("Souviens-toi que je pars à Lyon vendredi")
    assert detected == {"fact": "je pars à Lyon vendredi", "kind": "explicit"}


@pytest.mark.parametrize("phrase", [
    "Retiens que ma fille s'appelle Emma",
    "Sirius, mémorise : le code du portail est 4482",
    "note que je préfère les rapports en PDF",
])
def test_variantes_de_memorisation(phrase):
    detected = detect_memorize_request(phrase)
    assert detected is not None and detected["kind"] == "explicit"


def test_correction_detectee_comme_apprentissage():
    detected = detect_memorize_request("Je t'ai déjà dit que je ne bois pas de café")
    assert detected == {"fact": "je ne bois pas de café", "kind": "correction"}


def test_phrase_normale_non_interceptee():
    assert detect_memorize_request("Quelle est la météo demain ?") is None


def test_ask_sirius_memorise_sans_llm():
    """La mémorisation répond immédiatement, sans clé API ni appel réseau."""
    result = asyncio.run(ask_sirius("Souviens-toi que mon restaurant ouvre à 11h30"))
    assert "mémorisé" in result["reponse"].lower()
    assert result["memoire"] == ["mon restaurant ouvre à 11h30"]


# ---------- Classification automatique ----------

def test_classification_preference(memory_db):
    assert memory_db.classify_fact("j'aime le café serré le matin") == "preference"


def test_classification_projet(memory_db):
    assert memory_db.classify_fact("je travaille sur la certification HACCP") == "projet"


def test_learn_fact_prefixe_explicite(memory_db):
    fact = memory_db.learn_fact("preference: les rapports en PDF", user_id="u1")
    assert fact["category"] == "preference"
    assert fact["text"] == "les rapports en PDF"


# ---------- Rappel par pertinence + renforcement ----------

def test_recall_remonte_le_fait_pertinent(memory_db):
    memory_db.add_fact("souvenir", "le chat s'appelle Plume", user_id="u1")
    memory_db.add_fact("projet", "certification HACCP prévue en octobre", user_id="u1")
    memory_db.add_fact("preference", "déteste les réunions le lundi", user_id="u1")

    recalled = memory_db.recall_facts("où en est ma certification HACCP ?", user_id="u1", limit=2)
    assert recalled
    assert "HACCP" in recalled[0]["text"]


def test_recall_sans_recouvrement_rend_les_recents(memory_db):
    memory_db.add_fact("souvenir", "fait ancien quelconque", user_id="u1")
    recalled = memory_db.recall_facts("zzz aucun rapport qqq", user_id="u1")
    assert len(recalled) == 1  # repli : faits récents plutôt que rien


def test_renforcement_augmente_use_count(memory_db):
    memory_db.add_fact("preference", "aime les tableaux de bord sombres", user_id="u1")
    memory_db.recall_facts("mets le tableau de bord sombre", user_id="u1")
    memory_db.recall_facts("affiche le tableau de bord", user_id="u1")

    facts = memory_db.list_facts(user_id="u1")
    assert facts[0]["use_count"] >= 2
    assert facts[0]["last_used"]


def test_isolation_entre_utilisateurs(memory_db):
    memory_db.add_fact("souvenir", "secret de u1", user_id="u1")
    assert memory_db.recall_facts("secret", user_id="u2") == []


# ---------- Prompt système : mémoire structurée + historique ----------

def test_prompt_contient_la_memoire_categorisee():
    prompt = build_system_prompt(
        memory=[{"t": "aime le café serré", "c": "preference"}, "fait libre"],
    )
    assert "MÉMOIRE PERSISTANTE" in prompt
    assert "[preference] aime le café serré" in prompt
    assert "fait libre" in prompt


def test_prompt_sans_memoire_reste_propre():
    assert "MÉMOIRE PERSISTANTE" not in build_system_prompt(memory=[])

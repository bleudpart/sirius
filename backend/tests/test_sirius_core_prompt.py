# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Regression tests for the active ΣIRIUS production prompt."""

from datetime import datetime, timezone

from sirius_brain import SIRIUS_CORE_PROMPT, build_system_prompt, current_moment_text


def test_system_prompt_gives_the_real_current_date():
    moment = datetime(2026, 10, 12, 6, 30, tzinfo=timezone.utc)
    assert current_moment_text("Europe/Paris", now=moment) == "lundi 12 octobre 2026, 08:30 (Europe/Paris)"
    assert current_moment_text("Pas/Une_Zone", now=moment).endswith("(Europe/Paris)")
    prompt = build_system_prompt(environment={"timezone": "Europe/Paris"})
    assert "DATE ET HEURE ACTUELLES" in prompt
    assert "ÉTAT OPÉRATIONNEL DU HUD :" not in prompt


def test_proactive_dialogue_keeps_the_context_of_the_initiative():
    prompt = build_system_prompt(environment={"proactive_message": "Je peux préparer le briefing du jour."})
    assert "DERNIÈRE INITIATIVE AFFICHÉE DANS LE DIALOGUE" in prompt
    assert "Je peux préparer le briefing du jour." in prompt
    assert "sans résultat d'outil" in prompt
    assert "DERNIÈRE INITIATIVE" not in build_system_prompt(environment={"proactive_message": None})


def test_system_prompt_matches_the_current_sirius_production_contract():
    prompt = build_system_prompt(
        profile={"name": "Daniel"},
        memory=["Déployer le module HUD"],
        mode="turbo",
        mood={"label": "concentré"},
        environment={"active_tasks": ["Briefing du jour"], "display_open": True, "activity": "intense"},
    )

    assert prompt.startswith(SIRIUS_CORE_PROMPT)
    assert "assistant vocal intelligent" in SIRIUS_CORE_PROMPT
    assert "Tutoie toujours l'utilisateur" in SIRIUS_CORE_PROMPT
    assert "Ne vouvoie jamais l'utilisateur" in SIRIUS_CORE_PROMPT
    assert "STYLE DE COMMUNICATION" in SIRIUS_CORE_PROMPT
    assert "Tu connais ton environnement de travail" in SIRIUS_CORE_PROMPT
    assert "les tâches en cours" in SIRIUS_CORE_PROMPT
    assert "DÉCISION, SOLUTIONS ET OUTILS" in SIRIUS_CORE_PROMPT
    assert "tu choisis toi-même la solution la plus utile" in SIRIUS_CORE_PROMPT
    assert "une alternative concrète et réalisable" in SIRIUS_CORE_PROMPT
    assert "PRÉSENCE OPÉRATIONNELLE" in SIRIUS_CORE_PROMPT
    assert "un constat précis" in SIRIUS_CORE_PROMPT
    assert "ne prétends jamais avoir observé" in SIRIUS_CORE_PROMPT
    assert "RÉACTIVITÉ NATURELLE" in SIRIUS_CORE_PROMPT
    assert "jamais avec un scénario figé" in SIRIUS_CORE_PROMPT
    assert "N'interviens pas pour remplir le silence" in SIRIUS_CORE_PROMPT
    assert "l'ÉTAT OPÉRATIONNEL DU HUD est fourni" in SIRIUS_CORE_PROMPT
    assert "donne d'abord la décision utile" in SIRIUS_CORE_PROMPT
    assert "GESTION DE MÉMOIRE" in SIRIUS_CORE_PROMPT
    assert "COMPTE RENDU DES TÂCHES" in SIRIUS_CORE_PROMPT
    assert "EXÉCUTION AUTONOME" in SIRIUS_CORE_PROMPT
    assert "ΣIRIUS Display sans bouton intermédiaire" in SIRIUS_CORE_PROMPT
    assert "commentaire technique reste court" in SIRIUS_CORE_PROMPT
    # Charte de proactivité : initiative encadrée par les niveaux d'autonomie.
    assert "PROACTIVITÉ" in SIRIUS_CORE_PROMPT
    assert "NIVEAUX D’AUTONOMIE" in SIRIUS_CORE_PROMPT
    assert "Exécution directe" in SIRIUS_CORE_PROMPT
    assert "validation finale" in SIRIUS_CORE_PROMPT
    assert "Confirmation obligatoire" in SIRIUS_CORE_PROMPT
    assert "RÈGLES DE COMMUNICATION" in SIRIUS_CORE_PROMPT
    assert "Contexte utilisateur : ton interlocuteur s'appelle Daniel." in prompt
    assert "Mode d'exécution : turbo." in prompt
    assert "Contexte d'humeur actuel : concentré." in prompt
    assert "ÉTAT OPÉRATIONNEL DU HUD" in prompt
    assert "tâches en cours : Briefing du jour" in prompt
    assert "ΣIRIUS Display ouvert" in prompt
    assert "MÉMOIRE PERSISTANTE" in prompt
    assert "- Déployer le module HUD" in prompt


def test_prompt_lists_real_modules_and_forbids_invented_acronyms():
    prompt = build_system_prompt()
    assert "TES MODULES RÉELS" in prompt
    assert "HÉPHAÏSTOS : Auto-maintenance & diagnostic" in prompt
    assert "CALLIOPE : Bibliothèque audio" in prompt
    assert "ne fabrique JAMAIS de définition, d'acronyme" in prompt
    assert "RÈGLE SILENCIEUSE" in prompt and "[[HORS_SUJET]]" in prompt


def test_ignored_marker_helpers():
    from sirius_brain import could_become_ignored_marker, is_ignored_answer
    assert is_ignored_answer("  [[HORS_SUJET]]")
    assert not is_ignored_answer("Calliope est ta bibliothèque audio.")
    assert could_become_ignored_marker("")
    assert could_become_ignored_marker(" [[HORS")
    assert not could_become_ignored_marker("Bonjour")
    assert not could_become_ignored_marker("[Note]")

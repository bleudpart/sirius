# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Regression tests for the active SIRIUS production prompt."""

from sirius_brain import SIRIUS_CORE_PROMPT, build_system_prompt


def test_system_prompt_matches_the_current_sirius_production_contract():
    prompt = build_system_prompt(profile={"name": "Daniel"}, mode="turbo")

    assert prompt.startswith(SIRIUS_CORE_PROMPT)
    assert "assistant vocal intelligent" in SIRIUS_CORE_PROMPT
    assert "STYLE DE COMMUNICATION" in SIRIUS_CORE_PROMPT
    assert "GESTION DE MÉMOIRE" in SIRIUS_CORE_PROMPT
    assert "COMPTE RENDU FINAL" in SIRIUS_CORE_PROMPT
    assert "Mode turbo" in prompt

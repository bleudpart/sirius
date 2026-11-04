import asyncio

import pytest

import sirius_brain


@pytest.mark.parametrize("command", [
    "Zirius, ouvre la carte OSIRIS",
    "ΣIRIUS, affiche OSIRIS carte",
    "afficher OSIRIS carte",
    "ouvre OSIRIS",
    "montre-moi les cartes OSIRIS",
    "peux-tu m'afficher la carte OSIRIS ?",
    "est-ce que tu peux ouvrir OSIRIS dans ton Zirius Display ?",
    "je voudrais voir la carte d'OSIRIS s'il te plaît",
    "affiche la cartographie sur l'écran",
    "ouvre le module OSIRIS",
    "OSIRIS carte",
    "cartographie",
    "la carte des événements",
    "les événements proches",
    "ouvre Osiri",
    "affiche Osirisss",
])
def test_osiris_opens_cartographie_without_a_provider(monkeypatch, command):
    def unexpected_provider(*args, **kwargs):
        raise AssertionError("Une commande OSIRIS ne doit pas appeler le LLM.")

    monkeypatch.setattr(sirius_brain, "fast_provider", unexpected_provider)
    assert asyncio.run(sirius_brain.parse_intent(command)) == {
        "action": "open_module",
        "target": "cartographie",
        "say": "J'ouvre la cartographie des événements OSIRIS autour de Zirius.",
    }


@pytest.mark.parametrize("command", [
    "que fait OSIRIS en plus de la météo ?",
    "comment ouvrir la carte OSIRIS ?",
    "n'ouvre pas OSIRIS",
    "je ne veux pas afficher OSIRIS",
    "ferme OSIRIS",
    "réduis OSIRIS",
    "ouvre ATLAS",
    "affiche la carte de Paris",
    "affiche le guide de la carte OSIRIS",
    "explique la cartographie",
])
def test_osiris_mentions_and_other_actions_do_not_open_the_map(command):
    assert not sirius_brain.is_osiris_map_open_request(command)


def test_llm_intent_catalog_distinguishes_osiris_from_atlas_and_display():
    prompt = sirius_brain._INTENT_SYSTEM_PROMPT
    assert 'le module "cartographie"' in prompt
    assert 'pas "display" ni "atlas"' in prompt
    assert "pas une preuve que la carte est déjà affichée" in prompt

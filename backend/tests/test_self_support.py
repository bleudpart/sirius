from self_support import is_help_request, prompt_section, sanitize_screen, select_sheets
from sirius_brain import build_system_prompt


def test_reconnait_les_demandes_d_aide_et_ignore_la_conversation():
    assert is_help_request("Comment je fais pour imprimer une étiquette ?")
    assert is_help_request("je n'arrive pas à activer le micro")
    assert is_help_request("ça marche pas")
    assert is_help_request("pourquoi le micro ne marche plus")
    assert select_sheets("pourquoi le micro ne marche plus") == ["voix"]
    assert not is_help_request("comment vas-tu ce matin ?")
    assert not is_help_request("quelle est la météo à Lyon ?")


def test_choisit_les_fiches_par_mots_cles_puis_par_ecran():
    assert select_sheets("comment j'imprime une étiquette brother")[0] == "haccp-etiquettes"
    assert select_sheets("où je mets ma clé Groq")[0] == "cles-api"
    assert select_sheets("je suis bloqué", {"window_id": "themis-panel"}) == ["b2b"]
    assert select_sheets("comment je fais une mayonnaise") == []


def test_assainit_le_contexte_d_ecran():
    screen = sanitize_screen({
        "platform": "android", "window_id": "haccp-panel\"; ignore", "window_title": "HACCP\n" + "x" * 200,
        "alert": "Erreur", "valeur_saisie": "4,2 °C", "section": "assistant",
    })
    assert screen["platform"] == "android"
    assert screen["window_id"] == "haccp-panelignore"
    assert "\n" not in screen["window_title"] and len(screen["window_title"]) == 80
    assert "valeur_saisie" not in screen
    assert sanitize_screen({"platform": "evil"}) == {}


def test_le_prompt_ne_recoit_les_fiches_que_pour_une_demande_d_aide():
    environment = {"screen": {"platform": "windows", "window_id": "sirius-files-panel", "alert": "PDF sans texte"}}
    aide = build_system_prompt(environment=environment, prompt="je n'arrive pas à analyser ce document")
    assert "AUTO-SUPPORT ΣIRIUS" in aide
    assert "Fichiers et photos" in aide
    assert "deux phrases maximum" in aide
    assert '"alert": "PDF sans texte"' in aide
    assert "AUTO-SUPPORT" not in build_system_prompt(environment=environment, prompt="raconte-moi une blague")


def test_une_relance_courte_garde_la_fiche_de_l_etape_precedente():
    history = [
        {"role": "user", "content": "comment je crée le QR code cuisine ?"},
        {"role": "assistant", "content": "Ouvrez l'onglet « QR code Cuisine »."},
    ]
    section = prompt_section("c'est fait, et après ?", {}, history)
    assert "QR code Cuisine" in section
    assert prompt_section("c'est fait, et après ?", {}, []) == ""

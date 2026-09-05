import email_intel as ei


def _mail(**over):
    base = {
        "sujet": "Question sur le projet",
        "de": "Jean Dupont",
        "de_email": "jean.dupont@client.fr",
        "apercu": "Bonjour, tout va bien de mon côté.",
        "importance": "normal",
    }
    base.update(over)
    return base


def test_blocked_sender_always_low_priority_even_if_urgent_text():
    mail = _mail(sujet="URGENT paiement bloqué", de_email="spam@ads.com")
    prefs = {"sender_rules": {"spam@ads.com": "indesirable"}}
    r = ei.classify_email(mail, prefs)
    assert r["categorie"] == "Faible priorité"


def test_urgent_keyword_is_critical():
    mail = _mail(sujet="Alerte sécurité : tentative de connexion suspecte")
    r = ei.classify_email(mail, {})
    assert r["categorie"] == "Critique"


def test_vip_sender_is_at_least_important():
    mail = _mail(sujet="Petite question", apercu="Pas de souci particulier.")
    prefs = {"sender_rules": {"jean.dupont@client.fr": "vip"}}
    r = ei.classify_email(mail, prefs)
    assert r["categorie"] == "Important"


def test_learned_override_does_not_beat_explicit_vip_rule():
    mail = _mail()
    prefs = {
        "sender_rules": {"jean.dupont@client.fr": "vip"},
        "learned_overrides": {"jean.dupont@client.fr": "Faible priorité"},
    }
    r = ei.classify_email(mail, prefs)
    assert r["categorie"] == "Important"  # la règle explicite VIP prime sur l'apprentissage


def test_learned_override_applies_without_explicit_rule():
    mail = _mail(sujet="Compte rendu", apercu="Rien à faire, juste pour information.")
    prefs = {"learned_overrides": {"jean.dupont@client.fr": "À lire"}}
    r = ei.classify_email(mail, prefs)
    assert r["categorie"] == "À lire"


def test_question_mark_flags_reply_needed_and_important():
    mail = _mail(sujet="Disponible demain ?", apercu="Peux-tu confirmer ta présence ?")
    r = ei.classify_email(mail, {})
    assert r["categorie"] == "Important"
    assert r["necessite_reponse"] is True
    assert r["action_attendue"] == "Réponse attendue"


def test_action_required_without_reply_is_a_traiter():
    mail = _mail(sujet="Merci de valider le document", apercu="Veuillez signer avant la fin du mois.")
    r = ei.classify_email(mail, {})
    assert r["categorie"] == "À traiter"
    assert r["necessite_reponse"] is False


def test_newsletter_sender_is_low_priority():
    mail = _mail(de_email="newsletter@boutique.fr", sujet="Nos soldes commencent", apercu="Découvrez nos offres.")
    r = ei.classify_email(mail, {})
    assert r["categorie"] == "Faible priorité"


def test_plain_information_defaults_to_a_lire():
    mail = _mail(sujet="Compte rendu de réunion", apercu="Voici le résumé de notre échange d'hier.")
    r = ei.classify_email(mail, {})
    assert r["categorie"] == "À lire"


def test_deadline_phrase_is_extracted():
    mail = _mail(sujet="Facture à régler", apercu="Merci de régler avant le 15 septembre.")
    r = ei.classify_email(mail, {})
    assert r["echeance"] is not None
    assert "avant le" in r["echeance"].lower()


def test_graph_high_importance_flag_forces_critical():
    mail = _mail(sujet="Point rapide", apercu="Rien de spécial.", importance="high")
    r = ei.classify_email(mail, {})
    assert r["categorie"] == "Critique"


def test_group_by_priority_orders_correctly():
    mails = [
        {**_mail(sujet="a"), "categorie": "Faible priorité", "necessite_reponse": False},
        {**_mail(sujet="b"), "categorie": "Critique", "necessite_reponse": False},
        {**_mail(sujet="c"), "categorie": "Important", "necessite_reponse": True},
        {**_mail(sujet="d"), "categorie": "À traiter", "necessite_reponse": False},
        {**_mail(sujet="e"), "categorie": "À lire", "necessite_reponse": False},
    ]
    grouped = ei.group_by_priority(mails)
    assert grouped["urgences"][0]["sujet"] == "b"
    assert grouped["reponses_attendues"][0]["sujet"] == "c"
    assert grouped["actions"][0]["sujet"] == "d"
    assert grouped["a_lire"][0]["sujet"] == "e"
    assert grouped["reste"][0]["sujet"] == "a"

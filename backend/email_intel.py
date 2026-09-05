# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
"""Classement des e-mails Outlook par importance (voir cahier des charges "assistant e-mails").

Module volontairement pur (aucun accès réseau/DB) : classify_email() prend un mail déjà
récupéré via Microsoft Graph + les préférences de l'utilisateur, et renvoie une catégorie
parmi les 5 imposées, une courte explication, et les signaux utiles à l'affichage (action
attendue, échéance détectée).

Ordre de priorité des règles (une règle EXPLICITE de l'utilisateur ne doit jamais être
silencieusement écrasée par un apprentissage automatique) :
  1. expéditeur bloqué (règle explicite)               -> Faible priorité
  2. mot-clé d'urgence/sécurité dans le sujet ou l'aperçu -> Critique
  3. expéditeur VIP (règle explicite)                   -> au moins Important
  4. correction apprise pour cet expéditeur (non explicite) -> catégorie mémorisée
  5. réponse manifestement attendue                     -> Important
  6. action requise sans réponse attendue                -> À traiter
  7. expéditeur automatisé / newsletter                  -> Faible priorité
  8. par défaut                                          -> À lire
"""
import re

CATEGORIES = ("Critique", "Important", "À traiter", "À lire", "Faible priorité")

_URGENT_RE = re.compile(
    r"\b(urgent|urgence|imm[ée]diat(?:ement)?|d[ée]lai\s+d[ée]pass[ée]|dernier\s+d[ée]lai|"
    r"sous\s+24\s*h(?:eures)?|paiement\s+(?:bloqu[ée]|refus[ée]|[ée]chou[ée])|"
    r"facture\s+impay[ée]e|compte\s+(?:suspendu|bloqu[ée]|compromis)|pirat[ée]|"
    r"incident\s+(?:critique|de\s+s[ée]curit[ée])|faille\s+de\s+s[ée]curit[ée]|alerte\s+s[ée]curit[ée]|"
    r"tentative\s+de\s+connexion|acc[èe]s\s+non\s+autoris[ée]|danger|panne\s+critique)\b",
    re.IGNORECASE,
)

_DEADLINE_RE = re.compile(
    r"(avant\s+le\s+\S+|d['’]ici\s+(?:le\s+)?\S+|au\s+plus\s+tard\s+\S+|"
    r"date\s+limite\s*:?\s*\S+|[ée]ch[ée]ance\s*:?\s*\S+|avant\s+\S+\s+\d{1,2}h)",
    re.IGNORECASE,
)

_REPLY_NEEDED_RE = re.compile(
    r"\?|merci\s+de\s+(?:confirmer|r[ée]pondre|me\s+faire\s+savoir)|"
    r"pourriez[- ]vous|pouvez[- ]vous|merci\s+de\s+me\s+(?:dire|confirmer)|"
    r"dans\s+l['’]attente\s+de\s+votre\s+retour|rsvp|confirmer\s+votre\s+pr[ée]sence|"
    r"qu['’]en\s+pensez[- ]vous|[êe]tes[- ]vous\s+disponible",
    re.IGNORECASE,
)

_ACTION_RE = re.compile(
    r"\b(merci\s+de|veuillez|action\s+requise|à\s+traiter|reste\s+à\s+faire|"
    r"pri[èe]re\s+de|il\s+faut\s+que\s+vous|vous\s+devez)\b",
    re.IGNORECASE,
)

_AUTOMATED_SENDER_RE = re.compile(
    r"no[-_.]?reply|noreply|ne[-_.]?pas[-_.]?r[ée]pondre|newsletter|notification[s]?@|"
    r"marketing@|info@|contact@|hello@|news@|updates?@|do[-_.]?not[-_.]?reply",
    re.IGNORECASE,
)

_NEWSLETTER_SUBJECT_RE = re.compile(
    r"newsletter|se\s+d[ée]sabonner|unsubscribe|promo(?:tion)?s?\b|offre\s+sp[ée]ciale|"
    r"code\s+promo|soldes?\b",
    re.IGNORECASE,
)


def _norm_sender(value: str) -> str:
    return (value or "").strip().lower()


def _sender_domain(email: str) -> str:
    email = _norm_sender(email)
    return email.split("@", 1)[1] if "@" in email else email


def _lookup_rule(rules: dict, email: str) -> str:
    """Cherche une règle exacte sur l'adresse, sinon sur le domaine."""
    if not rules:
        return ""
    email = _norm_sender(email)
    if email in rules:
        return rules[email]
    domain = _sender_domain(email)
    return rules.get(domain, "") or rules.get("@" + domain, "")


def classify_email(mail: dict, prefs: dict | None = None) -> dict:
    """Classe un mail (dict issu de ms_recent_mail : sujet, de, de_email, apercu, importance)
    selon les préférences fournies (vip_senders/blocked_senders/learned_overrides, en
    minuscules, adresse complète ou domaine seul). Renvoie categorie/raison/action_attendue/
    echeance/necessite_reponse — jamais lève d'exception (préférences absentes = neutre)."""
    prefs = prefs or {}
    sender_email = _norm_sender(mail.get("de_email") or mail.get("de") or "")
    subject = str(mail.get("sujet") or "")
    preview = str(mail.get("apercu") or "")
    text = f"{subject} {preview}"
    graph_importance = str(mail.get("importance") or "").lower()

    sender_rules = prefs.get("sender_rules") or {}
    rule = _lookup_rule(sender_rules, sender_email)

    deadline_match = _DEADLINE_RE.search(text)
    echeance = deadline_match.group(0).strip() if deadline_match else None
    needs_reply = bool(_REPLY_NEEDED_RE.search(text))
    needs_action = bool(_ACTION_RE.search(text))
    is_urgent = bool(_URGENT_RE.search(text)) or graph_importance == "high"
    is_automated = bool(_AUTOMATED_SENDER_RE.search(sender_email)) or bool(_NEWSLETTER_SUBJECT_RE.search(subject))

    # 1. Expéditeur explicitement bloqué : toujours faible priorité, même si urgent en apparence.
    if rule == "indesirable":
        return _result("Faible priorité", "Expéditeur classé indésirable", needs_reply, needs_action, echeance)

    # 2. Urgence / sécurité : prioritaire sur tout le reste (sauf blocage explicite ci-dessus).
    if is_urgent:
        raison = "Mot-clé d'urgence ou de sécurité détecté" if _URGENT_RE.search(text) else "Marqué important par Microsoft Outlook"
        return _result("Critique", raison, needs_reply, needs_action, echeance)

    # 3. Expéditeur VIP explicite : au moins Important.
    if rule == "vip":
        raison = "Expéditeur VIP" + (" — réponse attendue" if needs_reply else "")
        return _result("Important", raison, needs_reply, needs_action, echeance)

    # 4. Correction apprise (non explicite) pour cet expéditeur.
    learned = _lookup_rule(prefs.get("learned_overrides") or {}, sender_email)
    if learned in CATEGORIES:
        return _result(learned, "Catégorie apprise de vos reclassements précédents", needs_reply, needs_action, echeance)

    # 5. Expéditeur "prioritaire" (explicite, moins fort que VIP).
    if rule == "prioritaire" and (needs_reply or needs_action):
        return _result("Important" if needs_reply else "À traiter",
                        "Expéditeur prioritaire", needs_reply, needs_action, echeance)

    # 6. Réponse manifestement attendue.
    if needs_reply:
        return _result("Important", "Une réponse semble attendue", needs_reply, needs_action, echeance)

    # 7. Action nécessaire, sans réponse attendue.
    if needs_action:
        return _result("À traiter", "Une action est demandée dans le message", needs_reply, needs_action, echeance)

    # 8. Expéditeur automatisé / newsletter.
    if is_automated or rule == "normal" and not text.strip():
        return _result("Faible priorité", "Newsletter ou message automatisé", needs_reply, needs_action, echeance)

    # 9. Par défaut : simple lecture.
    return _result("À lire", "Information sans action requise identifiée", needs_reply, needs_action, echeance)


def _result(categorie: str, raison: str, needs_reply: bool, needs_action: bool, echeance) -> dict:
    if needs_reply:
        action = "Réponse attendue"
    elif needs_action:
        action = "Action à effectuer"
    else:
        action = "Aucune action requise"
    return {
        "categorie": categorie,
        "raison": raison,
        "action_attendue": action,
        "echeance": echeance,
        "necessite_reponse": needs_reply,
    }


def group_by_priority(classified_mails: list) -> dict:
    """Regroupe une liste de mails déjà classés (chaque item = mail + résultat de
    classify_email fusionné) selon l'ordre imposé par la commande "Mes e-mails" :
    urgences, réponses attendues, actions à faire, importants à lire, puis le reste
    par catégorie."""
    urgences = [m for m in classified_mails if m["categorie"] == "Critique"]
    reponses_attendues = [m for m in classified_mails if m["categorie"] != "Critique" and m.get("necessite_reponse")]
    actions = [m for m in classified_mails
               if m["categorie"] == "À traiter" and not m.get("necessite_reponse")]
    a_lire = [m for m in classified_mails
              if m["categorie"] == "À lire"
              and m not in reponses_attendues and m not in actions]
    reste = [m for m in classified_mails if m["categorie"] == "Faible priorité"]
    return {
        "urgences": urgences,
        "reponses_attendues": reponses_attendues,
        "actions": actions,
        "a_lire": a_lire,
        "reste": reste,
    }

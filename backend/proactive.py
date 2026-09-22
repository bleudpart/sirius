"""Moteur de proactivité ΣIRIUS : suggestions issues de la mémoire réelle.

Sources (toutes locales, aucun appel réseau) :
- les PROJETS appris (facts categorie « projet », récents ou renforcés) ;
- le dernier ÉPISODE condensé (< 48 h) pour reprendre une conversation ;
- les HABITUDES horaires (événements récurrents à la même heure) ;
- le BRIEFING du matin s'il n'a pas encore été demandé aujourd'hui.

Chaque suggestion est traçable (« pourquoi ? »), snoozable (« plus tard »)
et suppressible définitivement (« ne plus proposer »).
"""

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

from local_memory import _conn, _local_datetime

MODES = ("proactif",)
_MODE_LIMITS = {"proactif": 4}
_SNOOZE_HOURS = 4
_PROJECT_WINDOW_DAYS = 21
_EPISODE_WINDOW_HOURS = 48
_HABIT_MIN_OCCURRENCES = 3
_WORK_LOG_WINDOW_DAYS = 7


def init_proactive_db():
    with _conn() as con:
        con.execute(
            "CREATE TABLE IF NOT EXISTS proactive_prefs ("
            "user_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'equilibre')"
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS proactive_mute ("
            "user_id TEXT NOT NULL, kind TEXT NOT NULL, until TEXT, "
            "PRIMARY KEY (user_id, kind))"
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS proactive_items ("
            "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, "
            "title TEXT, description TEXT, urgency TEXT, risk_level TEXT, "
            "reason TEXT, benefit TEXT, confidence REAL, action_json TEXT, created_at TEXT)"
        )


init_proactive_db()


def get_mode(user_id: str) -> str:
    return "proactif"


def set_mode(user_id: str, mode: str) -> str:
    mode = "proactif"
    with _conn() as con:
        con.execute(
            "INSERT OR REPLACE INTO proactive_prefs (user_id, mode) VALUES (?, ?)",
            (user_id, mode),
        )
    return mode


def _suggestion_id(user_id: str, kind: str) -> str:
    return hashlib.sha1(f"{user_id}|{kind}".encode("utf-8")).hexdigest()[:16]


def _muted_kinds(user_id: str, now) -> set:
    with _conn() as con:
        rows = con.execute(
            "SELECT kind, until FROM proactive_mute WHERE user_id = ?", (user_id,)
        ).fetchall()
    muted = set()
    for row in rows:
        if row["until"] is None or row["until"] > now.isoformat():
            muted.add(row["kind"])
    return muted


def _candidates(user_id: str, now) -> list:
    """Génère les suggestions candidates depuis la mémoire locale."""
    local_now = now.astimezone()
    items = []

    with _conn() as con:
        facts = [dict(r) for r in con.execute(
            "SELECT * FROM facts WHERE user_id = ? AND category = 'projet' "
            "ORDER BY COALESCE(use_count, 0) DESC, created_at DESC LIMIT 10", (user_id,)
        ).fetchall()]
        episodes = [dict(r) for r in con.execute(
            "SELECT * FROM episodes WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", (user_id,)
        ).fetchall()]
        work_items = [dict(r) for r in con.execute(
            "SELECT * FROM work_log WHERE user_id = ? ORDER BY started_at DESC LIMIT 3", (user_id,)
        ).fetchall()]
        habit_rows = [dict(r) for r in con.execute(
            "SELECT intent, hour, COUNT(*) AS n FROM events "
            "WHERE user_id = ? AND intent <> '' AND hour IS NOT NULL "
            "GROUP BY intent, hour HAVING n >= ?", (user_id, _HABIT_MIN_OCCURRENCES)
        ).fetchall()]
        briefing_today = con.execute(
            "SELECT 1 FROM events WHERE user_id = ? AND intent = 'daily_briefing' "
            "AND created_at >= ? LIMIT 1",
            (user_id, local_now.replace(hour=0, minute=0, second=0).astimezone(timezone.utc).isoformat()),
        ).fetchone()

    # 1) Briefing du matin (6 h – 10 h, pas encore demandé aujourd'hui)
    if 6 <= local_now.hour <= 10 and not briefing_today:
        items.append({
            "kind": "briefing",
            "title": "Briefing du jour",
            "description": "Ton briefing du matin n'a pas encore été lancé : météo, marchés, actus et ta journée.",
            "urgency": "moyenne",
            "reason": "Il est entre 6 h et 10 h et le briefing quotidien n'a pas été demandé aujourd'hui.",
            "benefit": "Démarrer la journée avec l'essentiel en 2 minutes, sans rien chercher.",
            "confidence": 0.8,
            "action": {"type": "command", "text": "briefing du jour"},
        })

    # 2) Projets actifs (récents ou renforcés)
    cutoff = now - timedelta(days=_PROJECT_WINDOW_DAYS)
    for fact in facts[:2]:
        created = _local_datetime(fact.get("created_at") or "")
        fresh = created and created >= cutoff.astimezone().replace(tzinfo=None)
        reinforced = int(fact.get("use_count") or 0) >= 2
        if not (fresh or reinforced):
            continue
        items.append({
            "kind": f"projet:{fact['id']}",
            "title": "Point projet",
            "description": f"Faire le point sur : {fact['text']}",
            "urgency": "moyenne" if reinforced else "faible",
            "reason": f"Projet en mémoire ({'évoqué plusieurs fois' if reinforced else 'appris récemment'}) : « {fact['text']} ».",
            "benefit": "Garder le projet sur les rails sans avoir à y penser.",
            "confidence": 0.7 if reinforced else 0.55,
            "action": {"type": "command", "text": f"Où en est-on : {fact['text']} ? Aide-moi à avancer."},
        })

    # 3) Reprendre le dernier épisode (conversation récente condensée)
    for episode in episodes:
        created = _local_datetime(episode.get("created_at") or "")
        if not created:
            continue
        age_hours = (now.astimezone().replace(tzinfo=None) - created).total_seconds() / 3600.0
        if age_hours > _EPISODE_WINDOW_HOURS:
            continue
        extrait = (episode["summary"] or "")[:160]
        items.append({
            "kind": f"episode:{episode['id']}",
            "title": "Reprendre où on s'était arrêté",
            "description": f"Dernière session : {extrait}",
            "urgency": "faible",
            "reason": "Un épisode de conversation récent contient possiblement des suites à donner.",
            "benefit": "Aucune tâche évoquée ne tombe dans l'oubli.",
            "confidence": 0.6,
            "action": {"type": "command", "text": f"Reprenons notre dernière conversation : {extrait}"},
        })

    # 4) Intervention Sirius récente : aucune action engagée ne doit se perdre.
    work_cutoff = now - timedelta(days=_WORK_LOG_WINDOW_DAYS)
    for work_item in work_items:
        started = _local_datetime(work_item.get("started_at") or "")
        if not started or started < work_cutoff.astimezone().replace(tzinfo=None):
            continue
        project = work_item.get("project") or ""
        subject = project or work_item.get("title") or "intervention récente"
        items.append({
            "kind": f"intervention:{work_item['id']}",
            "title": "Suivi d'intervention",
            "description": f"Reprendre : {subject}",
            "urgency": "moyenne" if work_item.get("status") == "running" else "faible",
            "reason": f"ΣIRIUS a {'démarré' if work_item.get('status') == 'running' else 'terminé'} cette intervention récemment : « {work_item.get('title')} ».",
            "benefit": "Conserver le fil du travail engagé et identifier la prochaine action utile.",
            "confidence": 0.75 if work_item.get("status") == "running" else 0.6,
            "action": {"type": "command", "text": f"Fais le point et reprends : {subject}."},
        })
        break

    # 5) Habitude horaire : même intention, même heure (±1 h), au moins 3 fois
    habit_best = None
    for row in habit_rows:
        if abs(int(row["hour"]) - local_now.hour) <= 1:
            if habit_best is None or row["n"] > habit_best["n"]:
                habit_best = row
    if habit_best and habit_best["intent"] != "daily_briefing":
        intent = habit_best["intent"]
        items.append({
            "kind": f"habitude:{intent}",
            "title": "Ton rituel de cette heure-ci",
            "description": f"À cette heure, tu demandes souvent « {intent} » ({habit_best['n']} fois). Je lance ?",
            "urgency": "faible",
            "reason": f"L'intention « {intent} » revient {habit_best['n']} fois autour de {habit_best['hour']} h.",
            "benefit": "ΣIRIUS anticipe ton rituel au lieu d'attendre la commande.",
            "confidence": min(0.9, 0.4 + habit_best["n"] * 0.1),
            "action": {"type": "command", "text": intent},
        })

    return items


_URGENCY_ORDER = {"haute": 0, "moyenne": 1, "faible": 2}


def _intervention(item: dict) -> dict:
    """Décide comment Sirius peut prendre en charge une suggestion sans agir à l'aveugle."""
    kind = item["kind"].split(":", 1)[0]
    if kind == "briefing":
        return {
            "decision": "agir",
            "message": "Je peux lancer ton briefing et te donner les priorités utiles pour la journée.",
            "alternative": "Sinon, je peux isoler uniquement les alertes, l'agenda ou les e-mails importants.",
        }
    if kind == "projet":
        return {
            "decision": "agir",
            "message": "Je peux faire le point, clarifier les prochaines actions et préparer ce qui manque.",
            "alternative": "Si tu préfères, je peux commencer par le blocage ou l'échéance la plus proche.",
        }
    if kind == "intervention":
        return {
            "decision": "agir",
            "message": "Je peux reprendre cette intervention, vérifier ce qui reste à faire et préparer la prochaine action.",
            "alternative": "Je peux aussi commencer par un résumé court de ce qui a déjà été fait.",
        }
    if kind == "episode":
        return {
            "decision": "reprendre",
            "message": "Je peux reprendre ce dossier là où nous nous étions arrêtés et remettre les priorités à plat.",
            "alternative": "Je peux aussi préparer un résumé court avant de reprendre l'action.",
        }
    return {
        "decision": "proposer",
        "message": "J'ai repéré cette habitude. Je peux m'en occuper maintenant si c'est le bon moment.",
        "alternative": "Sinon, je la garde en attente et je te la reproposerai seulement quand elle redevient pertinente.",
    }


def evaluate(user_id: str, now=None) -> dict:
    """Évalue et retourne les suggestions actives pour l'utilisateur."""
    now = now or datetime.now(timezone.utc)
    mode = get_mode(user_id)
    muted = _muted_kinds(user_id, now)

    candidates = [c for c in _candidates(user_id, now) if c["kind"] not in muted]
    candidates.sort(key=lambda c: (_URGENCY_ORDER.get(c["urgency"], 3), -c["confidence"]))
    selected = candidates[: _MODE_LIMITS[mode]]

    suggestions = []
    stamp = now.isoformat()
    with _conn() as con:
        for c in selected:
            sid = _suggestion_id(user_id, c["kind"])
            intervention = _intervention(c)
            con.execute(
                "INSERT OR REPLACE INTO proactive_items "
                "(id, user_id, kind, title, description, urgency, risk_level, reason, benefit, confidence, action_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (sid, user_id, c["kind"], c["title"], c["description"], c["urgency"], "faible",
                 c["reason"], c["benefit"], c["confidence"], json.dumps(c["action"], ensure_ascii=False), stamp),
            )
            suggestions.append({
                "id": sid,
                "title": c["title"],
                "description": c["description"],
                "urgency": c["urgency"],
                "risk_level": "faible",
                "reason": c["reason"],
                "benefit": c["benefit"],
                "confidence": c["confidence"],
                "source": c["kind"].split(":", 1)[0],
                "decision": intervention["decision"],
                "intervention": intervention["message"],
                "alternative": intervention["alternative"],
            })

    return {"settings": {"mode": mode}, "suggestions": suggestions}


def _get_item(user_id: str, suggestion_id: str):
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM proactive_items WHERE id = ? AND user_id = ?",
            (suggestion_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def suggestion_action(user_id: str, suggestion_id: str, action: str, now=None) -> dict:
    """Applique une action du panneau : executer, preparer, plus_tard, ne_plus_proposer."""
    now = now or datetime.now(timezone.utc)
    item = _get_item(user_id, suggestion_id)
    if not item:
        return {"ok": True, "mode": "noop", "message": "Suggestion expirée."}

    if action in ("plus_tard", "ne_plus_proposer"):
        until = None if action == "ne_plus_proposer" else (now + timedelta(hours=_SNOOZE_HOURS)).isoformat()
        with _conn() as con:
            con.execute(
                "INSERT OR REPLACE INTO proactive_mute (user_id, kind, until) VALUES (?, ?, ?)",
                (user_id, item["kind"], until),
            )
        return {"ok": True, "muted": True, "until": until}

    proposed = json.loads(item.get("action_json") or "{}")
    if action == "executer":
        return {"ok": True, "executed": True, "proposed_action": proposed}
    if action == "preparer":
        return {"ok": True, "prepared": True, "proposed_action": proposed}
    return {"ok": True, "mode": "noop", "message": "Action inconnue."}


def suggestion_why(user_id: str, suggestion_id: str) -> dict:
    item = _get_item(user_id, suggestion_id)
    if not item:
        return {"reason": "Suggestion expirée.", "expected_benefit": "", "confidence": 0.0}
    return {
        "reason": item.get("reason") or "",
        "expected_benefit": item.get("benefit") or "",
        "confidence": float(item.get("confidence") or 0.0),
    }

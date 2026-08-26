"""Moteur de proactivité SIRIUS : suggestions issues de la mémoire réelle.

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

MODES = ("discret", "equilibre", "proactif")
_MODE_LIMITS = {"discret": 1, "equilibre": 2, "proactif": 4}
_SNOOZE_HOURS = 4
_PROJECT_WINDOW_DAYS = 21
_EPISODE_WINDOW_HOURS = 48
_HABIT_MIN_OCCURRENCES = 3


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
    with _conn() as con:
        row = con.execute(
            "SELECT mode FROM proactive_prefs WHERE user_id = ?", (user_id,)
        ).fetchone()
    return row["mode"] if row and row["mode"] in MODES else "equilibre"


def set_mode(user_id: str, mode: str) -> str:
    if mode not in MODES:
        mode = "equilibre"
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

    # 4) Habitude horaire : même intention, même heure (±1 h), au moins 3 fois
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
            "benefit": "SIRIUS anticipe ton rituel au lieu d'attendre la commande.",
            "confidence": min(0.9, 0.4 + habit_best["n"] * 0.1),
            "action": {"type": "command", "text": intent},
        })

    return items


_URGENCY_ORDER = {"haute": 0, "moyenne": 1, "faible": 2}


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

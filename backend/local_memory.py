# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Mémoire locale persistante de SIRIUS (SQLite) : préférences, projets, souvenirs."""
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "sirius_local.db"
CATEGORIES = ("preference", "projet", "souvenir")


def _conn():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def _local_datetime(timestamp: str):
    """Convert stored timestamps to the PC's local date and time for SIRIUS PRIME."""
    if not timestamp:
        return None
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone().replace(tzinfo=None) if parsed.tzinfo else parsed


def init_local_db():
    with _conn() as con:
        con.execute(
            "CREATE TABLE IF NOT EXISTS facts ("
            "id TEXT PRIMARY KEY, category TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            "id TEXT PRIMARY KEY, text TEXT NOT NULL, intent TEXT, hour INTEGER, weekday INTEGER, created_at TEXT NOT NULL)"
        )
        for table in ("facts", "events"):
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
            if "user_id" not in cols:
                con.execute(f"ALTER TABLE {table} ADD COLUMN user_id TEXT DEFAULT 'legacy'")


def delete_user_data(user_id: str):
    """Efface toutes les données SQLite d'un utilisateur (suppression de compte)."""
    with _conn() as con:
        con.execute("DELETE FROM facts WHERE user_id = ?", (user_id,))
        con.execute("DELETE FROM events WHERE user_id = ?", (user_id,))
        media_events_exists = con.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_events'"
        ).fetchone()
        if media_events_exists:
            con.execute("DELETE FROM media_events WHERE user_id = ?", (user_id,))
        for table in ("productivity_notes", "productivity_tasks", "productivity_reports"):
            table_exists = con.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                (table,),
            ).fetchone()
            if table_exists:
                con.execute(f"DELETE FROM {table} WHERE user_id = ?", (user_id,))


def migrate_legacy_to_user(user_id: str):
    """Rattache toutes les données 'legacy' au premier compte créé."""
    with _conn() as con:
        con.execute("UPDATE facts SET user_id = ? WHERE user_id = 'legacy' OR user_id IS NULL", (user_id,))
        con.execute("UPDATE events SET user_id = ? WHERE user_id = 'legacy' OR user_id IS NULL", (user_id,))


def log_event(text: str, intent: str = "", user_id: str = "legacy"):
    text = (text or "").strip()[:200]
    if not text:
        return None
    now = datetime.now(timezone.utc)
    now_local = now.astimezone()
    with _conn() as con:
        con.execute(
            "INSERT INTO events (id, text, intent, hour, weekday, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), text, (intent or "")[:40], now_local.hour, now_local.weekday(), now.isoformat(), user_id),
        )
    return True


def update_fact(fact_id: str, text: str, user_id: str = None) -> bool:
    text = (text or "").strip()[:300]
    if not text:
        return False
    with _conn() as con:
        if user_id:
            cur = con.execute("UPDATE facts SET text = ? WHERE id = ? AND user_id = ?", (text, fact_id, user_id))
        else:
            cur = con.execute("UPDATE facts SET text = ? WHERE id = ?", (text, fact_id))
    return cur.rowcount > 0


INTENT_SUGGESTIONS = {
    "météo": "Vous consultez souvent la météo — voulez-vous un point météo automatique à votre première connexion ?",
    "musique": "Vous lancez régulièrement de la musique — je peux préparer votre ambiance habituelle dès l'ouverture.",
    "heure": "Vous demandez souvent l'heure — je peux l'annoncer à chaque réveil de l'interface.",
    "système": "Vous surveillez le système — je peux vous alerter si le CPU dépasse 85 %.",
    "cortex": "Vous aimez explorer le cortex — je peux afficher un résumé neural quotidien.",
    "conversation IA": "Nos conversations sont fréquentes — pensez à enrichir ma mémoire locale avec vos projets en cours.",
}


def prime_overview():
    """Synthèse apprentissage : journal du jour, habitudes, score de confiance, suggestions."""
    today = datetime.now().date()
    with _conn() as con:
        events = [dict(r) for r in con.execute(
            "SELECT * FROM events ORDER BY created_at DESC LIMIT 400").fetchall()]
        facts = [dict(r) for r in con.execute(
            "SELECT * FROM facts ORDER BY created_at DESC LIMIT 100").fetchall()]

    dated_events = [(e, _local_datetime(e["created_at"])) for e in events]
    dated_facts = [(f, _local_datetime(f["created_at"])) for f in facts]
    today_events = [(e, timestamp) for e, timestamp in dated_events if timestamp and timestamp.date() == today]
    today_facts = [(f, timestamp) for f, timestamp in dated_facts if timestamp and timestamp.date() == today]

    journal = (
        [{"time": timestamp.strftime("%H:%M"), "text": f"Souvenir appris : {f['text']}", "kind": "fact"}
         for f, timestamp in today_facts]
        + [{"time": timestamp.strftime("%H:%M"), "text": f"Commande « {e['text']} » ({e['intent'] or 'libre'})", "kind": "event"}
            for e, timestamp in today_events[:25]]
    )
    journal.sort(key=lambda j: j["time"], reverse=True)

    hours = [0] * 24
    weekdays = [0] * 7
    intents = {}
    for e, timestamp in dated_events:
        if timestamp:
            hours[timestamp.hour] += 1
            weekdays[timestamp.weekday()] += 1
        else:
            if e["hour"] is not None:
                hours[int(e["hour"])] += 1
            if e["weekday"] is not None:
                weekdays[int(e["weekday"])] += 1
        key = e["intent"] or "libre"
        intents[key] = intents.get(key, 0) + 1

    distinct_days = len({timestamp.date() for _, timestamp in dated_events if timestamp})
    confidence = min(97, 18 + distinct_days * 6 + len(facts) * 3 + len(events) // 4)

    top_intents = sorted(intents.items(), key=lambda kv: -kv[1])
    suggestions = [INTENT_SUGGESTIONS[k] for k, _ in top_intents if k in INTENT_SUGGESTIONS][:3]
    if len(suggestions) < 3 and facts:
        suggestions.append(f"Je me souviens : « {facts[0]['text']} » — voulez-vous que j'en tienne compte plus souvent ?")
    while len(suggestions) < 3:
        suggestions.append([
            "Dites « souviens-toi que... » pour enrichir ma mémoire et affiner mes suggestions.",
            "Ajoutez vos projets dans la base locale : je pourrai les suivre entre les sessions.",
            "Plus nous échangeons, plus mes suggestions deviennent précises.",
        ][len(suggestions)])

    return {
        "journal": journal[:30],
        "habits": {"hours": hours, "weekdays": weekdays,
                   "intents": [{"name": k, "count": v} for k, v in top_intents[:6]]},
        "memories": facts,
        "confidence": confidence,
        "suggestions": suggestions[:3],
        "totals": {"events": len(events), "facts": len(facts), "days": distinct_days},
    }


def list_facts(category=None, user_id: str = "legacy"):
    with _conn() as con:
        if category in CATEGORIES:
            rows = con.execute(
                "SELECT * FROM facts WHERE category = ? AND user_id = ? ORDER BY created_at DESC LIMIT 100",
                (category, user_id),
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM facts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", (user_id,)
            ).fetchall()
    return [dict(r) for r in rows]


def add_fact(category: str, text: str, user_id: str = "legacy"):
    text = (text or "").strip()
    if not text:
        return None
    if category not in CATEGORIES:
        category = "souvenir"
    with _conn() as con:
        dup = con.execute(
            "SELECT id FROM facts WHERE lower(text) = lower(?) AND user_id = ? LIMIT 1", (text, user_id)
        ).fetchone()
        if dup:
            return None
        fact = {
            "id": str(uuid.uuid4()),
            "category": category,
            "text": text[:300],
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        con.execute(
            "INSERT INTO facts (id, category, text, created_at, user_id) VALUES (?, ?, ?, ?, ?)",
            (fact["id"], fact["category"], fact["text"], fact["created_at"], user_id),
        )
    return fact


def delete_fact(fact_id: str, user_id: str = None) -> bool:
    with _conn() as con:
        if user_id:
            cur = con.execute("DELETE FROM facts WHERE id = ? AND user_id = ?", (fact_id, user_id))
        else:
            cur = con.execute("DELETE FROM facts WHERE id = ?", (fact_id,))
    return cur.rowcount > 0


init_local_db()


def log_service(service: str, action: str, status: str):
    with _conn() as con:
        con.execute(
            "CREATE TABLE IF NOT EXISTS service_log ("
            "id TEXT PRIMARY KEY, service TEXT, action TEXT, status TEXT, created_at TEXT)"
        )
        con.execute(
            "INSERT INTO service_log (id, service, action, status, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), service[:40], action[:120], status[:20],
             datetime.now(timezone.utc).isoformat()),
        )


def list_service_log(limit: int = 25):
    with _conn() as con:
        con.execute(
            "CREATE TABLE IF NOT EXISTS service_log ("
            "id TEXT PRIMARY KEY, service TEXT, action TEXT, status TEXT, created_at TEXT)"
        )
        rows = con.execute(
            "SELECT * FROM service_log ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]

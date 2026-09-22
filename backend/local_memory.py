# © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Mémoire locale persistante de ΣIRIUS (SQLite) : préférences, projets, souvenirs."""
import os
import re
import sqlite3
import time
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from runtime_paths import data_file

DB_PATH = data_file("sirius_local.db")
CATEGORIES = ("preference", "projet", "souvenir")
try:
    TEMPORARY_MEMORY_TTL_DAYS = max(0, int(os.getenv("SIRIUS_TEMP_MEMORY_TTL_DAYS", "3")))
except ValueError:
    TEMPORARY_MEMORY_TTL_DAYS = 3
_EXPIRY_INTERVAL_SECONDS = 3600.0
_last_expiry_by_user = {}


def _conn():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def _local_datetime(timestamp: str):
    """Convert stored timestamps to the PC's local date and time for ΣIRIUS PRIME."""
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
        # Renforcement : chaque rappel d'un fait augmente sa priorité future.
        fact_cols = [r[1] for r in con.execute("PRAGMA table_info(facts)").fetchall()]
        if "use_count" not in fact_cols:
            con.execute("ALTER TABLE facts ADD COLUMN use_count INTEGER DEFAULT 0")
        if "last_used" not in fact_cols:
            con.execute("ALTER TABLE facts ADD COLUMN last_used TEXT")
        # Mémoire épisodique : résumés de conversations condensés par le LLM.
        con.execute(
            "CREATE TABLE IF NOT EXISTS episodes ("
            "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, "
            "summary TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS work_log ("
            "id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, "
            "project TEXT NOT NULL DEFAULT '', task_type TEXT NOT NULL DEFAULT '', "
            "status TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', date_key TEXT NOT NULL, "
            "started_at TEXT NOT NULL, completed_at TEXT)"
        )
        # Rappel sémantique : vecteurs d'embedding mis en cache localement.
        con.execute(
            "CREATE TABLE IF NOT EXISTS fact_vectors ("
            "fact_id TEXT PRIMARY KEY, model TEXT NOT NULL, vector TEXT NOT NULL)"
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_facts_user_category_activity "
            "ON facts(user_id, category, last_used, created_at)"
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_work_log_user_date_project "
            "ON work_log(user_id, date_key, project, started_at)"
        )


def expire_stale_temporary_memory(user_id: str | None = "legacy", force: bool = False) -> int:
    """Efface les souvenirs temporaires non consultés depuis 3 jours, sans bloquer le chat."""
    if TEMPORARY_MEMORY_TTL_DAYS <= 0:
        return 0
    key = user_id or "__all__"
    now_mono = time.monotonic()
    if not force and now_mono - _last_expiry_by_user.get(key, 0.0) < _EXPIRY_INTERVAL_SECONDS:
        return 0
    _last_expiry_by_user[key] = now_mono

    cutoff = (datetime.now(timezone.utc) - timedelta(days=TEMPORARY_MEMORY_TTL_DAYS)).isoformat()
    params = [cutoff]
    user_clause = ""
    if user_id:
        user_clause = "AND user_id = ?"
        params.append(user_id)
    with _conn() as con:
        rows = con.execute(
            "SELECT id FROM facts "
            "WHERE category = 'souvenir' "
            "AND COALESCE(last_used, created_at) < ? "
            f"{user_clause} ORDER BY COALESCE(last_used, created_at) ASC LIMIT 200",
            tuple(params),
        ).fetchall()
        ids = [row["id"] for row in rows]
        if not ids:
            return 0
        placeholders = ",".join("?" for _ in ids)
        con.execute(f"DELETE FROM fact_vectors WHERE fact_id IN ({placeholders})", ids)
        con.execute(f"DELETE FROM facts WHERE id IN ({placeholders})", ids)
    return len(ids)


def delete_user_data(user_id: str):
    """Efface toutes les données SQLite d'un utilisateur (suppression de compte)."""
    with _conn() as con:
        con.execute(
            "DELETE FROM fact_vectors WHERE fact_id IN (SELECT id FROM facts WHERE user_id = ?)",
            (user_id,),
        )
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
        con.execute("DELETE FROM work_log WHERE user_id = ?", (user_id,))


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


def log_work_intervention(
    title: str,
    task_type: str = "",
    project: str = "",
    status: str = "running",
    result: str = "",
    user_id: str = "legacy",
    entry_id: str | None = None,
):
    """Enregistre une intervention Sirius durablement, avec sa date locale."""
    title = (title or "").strip()[:300]
    if not title:
        return None
    now = datetime.now(timezone.utc)
    entry = {
        "id": (entry_id or str(uuid.uuid4())).strip()[:120],
        "user_id": user_id,
        "title": title,
        "project": (project or "").strip()[:160],
        "task_type": (task_type or "").strip()[:80],
        "status": (status or "running").strip()[:40],
        "result": (result or "").strip()[:1200],
        "date_key": now.astimezone().date().isoformat(),
        "started_at": now.isoformat(),
        "completed_at": None,
    }
    with _conn() as con:
        con.execute(
            "INSERT OR IGNORE INTO work_log (id, user_id, title, project, task_type, status, result, date_key, started_at, completed_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            tuple(entry.values()),
        )
        persisted = con.execute(
            "SELECT * FROM work_log WHERE id = ? AND user_id = ?", (entry["id"], user_id)
        ).fetchone()
    return dict(persisted) if persisted else None


def update_work_intervention(entry_id: str, status: str, result: str = "", user_id: str = "legacy") -> bool:
    """Clôture ou met à jour une intervention appartenant à son utilisateur."""
    status = (status or "").strip()[:40]
    if not entry_id or not status:
        return False
    completed_at = datetime.now(timezone.utc).isoformat() if status in {"done", "error", "cancelled"} else None
    with _conn() as con:
        cur = con.execute(
            "UPDATE work_log SET status = ?, result = ?, completed_at = COALESCE(?, completed_at) "
            "WHERE id = ? AND user_id = ?",
            (status, (result or "").strip()[:1200], completed_at, entry_id, user_id),
        )
    return cur.rowcount > 0


def list_work_interventions(
    user_id: str = "legacy", date_key: str = "", project: str = "", limit: int = 100
):
    """Retourne l'historique, filtrable par date locale et par projet."""
    limit = max(1, min(int(limit), 500))
    clauses = ["user_id = ?"]
    params = [user_id]
    if date_key:
        clauses.append("date_key = ?")
        params.append(date_key)
    if project:
        clauses.append("lower(project) LIKE ?")
        params.append(f"%{project.strip().lower()}%")
    with _conn() as con:
        rows = con.execute(
            f"SELECT * FROM work_log WHERE {' AND '.join(clauses)} ORDER BY started_at DESC LIMIT ?",
            (*params, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def update_fact(fact_id: str, text: str, user_id: str = None) -> bool:
    text = (text or "").strip()[:300]
    if not text:
        return False
    with _conn() as con:
        if user_id:
            cur = con.execute("UPDATE facts SET text = ? WHERE id = ? AND user_id = ?", (text, fact_id, user_id))
        else:
            cur = con.execute("UPDATE facts SET text = ? WHERE id = ?", (text, fact_id))
        if cur.rowcount > 0:
            # Le texte a changé : le vecteur en cache est périmé, il sera recalculé.
            con.execute("DELETE FROM fact_vectors WHERE fact_id = ?", (fact_id,))
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
    expire_stale_temporary_memory(user_id=None)
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
    expire_stale_temporary_memory(user_id=user_id)
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
        if cur.rowcount > 0:
            con.execute("DELETE FROM fact_vectors WHERE fact_id = ?", (fact_id,))
    return cur.rowcount > 0


# =========================================================
# APPRENTISSAGE RAPIDE : rappel par pertinence + renforcement
# =========================================================

_STOPWORDS = frozenset(
    "le la les un une des de du au aux et ou mais donc car ni or que qui quoi dont ce cette ces "
    "mon ton son mes tes ses notre votre leur nos vos leurs je tu il elle on nous vous ils elles "
    "me te se moi toi lui eux en dans par pour sur avec sans sous chez vers est sont suis es "
    "etre avoir fait faire plus tres bien tout tous toute toutes pas non oui the and for with".split()
)

# Rappel sémantique hors-ligne : mots ramenés à un concept commun (sans accents).
# « bistrot » et « restaurant » partagent le même concept, donc se retrouvent.
_SYN_CLUSTERS = (
    ("restaurant", ("restaurant", "resto", "bistrot", "bistro", "brasserie", "cantine", "pizzeria", "creperie", "snack", "gargote")),
    ("repas", ("repas", "dejeuner", "diner", "souper", "manger", "petit-dejeuner", "brunch", "gouter")),
    ("boisson", ("cafe", "the", "expresso", "capuccino", "cappuccino", "boisson", "infusion")),
    ("travail", ("travail", "boulot", "job", "bureau", "taf", "profession", "metier")),
    ("voiture", ("voiture", "auto", "automobile", "bagnole", "vehicule", "caisse")),
    ("maison", ("maison", "domicile", "appartement", "appart", "logement", "chez-moi", "foyer")),
    ("enfant", ("enfant", "fils", "fille", "gamin", "gamine", "petit", "petite", "gosse")),
    ("epouse", ("femme", "epouse", "epoux", "mari", "conjoint", "conjointe", "compagne", "compagnon")),
    ("musique", ("musique", "chanson", "morceau", "titre", "playlist", "album", "spotify")),
    ("film", ("film", "cinema", "serie", "documentaire", "video", "netflix")),
    ("sport", ("sport", "footing", "course", "jogging", "musculation", "gym", "velo", "natation")),
    ("sante", ("sante", "medecin", "docteur", "rendez-vous", "rdv", "pharmacie", "traitement")),
    ("courses", ("courses", "achats", "magasin", "supermarche", "shopping", "commande")),
    ("voyage", ("voyage", "vacances", "deplacement", "sejour", "week-end", "weekend", "trajet")),
    ("horaire", ("heure", "horaire", "ouverture", "fermeture", "ouvre", "ferme", "planning", "agenda")),
    ("hygiene", ("haccp", "hygiene", "sanitaire", "tracabilite", "temperature", "releve")),
    ("animal", ("chat", "chien", "animal", "chaton", "chiot", "matou")),
    ("anniversaire", ("anniversaire", "fete", "celebration")),
)
_SYN_INDEX = {}
for _concept, _words in _SYN_CLUSTERS:
    for _w in _words:
        _SYN_INDEX[_w] = _concept


def _tokens(text: str) -> set:
    """Découpe un texte en mots-clés normalisés, enrichis de leurs concepts sémantiques."""
    normalized = unicodedata.normalize("NFD", (text or "").lower())
    normalized = "".join(c for c in normalized if unicodedata.category(c) != "Mn")
    words = re.findall(r"[a-z0-9]{3,}", normalized)
    tokens = {w for w in words if w not in _STOPWORDS}
    concepts = {_SYN_INDEX[w] for w in tokens if w in _SYN_INDEX}
    return tokens | concepts


_CATEGORY_HINTS = (
    ("preference", ("j'aime", "je prefere", "je préfère", "je deteste", "je déteste",
                    "ma couleur", "mon plat", "favori", "favorite", "preference", "préférence")),
    ("projet", ("projet", "objectif", "je travaille sur", "je prépare", "je prepare",
                "je veux construire", "je developpe", "je développe", "deadline", "échéance")),
)


def classify_fact(text: str) -> str:
    """Devine la catégorie d'un fait libre : preference, projet, sinon souvenir."""
    lowered = (text or "").lower()
    explicit = lowered.split(":", 1)[0].strip()
    if explicit in CATEGORIES:
        return explicit
    for category, hints in _CATEGORY_HINTS:
        if any(h in lowered for h in hints):
            return category
    return "souvenir"


def learn_fact(text: str, user_id: str = "legacy"):
    """Apprentissage direct : classe puis enregistre un fait exprimé librement.

    Accepte aussi le format explicite « categorie: texte » produit par le LLM.
    """
    text = (text or "").strip()
    if not text:
        return None
    category = classify_fact(text)
    head, sep, tail = text.partition(":")
    if sep and head.strip().lower() in CATEGORIES and tail.strip():
        text = tail.strip()
    return add_fact(category, text, user_id=user_id)


def recall_facts(query: str, user_id: str = "legacy", limit: int = 8):
    """Rappelle les faits les plus pertinents pour la requête, avec renforcement.

    Score = recouvrement de mots-clés (dominant) + fraîcheur + fréquence d'usage.
    Les faits rappelés voient leur use_count/last_used mis à jour : plus un fait
    sert, plus il remonte vite — c'est le mécanisme d'apprentissage par renforcement.
    Sans recouvrement, renvoie les faits les plus récents (comportement antérieur).
    """
    expire_stale_temporary_memory(user_id=user_id)
    query_tokens = _tokens(query)
    now = datetime.now(timezone.utc)
    with _conn() as con:
        rows = [dict(r) for r in con.execute(
            "SELECT * FROM facts WHERE user_id = ? ORDER BY created_at DESC LIMIT 400", (user_id,)
        ).fetchall()]

    scored = []
    for fact in rows:
        fact_tokens = _tokens(fact["text"])
        overlap = len(query_tokens & fact_tokens)
        score = float(overlap) * 3.0
        created = _local_datetime(fact.get("created_at") or "")
        if created:
            age_days = max(0.0, (now.replace(tzinfo=None) - created).total_seconds() / 86400.0)
            score += max(0.0, 1.5 - age_days / 30.0)  # bonus fraîcheur (30 jours)
        score += min(int(fact.get("use_count") or 0), 5) * 0.4  # bonus renforcement
        if fact.get("category") == "preference":
            score += 0.3  # les préférences guident les réponses : léger avantage
        scored.append((score, overlap, fact))

    relevant = [item for item in scored if item[1] > 0]
    pool = relevant if relevant else scored
    pool.sort(key=lambda item: -item[0])
    selected = [fact for _, _, fact in pool[:limit]]

    if relevant and selected:
        stamp = now.isoformat()
        with _conn() as con:
            con.executemany(
                "UPDATE facts SET use_count = COALESCE(use_count, 0) + 1, last_used = ? WHERE id = ?",
                [(stamp, fact["id"]) for fact in selected],
            )
    return selected


# =========================================================
# MÉMOIRE ÉPISODIQUE : résumés de conversations passées
# =========================================================

def add_episode(user_id: str, summary: str, session_id: str = ""):
    """Enregistre un épisode (résumé condensé d'une conversation)."""
    summary = (summary or "").strip()[:1200]
    if not summary:
        return None
    episode = {
        "id": str(uuid.uuid4()),
        "user_id": user_id,
        "session_id": session_id or "",
        "summary": summary,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with _conn() as con:
        con.execute(
            "INSERT INTO episodes (id, user_id, session_id, summary, created_at) VALUES (?, ?, ?, ?, ?)",
            (episode["id"], episode["user_id"], episode["session_id"], episode["summary"], episode["created_at"]),
        )
    return episode


def recent_episodes(user_id: str, limit: int = 3):
    """Derniers épisodes condensés, du plus récent au plus ancien."""
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM episodes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# =========================================================
# CACHE LOCAL DES VECTEURS D'EMBEDDING
# =========================================================

def get_cached_vector(fact_id: str, model: str):
    with _conn() as con:
        row = con.execute(
            "SELECT vector FROM fact_vectors WHERE fact_id = ? AND model = ?", (fact_id, model)
        ).fetchone()
    if not row:
        return None
    try:
        import json as _json
        return _json.loads(row["vector"])
    except Exception:
        return None


def store_vector(fact_id: str, model: str, vector):
    import json as _json
    with _conn() as con:
        con.execute(
            "INSERT OR REPLACE INTO fact_vectors (fact_id, model, vector) VALUES (?, ?, ?)",
            (fact_id, model, _json.dumps([round(float(v), 6) for v in vector])),
        )


def facts_missing_vectors(model: str, limit: int = 64):
    """Faits sans vecteur d'embedding en cache — candidats à la pré-vectorisation."""
    expire_stale_temporary_memory(user_id=None)
    with _conn() as con:
        rows = con.execute(
            "SELECT f.id, f.text FROM facts f "
            "LEFT JOIN fact_vectors v ON v.fact_id = f.id AND v.model = ? "
            "WHERE v.fact_id IS NULL ORDER BY f.created_at DESC LIMIT ?",
            (model, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def vectorized_facts(user_id: str, model: str, limit: int = 2000):
    """Tous les faits d'un utilisateur déjà vectorisés, avec leur vecteur décodé."""
    import json as _json
    expire_stale_temporary_memory(user_id=user_id)
    with _conn() as con:
        rows = con.execute(
            "SELECT f.id, f.category, f.text, f.created_at, f.use_count, v.vector "
            "FROM facts f JOIN fact_vectors v ON v.fact_id = f.id AND v.model = ? "
            "WHERE f.user_id = ? ORDER BY f.created_at DESC LIMIT ?",
            (model, user_id, limit),
        ).fetchall()
    facts = []
    for row in rows:
        fact = dict(row)
        try:
            fact["vector"] = _json.loads(fact["vector"])
        except Exception:
            continue
        facts.append(fact)
    return facts


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

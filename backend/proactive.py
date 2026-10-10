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
from productivite.store import ProductivityStore

MODES = ("proactif",)
_MODE_LIMITS = {"proactif": 6}
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
            "title": "Infos du jour",
            "description": "Les infos du jour n'ont pas encore été lancées : météo, marchés, actus et ta journée.",
            "urgency": "moyenne",
            "reason": "Il est entre 6 h et 10 h et le briefing quotidien n'a pas été demandé aujourd'hui.",
            "benefit": "Démarrer la journée avec un journal d'environ 5 minutes, sans rien chercher.",
            "confidence": 0.8,
            "action": {"type": "command", "text": "infos du jour"},
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
        status = work_item.get("status") or "running"
        state = {"running": "en cours", "done": "terminée", "error": "en erreur",
                 "cancelled": "annulée"}.get(status, "à vérifier")
        result = (work_item.get("result") or "").strip()[:240]
        items.append({
            "kind": f"intervention:{work_item['id']}",
            "state": status,
            "title": "Suivi d'intervention",
            "description": f"{work_item.get('title') or subject} : dernier état enregistré {state}." + (f" {result}" if result else ""),
            "urgency": "haute" if status == "error" else "moyenne" if status == "running" else "faible",
            "reason": f"Journal d'intervention : « {work_item.get('title')} », état {state}, commencé le {work_item['started_at']}.",
            "benefit": "Conserver le fil du travail engagé et identifier la prochaine action utile.",
            "confidence": 0.75 if status in {"running", "error"} else 0.6,
            "action": {"type": "command", "text": f"Fais le point et reprends : {subject}."},
        })

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

    items.extend(_task_candidates(user_id, now, local_now))
    items.extend(_service_candidates(now))
    items.extend(_next_step_candidates(user_id))
    return items


def _task_candidates(user_id: str, now, local_now) -> list:
    """Tâches échues ou dues aujourd'hui : la source la plus actionnable qui existait déjà en base."""
    items = []
    today = local_now.date().isoformat()
    rows = ProductivityStore().due_tasks(user_id)

    late = [r for r in rows if (r["due_at"] or "")[:10] < today]
    due_today = [r for r in rows if (r["due_at"] or "")[:10] == today]

    if late:
        first = late[0]
        titles = ", ".join(r["title"] for r in late[:3])
        items.append({
            "kind": f"tache-retard:{first['id']}",
            "title": f"{len(late)} tâche{'s' if len(late) > 1 else ''} en retard",
            "description": f"Échéance dépassée : {titles}.",
            "urgency": "haute",
            "reason": f"{len(late)} tâche(s) ont une échéance antérieure à aujourd'hui et ne sont pas clôturées.",
            "benefit": "Rattraper le retard avant qu'il ne s'accumule.",
            "confidence": 0.9,
            "action": {"type": "command", "text": f"Aide-moi à traiter la tâche en retard : {first['title']}"},
        })

    if due_today:
        first = due_today[0]
        items.append({
            "kind": f"tache-jour:{first['id']}",
            "title": f"{len(due_today)} tâche{'s' if len(due_today) > 1 else ''} à rendre aujourd'hui",
            "description": f"À traiter aujourd'hui : {', '.join(r['title'] for r in due_today[:3])}.",
            "urgency": "moyenne",
            "reason": "Ces tâches ont leur échéance fixée à la date du jour.",
            "benefit": "Terminer la journée sans échéance manquée.",
            "confidence": 0.85,
            "action": {"type": "command", "text": f"Prépare la tâche du jour : {first['title']}"},
        })
    return items


def _service_candidates(now) -> list:
    """Dégradation réelle d'un service dans le journal des dernières 24 h."""
    since = (now - timedelta(hours=24)).isoformat()
    with _conn() as con:
        rows = [dict(r) for r in con.execute(
            "SELECT service, COUNT(*) AS total, "
            "SUM(CASE WHEN UPPER(COALESCE(status,'')) <> 'OK' THEN 1 ELSE 0 END) AS ko "
            "FROM service_log WHERE service IS NOT NULL AND created_at >= ? "
            "GROUP BY service HAVING total >= 5 AND ko * 2 >= total "
            "ORDER BY ko DESC LIMIT 1",
            (since,),
        ).fetchall()]
    items = []
    for row in rows:
        rate = round(row["ko"] / row["total"] * 100)
        items.append({
            "kind": f"service:{row['service']}",
            "title": f"Service {row['service']} dégradé",
            "description": f"{rate} % d'échecs sur les dernières 24 h ({row['ko']} sur {row['total']}).",
            "urgency": "haute",
            "reason": f"Le journal de service enregistre {row['ko']} échecs sur {row['total']} appels depuis 24 h.",
            "benefit": "Corriger avant que la panne ne bloque une action importante.",
            "confidence": 0.85,
            "action": {"type": "command", "text": "lance un diagnostic complet"},
        })
    return items


def _next_step_candidates(user_id: str) -> list:
    """Prédit la suite probable : après l'intention courante, quelle intention suit d'ordinaire ?"""
    with _conn() as con:
        seq = [r["intent"] or "" for r in con.execute(
            "SELECT intent FROM events WHERE user_id = ? ORDER BY created_at DESC LIMIT 400",
            (user_id,),
        ).fetchall()]
    if len(seq) < 10:
        return []
    chrono = seq[::-1]

    def successors_of(target):
        acc, tot = {}, 0
        for a, b in zip(chrono, chrono[1:]):
            if a == target and b and b != target:
                acc[b] = acc.get(b, 0) + 1
                tot += 1
        return acc, tot

    # La toute dernière intention n'a parfois aucune suite connue : on remonte alors
    # les intentions récentes jusqu'à en trouver une réellement documentée.
    seen = []
    for intent in seq[:12]:
        if intent and intent not in seen:
            seen.append(intent)

    for rank, last in enumerate(seen):
        successors, total = successors_of(last)
        if total < 3:
            continue
        nxt, n = max(successors.items(), key=lambda kv: kv[1])
        confidence = n / total
        # Une intention très fréquente disperse ses suites : exiger 40 % l'écarterait toujours.
        # On retient donc un appui absolu suffisant avec une part nettement au-dessus du hasard.
        if n < 4 or confidence < 0.2:
            continue
        contexte = "ta dernière commande" if rank == 0 else f"« {last} », ta commande récente"
        return [{
            "kind": f"suite:{last}->{nxt}",
            "title": "Suite habituelle",
            "description": f"Après {contexte}, tu enchaînes le plus souvent sur « {nxt} ». Je prépare ?",
            "urgency": "faible",
            "reason": f"Sur {total} enchaînements observés après « {last} », {n} mènent à « {nxt} » ({round(confidence * 100)} %).",
            "benefit": "Gagner une étape en anticipant la suite logique.",
            "confidence": round(min(0.9, confidence), 2),
            "action": {"type": "command", "text": nxt},
        }]
    return []


_URGENCY_ORDER = {"haute": 0, "moyenne": 1, "faible": 2}


def _intervention(item: dict) -> dict:
    """Décide comment Sirius peut prendre en charge une suggestion sans agir à l'aveugle."""
    kind = item["kind"].split(":", 1)[0]
    if kind == "actualite":
        return {
            "decision": "informer",
            "message": "C'est un titre publié récemment, pas nécessairement un événement survenu aujourd'hui. Quel point souhaites-tu approfondir ?",
            "alternative": "Le briefing complet rassemble les autres rubriques avec leurs sources.",
        }
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
    if kind in ("tache-retard", "tache-jour"):
        return {
            "decision": "agir",
            "message": "Je peux ouvrir la tâche, résumer ce qu'il reste à faire et préparer le livrable.",
            "alternative": "Sinon, je peux seulement replanifier l'échéance à une date tenable.",
        }
    if kind == "service":
        return {
            "decision": "agir",
            "message": "Je peux lancer un diagnostic complet et isoler la cause des échecs.",
            "alternative": "Je peux aussi me contenter de surveiller et t'alerter si le taux se dégrade encore.",
        }
    if kind == "suite":
        return {
            "decision": "proposer",
            "message": "Je peux enchaîner directement sur cette étape, comme d'habitude.",
            "alternative": "Si ce n'est pas la suite voulue cette fois, dis-moi simplement par quoi commencer.",
        }
    return {
        "decision": "proposer",
        "message": "J'ai repéré cette habitude. Je peux m'en occuper maintenant si c'est le bon moment.",
        "alternative": "Sinon, je la garde en attente et je te la reproposerai seulement quand elle redevient pertinente.",
    }


def _news_candidates(news_sections: list[dict], now: datetime) -> list[dict]:
    """Informe même sans tâche préalable, uniquement depuis des sources récentes."""
    articles = []
    for section in news_sections:
        if section["status"] != "ok":
            continue
        for article in section["articles"]:
            published = datetime.fromisoformat(article["date"])
            if published.tzinfo is not None and timedelta(0) <= now - published <= timedelta(hours=24):
                articles.append((published, section["label"], article))
    articles.sort(key=lambda entry: entry[0], reverse=True)
    seen = set()
    candidates = []
    for published, label, article in articles:
        if article["url"] in seen:
            continue
        seen.add(article["url"])
        candidates.append({
            "kind": "actualite:" + hashlib.sha1(article["url"].encode("utf-8")).hexdigest()[:16],
            "title": f"À suivre · {label}",
            "description": f"Dans la rubrique {label}, {article['source']} titre : « {article['titre']} ».",
            "urgency": "faible",
            "reason": f"Publication du {published.isoformat()} : {article['url']}",
            "benefit": "Rester informé sans devoir demander systématiquement les nouvelles.",
            "confidence": 0.65,
            "action": {"type": "command", "text": f"Explique cette actualité, vérifie les faits et le contexte : {article['titre']}. Source : {article['url']}"},
        })
        if len(candidates) == 2:
            break
    return candidates


def evaluate(user_id: str, now=None, *, news_sections: list[dict] | None = None) -> dict:
    """Évalue et retourne les suggestions actives pour l'utilisateur."""
    now = now or datetime.now(timezone.utc)
    mode = get_mode(user_id)
    muted = _muted_kinds(user_id, now)

    candidates = [c for c in _candidates(user_id, now) + _news_candidates(news_sections or [], now)
                  if c["kind"] not in muted]
    candidates.sort(key=lambda c: (_URGENCY_ORDER.get(c["urgency"], 3), -c["confidence"]))
    selected = candidates[: _MODE_LIMITS[mode]]

    suggestions = []
    stamp = now.isoformat()
    with _conn() as con:
        for c in selected:
            identity = f"{c['kind']}:{c['state']}" if "state" in c else c["kind"]
            sid = _suggestion_id(user_id, identity)
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

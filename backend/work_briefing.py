"""Read-only work report from authorized dossiers, never from news or invented tasks."""

from datetime import date


def work_briefing_text(day: dict) -> str:
    today = day["on"]
    dossiers = day["dossiers"]
    names = {item["id"]: item["title"] for item in dossiers}
    lines = [
        f"Briefing de travail du {date.fromisoformat(today):%d/%m/%Y}.",
        "Sources : vos dossiers privés et les données métier autorisées, vérifiés à cette demande.",
        f"Dossiers enregistrés : {len(dossiers)}.",
    ]
    if dossiers:
        lines.append("À reprendre dans Mes dossiers : " + ", ".join(item["title"] for item in dossiers[:6]) + ".")
        if len(dossiers) > 6:
            lines.append(f"{len(dossiers) - 6} autres dossiers sont disponibles dans Mes dossiers.")
    else:
        lines.append("Aucun dossier de travail enregistré. Créez un dossier dans Mes dossiers pour organiser le suivi.")

    commitments = day["commitments"]
    groups = (
        ("Engagements en retard", [item for item in commitments if item.get("due_date") and item["due_date"] < today]),
        ("À terminer aujourd'hui", [item for item in commitments if item.get("due_date") == today]),
        ("À planifier, sans échéance renseignée", [item for item in commitments if not item.get("due_date")]),
        ("Prochaines échéances", [item for item in commitments if item.get("due_date") and item["due_date"] > today]),
    )
    if not commitments:
        lines.append("Aucun engagement confirmé restant à terminer dans les données accessibles.")
    for title, tasks in groups:
        if not tasks:
            continue
        lines.append(f"\n{title} : {len(tasks)}.")
        for task in sorted(tasks, key=lambda item: item.get("due_date") or "")[:5]:
            due = f", échéance le {date.fromisoformat(task['due_date']):%d/%m/%Y}" if task.get("due_date") else ""
            lines.append(f"- {names[task['dossier_id']]} : {task['text']} — responsable : {task['owner']}{due}.")
        if len(tasks) > 5:
            lines.append(f"{len(tasks) - 5} autres engagements à consulter dans Mes dossiers.")
    proposals = day["proposals"]
    if proposals:
        lines.append(f"\nPoints métier à vérifier : {len(proposals)} propositions, pas des tâches déjà approuvées.")
        for proposal in proposals[:5]:
            source = proposal.get("source") or {}
            lines.append(f"- {proposal['title']} — source : {source.get('label') or source.get('id') or source.get('module', 'non renseignée')}.")
        if len(proposals) > 5:
            lines.append(f"{len(proposals) - 5} autres propositions à consulter dans Mes dossiers.")
    else:
        lines.append("Aucun signal métier à vérifier dans les données accessibles.")
    if day["truncated"]:
        lines.append("Attention : la limite de lecture a été atteinte ; ce rapport est partiel.")
    for missing in day["missing_info"]:
        lines.append(missing)
    lines.append(
        "Pour continuer, choisissez un dossier dans Mes dossiers, puis l'engagement à reprendre. "
        "Aucune tâche terminée, aucun message envoyé et aucune action métier exécutée par ce briefing."
    )
    return "\n".join(lines)

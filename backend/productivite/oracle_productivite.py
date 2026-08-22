"""Synthese Oracle des donnees Productivite."""


def build_productivity_oracle(summary: dict) -> dict:
    tasks = summary.get("tasks") or {}
    next_task = summary.get("next_task")
    active = int(tasks.get("todo", 0)) + int(tasks.get("in_progress", 0))
    if next_task:
        headline = f"Prochaine echeance : {next_task['title']} ({next_task['due_at']})."
    elif active:
        headline = f"{active} tache(s) active(s) a organiser."
    else:
        headline = "Aucune tache active : votre espace de travail est a jour."

    return {
        "status": "focus" if active else "clear",
        "headline": headline,
        "notes": summary.get("notes", 0),
        "reports": summary.get("reports", 0),
        "tasks": tasks,
        "next_task": next_task,
    }


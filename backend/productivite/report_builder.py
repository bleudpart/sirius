"""Generation de rapports Markdown locaux a partir des donnees Productivite."""

from datetime import datetime, timezone

from .store import ProductivityStore


class ReportBuilder:
    def __init__(self, store: ProductivityStore):
        self.store = store

    def build(self, user_id: str, title: str, report_type: str = "work") -> dict:
        summary = self.store.summary(user_id)
        notes = self.store.list_notes(user_id, limit=8)
        tasks = self.store.list_tasks(user_id, limit=30)
        clean_title = " ".join((title or "Rapport Productivite").split())[:180]
        generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

        lines = [
            f"# {clean_title}",
            "",
            f"Genere par SIRIUS le {generated_at}.",
            "",
            "## Synthese",
            f"- Notes actives : {summary['notes']}",
            f"- Taches a faire : {summary['tasks']['todo']}",
            f"- Taches en cours : {summary['tasks']['in_progress']}",
            f"- Taches terminees : {summary['tasks']['done']}",
        ]
        if summary["next_task"]:
            lines.extend([
                "",
                "## Prochaine echeance",
                f"- **{summary['next_task']['title']}** - {summary['next_task']['due_at']}",
            ])
        if tasks:
            lines.extend(["", "## Taches prioritaires"])
            for task in tasks[:12]:
                due = f" - echeance {task['due_at']}" if task.get("due_at") else ""
                lines.append(f"- [{task['status']}] {task['title']} ({task['priority']}){due}")
        if notes:
            lines.extend(["", "## Notes recentes"])
            for note in notes[:6]:
                excerpt = " ".join(note["content"].split())[:180]
                lines.append(f"- **{note['title']}** : {excerpt}")

        return self.store.create_report(user_id, clean_title, "\n".join(lines), report_type=report_type)

    def list(self, user_id: str, limit: int = 50) -> list[dict]:
        return self.store.list_reports(user_id, limit=limit)


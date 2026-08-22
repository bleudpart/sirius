"""Service TaskMaster."""

from .store import ProductivityStore


class TaskMaster:
    _STATUSES = {"todo", "in_progress", "done"}
    _PRIORITIES = {"low", "medium", "high"}

    def __init__(self, store: ProductivityStore):
        self.store = store

    def list(self, user_id: str, status: str = "", limit: int = 200) -> list[dict]:
        if status and status not in self._STATUSES:
            raise ValueError("Statut de tache invalide.")
        return self.store.list_tasks(user_id, status=status, limit=limit)

    def create(self, user_id: str, title: str, description: str = "", status: str = "todo", priority: str = "medium", due_at: str = "") -> dict:
        self._validate(status, priority)
        return self.store.create_task(user_id, title, description, status, priority, due_at)

    def update(self, user_id: str, task_id: str, **changes) -> dict | None:
        status = changes.get("status")
        priority = changes.get("priority")
        if status is not None and status not in self._STATUSES:
            raise ValueError("Statut de tache invalide.")
        if priority is not None and priority not in self._PRIORITIES:
            raise ValueError("Priorite de tache invalide.")
        return self.store.update_task(user_id, task_id, **changes)

    def delete(self, user_id: str, task_id: str) -> bool:
        return self.store.delete_task(user_id, task_id)

    def summary(self, user_id: str) -> dict:
        return self.store.summary(user_id)

    def _validate(self, status: str, priority: str) -> None:
        if status not in self._STATUSES:
            raise ValueError("Statut de tache invalide.")
        if priority not in self._PRIORITIES:
            raise ValueError("Priorite de tache invalide.")


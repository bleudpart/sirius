"""Service SmartNotes."""

from .store import ProductivityStore


class SmartNotes:
    def __init__(self, store: ProductivityStore):
        self.store = store

    def list(self, user_id: str, query: str = "", limit: int = 100) -> list[dict]:
        return self.store.list_notes(user_id, query=query, limit=limit)

    def create(self, user_id: str, title: str, content: str, tags=None, pinned: bool = False) -> dict:
        return self.store.create_note(user_id, title, content, tags=tags, pinned=pinned)

    def update(self, user_id: str, note_id: str, **changes) -> dict | None:
        return self.store.update_note(user_id, note_id, **changes)

    def delete(self, user_id: str, note_id: str) -> bool:
        return self.store.delete_note(user_id, note_id)


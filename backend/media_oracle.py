"""Synthese Oracle pour l'etat multimedia courant."""


def build_media_oracle(state: dict, recent_events: list[dict]) -> dict:
    status = state.get("status") or "idle"
    provider = state.get("provider") or ""
    title = state.get("title") or ""

    if status == "playing":
        headline = f"Lecture active sur {provider}: {title}".strip(": ")
    elif status in ("ready", "paused"):
        headline = f"Media pret sur {provider}: {title}".strip(": ")
    elif status == "closed":
        headline = "Le lecteur multimedia est ferme."
    else:
        headline = "Aucun media actif."

    return {
        "status": status,
        "provider": provider,
        "title": title,
        "headline": headline,
        "recent_actions": len(recent_events),
        "last_action": recent_events[0] if recent_events else None,
    }


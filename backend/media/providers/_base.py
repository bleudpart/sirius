"""Modele public commun aux providers multimedia."""

from dataclasses import dataclass


@dataclass(frozen=True)
class MediaProvider:
    """Metadonnees sans secret exposees au frontend."""

    id: str
    name: str
    description: str
    url: str
    media_type: str
    available: bool = True
    launch_mode: str = "external"

    def to_payload(self) -> dict[str, str | bool]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "url": self.url,
            "media_type": self.media_type,
            "available": self.available,
            "launch_mode": self.launch_mode,
        }

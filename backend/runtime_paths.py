"""Runtime paths shared by source and packaged SIRIUS backends."""

import json
import os
import sys
import tempfile
from pathlib import Path


SOURCE_DIR = Path(__file__).resolve().parent


def data_dir() -> Path:
    configured = os.getenv("SIRIUS_DATA_DIR", "").strip()
    directory = Path(configured).expanduser() if configured else SOURCE_DIR
    directory.mkdir(parents=True, exist_ok=True)
    return directory.resolve()


def project_dir() -> Path:
    configured = os.getenv("SIRIUS_PROJECT_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS).resolve()
    return SOURCE_DIR.parent


def data_file(name: str) -> Path:
    return data_dir() / name


def write_json_atomic(path, data, *, ensure_ascii: bool = False) -> None:
    """Écrit `data` en JSON de façon atomique (tmp + fsync + os.replace).

    Évite la corruption du fichier si le process est interrompu en cours d'écriture :
    l'ancien contenu reste intact tant que le remplacement n'a pas abouti.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=ensure_ascii)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise

#!/usr/bin/env python3
"""Copie et vérifie les bases SQLite d'une sauvegarde, sans toucher aux originaux."""

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from contextlib import closing
from pathlib import Path, PurePosixPath

MANIFEST = ".sirius-sqlite-snapshot.json"
SQLITE_HEADER = b"SQLite format 3\x00"
DATABASE_SUFFIXES = {".sqlite3", ".sqlite", ".db"}
RESERVED_NAMES = tuple(
    suffix + extension
    for suffix in DATABASE_SUFFIXES
    for extension in ("", "-wal", "-shm")
)


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _check_sqlite(path: Path) -> None:
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True, timeout=30)) as database:
        if database.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError(f"Base SQLite corrompue : {path}")


def create_snapshot(data_dir: Path, snapshot_dir: Path) -> dict:
    data_dir = data_dir.resolve()
    snapshot_dir = snapshot_dir.resolve()
    if not data_dir.is_dir():
        raise ValueError(f"Dossier de données introuvable : {data_dir}")
    if snapshot_dir == data_dir or data_dir in snapshot_dir.parents:
        raise ValueError("Le dossier de copie doit être séparé du dossier de données.")
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    if any(snapshot_dir.iterdir()):
        raise ValueError(f"Le dossier de copie n'est pas vide : {snapshot_dir}")

    files = []
    for source in sorted(data_dir.rglob("*")):
        if source.is_dir() and source.name.endswith(RESERVED_NAMES):
            raise ValueError(f"Répertoire avec une extension réservée à une base : {source}")
        if source.suffix not in DATABASE_SUFFIXES:
            continue
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"Fichier de base non régulier : {source}")
        relative = source.relative_to(data_dir)
        target = snapshot_dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as stream:
            is_sqlite = stream.read(len(SQLITE_HEADER)) == SQLITE_HEADER
        if is_sqlite:
            with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)) as original:
                with closing(sqlite3.connect(target)) as copy:
                    original.backup(copy)
            _check_sqlite(target)
        else:
            shutil.copy2(source, target)
        files.append({
            "path": relative.as_posix(),
            "kind": "sqlite" if is_sqlite else "file",
            "size": target.stat().st_size,
            "sha256": _digest(target),
        })

    manifest = {"version": 1, "files": files}
    (snapshot_dir / MANIFEST).write_text(
        json.dumps(manifest, ensure_ascii=True, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def verify_snapshot(snapshot_dir: Path) -> dict:
    snapshot_dir = snapshot_dir.resolve()
    manifest = json.loads((snapshot_dir / MANIFEST).read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or not isinstance(manifest.get("files"), list):
        raise ValueError("Manifeste de sauvegarde invalide.")

    seen = set()
    for entry in manifest["files"]:
        if not isinstance(entry, dict):
            raise ValueError("Entrée de sauvegarde invalide.")
        name = entry.get("path")
        if not isinstance(name, str) or "\\" in name:
            raise ValueError("Chemin de sauvegarde invalide.")
        relative = PurePosixPath(name)
        if not name or relative.is_absolute() or ".." in relative.parts or name == MANIFEST or name in seen:
            raise ValueError("Chemin de sauvegarde invalide ou dupliqué.")
        seen.add(name)
        path = snapshot_dir.joinpath(*relative.parts)
        if path.is_symlink() or not path.is_file() or snapshot_dir not in path.resolve().parents:
            raise ValueError(f"Fichier de sauvegarde manquant ou invalide : {name}")
        if not isinstance(entry.get("size"), int) or path.stat().st_size != entry["size"]:
            raise ValueError(f"Taille incorrecte dans la sauvegarde : {name}")
        if not isinstance(entry.get("sha256"), str) or _digest(path) != entry["sha256"]:
            raise ValueError(f"Empreinte incorrecte dans la sauvegarde : {name}")
        if entry.get("kind") == "sqlite":
            _check_sqlite(path)
        elif entry.get("kind") != "file":
            raise ValueError(f"Type de fichier inconnu dans la sauvegarde : {name}")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("data_dir", type=Path)
    create.add_argument("snapshot_dir", type=Path)
    verify = commands.add_parser("verify")
    verify.add_argument("snapshot_dir", type=Path)
    arguments = parser.parse_args()
    if arguments.command == "create":
        manifest = create_snapshot(arguments.data_dir, arguments.snapshot_dir)
        print(f"Copie de sauvegarde créée : {len(manifest['files'])} fichier(s).")
    else:
        manifest = verify_snapshot(arguments.snapshot_dir)
        print(f"Copie de sauvegarde vérifiée : {len(manifest['files'])} fichier(s).")


if __name__ == "__main__":
    try:
        main()
    except (OSError, sqlite3.Error, ValueError) as failure:
        print(f"Échec de la sauvegarde ou de sa vérification : {failure}", file=sys.stderr)
        sys.exit(1)

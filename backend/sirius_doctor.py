# © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
"""Sauvegarde et contrôle d'intégrité de la mémoire locale SQLite de SIRIUS.

Le module est volontairement autonome : il peut être exécuté même lorsque le
serveur FastAPI n'est pas démarré et n'ajoute aucune dépendance au projet.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DATABASE_PATH = SCRIPT_DIR / "sirius_local.db"
DEFAULT_BACKUP_DIRECTORY = SCRIPT_DIR / "backups" / "sirius_doctor"
MANIFEST_SUFFIX = ".manifest.json"
MANIFEST_VERSION = 1
HASH_CHUNK_SIZE = 1024 * 1024


class DoctorError(RuntimeError):
    """Erreur attendue lors d'une sauvegarde ou d'une vérification."""


@dataclass(frozen=True)
class IntegrityReport:
    """Résultat d'un contrôle SQLite, incluant les clés étrangères."""

    database: Path
    integrity_messages: tuple[str, ...] = ()
    foreign_key_violations: tuple[tuple[Any, ...], ...] = ()
    error: str | None = None

    @property
    def ok(self) -> bool:
        return (
            self.error is None
            and self.integrity_messages == ("ok",)
            and not self.foreign_key_violations
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "database": str(self.database),
            "ok": self.ok,
            "integrity_check": list(self.integrity_messages),
            "foreign_key_violations": [
                {
                    "table": violation[0],
                    "rowid": violation[1],
                    "parent": violation[2],
                    "foreign_key_index": violation[3],
                }
                if len(violation) == 4
                else list(violation)
                for violation in self.foreign_key_violations
            ],
            "error": self.error,
        }


@dataclass(frozen=True)
class BackupResult:
    """Informations sur une sauvegarde créée et validée."""

    source: Path
    backup: Path
    manifest: Path
    sha256: str
    created_at: str
    source_integrity: IntegrityReport
    backup_integrity: IntegrityReport

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": True,
            "source": str(self.source),
            "backup": str(self.backup),
            "manifest": str(self.manifest),
            "sha256": self.sha256,
            "created_at": self.created_at,
            "source_integrity": self.source_integrity.to_dict(),
            "backup_integrity": self.backup_integrity.to_dict(),
        }


@dataclass(frozen=True)
class BackupVerification:
    """Résultat de la vérification d'un instantané et de son manifeste."""

    backup: Path
    manifest: Path
    integrity: IntegrityReport
    actual_sha256: str | None
    manifest_errors: tuple[str, ...] = ()

    @property
    def ok(self) -> bool:
        return self.integrity.ok and not self.manifest_errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "backup": str(self.backup),
            "manifest": str(self.manifest),
            "ok": self.ok,
            "actual_sha256": self.actual_sha256,
            "integrity": self.integrity.to_dict(),
            "manifest_errors": list(self.manifest_errors),
        }


def _normalise_path(path: Path | str) -> Path:
    return Path(path).expanduser().resolve()


def _read_only_database_uri(database: Path) -> str:
    return f"{database.as_uri()}?mode=ro"


def manifest_path_for(backup_path: Path | str) -> Path:
    """Retourne le chemin du manifeste SHA-256 associé à une sauvegarde."""

    backup = _normalise_path(backup_path)
    return backup.with_name(f"{backup.name}{MANIFEST_SUFFIX}")


def check_integrity(database_path: Path | str) -> IntegrityReport:
    """Vérifie la structure SQLite et les références de clés étrangères.

    La base est ouverte explicitement en lecture seule, afin que ce contrôle ne
    crée jamais une base vide par erreur et ne modifie pas les données.
    """

    database = _normalise_path(database_path)
    try:
        if not database.is_file():
            return IntegrityReport(database=database, error="Le fichier de base de données est introuvable.")
    except OSError as error:
        return IntegrityReport(database=database, error=f"Impossible d'accéder au fichier : {error}")

    try:
        with closing(sqlite3.connect(_read_only_database_uri(database), uri=True)) as connection:
            integrity_messages = tuple(
                str(row[0]) for row in connection.execute("PRAGMA integrity_check")
            )
            foreign_key_violations = tuple(
                tuple(row) for row in connection.execute("PRAGMA foreign_key_check")
            )
    except (sqlite3.Error, OSError, ValueError) as error:
        return IntegrityReport(database=database, error=f"Contrôle SQLite impossible : {error}")

    return IntegrityReport(
        database=database,
        integrity_messages=integrity_messages,
        foreign_key_violations=foreign_key_violations,
    )


def verify_integrity(database_path: Path | str) -> IntegrityReport:
    """Alias explicite de :func:`check_integrity` pour les appels métiers."""

    return check_integrity(database_path)


def sha256_file(file_path: Path | str) -> str:
    """Calcule le condensat SHA-256 d'un fichier sans le charger en mémoire."""

    digest = hashlib.sha256()
    with _normalise_path(file_path).open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(HASH_CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _describe_integrity_failure(report: IntegrityReport) -> str:
    if report.error:
        return report.error
    parts = []
    if report.integrity_messages != ("ok",):
        parts.append("PRAGMA integrity_check : " + "; ".join(report.integrity_messages))
    if report.foreign_key_violations:
        parts.append(f"{len(report.foreign_key_violations)} violation(s) de clé étrangère")
    return ". ".join(parts) or "État d'intégrité inconnu."


def _require_healthy(report: IntegrityReport, label: str) -> None:
    if not report.ok:
        raise DoctorError(f"{label} n'est pas intègre : {_describe_integrity_failure(report)}")


def _timestamp(now: datetime | None = None) -> str:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _available_backup_path(source: Path, backup_directory: Path, now: datetime | None) -> Path:
    suffix = source.suffix or ".db"
    stem = source.stem if source.suffix else source.name
    timestamp = _timestamp(now)
    candidate = backup_directory / f"{stem}-{timestamp}{suffix}"
    counter = 1

    while candidate.exists() or manifest_path_for(candidate).exists():
        candidate = backup_directory / f"{stem}-{timestamp}-{counter}{suffix}"
        counter += 1
    return candidate


def _sync_file(file_path: Path) -> None:
    # Windows requires a writable descriptor for fsync, even though no byte is changed.
    with file_path.open("r+b") as file_handle:
        os.fsync(file_handle.fileno())


def _write_manifest(manifest_path: Path, payload: dict[str, Any]) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=manifest_path.parent,
            prefix=f".{manifest_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            json.dump(payload, temporary_file, ensure_ascii=False, indent=2, sort_keys=True)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, manifest_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass


def create_backup(
    database_path: Path | str = DEFAULT_DATABASE_PATH,
    backup_directory: Path | str = DEFAULT_BACKUP_DIRECTORY,
    *,
    now: datetime | None = None,
) -> BackupResult:
    """Crée une copie SQLite cohérente, son manifeste et les vérifie.

    ``Connection.backup`` prend un instantané SQLite cohérent, y compris si le
    serveur utilise un journal WAL. Le fichier final n'est publié qu'après son
    propre contrôle d'intégrité.
    """

    source = _normalise_path(database_path)
    destination_directory = _normalise_path(backup_directory)
    source_integrity = check_integrity(source)
    _require_healthy(source_integrity, "La base source")

    try:
        destination_directory.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise DoctorError(
            f"Impossible de créer le dossier de sauvegarde {destination_directory} : {error}"
        ) from error

    backup_path = _available_backup_path(source, destination_directory, now)
    manifest_path = manifest_path_for(backup_path)
    temporary_path: Path | None = None
    published = False

    try:
        with tempfile.NamedTemporaryFile(
            dir=destination_directory,
            prefix=f".{backup_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)

        with closing(sqlite3.connect(_read_only_database_uri(source), uri=True)) as source_connection:
            with closing(sqlite3.connect(temporary_path)) as backup_connection:
                source_connection.backup(backup_connection)
                backup_connection.commit()

        _sync_file(temporary_path)
        temporary_backup_integrity = check_integrity(temporary_path)
        _require_healthy(temporary_backup_integrity, "La sauvegarde temporaire")

        os.replace(temporary_path, backup_path)
        temporary_path = None
        published = True
        backup_integrity = IntegrityReport(
            database=backup_path,
            integrity_messages=temporary_backup_integrity.integrity_messages,
            foreign_key_violations=temporary_backup_integrity.foreign_key_violations,
            error=temporary_backup_integrity.error,
        )

        checksum = sha256_file(backup_path)
        created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _write_manifest(
            manifest_path,
            {
                "format_version": MANIFEST_VERSION,
                "created_at": created_at,
                "source_database": source.name,
                "backup_file": backup_path.name,
                "size_bytes": backup_path.stat().st_size,
                "sha256": checksum,
                "integrity_check": list(backup_integrity.integrity_messages),
                "foreign_key_violations": len(backup_integrity.foreign_key_violations),
            },
        )
    except DoctorError:
        if published:
            try:
                backup_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    except (sqlite3.Error, OSError, ValueError) as error:
        if published:
            try:
                backup_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise DoctorError(f"Création de la sauvegarde impossible : {error}") from error
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass

    return BackupResult(
        source=source,
        backup=backup_path,
        manifest=manifest_path,
        sha256=checksum,
        created_at=created_at,
        source_integrity=source_integrity,
        backup_integrity=backup_integrity,
    )


def verify_backup(
    backup_path: Path | str,
    manifest_path: Path | str | None = None,
) -> BackupVerification:
    """Vérifie l'intégrité SQLite d'une sauvegarde et son manifeste SHA-256."""

    backup = _normalise_path(backup_path)
    manifest = _normalise_path(manifest_path) if manifest_path else manifest_path_for(backup)
    integrity = check_integrity(backup)
    manifest_errors: list[str] = []
    actual_sha256: str | None = None

    try:
        raw_manifest = json.loads(manifest.read_text(encoding="utf-8"))
    except FileNotFoundError:
        manifest_errors.append("Manifeste introuvable.")
        raw_manifest = None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        manifest_errors.append(f"Manifeste illisible : {error}")
        raw_manifest = None

    if not isinstance(raw_manifest, dict):
        if raw_manifest is not None:
            manifest_errors.append("Le manifeste doit contenir un objet JSON.")
        return BackupVerification(
            backup=backup,
            manifest=manifest,
            integrity=integrity,
            actual_sha256=actual_sha256,
            manifest_errors=tuple(manifest_errors),
        )

    if raw_manifest.get("format_version") != MANIFEST_VERSION:
        manifest_errors.append("Version de manifeste non prise en charge.")
    if raw_manifest.get("backup_file") != backup.name:
        manifest_errors.append("Le manifeste ne correspond pas au fichier de sauvegarde.")

    expected_size = raw_manifest.get("size_bytes")
    if not isinstance(expected_size, int) or isinstance(expected_size, bool):
        manifest_errors.append("Taille de sauvegarde absente ou invalide dans le manifeste.")
    else:
        try:
            if backup.stat().st_size != expected_size:
                manifest_errors.append("La taille du fichier ne correspond pas au manifeste.")
        except OSError as error:
            manifest_errors.append(f"Impossible de lire la taille de la sauvegarde : {error}")

    expected_sha256 = raw_manifest.get("sha256")
    if not isinstance(expected_sha256, str) or len(expected_sha256) != 64:
        manifest_errors.append("Empreinte SHA-256 absente ou invalide dans le manifeste.")
    else:
        try:
            actual_sha256 = sha256_file(backup)
        except OSError as error:
            manifest_errors.append(f"Impossible de calculer l'empreinte SHA-256 : {error}")
        else:
            if actual_sha256.lower() != expected_sha256.lower():
                manifest_errors.append("L'empreinte SHA-256 ne correspond pas au manifeste.")

    return BackupVerification(
        backup=backup,
        manifest=manifest,
        integrity=integrity,
        actual_sha256=actual_sha256,
        manifest_errors=tuple(manifest_errors),
    )


def _database_from_arguments(args: argparse.Namespace) -> Path:
    positional = getattr(args, "database_path", None)
    option = getattr(args, "database_option", None)
    if positional is not None and option is not None and _normalise_path(positional) != _normalise_path(option):
        raise DoctorError("Indiquez la base une seule fois, avec l'argument positionnel ou --database.")
    return _normalise_path(option or positional or DEFAULT_DATABASE_PATH)


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _print_integrity(report: IntegrityReport, as_json: bool) -> None:
    if as_json:
        _print_json(report.to_dict())
        return

    print(f"Base contrôlée : {report.database}")
    if report.ok:
        print("Intégrité SQLite : OK")
        return
    print(f"Intégrité SQLite : ÉCHEC — {_describe_integrity_failure(report)}")


def _print_backup(result: BackupResult, as_json: bool) -> None:
    if as_json:
        _print_json(result.to_dict())
        return

    print(f"Sauvegarde validée : {result.backup}")
    print(f"Manifeste SHA-256 : {result.manifest}")
    print(f"Empreinte SHA-256 : {result.sha256}")


def _print_backup_verification(result: BackupVerification, as_json: bool) -> None:
    if as_json:
        _print_json(result.to_dict())
        return

    print(f"Sauvegarde contrôlée : {result.backup}")
    if result.ok:
        print("Intégrité SQLite et manifeste : OK")
        return

    details = [_describe_integrity_failure(result.integrity)] if not result.integrity.ok else []
    details.extend(result.manifest_errors)
    print("Intégrité SQLite et manifeste : ÉCHEC — " + " ".join(details))


def _add_database_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "database_path",
        nargs="?",
        type=Path,
        help=f"Base SQLite à traiter (défaut : {DEFAULT_DATABASE_PATH})",
    )
    parser.add_argument(
        "--database",
        dest="database_option",
        type=Path,
        help="Chemin explicite de la base SQLite à traiter.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Sauvegarde et contrôle d'intégrité de la mémoire SQLite locale de SIRIUS."
    )
    subparsers = parser.add_subparsers(dest="command", metavar="{backup,check,verify}")

    backup_parser = subparsers.add_parser(
        "backup",
        help="créer, contrôler et signer une sauvegarde SQLite",
    )
    _add_database_arguments(backup_parser)
    backup_parser.add_argument(
        "--backup-dir",
        "--output-dir",
        dest="backup_directory",
        type=Path,
        default=DEFAULT_BACKUP_DIRECTORY,
        help=f"Dossier de destination (défaut : {DEFAULT_BACKUP_DIRECTORY})",
    )
    backup_parser.add_argument("--json", action="store_true", help="Produire un résultat JSON.")

    check_parser = subparsers.add_parser("check", help="contrôler une base SQLite sans la modifier")
    _add_database_arguments(check_parser)
    check_parser.add_argument("--json", action="store_true", help="Produire un résultat JSON.")

    verify_parser = subparsers.add_parser(
        "verify",
        help="contrôler une sauvegarde SQLite et son manifeste SHA-256",
    )
    verify_parser.add_argument("backup_path", type=Path, help="Fichier de sauvegarde à vérifier.")
    verify_parser.add_argument(
        "--manifest",
        type=Path,
        help="Chemin du manifeste à utiliser (défaut : manifeste voisin de la sauvegarde).",
    )
    verify_parser.add_argument("--json", action="store_true", help="Produire un résultat JSON.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Exécute l'interface de ligne de commande et retourne son code de sortie."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0].startswith("-"):
        arguments.insert(0, "backup")

    parser = build_parser()
    args = parser.parse_args(arguments)

    try:
        if args.command == "backup":
            result = create_backup(
                _database_from_arguments(args),
                args.backup_directory,
            )
            _print_backup(result, args.json)
            return 0

        if args.command == "check":
            report = check_integrity(_database_from_arguments(args))
            _print_integrity(report, args.json)
            return 0 if report.ok else 2

        if args.command == "verify":
            result = verify_backup(args.backup_path, args.manifest)
            _print_backup_verification(result, args.json)
            return 0 if result.ok else 2
    except DoctorError as error:
        if getattr(args, "json", False):
            _print_json({"ok": False, "error": str(error)})
        else:
            print(f"ERREUR : {error}", file=sys.stderr)
        return 1

    parser.error("Commande inconnue.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

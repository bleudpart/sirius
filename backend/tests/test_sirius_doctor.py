"""Tests unitaires de l'outil de sauvegarde local Sirius Doctor."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


BACKEND_DIRECTORY = Path(__file__).resolve().parents[1]
if str(BACKEND_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIRECTORY))

from sirius_doctor import (  # noqa: E402
    DoctorError,
    check_integrity,
    create_backup,
    manifest_path_for,
    verify_backup,
)


class SiriusDoctorTests(unittest.TestCase):
    def _create_database(self, path: Path) -> None:
        with closing(sqlite3.connect(path)) as connection:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
            connection.execute(
                "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL "
                "REFERENCES parent(id))"
            )
            connection.execute("INSERT INTO parent (name) VALUES ('ΣIRIUS')")
            connection.execute("INSERT INTO child (parent_id) VALUES (1)")
            connection.commit()

    def test_creates_verified_snapshot_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "sirius_local.db"
            backup_directory = root / "backups"
            self._create_database(source)

            result = create_backup(source, backup_directory)

            self.assertTrue(result.source_integrity.ok)
            self.assertTrue(result.backup_integrity.ok)
            self.assertEqual(result.backup_integrity.database, result.backup)
            self.assertTrue(result.backup.is_file())
            self.assertTrue(result.manifest.is_file())
            self.assertEqual(result.manifest, manifest_path_for(result.backup))
            self.assertTrue(verify_backup(result.backup).ok)

            with closing(sqlite3.connect(result.backup)) as connection:
                self.assertEqual(
                    connection.execute("SELECT name FROM parent WHERE id = 1").fetchone()[0],
                    "ΣIRIUS",
                )

    def test_detects_a_tampered_backup_from_its_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "sirius_local.db"
            self._create_database(source)
            result = create_backup(source, root / "backups")

            with result.backup.open("ab") as backup_file:
                backup_file.write(b"unexpected trailing bytes")

            verification = verify_backup(result.backup)

            self.assertTrue(verification.integrity.ok)
            self.assertFalse(verification.ok)
            self.assertIn(
                "L'empreinte SHA-256 ne correspond pas au manifeste.",
                verification.manifest_errors,
            )

    def test_reports_an_unreadable_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            source = root / "sirius_local.db"
            self._create_database(source)
            result = create_backup(source, root / "backups")
            result.manifest.write_bytes(b"\xff\xfe")

            verification = verify_backup(result.backup)

            self.assertFalse(verification.ok)
            self.assertTrue(
                any(error.startswith("Manifeste illisible :") for error in verification.manifest_errors)
            )

    def test_reports_foreign_key_violations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = Path(temporary_directory) / "broken.db"
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
                connection.execute(
                    "CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))"
                )
                connection.execute("INSERT INTO child (parent_id) VALUES (999)")
                connection.commit()

            report = check_integrity(database)

            self.assertEqual(report.integrity_messages, ("ok",))
            self.assertFalse(report.ok)
            self.assertEqual(len(report.foreign_key_violations), 1)

    def test_refuses_to_backup_a_database_with_broken_references(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            database = root / "broken.db"
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("CREATE TABLE parent (id INTEGER PRIMARY KEY)")
                connection.execute(
                    "CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))"
                )
                connection.execute("INSERT INTO child (parent_id) VALUES (999)")
                connection.commit()

            backup_directory = root / "backups"
            with self.assertRaises(DoctorError):
                create_backup(database, backup_directory)

            self.assertFalse(backup_directory.exists())


if __name__ == "__main__":
    unittest.main()

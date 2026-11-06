import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[2] / "deploy" / "hetzner" / "sqlite_snapshot.py"
spec = importlib.util.spec_from_file_location("sqlite_snapshot", SCRIPT)
sqlite_snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sqlite_snapshot)


def make_database(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("CREATE TABLE documents (name TEXT)")
    connection.execute("INSERT INTO documents VALUES ('preuve de test')")
    connection.commit()
    return connection


def test_snapshot_copies_live_wal_and_preserves_non_sqlite_db_files(tmp_path):
    data = tmp_path / "données avec espaces"
    data.mkdir()
    database = data / "haccp.sqlite3"
    connection = make_database(database)
    try:
        (data / "nested").mkdir()
        (data / "nested" / "autre.db").write_bytes(b"fichier non sqlite")
        snapshot = tmp_path / "snapshot"
        manifest = sqlite_snapshot.create_snapshot(data, snapshot)
        assert [(entry["path"], entry["kind"]) for entry in manifest["files"]] == [
            ("haccp.sqlite3", "sqlite"),
            ("nested/autre.db", "file"),
        ]
        assert sqlite_snapshot.verify_snapshot(snapshot) == manifest
        assert not list(snapshot.glob("*-wal"))
        assert not list(snapshot.glob("*-shm"))
        with closing(sqlite3.connect((snapshot / "haccp.sqlite3").as_uri() + "?mode=ro&immutable=1", uri=True)) as restored:
            assert restored.execute("SELECT name FROM documents").fetchone() == ("preuve de test",)
        assert (snapshot / "nested" / "autre.db").read_bytes() == b"fichier non sqlite"
    finally:
        connection.close()


def test_snapshot_rejects_missing_sources_nonempty_destinations_and_reserved_directories(tmp_path):
    data = tmp_path / "data"
    with pytest.raises(ValueError, match="introuvable"):
        sqlite_snapshot.create_snapshot(data, tmp_path / "missing")
    data.mkdir()
    with pytest.raises(ValueError, match="séparé"):
        sqlite_snapshot.create_snapshot(data, data / "snapshot")
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / "existing").write_text("do not overwrite")
    with pytest.raises(ValueError, match="n'est pas vide"):
        sqlite_snapshot.create_snapshot(data, snapshot)
    (data / "directory.db").mkdir()
    with pytest.raises(ValueError, match="extension réservée"):
        sqlite_snapshot.create_snapshot(data, tmp_path / "other-snapshot")


def test_snapshot_fails_on_corrupt_sqlite_and_detects_missing_or_changed_copies(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    database = data / "sample.sqlite3"
    database.write_bytes(sqlite_snapshot.SQLITE_HEADER + b"not a database")
    with pytest.raises(sqlite3.DatabaseError):
        sqlite_snapshot.create_snapshot(data, tmp_path / "bad")

    database.unlink()
    connection = make_database(database)
    try:
        snapshot = tmp_path / "snapshot"
        sqlite_snapshot.create_snapshot(data, snapshot)
        copy = snapshot / "sample.sqlite3"
        copy.write_bytes(copy.read_bytes() + b"changed")
        with pytest.raises(ValueError, match="Taille incorrecte"):
            sqlite_snapshot.verify_snapshot(snapshot)
        copy.unlink()
        with pytest.raises(ValueError, match="manquant"):
            sqlite_snapshot.verify_snapshot(snapshot)
    finally:
        connection.close()


@pytest.mark.parametrize("name", ["../outside.db", "/absolute.db", "nested\\escape.db"])
def test_restore_verification_rejects_paths_outside_the_snapshot(tmp_path, name):
    snapshot = tmp_path / "snapshot"
    snapshot.mkdir()
    (snapshot / sqlite_snapshot.MANIFEST).write_text(
        json.dumps({"version": 1, "files": [{"path": name, "kind": "file", "size": 0, "sha256": ""}]}),
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="Chemin de sauvegarde invalide"):
        sqlite_snapshot.verify_snapshot(snapshot)


def test_restic_round_trip_restores_verified_database_and_photo(tmp_path):
    restic = os.environ.get("SIRIUS_TEST_RESTIC") or shutil.which("restic")
    if not restic:
        pytest.skip("restic requis pour le test de sauvegarde et restauration")
    data = tmp_path / "data"
    data.mkdir()
    connection = make_database(data / "hacc.sqlite3")
    try:
        photo = data / "storage" / "proof.jpg"
        photo.parent.mkdir()
        photo.write_bytes(b"photo de test")
        (data / "other.db").write_bytes(b"autre fichier")
        snapshot = tmp_path / "snapshot"
        sqlite_snapshot.create_snapshot(data, snapshot)

        environment = os.environ.copy()
        environment["RESTIC_REPOSITORY"] = str(tmp_path / "repository")
        environment["RESTIC_PASSWORD"] = "test-only-restic-password"

        def restic_command(*arguments):
            result = subprocess.run(
                [restic, "--no-cache", *arguments],
                env=environment, capture_output=True, text=True,
            )
            if result.returncode:
                pytest.fail(f"restic {arguments[0]} a échoué ({result.returncode}) :\n{result.stderr}\n{result.stdout}")

        restic_command("init")
        exclusions = []
        for suffix in (".sqlite3", ".sqlite3-wal", ".sqlite3-shm", ".sqlite", ".sqlite-wal",
                       ".sqlite-shm", ".db", ".db-wal", ".db-shm"):
            exclusions.extend(["--exclude", f"{data.as_posix()}/**/*{suffix}"])
        restic_command("backup", *exclusions, str(data), str(snapshot))
        restored = tmp_path / "restored"
        source_tree = tmp_path.resolve().as_posix()
        if os.name == "nt":
            source_tree = f"/{source_tree[0]}{source_tree[2:]}"
        restic_command("restore", f"latest:{source_tree}", "--target", str(restored), "--verify")

        manifest_path = next(restored.rglob(sqlite_snapshot.MANIFEST))
        restored_snapshot = manifest_path.parent
        sqlite_snapshot.verify_snapshot(restored_snapshot)
        with closing(sqlite3.connect((restored_snapshot / "hacc.sqlite3").as_uri() + "?mode=ro&immutable=1", uri=True)) as database:
            assert database.execute("SELECT name FROM documents").fetchone() == ("preuve de test",)
        assert (restored_snapshot / "other.db").read_bytes() == b"autre fichier"
        restored_photo = next(restored.rglob("proof.jpg"))
        assert restored_photo.read_bytes() == b"photo de test"
        assert not (restored_photo.parent.parent / "hacc.sqlite3").exists()
    finally:
        connection.close()


def test_backup_password_is_shown_before_first_operation_that_can_fail():
    script = SCRIPT.with_name("prepare-backup.sh").read_text(encoding="utf-8")
    password_display = script.index('cat "$PASSWORD_FILE"')
    assert password_display < script.index("restic cat config")
    assert password_display < script.index("systemctl start sirius-backup.service")


def test_backup_checks_flock_availability_before_locking():
    script = SCRIPT.with_name("backup.sh").read_text(encoding="utf-8")
    assert script.index("command -v flock") < script.index("flock -n 9")

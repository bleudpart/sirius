import json
import asyncio
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from enterprise import _backup_company, _restore_company_archive, _user_context


class FakeCursor:
    def __init__(self, documents):
        self.documents = list(documents)

    def sort(self, *_args):
        return self

    async def to_list(self, _limit):
        return list(self.documents)


class FakeCollection:
    def __init__(self, documents=None):
        self.documents = list(documents or [])

    async def find_one(self, query, *_args):
        return next((item for item in self.documents if all(item.get(k) == v for k, v in query.items())), None)

    def find(self, query, *_args):
        return FakeCursor([item for item in self.documents if all(item.get(k) == v for k, v in query.items())])

    async def insert_one(self, document):
        self.documents.append(document)

    async def delete_many(self, query):
        self.documents = [item for item in self.documents if not all(item.get(k) == v for k, v in query.items())]

    async def insert_many(self, documents):
        self.documents.extend(documents)


class FakeDb:
    def __init__(self):
        self.enterprise_companies = FakeCollection([{"id": "company_test", "name": "Bistrot test"}])
        self.enterprise_members = FakeCollection([])
        self.enterprise_sites = FakeCollection([])
        self.enterprise_audit = FakeCollection([])
        self.haccp_trace = FakeCollection([{"id": "trace_1", "company_id": "company_test", "produit": "Lait"}])
        for collection in ("haccp_equip", "haccp_temp", "haccp_pms", "haccp_nc", "haccp_clean", "haccp_clean_log", "haccp_allerg", "haccp_docs", "haccp_controls", "user_files"):
            setattr(self, collection, FakeCollection([]))


def test_backup_contains_manifest_and_company_data(tmp_path, monkeypatch):
    db = FakeDb()
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    company = {"id": "company_test", "name": "Bistrot test"}
    path = asyncio.run(_backup_company(db, company, {"email": "admin@example.test"}))

    assert path.exists()
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        trace = json.loads(archive.read("mongo/haccp_trace.json"))
    assert manifest["company"]["id"] == "company_test"
    assert trace[0]["produit"] == "Lait"
    assert "uploads/documents/company_test" not in archive.namelist()
    assert db.enterprise_audit.documents[0]["action"] == "backup.create"


def test_backup_scopes_company_files(tmp_path, monkeypatch):
    db = FakeDb()
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    own_file = tmp_path / "uploads" / "documents" / "company_test" / "temperature.pdf"
    other_file = tmp_path / "uploads" / "documents" / "other_company" / "private.pdf"
    own_file.parent.mkdir(parents=True)
    other_file.parent.mkdir(parents=True)
    own_file.write_bytes(b"own")
    other_file.write_bytes(b"other")

    path = asyncio.run(_backup_company(db, {"id": "company_test", "name": "Bistrot test"}, {"email": "admin@example.test"}))

    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
    assert "uploads/documents/company_test/temperature.pdf" in names
    assert "uploads/documents/other_company/private.pdf" not in names


def test_restore_replaces_company_data_and_files(tmp_path, monkeypatch):
    db = FakeDb()
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    source = tmp_path / "uploads" / "documents" / "company_test" / "old.pdf"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"old")
    archive_path = asyncio.run(_backup_company(db, {"id": "company_test", "name": "Bistrot test"}, {"email": "admin@example.test"}))
    source.write_bytes(b"stale")
    db.haccp_trace.documents = [{"id": "stale", "company_id": "company_test"}]

    with zipfile.ZipFile(archive_path) as archive:
        raw = archive_path.read_bytes()
    result = asyncio.run(_restore_company_archive(db, "company_test", raw))

    assert result["files"] == 1
    assert source.read_bytes() == b"old"
    assert db.haccp_trace.documents[0]["id"] == "trace_1"


def test_restore_rejects_archive_for_another_company(tmp_path, monkeypatch):
    db = FakeDb()
    monkeypatch.setenv("SIRIUS_DATA_DIR", str(tmp_path))
    archive_path = asyncio.run(_backup_company(db, {"id": "other_company", "name": "Autre"}, {"email": "admin@example.test"}))

    with pytest.raises(Exception):
        asyncio.run(_restore_company_archive(db, "company_test", archive_path.read_bytes()))


def test_user_context_returns_membership(monkeypatch):
    db = FakeDb()
    db.enterprise_members.documents.append({"company_id": "company_test", "user_id": "user_1", "role": "admin"})

    async def fake_require_user(_request, _db):
        return {"user_id": "user_1", "email": "admin@example.test", "role": "admin"}

    monkeypatch.setattr("enterprise.require_user", fake_require_user)
    user, company, membership = asyncio.run(_user_context(object(), db))

    assert user["user_id"] == "user_1"
    assert company["name"] == "Bistrot test"
    assert membership["role"] == "admin"
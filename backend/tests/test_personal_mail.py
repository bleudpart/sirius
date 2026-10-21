import email
import imaplib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import personal_mail


class Collection:
    def __init__(self):
        self.documents = {}

    async def find_one(self, query, *args, **kwargs):
        document = self.documents.get(query.get("_id"))
        return dict(document) if document else None

    async def update_one(self, query, update, upsert=False):
        self.documents.setdefault(query["_id"], {"_id": query["_id"]}).update(update["$set"])

    async def delete_one(self, query):
        self.documents.pop(query["_id"], None)


class Database:
    def __init__(self):
        self.personal_mail = Collection()
        self.users = Collection()


@pytest.fixture
def api(monkeypatch):
    db = Database()
    calls = {"login": [], "sent": []}

    async def uid(request, database):
        return "user-1"

    async def no_ispdb(domain):
        return None

    def login(cfg, password):
        calls["login"].append((dict(cfg), password))
        if password != "bon":
            raise imaplib.IMAP4.error("AUTHENTICATIONFAILED")

    monkeypatch.setattr(personal_mail, "resolve_user_id", uid)
    monkeypatch.setattr(personal_mail, "_fetch_ispdb", no_ispdb)
    monkeypatch.setattr(personal_mail, "_public_host", lambda host, port: None)
    monkeypatch.setattr(personal_mail, "_check_login", login)
    monkeypatch.setattr(personal_mail, "_send", lambda cfg, password, message: calls["sent"].append((cfg, password, message)))
    personal_mail._failures.clear()
    app = FastAPI()
    app.include_router(personal_mail.make_personal_mail_router(db), prefix="/api")
    return TestClient(app), db, calls


def test_detects_french_providers_and_routes_gmail_to_one_click():
    import asyncio
    orange = asyncio.run(personal_mail.detect("lea@orange.fr"))
    assert (orange["label"], orange["imap_host"], orange["smtp_port"]) == ("Orange", "imap.orange.fr", 465)
    assert asyncio.run(personal_mail.detect("lea@icloud.com"))["app_password"] is True
    assert asyncio.run(personal_mail.detect("lea@hotmail.fr"))["oauth"] == "microsoft"


def test_connect_checks_login_and_stores_password_encrypted(api):
    client, db, calls = api
    response = client.post("/api/personal-mail/connect", json={"email": " Lea@Free.fr ", "password": "bon"})
    assert response.json() == {"connected": True, "email": "lea@free.fr", "label": "Free"}
    assert calls["login"][0][0]["imap_host"] == "imap.free.fr"
    stored = db.personal_mail.documents["user-1"]
    assert "bon" not in str(stored)
    assert personal_mail.decrypt_password(stored["password_enc"]) == "bon"
    assert client.get("/api/personal-mail/status").json() == {"connected": True, "email": "lea@free.fr", "label": "Free"}


def test_wrong_password_gives_clear_help_and_is_rate_limited(api):
    client, db, _ = api
    response = client.post("/api/personal-mail/connect", json={"email": "lea@yahoo.fr", "password": "faux"})
    assert response.status_code == 400
    assert "mot de passe d'application" in response.json()["detail"]
    assert db.personal_mail.documents == {}
    for _ in range(4):
        client.post("/api/personal-mail/connect", json={"email": "lea@yahoo.fr", "password": "faux"})
    assert client.post("/api/personal-mail/connect", json={"email": "lea@yahoo.fr", "password": "bon"}).status_code == 429


def test_gmail_and_unknown_domains_are_guided(api):
    client, _, calls = api
    gmail = client.post("/api/personal-mail/connect", json={"email": "lea@gmail.com", "password": "bon"})
    assert "Connecter Google" in gmail.json()["detail"]
    unknown = client.post("/api/personal-mail/connect", json={"email": "lea@exemple-inconnu.fr", "password": "bon"})
    assert unknown.status_code == 422 and "Réglages avancés" in unknown.json()["detail"]
    manual = client.post("/api/personal-mail/connect", json={
        "email": "lea@exemple-inconnu.fr", "password": "bon",
        "imap_host": "imap.exemple-inconnu.fr", "smtp_host": "smtp.exemple-inconnu.fr", "smtp_port": 587,
    })
    assert manual.status_code == 200
    assert calls["login"][-1][0]["smtp_port"] == 587


def test_send_uses_saved_account_and_signature(api):
    client, _, calls = api
    client.post("/api/personal-mail/connect", json={"email": "lea@sfr.fr", "password": "bon"})
    response = client.post("/api/personal-mail/send", json={"to": "paul@exemple.fr", "subject": "Devis", "body": "Bonjour"})
    assert response.json() == {"ok": True}
    cfg, password, message = calls["sent"][0]
    assert (cfg["smtp_host"], password, message["From"], message["To"]) == ("smtp.sfr.fr", "bon", "lea@sfr.fr", "paul@exemple.fr")
    assert "ΣIRIUS" in message.get_body(("plain",)).get_content()


def test_disconnect_and_unconnected_access(api):
    client, db, _ = api
    assert client.get("/api/personal-mail/messages").status_code == 401
    client.post("/api/personal-mail/connect", json={"email": "lea@laposte.net", "password": "bon"})
    client.post("/api/personal-mail/disconnect")
    assert db.personal_mail.documents == {}
    assert client.get("/api/personal-mail/status").json() == {"connected": False}


def test_internal_servers_and_odd_ports_are_refused():
    with pytest.raises(personal_mail.HTTPException):
        personal_mail._public_host("localhost.localdomain", 993)
    with pytest.raises(personal_mail.HTTPException):
        personal_mail._public_host("imap.orange.fr", 22)


class FakeImap:
    def __init__(self):
        self.readonly = None

    def select(self, box, readonly=False):
        self.readonly = readonly
        return "OK", [b"2"]

    def uid(self, command, *args):
        if command == "search":
            return "OK", [b"7 8"]
        body = email.message_from_string(
            "From: =?utf-8?q?L=C3=A9a?= <lea@orange.fr>\r\nSubject: Rendez-vous\r\n"
            "Date: Tue, 20 Oct 2026 08:30:00 +0200\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBonjour   Daniel"
        ).as_bytes()
        header, text = body.split(b"\n\n", 1)
        flags = b"\\Seen" if args[0] == b"7" else b""
        return "OK", [(b"1 (FLAGS (" + flags + b") BODY[HEADER]", header + b"\n"), (b" BODY[TEXT]<0>", text), b")"]

    def logout(self):
        pass


def test_inbox_is_read_only_and_formatted(monkeypatch):
    fake = FakeImap()
    monkeypatch.setattr(personal_mail, "_imap_login", lambda cfg, password: fake)
    mails = personal_mail._read_inbox({"email": "moi@orange.fr"}, "bon", 25)
    assert fake.readonly is True
    assert [mail["id"] for mail in mails] == ["8", "7"]
    assert mails[0]["de"] == "Léa" and mails[0]["de_email"] == "lea@orange.fr"
    assert mails[0]["recu"] == "2026-10-20 06:30" and mails[0]["apercu"] == "Bonjour Daniel"
    assert (mails[0]["lu"], mails[1]["lu"]) == (False, True)

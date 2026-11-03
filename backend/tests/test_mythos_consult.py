"""Consultations des personnages (SOLON, PROMÉTHÉE, PYTHAGORE, HERMÈS AGORA) : avis, historique, PDF, e-mail."""
import asyncio
import io
import json
import smtplib
import unicodedata
import zipfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auth_api
import modules_api
import personal_mail
import provider_access as access
import sirius_brain
import themis_api
from local_docstore import LocalDocStore

ANSWER = "FAITS\nLe bail est commercial.\nDROIT\nArticle L145-4 du Code de commerce.\nANALYSE\nOK.\nOPTIONS\nNégocier."


class FakeLLM:
    keys = []
    requests = []
    content = json.dumps({"reponse": ANSWER, "popups": []}, ensure_ascii=False)
    failure = None

    def __init__(self, api_key=None, **kwargs):
        FakeLLM.keys.append(api_key)
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        FakeLLM.requests.append(kwargs)
        if FakeLLM.failure:
            raise FakeLLM.failure
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=FakeLLM.content))])


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.delenv("SIRIUS_PACKAGED", raising=False)
    monkeypatch.delenv("SIRIUS_QUOTA", raising=False)
    FakeLLM.keys, FakeLLM.requests, FakeLLM.failure = [], [], None
    FakeLLM.content = json.dumps({"reponse": ANSWER, "popups": []}, ensure_ascii=False)
    monkeypatch.setattr(sirius_brain, "ENV_K3_KEY", "owner-kimi")
    monkeypatch.setattr(sirius_brain, "AsyncOpenAI", FakeLLM)
    sirius_brain._k3_clients.clear()
    db = LocalDocStore(str(tmp_path / "consult.db"))
    app = FastAPI()
    app.add_middleware(access.ProviderAccessMiddleware, db=db)
    app.include_router(modules_api.make_modules_router(db), prefix="/api")
    yield SimpleNamespace(db=db, client=TestClient(app))
    sirius_brain._k3_clients.clear()


def login(db, uid, role="admin", started=None):
    user = {"user_id": uid, "email": f"{uid}@example.test", "role": role, "trial_started_at": started}
    asyncio.run(db.users.insert_one(dict(user)))
    return {"Authorization": "Bearer " + auth_api.create_access_token(user)}


def consult(env, headers, module="SOLON#", question="Mon bailleur peut-il résilier le bail ?", **extra):
    return env.client.post("/api/mythos/consult", json={"module": module, "question": question, **extra}, headers=headers)


def history(env, headers, **params):
    response = env.client.get("/api/mythos/consult/history", params=params, headers=headers)
    assert response.status_code == 200
    return response.json()["history"]


def test_every_consult_route_needs_an_account(env):
    client = env.client
    assert client.post("/api/mythos/consult", json={"module": "SOLON#", "question": "x"}).status_code == 401
    assert client.get("/api/mythos/consult/history", params={"module": "SOLON#"}).status_code == 401
    assert client.post("/api/mythos/consult/history", json={"module": "SOLON#", "a": "x"}).status_code == 401
    assert client.delete("/api/mythos/consult/history/abc").status_code == 401
    assert client.post("/api/mythos/consult/pdf", json={"module": "SOLON#", "reponse": "x"}).status_code == 401
    assert client.post("/api/mythos/consult/email", json={"module": "SOLON#", "reponse": "x"}).status_code == 401


def test_consult_uses_the_character_prompt_and_is_saved_in_the_history(env):
    headers = login(env.db, "admin-user")
    response = consult(env, headers)
    assert response.status_code == 200
    assert response.json() == {"ok": True, "reponse": ANSWER}
    request = FakeLLM.requests[0]
    assert request["max_tokens"] == modules_api.CONSULT_MAX_TOKENS
    assert request["extra_body"] == {"thinking": {"type": "disabled"}}
    assert request["timeout"] == modules_api.LLM_TIMEOUT
    assert "SOLON" in request["messages"][0]["content"] and "DROIT FRANÇAIS" in request["messages"][0]["content"]
    assert request["messages"][1]["content"] == "Mon bailleur peut-il résilier le bail ?"
    [entry] = history(env, headers, module="SOLON#")
    assert set(entry) == {"id", "module", "q", "a", "date"}
    assert entry["module"] == "SOLON#" and entry["a"] == ANSWER
    assert entry["q"] == "Mon bailleur peut-il résilier le bail ?"
    assert datetime.fromisoformat(entry["date"]).tzinfo is not None


@pytest.mark.parametrize("module", ["SOLON#", "PROMÉTHÉE#", "PYTHAGORE#", "HERMÈS AGORA#"])
def test_each_character_with_a_consultation_answers(env, module):
    response = consult(env, login(env.db, "admin-user"), module=module)
    assert response.status_code == 200 and response.json()["reponse"] == ANSWER


def test_consult_validation_errors_do_not_call_the_model(env):
    headers = login(env.db, "admin-user")
    unknown = consult(env, headers, module="ARGUS#")
    assert unknown.status_code == 404 and unknown.json()["detail"] == modules_api.CONSULT_UNKNOWN
    assert consult(env, headers, question="   ").status_code == 422
    too_long = consult(env, headers, question="x" * (modules_api.CONSULT_QUESTION_MAX + 1))
    assert too_long.status_code == 413
    assert FakeLLM.requests == []
    assert history(env, headers) == []


def test_consult_accepts_a_decomposed_unicode_module_name(env):
    headers = login(env.db, "admin-user")
    decomposed = unicodedata.normalize("NFD", "PROMÉTHÉE#")
    assert decomposed != "PROMÉTHÉE#"
    assert consult(env, headers, module=decomposed).status_code == 200
    assert [item["module"] for item in history(env, headers, module=decomposed)] == ["PROMÉTHÉE#"]


def test_consult_accepts_a_plain_text_answer(env):
    FakeLLM.content = "FAITS\nTexte brut sans JSON."
    response = consult(env, login(env.db, "admin-user"))
    assert response.status_code == 200 and response.json()["reponse"] == "FAITS\nTexte brut sans JSON."


def test_consult_model_failure_is_explicit_and_leaves_no_history(env):
    headers = login(env.db, "admin-user")
    FakeLLM.failure = RuntimeError("provider down")
    response = consult(env, headers)
    assert response.status_code == 502
    assert "momentanément indisponible" in response.json()["detail"]
    assert history(env, headers) == []
    FakeLLM.failure = None
    FakeLLM.content = json.dumps({"reponse": "   "})
    assert consult(env, headers).status_code == 502
    assert history(env, headers) == []


@pytest.mark.parametrize("content", [
    "", "   ", json.dumps({"reponse": ""}), json.dumps({"reponse": "", "popups": []}), json.dumps({"plan": " "}),
])
def test_consult_empty_model_output_is_a_502_and_never_shown_as_json(env, content):
    headers = login(env.db, "admin-user")
    FakeLLM.content = content
    response = consult(env, headers)
    assert response.status_code == 502 and "aucune réponse" in response.json()["detail"]
    assert history(env, headers) == []


def test_consult_answer_takes_the_first_non_empty_text():
    assert modules_api._consult_answer(json.dumps({"reponse": "", "plan": " Étape 1 "})) == "Étape 1"
    assert modules_api._consult_answer(json.dumps({"autre": "x"})) == json.dumps({"autre": "x"})


def test_consult_accepts_the_raw_line_breaks_kimi_writes_inside_the_json_string(env):
    FakeLLM.content = '{"reponse": "FAITS\nLe bail est commercial.\nDROIT\nArticle L145-4.", "popups": []}'
    response = consult(env, login(env.db, "admin-user"))
    assert response.status_code == 200
    assert response.json()["reponse"] == "FAITS\nLe bail est commercial.\nDROIT\nArticle L145-4."


@pytest.mark.parametrize("content", [
    '{"reponse": "FAITS\\nLe bail est commercial.\\nDROIT\\nArticle L145-4 du Code de comm',
    '{"reponse": "FAITS\nLe bail est commercial.\nDROIT\nArticle L145-4 du Code de comm',
    '{"reponse": "FAITS\\nLe bail est commercial.\\nDROIT\\nArticle L145-4 du Code de comm", "popups": [{"titre": "A", "contenu": "B"}',
])
def test_consult_keeps_the_text_written_before_the_token_limit_cut_the_json(env, content):
    FakeLLM.content = content
    response = consult(env, login(env.db, "admin-user"))
    assert response.status_code == 200
    answer = response.json()["reponse"]
    assert answer.startswith("FAITS\nLe bail est commercial.\nDROIT\nArticle L145-4 du Code de comm")
    assert "{" not in answer and "reponse" not in answer


def test_consult_waits_for_the_model_only_up_to_the_timeout(env, monkeypatch):
    headers = login(env.db, "admin-user")

    async def never_answers(self, **kwargs):
        await asyncio.sleep(30)

    monkeypatch.setattr(FakeLLM, "_create", never_answers)
    monkeypatch.setattr(modules_api, "LLM_TIMEOUT", 0.05)
    response = consult(env, headers)
    assert response.status_code == 502 and "momentanément indisponible" in response.json()["detail"]
    assert history(env, headers) == []


def test_history_is_private_filtered_and_sorted_newest_first(env):
    alice, bob = login(env.db, "alice"), login(env.db, "bob")
    client = env.client
    posted = []
    for day, module in (("2025-03-01T08:00:00Z", "SOLON#"), ("2025-03-03T08:00:00Z", "SOLON#"), ("2025-03-02T08:00:00Z", "PROMÉTHÉE#")):
        response = client.post("/api/mythos/consult/history", json={"module": module, "q": f"q {day}", "a": f"a {day}", "date": day}, headers=alice)
        assert response.status_code == 200
        entry = response.json()["entry"]
        assert set(entry) == {"id", "module", "q", "a", "date"}
        posted.append(entry)
    assert posted[0]["date"] == "2025-03-01T08:00:00+00:00"
    assert [item["q"] for item in history(env, alice)] == ["q 2025-03-03T08:00:00Z", "q 2025-03-02T08:00:00Z", "q 2025-03-01T08:00:00Z"]
    assert [item["module"] for item in history(env, alice, module="SOLON#")] == ["SOLON#", "SOLON#"]
    assert history(env, bob) == []
    assert client.delete(f"/api/mythos/consult/history/{posted[0]['id']}", headers=bob).status_code == 404
    assert len(history(env, alice)) == 3


def test_history_delete_removes_only_the_requested_entry(env):
    headers = login(env.db, "alice")
    first = env.client.post("/api/mythos/consult/history", json={"module": "SOLON#", "q": "a", "a": "A"}, headers=headers).json()["entry"]
    second = env.client.post("/api/mythos/consult/history", json={"module": "SOLON#", "q": "b", "a": "B"}, headers=headers).json()["entry"]
    deleted = env.client.delete(f"/api/mythos/consult/history/{first['id']}", headers=headers)
    assert deleted.status_code == 200 and deleted.json() == {"ok": True}
    assert [item["id"] for item in history(env, headers)] == [second["id"]]
    missing = env.client.delete(f"/api/mythos/consult/history/{first['id']}", headers=headers)
    assert missing.status_code == 404 and missing.json()["detail"] == "Consultation introuvable."


def test_history_post_validation_and_date_fallback(env):
    headers = login(env.db, "alice")
    client = env.client
    assert client.post("/api/mythos/consult/history", json={"module": "ARGUS#", "a": "x"}, headers=headers).status_code == 404
    assert client.post("/api/mythos/consult/history", json={"module": "SOLON#", "a": "  "}, headers=headers).status_code == 422
    entry = client.post("/api/mythos/consult/history", json={"module": "SOLON#", "a": "x", "date": "12/03/2025"}, headers=headers).json()["entry"]
    parsed = datetime.fromisoformat(entry["date"])
    assert abs(datetime.now(timezone.utc) - parsed) < timedelta(minutes=1)
    long_entry = client.post("/api/mythos/consult/history", json={"module": "SOLON#", "q": "q" * 9000, "a": "a" * 30000}, headers=headers).json()["entry"]
    assert len(long_entry["q"]) == modules_api.CONSULT_QUESTION_MAX
    assert len(long_entry["a"]) == modules_api.CONSULT_TEXT_MAX


def test_history_keeps_only_the_most_recent_entries_per_module(env, monkeypatch):
    monkeypatch.setattr(modules_api, "CONSULT_HISTORY_MAX", 3)
    headers = login(env.db, "alice")
    for day in range(1, 6):
        env.client.post("/api/mythos/consult/history", json={"module": "SOLON#", "q": f"solon {day}", "a": "A", "date": f"2025-01-0{day}T00:00:00Z"}, headers=headers)
    env.client.post("/api/mythos/consult/history", json={"module": "PROMÉTHÉE#", "q": "plan", "a": "A", "date": "2024-01-01T00:00:00Z"}, headers=headers)
    assert [item["q"] for item in history(env, headers, module="SOLON#")] == ["solon 5", "solon 4", "solon 3"]
    assert [item["q"] for item in history(env, headers, module="PROMÉTHÉE#")] == ["plan"]


def test_pdf_export_for_solon_and_promethee_only(env):
    headers = login(env.db, "alice")
    for module, filename in (("SOLON#", "solon-avis.pdf"), ("PROMÉTHÉE#", "promethee-plan.pdf")):
        response = env.client.post("/api/mythos/consult/pdf", json={"module": module, "question": "Question", "reponse": ANSWER, "date": "12/03/2025"}, headers=headers)
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pdf"
        assert response.headers["content-disposition"] == f'attachment; filename="{filename}"'
        assert response.content.startswith(b"%PDF")
    refused = env.client.post("/api/mythos/consult/pdf", json={"module": "PYTHAGORE#", "reponse": ANSWER}, headers=headers)
    assert refused.status_code == 404 and refused.json()["detail"] == modules_api.CONSULT_UNKNOWN


def email_payload(**changes):
    payload = {
        "module": "SOLON#", "question": "Question", "reponse": ANSWER, "date": "12/03/2025",
        "to": "client@example.org", "subject": "",
        "smtp": {"host": "smtp.example.org", "port": 587, "user": "me", "password": "secret", "from_email": "me@example.org", "from_name": "ΣIRIUS — PANTHÉON"},
    }
    payload.update(changes)
    return payload


def test_email_checks_module_then_recipient_then_smtp_without_422(env):
    headers = login(env.db, "alice")
    post = lambda payload: env.client.post("/api/mythos/consult/email", json=payload, headers=headers)
    unknown = post(email_payload(module="PYTHAGORE#", to="pas-une-adresse"))
    assert unknown.status_code == 404 and unknown.json()["detail"] == modules_api.CONSULT_UNKNOWN
    for bad in ("", "sans-arobase", "a@b", "a@b.fr, c@d.fr", "a b@c.fr", "a@b.fr\nBcc: x@y.fr"):
        invalid = post(email_payload(to=bad))
        assert invalid.status_code == 400, bad
        assert invalid.json()["detail"] == "Adresse e-mail du destinataire invalide."
    for smtp in ({}, {"host": "  "}, {"port": 587}):
        missing = post(email_payload(smtp=smtp))
        assert missing.status_code == 400 and "Serveur SMTP non configuré" in missing.json()["detail"]
    no_smtp = email_payload()
    del no_smtp["smtp"]
    assert "Serveur SMTP non configuré" in post(no_smtp).json()["detail"]
    broken = post(email_payload(smtp={"host": "smtp.example.org", "port": "abc"}))
    assert broken.status_code == 400 and broken.json()["detail"] == "Configuration SMTP invalide."


def test_email_sends_the_pdf_with_the_account_signature(env, monkeypatch):
    headers = login(env.db, "alice")
    sent = []
    monkeypatch.setattr(personal_mail, "_public_host", lambda host, port: None)
    monkeypatch.setattr(
        themis_api, "_send_smtp",
        lambda conf, to, subject, body, pdf, name, **identity: sent.append(SimpleNamespace(conf=conf, to=to, subject=subject, body=body, pdf=pdf, name=name, identity=identity)))
    response = env.client.post("/api/mythos/consult/email", json=email_payload(subject="Mon\r\nsujet  perso"), headers=headers)
    assert response.status_code == 200 and response.json() == {"ok": True, "sent_to": "client@example.org"}
    [mail] = sent
    assert mail.conf.host == "smtp.example.org" and mail.conf.port == 587 and mail.conf.user == "me"
    assert mail.to == "client@example.org" and mail.subject == "Mon sujet perso"
    assert "l'avis juridique de SOLON (consultation du 12/03/2025)" in mail.body
    assert mail.name == "solon-avis.pdf" and mail.pdf.startswith(b"%PDF")
    assert mail.identity["signature_email"] == "alice@example.test"
    sent.clear()
    plan = env.client.post("/api/mythos/consult/email", json=email_payload(module="PROMÉTHÉE#", date=""), headers=headers)
    assert plan.status_code == 200
    assert sent[0].name == "promethee-plan.pdf" and sent[0].subject == "Plan de projet PROMÉTHÉE — ΣIRIUS"
    assert sent[0].body.endswith("le plan de projet de PROMÉTHÉE.\n\nCordialement.")


@pytest.mark.parametrize("failure, status_text", [
    (smtplib.SMTPAuthenticationError(535, b"bad credentials"), "Authentification SMTP refusée"),
    (smtplib.SMTPRecipientsRefused({"x@y.fr": (550, b"no")}), "Envoi refusé par le serveur SMTP"),
    (OSError("connection refused"), "Serveur SMTP injoignable"),
    (ValueError("boom"), "Envoi impossible"),
])
def test_email_smtp_failures_are_explicit_400(env, monkeypatch, failure, status_text):
    headers = login(env.db, "alice")
    monkeypatch.setattr(personal_mail, "_public_host", lambda host, port: None)

    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(themis_api, "_send_smtp", fail)
    response = env.client.post("/api/mythos/consult/email", json=email_payload(), headers=headers)
    assert response.status_code == 400
    assert status_text in response.json()["detail"]
    assert "secret" not in response.text


def test_email_never_reaches_internal_or_unusual_servers(env, monkeypatch):
    headers = login(env.db, "alice")
    monkeypatch.setattr(themis_api, "_send_smtp", lambda *args, **kwargs: pytest.fail("SMTP contacted"))

    def post(**smtp):
        return env.client.post("/api/mythos/consult/email", json=email_payload(smtp={"host": "smtp.example.org", "port": 587, **smtp}), headers=headers)

    assert post(host="localhost").status_code == 400
    assert post(host="10.0.0.5").status_code == 400
    assert post(port=6379).json()["detail"] == "Serveur ou port de messagerie invalide."
    monkeypatch.setattr(personal_mail.socket, "getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("127.0.0.1", 587))])
    internal = post(host="smtp.example.org")
    assert internal.status_code == 400 and internal.json()["detail"] == "Serveur de messagerie non autorisé."


def test_expired_trial_needs_a_personal_key_but_keeps_history_tools(env):
    expired = login(env.db, "expired", role="user", started=access.utc_now() - timedelta(days=16))
    denied = consult(env, expired)
    assert denied.status_code == 403 and denied.json()["detail"] == access.PERSONAL_REQUIRED
    assert "owner-kimi" not in denied.text and FakeLLM.requests == []
    allowed = consult(env, expired, keys={"k3": "personal-kimi"})
    assert allowed.status_code == 200 and allowed.json()["reponse"] == ANSWER
    assert FakeLLM.keys == ["personal-kimi"]
    assert len(history(env, expired)) == 1
    pdf = env.client.post("/api/mythos/consult/pdf", json={"module": "SOLON#", "reponse": ANSWER}, headers=expired)
    assert pdf.status_code == 200


def chat_units(env, uid):
    doc = asyncio.run(env.db.usage_quota.find_one({"user_id": uid}))
    return int((doc or {}).get("chat") or 0)


def test_active_trial_account_consults_with_the_owner_key_and_is_counted_in_the_daily_quota(env):
    trial = login(env.db, "trial", role="user", started=access.utc_now())
    response = consult(env, trial)
    assert response.status_code == 200 and response.json()["reponse"] == ANSWER
    assert FakeLLM.keys == ["owner-kimi"]
    assert chat_units(env, "trial") == 1


def test_consult_with_a_personal_key_is_not_counted_in_the_daily_quota(env):
    trial = login(env.db, "trial", role="user", started=access.utc_now())
    assert consult(env, trial, keys={"k3": "personal-kimi"}).status_code == 200
    assert FakeLLM.keys == ["personal-kimi"]
    assert chat_units(env, "trial") == 0


def test_daily_limit_withholds_the_owner_key_but_not_a_personal_one(env, monkeypatch):
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    trial = login(env.db, "trial", role="user", started=access.utc_now())
    assert consult(env, trial).status_code == 200
    limited = consult(env, trial)
    assert limited.status_code == 429 and "Limite quotidienne" in limited.json()["detail"]
    assert len(FakeLLM.requests) == 1
    assert consult(env, trial, keys={"k3": "personal-kimi"}).status_code == 200
    assert FakeLLM.keys == ["owner-kimi", "personal-kimi"]
    assert len(history(env, trial)) == 2


def test_consult_history_is_exported_with_the_account_data_and_covered_by_erasure(env):
    alice, bob = login(env.db, "alice"), login(env.db, "bob")
    for headers, question in ((alice, "question d'alice"), (bob, "question de bob")):
        env.client.post("/api/mythos/consult/history", json={"module": "SOLON#", "q": question, "a": "A"}, headers=headers)
    app = FastAPI()
    app.include_router(auth_api.make_auth_router(env.db), prefix="/api")
    export = TestClient(app).get("/api/auth/privacy/export", headers=alice)
    assert export.status_code == 200
    with zipfile.ZipFile(io.BytesIO(export.content)) as archive:
        data = json.loads(archive.read("sirius-personal-data.json"))
    assert [item["q"] for item in data["collections"]["consult_history"]] == ["question d'alice"]
    from account_deletion import PERSONAL_COLLECTIONS
    assert "consult_history" in PERSONAL_COLLECTIONS

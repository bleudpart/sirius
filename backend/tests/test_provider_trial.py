import asyncio
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient
from starlette.requests import Request

import auth_api
import provider_access as access
import usage_quota
from local_docstore import LocalDocStore
from routes import voice_io


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.delenv("SIRIUS_PACKAGED", raising=False)
    monkeypatch.delenv("SIRIUS_QUOTA", raising=False)
    return LocalDocStore(str(tmp_path / "trial.db"))


def account(uid="trial-user", started=None, role="user"):
    return {"user_id": uid, "email": f"{uid}@example.test", "role": role, "trial_started_at": started}


def test_activation_is_atomic_persisted_and_never_resets(db):
    async def scenario():
        user = account()
        await db.users.insert_one(user)
        results = await asyncio.gather(*(access.activate_trial(db, user) for _ in range(20)))
        starts = {str(result["trial_started_at"]) for result in results}
        assert len(starts) == 1
        persisted = await db.users.find_one({"user_id": user["user_id"]})
        restarted = LocalDocStore(db._path)
        assert (await access.activate_trial(restarted, user))["trial_started_at"] == persisted["trial_started_at"]
        assert (await access.activate_trial(db, persisted))["trial_started_at"] == persisted["trial_started_at"]
    asyncio.run(scenario())


def test_trial_exact_seven_day_boundary_and_admin():
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    user = account(started=start.isoformat())
    boundary = start + timedelta(days=7)
    assert access.trial_status(user, boundary - timedelta(microseconds=1))["state"] == "active"
    assert access.trial_status(user, boundary)["state"] == "expired"
    assert access.trial_status(user, boundary)["remaining_seconds"] == 0
    assert access.trial_status(account(role="admin"), boundary)["state"] == "admin"
    assert access.trial_status(account(), boundary)["state"] == "expired"


@pytest.mark.parametrize("quota_flag", ["off", "0", "false", "on"])
def test_expiration_enforced_even_when_quota_disabled(db, monkeypatch, quota_flag):
    monkeypatch.setenv("SIRIUS_QUOTA", quota_flag)
    expired = account(started=access.utc_now() - timedelta(days=7))
    with pytest.raises(HTTPException) as failure:
        asyncio.run(usage_quota.consume(db, expired, "chat"))
    assert failure.value.status_code == 403
    assert "7 jours" in failure.value.detail
    asyncio.run(usage_quota.consume(db, account(role="admin"), "chat"))


def test_personal_keys_isolate_concurrent_tasks_and_do_not_fallback():
    async def request(key):
        expired = account(started=access.utc_now() - timedelta(days=8))
        with access.provider_scope(expired, {"groq_key": key}):
            await asyncio.sleep(0)
            assert access.provider_key("groq", "owner-secret") == key
            # Expired: no owner key for any provider, whatever personal keys are present.
            assert access.provider_key("k3", "owner-kimi") == ""
            async def child():
                await asyncio.sleep(0)
                return access.provider_key("groq", "owner-secret")
            return await asyncio.create_task(child())
    async def scenario():
        assert await asyncio.gather(request("bad-personal"), request("other-personal")) == ["bad-personal", "other-personal"]
    asyncio.run(scenario())
    with access.provider_scope(account(started=access.utc_now()), {"groq_key": "bad-personal", "gmaps": "personal-maps"}):
        # Active trial, per-provider precedence: own Groq key is never replaced by the owner's,
        # while providers without a personal key keep the trial owner key.
        assert access.provider_key("groq", "owner-secret") == "bad-personal"
        assert access.provider_key("k3", "owner-kimi") == "owner-kimi"
        assert access.provider_key("gmaps", "owner-maps") == "personal-maps"
        assert access.denial_error("groq", "owner-secret") is None


@pytest.fixture
def api(db, monkeypatch):
    user = account(started=access.utc_now() - timedelta(days=8))
    asyncio.run(db.users.insert_one(user))
    app = FastAPI()
    app.add_middleware(access.ProviderAccessMiddleware, db=db)
    app.include_router(voice_io.make_voice_io_router(db), prefix="/api")

    @app.post("/api/task/image")
    async def optional(request: Request):
        key = access.require_env_key("gemini", "GEMINI_API_KEY", keys=(await request.json()).get("keys", {}))
        if key == "owner-gemini-image":
            pytest.fail("Owner provider key used after trial")
        if not key:
            raise HTTPException(status_code=500, detail="Clé Gemini absente")
        return {"used": "personal" if key == "personal" else "other"}

    @app.post("/api/themis/pieces/upload")
    async def local_tool():
        return {"ok": True, "owner": access.provider_key("groq", "owner-local")}

    @app.post("/api/chat/stream")
    async def stream(request: Request):
        user = await auth_api.require_user(request, db)
        access.bind_keys((await request.json()).get("keys", {}))
        access.require_personal("groq")
        async def generate():
            await asyncio.sleep(0)
            yield access.provider_key("groq", "owner-chat")
        return StreamingResponse(generate())

    client = TestClient(app)
    client.headers["Authorization"] = "Bearer " + auth_api.create_access_token(user)
    return client, user


def mock_voice(monkeypatch, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(voice_io.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


@pytest.mark.parametrize("path,payload", [
    ("/api/tts/google", {"text": "bonjour"}),
    ("/api/tts/gemini", {"text": "bonjour"}),
    ("/api/tts", {"text": "bonjour"}),
    ("/api/task/image", {"prompt": "bonjour"}),
    ("/api/chat/stream", {"text": "bonjour"}),
])
def test_expired_missing_key_and_optional_modules_never_call_owner(api, monkeypatch, path, payload):
    client, _ = api
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "owner-google")
    monkeypatch.setenv("GEMINI_TTS_API_KEY", "owner-gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "owner-gemini-image")
    mock_voice(monkeypatch, lambda request: pytest.fail("Owner provider called"))
    response = client.post(path, json=payload)
    assert response.status_code == 403
    assert "essai" in response.json()["detail"]


def test_expired_stt_uses_personal_key_not_owner_or_proxy(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("GROQ_KEY", "owner-groq")
    monkeypatch.setenv("STT_BACKEND_URL", "https://owner.invalid/transcribe")
    seen = []
    def provider(request):
        seen.append(request.headers["authorization"])
        assert request.url.host == "api.groq.com"
        return httpx.Response(401, text="bad personal")
    mock_voice(monkeypatch, provider)
    response = client.post("/api/stt", files={"file": ("a.webm", b"audio", "audio/webm")}, data={"groq_key": "bad-personal"})
    assert response.status_code == 502
    assert seen == ["Bearer bad-personal"]
    assert client.post("/api/stt", files={"file": ("a.webm", b"audio", "audio/webm")}).status_code == 403
    assert len(seen) == 1


@pytest.mark.parametrize("service,path,owner_env", [
    ("google_tts", "/api/tts/google", "GOOGLE_TTS_API_KEY"),
    ("gemini_tts", "/api/tts/gemini", "GEMINI_TTS_API_KEY"),
])
def test_personal_tts_invalid_key_never_uses_owner_or_chirp(api, monkeypatch, service, path, owner_env):
    client, _ = api
    monkeypatch.setenv(owner_env, "owner-secret")
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "owner-chirp")
    calls = []
    def provider(request):
        calls.append(request)
        supplied = request.headers.get("x-goog-api-key") or request.url.params.get("key")
        assert supplied == "invalid-personal"
        return httpx.Response(403, text="private upstream detail")
    mock_voice(monkeypatch, provider)
    response = client.post(path, json={"text": "bonjour", "keys": {service: "invalid-personal"}})
    assert response.status_code == 502
    assert len(calls) == 1
    assert "secret" not in response.text and "private upstream" not in response.text


def test_stream_scope_survives_generator_and_anonymous_is_blocked(api):
    client, _ = api
    response = client.post("/api/chat/stream", json={"keys": {"groq_key": "personal"}})
    assert response.status_code == 200 and response.text == "personal"
    client.headers.pop("Authorization")
    assert client.post("/api/chat/stream", json={"keys": {"groq_key": "personal"}}).status_code == 401


def test_database_role_overrides_token_and_activation_returned(db):
    async def scenario():
        user = account()
        await db.users.insert_one(user)
        token = auth_api.create_access_token({**user, "role": "admin"})
        request = Request({"type": "http", "headers": [(b"authorization", f"Bearer {token}".encode())]})
        actual = await auth_api.require_user(request, db)
        assert actual["role"] == "user"
        assert actual["trial_started_at"] is not None
        assert access.owner_allowed(actual)
    asyncio.run(scenario())


def test_optional_llm_and_embedding_do_not_use_owner_after_trial(monkeypatch):
    import sirius_brain
    import semantic_vectors
    monkeypatch.setattr(sirius_brain, "ENV_K3_KEY", "owner-kimi")
    monkeypatch.setattr(sirius_brain, "ENV_GROQ_LLM_KEY", "owner-groq")
    monkeypatch.setattr(semantic_vectors, "_local_model_instance", None)
    monkeypatch.setattr(semantic_vectors, "_EMBED_API_KEY", "owner-embedding")
    with access.provider_scope(account(started=access.utc_now() - timedelta(days=8))):
        assert sirius_brain.k3_client() is None
        assert asyncio.run(sirius_brain.extract_memory_background("prompt", "answer")) == []
        assert asyncio.run(sirius_brain.summarize_episode([{"content": "p"}, {"content": "a"}])) is None
        assert asyncio.run(semantic_vectors._embed_batch(["memory"])) == []


@pytest.fixture
def server_api(db, monkeypatch):
    import server
    monkeypatch.setattr(server, "db", db)
    monkeypatch.setattr(server.cloud_link, "relay_allowed", lambda: False)
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda keys: False)
    server._RATE.clear()
    user = account(started=access.utc_now() - timedelta(days=8))
    asyncio.run(db.users.insert_one(user))
    app = FastAPI()
    app.add_middleware(access.ProviderAccessMiddleware, db=db)
    app.add_api_route("/api/setup/status", server.setup_status, methods=["GET"])
    app.add_api_route("/api/keys/validate", server.keys_validate, methods=["POST"])
    app.add_api_route("/api/chat", server.chat, methods=["POST"])
    app.add_api_route("/api/chat/stream", server.chat_stream, methods=["POST"])
    app.add_api_route("/api/intent", server.ui_intent, methods=["POST"])
    app.add_api_route("/api/setup/test-chat", server.setup_test_chat, methods=["POST"])
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer " + auth_api.create_access_token(user)
    return client, user, server


def test_setup_status_never_contains_provider_or_cloud_credentials(server_api, monkeypatch):
    client, user, server = server_api
    monkeypatch.setenv("GROQ_KEY", "owner-private")
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "owner-voice-private")
    monkeypatch.setattr(server.cloud_link, "load_state", lambda: {"access_token": "private-token", "refresh_token": "private-refresh"})
    response = client.get("/api/setup/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "trial_then_personal"
    assert payload["role"] == "user"
    assert payload["trial"]["state"] == "expired"
    assert payload["trial"]["remaining_seconds"] == 0
    assert payload["quotas"]["enabled"] is False
    states = {service["id"]: (service["state"], service["scope"]) for service in payload["services"]}
    assert states["groq"] == ("not_configured", "personal")
    assert states["google_tts"] == ("not_configured", "personal")
    assert states["fal"] == ("not_configured", "personal")
    assert states["gmaps"] == ("not_configured", "personal")
    assert states["alphavantage"] == ("not_configured", "personal")
    assert states["chat"] == ("not_configured", "personal")
    assert states["stt"] == ("not_configured", "personal")
    assert states["tts"] == ("available", "local")
    assert {service["state"] for service in payload["services"]} <= {"configured", "available", "not_configured", "restricted"}
    assert all(service["description"] and service["description"] != service["scope"] for service in payload["services"])
    assert all(secret not in response.text for secret in ("owner-private", "owner-voice-private", "private-token", "private-refresh"))
    client.headers.pop("Authorization")
    assert client.get("/api/setup/status").status_code == 401


@pytest.mark.parametrize("service,url,payload", [
    ("groq", "api.groq.com", {"data": [{"id": "test"}]}),
    ("google_tts", "texttospeech.googleapis.com", {"voices": [{"name": "test"}]}),
    ("gemini_tts", "generativelanguage.googleapis.com", {"models": [{"name": "test"}]}),
    ("serp", "serpapi.com", {"account_id": "test"}),
])
def test_validation_is_authenticated_real_provider_request_and_rate_limited(server_api, monkeypatch, caplog, service, url, payload):
    client, _, server = server_api
    calls = []
    def provider(request):
        calls.append(request)
        assert request.url.host == url
        assert "validation-secret" in str(request.url) or "validation-secret" in str(dict(request.headers))
        return httpx.Response(200, json=payload)
    original = httpx.AsyncClient
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(provider), **kwargs))
    caplog.set_level("INFO", logger="httpx")
    body = {"service": service, "key": "validation-secret"}
    response = client.post("/api/keys/validate", json=body)
    assert response.status_code == 200 and response.json()["ok"] is True
    assert "validation-secret" not in response.text
    assert "validation-secret" not in caplog.text
    for _ in range(9):
        assert client.post("/api/keys/validate", json=body).status_code == 200
    assert client.post("/api/keys/validate", json=body).status_code == 429
    client.headers.pop("Authorization")
    assert client.post("/api/keys/validate", json=body).status_code == 401
    assert len(calls) == 10


def test_google_tts_validation_rejects_long_but_invalid_key(server_api, monkeypatch):
    client, _, server = server_api
    original = httpx.AsyncClient
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **kwargs: original(
        transport=httpx.MockTransport(lambda request: httpx.Response(403, text="private key detail")),
        **kwargs,
    ))
    response = client.post("/api/keys/validate", json={"service": "google_tts", "key": "x" * 60})
    assert response.json()["ok"] is False
    assert "private key detail" not in response.text


def test_real_chat_intent_and_stream_routes_bind_personal_scope(server_api, monkeypatch):
    import sirius_brain
    client, _, server = server_api
    seen = []
    async def memory(*args):
        return []
    async def answer(**kwargs):
        seen.append(access.provider_key("groq", "owner-brain"))
        assert access.provider_key("k3", "owner-reflection") == ""
        return {"reponse": "personnel"}
    async def intent(text):
        seen.append(access.provider_key("groq", "owner-intent"))
        return {"action": "general", "query": text}
    async def stream(**kwargs):
        seen.append(access.provider_key("groq", "owner-stream"))
        yield "personnel"
    monkeypatch.setattr(server, "_gather_memory_context", memory)
    monkeypatch.setattr(server, "ask_sirius", answer)
    monkeypatch.setattr(server, "parse_intent", intent)
    monkeypatch.setattr(server, "should_extract_memory", lambda *args: False)
    monkeypatch.setattr(sirius_brain, "ask_sirius_stream", stream)
    body = {"text": "bonjour", "keys": {"groq_key": "invalid-personal"}}
    assert client.post("/api/chat", json=body).status_code == 200
    assert client.post("/api/chat/stream", json=body).status_code == 200
    assert client.post("/api/intent", json=body).status_code == 200
    assert seen == ["invalid-personal"] * 3
    for path in ("/api/chat", "/api/chat/stream"):
        assert client.post(path, json={"text": "bonjour"}).status_code == 403
    assert len(seen) == 3
    # Intent keeps working through the local parser: the owner key is never offered.
    assert client.post("/api/intent", json={"text": "bonjour"}).status_code == 200
    assert seen[-1] == ""


def test_real_brain_invalid_personal_does_not_try_owner(monkeypatch):
    import sirius_brain as brain
    created = []
    class Client:
        def __init__(self, api_key, **kwargs):
            created.append(api_key)
            self.chat = self
            self.completions = self
        async def create(self, **kwargs):
            raise RuntimeError("invalid supplied provider credential")
    monkeypatch.setattr(brain, "AsyncOpenAI", Client)
    monkeypatch.setattr(brain, "ENV_GROQ_LLM_KEY", "owner-brain")
    monkeypatch.setattr(brain, "ENV_K3_KEY", "owner-fallback")
    monkeypatch.setattr(brain, "client", None)
    with access.provider_scope(account(started=access.utc_now() - timedelta(days=8)), {"groq_key": "bad-personal"}):
        result = asyncio.run(brain.ask_sirius("bonjour", keys={"groq_key": "bad-personal"}))
    assert created == ["bad-personal"]
    assert isinstance(result, dict)


def test_public_cloud_account_expires_even_when_local_caller_is_admin(server_api, monkeypatch):
    import cloud_link
    client, user, server = server_api
    monkeypatch.setattr(cloud_link, "load_state", lambda: {"access_token": auth_api.create_access_token(user)})
    monkeypatch.setattr(cloud_link, "transport", httpx.ASGITransport(app=client.app))
    async def scenario():
        with access.provider_scope(account(role="admin")):
            with pytest.raises(HTTPException) as failure:
                await cloud_link.relay_json("/api/chat", {"text": "bonjour"})
        assert failure.value.status_code == 403
    asyncio.run(scenario())


def test_active_trial_daily_quota_and_admin_exemption_on_chat(server_api, db, monkeypatch):
    client, user, server = server_api
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    async def memory(*args):
        return []
    async def answer(**kwargs):
        assert access.provider_key("groq", "test-owner") == "test-owner"
        return {"reponse": "essai"}
    monkeypatch.setattr(server, "_gather_memory_context", memory)
    monkeypatch.setattr(server, "ask_sirius", answer)
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    assert client.post("/api/chat", json={"text": "bonjour"}).status_code == 200
    assert client.post("/api/chat", json={"text": "bonjour"}).status_code == 429
    status = client.get("/api/setup/status").json()
    assert status["trial"]["state"] == "active"
    assert status["quotas"]["usage"]["chat"] == 1
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {
        "role": "admin", "trial_started_at": access.utc_now() - timedelta(days=20),
    }}))
    assert client.post("/api/chat", json={"text": "bonjour"}).status_code == 200
    assert client.get("/api/setup/status").json()["trial"]["state"] == "admin"


def test_logout_login_does_not_restart_first_activation(db):
    app = FastAPI()
    app.include_router(auth_api.make_auth_router(db), prefix="/api")
    client = TestClient(app)
    body = {"email": "activation@example.test", "password": "long-password", "name": "Test"}
    registered = client.post("/api/auth/register", json=body)
    assert registered.status_code == 200
    first = registered.json()["trial_started_at"]
    assert first
    assert client.post("/api/auth/logout").status_code == 200
    logged_in = client.post("/api/auth/login", json=body)
    assert logged_in.status_code == 200
    assert logged_in.json()["trial_started_at"] == first


def test_packaged_flag_does_not_extend_non_admin_trial(db, monkeypatch):
    monkeypatch.setenv("SIRIUS_PACKAGED", "1")
    with pytest.raises(HTTPException) as failure:
        asyncio.run(usage_quota.consume(db, account(started=access.utc_now() - timedelta(days=8)), "stt"))
    assert failure.value.status_code == 403


@pytest.mark.parametrize("path", [
    "/api/diagram", "/api/display/analyze", "/api/display/ask", "/api/vision/analyze",
    "/api/webagent/run", "/api/webbrowser/open", "/api/task/video/start",
    "/api/task/video/status/job", "/api/dev/review", "/api/floorplan",
    "/api/news/headlines", "/api/weather/current", "/api/country", "/api/technews/bulletin",
    "/api/documentary", "/api/europeana/search", "/api/oracle/overview", "/api/pantheon/ocr",
    "/api/nummarius/market", "/api/nummarius/history/stock", "/api/hephaistos/diagnostic",
    "/api/agora/coach", "/api/files/uploaded/analyze",
])
def test_optional_online_surfaces_need_account_but_are_not_blanket_blocked_after_trial(api, path):
    client, _ = api
    # Unregistered in the fixture: 404 proves the middleware let the expired account through.
    assert client.post(path, json={"keys": {"groq_key": "personal"}}).status_code == 404
    client.headers.pop("Authorization")
    assert client.post(path, json={}).status_code == 401


def test_expired_account_keeps_local_tools_without_owner_key(api, db):
    client, user = api
    response = client.post("/api/themis/pieces/upload", json={})
    assert response.status_code == 200
    assert response.json() == {"ok": True, "owner": ""}
    assert asyncio.run(db.usage_quota.count_documents({})) == 0


def test_expired_online_module_uses_personal_key_and_explains_missing_one(api, monkeypatch):
    client, _ = api
    monkeypatch.setenv("GEMINI_API_KEY", "owner-gemini-image")
    ok = client.post("/api/task/image", json={"prompt": "x", "keys": {"gemini": "personal"}})
    assert ok.status_code == 200 and ok.json() == {"used": "personal"}
    denied = client.post("/api/task/image", json={"prompt": "x"})
    assert denied.status_code == 403
    assert denied.json()["detail"] == access.PERSONAL_REQUIRED
    assert "owner-gemini-image" not in denied.text
    monkeypatch.delenv("GEMINI_API_KEY")
    # Expired: a personal-capable service always asks for the personal key, even if unconfigured server-side.
    missing = client.post("/api/task/image", json={"prompt": "x"})
    assert missing.status_code == 403 and missing.json()["detail"] == access.PERSONAL_REQUIRED


def test_expired_chat_autonomous_local_action_is_not_blocked(server_api, monkeypatch):
    client, _, server = server_api
    async def memory(*args):
        return []
    monkeypatch.setattr(server, "detect_autonomous_action", lambda text: {"type": "local", "technical_comment": "Dossier ouvert."})
    monkeypatch.setattr(server, "_gather_memory_context", memory)
    monkeypatch.setattr(server, "ask_sirius", lambda **kwargs: pytest.fail("Provider brain called for a local action"))
    response = client.post("/api/chat", json={"text": "ouvre le dossier"})
    assert response.status_code == 200
    assert response.json()["answer"] == "Dossier ouvert."
    stream = client.post("/api/chat/stream", json={"text": "ouvre le dossier"})
    assert stream.status_code == 200 and "Dossier ouvert." in stream.text


def test_hephaistos_probe_never_sends_owner_kimi_key_after_trial(monkeypatch):
    import inspect
    from routes import hephaistos
    source = inspect.getsource(hephaistos)
    assert "DANIEL_DEV_K3','')" not in source and 'environ.get("DANIEL_DEV_K3")' not in source
    monkeypatch.setenv("DANIEL_DEV_K3", "owner-kimi")
    with access.provider_scope(account(started=access.utc_now() - timedelta(days=8)), {}):
        assert access.provider_env("k3", "K3_API_KEY", "DANIEL_DEV_K3") == ""


def test_fal_personal_client_never_changes_environment(server_api, monkeypatch):
    import fal_client
    import os
    _, _, server = server_api
    monkeypatch.setenv("FAL_KEY", "original-owner")
    async def installed():
        return fal_client, False
    monkeypatch.setattr(server, "_ensure_fal_client", installed)
    with access.provider_scope(account(started=access.utc_now()), {"fal": "personal-fal"}):
        client, installed_module = asyncio.run(server._fal_setup({"fal": "personal-fal"}))
    assert callable(client.submit_async)
    assert installed_module is False
    assert os.environ["FAL_KEY"] == "original-owner"


def test_scheduled_summary_skips_expired_accounts_without_personal_keys(db):
    import episodic
    async def scenario():
        user = account(started=access.utc_now() - timedelta(days=8))
        await db.users.insert_one(user)
        await db.sirius_chats.insert_one({
            "session_id": user["user_id"] + ":default",
            "updated_at": (access.utc_now() - timedelta(hours=1)).isoformat(),
            "history": [{"role": "user", "content": "test"}] * 4,
        })
        async def forbidden(history):
            pytest.fail("Expired account caused a scheduled owner summary")
        assert await episodic.condense_idle_sessions(db, forbidden, enforce_accounts=True) == 0
    asyncio.run(scenario())


def mock_server_http(monkeypatch, server, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def test_setup_test_chat_personal_key_real_upstream_and_no_owner_fallback(server_api, monkeypatch, caplog):
    client, _, server = server_api
    monkeypatch.setenv("GROQ_KEY", "owner-private")
    monkeypatch.setenv("K3_API_KEY", "owner-kimi-private")
    seen = []
    def provider(request):
        seen.append((request.url.host, request.headers["authorization"]))
        if request.headers["authorization"] == "Bearer good-personal":
            return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
        return httpx.Response(401, text="bad-personal leaked detail")
    mock_server_http(monkeypatch, server, provider)
    caplog.set_level("INFO", logger="httpx")
    ok = client.post("/api/setup/test-chat", json={"keys": {"groq_key": "good-personal"}})
    assert ok.status_code == 200
    assert ok.json() == {"ok": True, "provider": "groq", "message": "Connexion Groq réussie avec votre clé personnelle.", "source": "personal"}
    bad = client.post("/api/setup/test-chat", json={"keys": {"groq_key": "bad-personal"}})
    assert bad.status_code == 200 and bad.json()["ok"] is False
    kimi = client.post("/api/setup/test-chat", json={"keys": {"k3": "bad-personal"}})
    assert kimi.json()["ok"] is False and kimi.json()["provider"] == "kimi"
    assert [auth for _, auth in seen] == ["Bearer good-personal", "Bearer bad-personal", "Bearer bad-personal"]
    assert seen[0][0] == "api.groq.com"
    for response in (ok, bad, kimi):
        assert all(secret not in response.text for secret in ("good-personal", "bad-personal", "owner-private", "owner-kimi"))
    assert "good-personal" not in caplog.text and "bad-personal" not in caplog.text


@pytest.mark.parametrize("upstream", [
    httpx.Response(200, json={"choices": []}),
    httpx.Response(200, json={"choices": [{}]}),
    httpx.Response(200, json={"choices": [{"message": {"content": ""}}]}),
    httpx.Response(200, json={"choices": [{"message": {"content": "   "}}]}),
    httpx.Response(200, json={"choices": [{"message": {"content": None}}]}),
    httpx.Response(200, text="not json"),
    httpx.Response(500, json={"choices": [{"message": {"content": "OK"}}]}),
    httpx.Response(429, json={}),
])
def test_setup_test_chat_reports_success_only_for_real_completion(server_api, monkeypatch, upstream):
    client, _, server = server_api
    mock_server_http(monkeypatch, server, lambda request: upstream)
    response = client.post("/api/setup/test-chat", json={"keys": {"groq_key": "personal"}})
    assert response.status_code == 200 and response.json()["ok"] is False


def test_setup_test_chat_network_error_is_not_success(server_api, monkeypatch):
    client, _, server = server_api
    def provider(request):
        raise httpx.ConnectError("down", request=request)
    mock_server_http(monkeypatch, server, provider)
    assert client.post("/api/setup/test-chat", json={"keys": {"groq_key": "personal"}}).json()["ok"] is False


def test_setup_test_chat_expired_unrelated_or_anonymous_never_call_owner(server_api, monkeypatch):
    client, _, server = server_api
    monkeypatch.setenv("GROQ_KEY", "owner-private")
    calls = []
    mock_server_http(monkeypatch, server, lambda request: calls.append(request) or httpx.Response(200, json={"choices": [{}]}))
    expired = client.post("/api/setup/test-chat", json={"keys": {}})
    assert expired.status_code == 403 and "7 jours" in expired.json()["detail"]
    unrelated = client.post("/api/setup/test-chat", json={"keys": {"serp": "personal-search", "gmaps": "personal-maps"}})
    assert unrelated.status_code == 403 and unrelated.json()["detail"] == access.PERSONAL_REQUIRED
    client.headers.pop("Authorization")
    assert client.post("/api/setup/test-chat", json={"keys": {"groq_key": "personal"}}).status_code == 401
    assert calls == []


def test_setup_test_chat_trial_uses_owner_with_quota_and_admin_exemption(server_api, db, monkeypatch):
    client, user, server = server_api
    monkeypatch.setenv("GROQ_KEY", "owner-private")
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    calls = []
    def provider(request):
        calls.append(request.headers["authorization"])
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
    mock_server_http(monkeypatch, server, provider)
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    status = client.get("/api/setup/status").json()
    assert {s["id"]: s["state"] for s in status["services"]}["groq"] == "configured"
    first = client.post("/api/setup/test-chat", json={"keys": {}})
    assert first.json() == {"ok": True, "provider": "groq", "message": "Connexion Groq réussie avec l'essai SIRIUS.", "source": "local"}
    assert "owner-private" not in first.text
    assert client.post("/api/setup/test-chat", json={"keys": {}}).status_code == 429
    assert client.post("/api/setup/test-chat", json={"keys": {"groq_key": "personal"}}).json()["ok"] is True
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"role": "admin"}}))
    assert client.post("/api/setup/test-chat", json={"keys": {}}).json()["ok"] is True
    assert calls == ["Bearer owner-private", "Bearer personal", "Bearer owner-private"]


def _usage(db, user, kind="chat"):
    doc = asyncio.run(db.usage_quota.find_one({"user_id": user["user_id"]})) or {}
    return int(doc.get(kind) or 0)


def test_active_trial_unrelated_personal_key_keeps_owner_chat_and_stream(server_api, db, monkeypatch):
    import sirius_brain
    client, user, server = server_api
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "2")
    seen = []
    async def memory(*args):
        return []
    async def answer(**kwargs):
        seen.append(access.provider_key("groq", "owner-brain"))
        return {"reponse": "essai"}
    async def stream(**kwargs):
        seen.append(access.provider_key("groq", "owner-brain"))
        yield "essai"
    monkeypatch.setattr(server, "_gather_memory_context", memory)
    monkeypatch.setattr(server, "ask_sirius", answer)
    monkeypatch.setattr(server, "should_extract_memory", lambda *args: False)
    monkeypatch.setattr(sirius_brain, "ask_sirius_stream", stream)
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    body = {"text": "bonjour", "keys": {"gmaps": "personal-maps", "serp": "personal-serp"}}
    assert client.post("/api/chat", json=body).status_code == 200
    assert client.post("/api/chat/stream", json=body).status_code == 200
    assert seen == ["owner-brain", "owner-brain"] and _usage(db, user) == 2
    assert client.post("/api/chat", json=body).status_code == 429
    # Expired: the same partial vault never reaches the owner key.
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now() - timedelta(days=7, seconds=1)}}))
    for path in ("/api/chat", "/api/chat/stream"):
        assert client.post(path, json=body).status_code == 403
    assert seen == ["owner-brain", "owner-brain"]


def test_active_trial_personal_groq_with_owner_kimi_is_charged_and_exhausted_quota_blocks_owner_only(server_api, db, monkeypatch):
    client, user, server = server_api
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    seen = []
    async def memory(*args):
        return []
    async def answer(**kwargs):
        seen.append((access.provider_key("groq", "owner-groq"), access.provider_key("k3", "owner-kimi")))
        return {"reponse": "essai"}
    monkeypatch.setattr(server, "_gather_memory_context", memory)
    monkeypatch.setattr(server, "ask_sirius", answer)
    monkeypatch.setattr(server, "should_extract_memory", lambda *args: False)
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    body = {"text": "bonjour", "keys": {"groq_key": "personal-groq"}}
    assert client.post("/api/chat", json=body).status_code == 200
    assert seen == [("personal-groq", "owner-kimi")] and _usage(db, user) == 1
    # Quota reached: own Groq key keeps working, owner Kimi is no longer offered nor charged.
    assert client.post("/api/chat", json=body).status_code == 200
    assert seen[-1] == ("personal-groq", "") and _usage(db, user) == 1
    assert client.post("/api/chat", json={"text": "bonjour"}).status_code == 429


def test_setup_test_chat_active_trial_with_unrelated_keys_uses_owner_chat(server_api, db, monkeypatch):
    client, user, server = server_api
    monkeypatch.setenv("GROQ_KEY", "owner-private")
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    calls = []
    def provider(request):
        calls.append(request.url.host)
        return httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})
    mock_server_http(monkeypatch, server, provider)
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    keys = {"gmaps": "personal-maps", "fal": "personal-fal"}
    first = client.post("/api/setup/test-chat", json={"keys": keys})
    assert first.json() == {"ok": True, "provider": "groq", "message": "Connexion Groq réussie avec l'essai SIRIUS.", "source": "local"}
    assert client.post("/api/setup/test-chat", json={"keys": keys}).status_code == 429
    assert calls == ["api.groq.com"] and _usage(db, user) == 1
    assert all(s not in first.text for s in ("owner-private", "personal-maps", "personal-fal"))


def test_setup_test_chat_is_rate_limited(server_api, monkeypatch):
    client, _, server = server_api
    mock_server_http(monkeypatch, server, lambda request: httpx.Response(200, json={"choices": [{}]}))
    body = {"keys": {"groq_key": "personal"}}
    assert all(client.post("/api/setup/test-chat", json=body).status_code == 200 for _ in range(6))
    assert client.post("/api/setup/test-chat", json=body).status_code == 429

def voice_app(db, user):
    app = FastAPI()
    app.add_middleware(access.ProviderAccessMiddleware, db=db)
    app.add_api_route("/api/ping", lambda: {"ok": True})
    app.include_router(voice_io.make_voice_io_router(db), prefix="/api")
    return TestClient(app)


def cookie_client(db, started):
    user = account(uid="voice-user", started=started)
    asyncio.run(db.users.insert_one(user))
    client = voice_app(db, user)
    client.cookies.set("access_token", auth_api.create_access_token(user))
    return client, user


def test_ws_stt_expired_without_personal_key_is_refused_before_recording(db, monkeypatch):
    from starlette.websockets import WebSocketDisconnect
    client, _ = cookie_client(db, access.utc_now() - timedelta(days=8))
    monkeypatch.setenv("GROQ_KEY", "owner-groq")
    monkeypatch.setenv("WHISPER_API_URL", "http://owner-whisper.invalid/stt")
    mock_voice(monkeypatch, lambda request: pytest.fail("Owner STT called"))
    with client.websocket_connect("/api/stt/stream") as ws:
        ws.send_json({"action": "start", "content_type": "audio/webm"})
        message = ws.receive_json()
        assert message == {"type": "error", "detail": access.PERSONAL_REQUIRED, "trial": "expired"}
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
        assert closed.value.code == 1008


@pytest.mark.parametrize("expired,setup_key,expected", [
    (True, "personal-groq", "Bearer personal-groq"),
    (False, "", "Bearer owner-groq"),
    (False, "personal-groq", "Bearer personal-groq"),
])
def test_ws_stt_uses_personal_key_or_owner_only_during_trial(db, monkeypatch, expired, setup_key, expected):
    started = access.utc_now() - timedelta(days=8 if expired else 1)
    client, _ = cookie_client(db, started)
    monkeypatch.setenv("GROQ_KEY", "owner-groq")
    monkeypatch.delenv("WHISPER_API_URL", raising=False)
    monkeypatch.delenv("STT_BACKEND_URL", raising=False)
    monkeypatch.setattr(voice_io.cloud_link, "should_relay_stt", lambda key: False)
    seen = []
    def provider(request):
        seen.append(request.headers["authorization"])
        return httpx.Response(200, json={"text": "bonjour"})
    mock_voice(monkeypatch, provider)
    with client.websocket_connect("/api/stt/stream") as ws:
        ws.send_json({"action": "start", "content_type": "audio/webm", "groq_key": setup_key})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(b"audio")
        ws.send_json({"action": "finish"})
        message = ws.receive_json()
    assert message["type"] == "transcript"
    assert seen == [expected]


def test_ws_stt_invalid_personal_key_never_retries_owner(db, monkeypatch):
    client, _ = cookie_client(db, access.utc_now() - timedelta(days=1))
    monkeypatch.setenv("GROQ_KEY", "owner-groq")
    monkeypatch.setattr(voice_io.cloud_link, "should_relay_stt", lambda key: False)
    seen = []
    def provider(request):
        seen.append(request.headers["authorization"])
        return httpx.Response(401, json={"error": "invalid"})
    mock_voice(monkeypatch, provider)
    with client.websocket_connect("/api/stt/stream") as ws:
        ws.send_json({"action": "start", "groq_key": "bad-personal"})
        assert ws.receive_json() == {"type": "ready"}
        ws.send_bytes(b"audio")
        ws.send_json({"action": "finish"})
        assert ws.receive_json()["type"] == "error"
    assert seen == ["Bearer bad-personal"]


def test_ws_stt_anonymous_is_closed_before_accept(db):
    from starlette.websockets import WebSocketDisconnect
    client = voice_app(db, None)
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/api/stt/stream") as ws:
            ws.receive_json()
    assert closed.value.code == 1008


@pytest.mark.parametrize("path", ["/api/tts/google", "/api/tts", "/api/tts/gemini"])
def test_tts_cache_filled_during_trial_is_not_served_after_expiry(db, monkeypatch, path):
    client, user = cookie_client(db, access.utc_now() - timedelta(days=1))
    monkeypatch.setenv("GOOGLE_TTS_API_KEY", "owner-google")
    monkeypatch.setenv("GEMINI_TTS_API_KEY", "owner-gemini")
    monkeypatch.setenv("GEMINI_TTS_PRIMARY", "1")
    monkeypatch.delenv("TTS_BACKEND_URL", raising=False)
    voice_io._TTS_CACHE.clear()
    calls = []
    async def gemini(key, payload):
        calls.append(key)
        return "Q0FDSEVELUFVRElP"
    monkeypatch.setattr(voice_io, "_gemini_request", gemini)
    def provider(request):
        calls.append("google")
        return httpx.Response(200, json={"audioContent": "Q0FDSEVELUFVRElP"})
    mock_voice(monkeypatch, provider)
    first = client.post(path, json={"text": "bonjour"})
    assert first.status_code == 200 and calls
    assert voice_io._TTS_CACHE
    asyncio.run(db.users.update_one({"user_id": user["user_id"]},
                                    {"$set": {"trial_started_at": access.utc_now() - timedelta(days=8)}}))
    before = len(calls)
    again = client.post(path, json={"text": "bonjour"})
    assert again.status_code == 403
    assert again.json()["detail"] == access.PERSONAL_REQUIRED
    assert "Q0FDSEVELUFVRElP" not in again.text
    assert len(calls) == before
    voice_io._TTS_CACHE.clear()


def test_packaging_spec_never_bundles_env_files():
    from pathlib import Path
    spec = (Path(__file__).resolve().parents[1] / "sirius-backend.spec").read_text(encoding="utf-8")
    assert "Fichier .env interdit" in spec
    datas_lines = [line for line in spec.splitlines() if "datas" in line and ".env" in line and "rglob" not in line]
    assert datas_lines == []


# ---------------------------------------------------------------------------
# Optional online modules: explicit errors, personal keys, no owner fallback.
# ---------------------------------------------------------------------------

class FakeLLM:
    calls = []
    content = '{"reponse": "Coach OK"}'

    def __init__(self, api_key=None, **kwargs):
        from types import SimpleNamespace
        FakeLLM.calls.append(api_key)
        self.key = api_key
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    async def _create(self, **kwargs):
        from types import SimpleNamespace
        if str(self.key).startswith("bad"):
            raise RuntimeError("401 invalid_api_key")
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=FakeLLM.content))])


@pytest.fixture
def modules(db, monkeypatch):
    import openai
    import floorplan
    import modules_api
    import nummarius_api
    import sirius_brain
    from routes import infos
    from routes.pantheon_oracle import make_pantheon_oracle_router
    user = account(started=access.utc_now() - timedelta(days=8))
    asyncio.run(db.users.insert_one(user))
    for name, value in {"NEWS_API_KEY": "owner-news", "OPENWEATHER_API_KEY": "owner-weather",
                        "RESTCOUNTRIES_API_KEY": "owner-countries"}.items():
        monkeypatch.setattr(infos, name, value)
    monkeypatch.setenv("EUROPEANA_API_KEY", "owner-europeana")
    monkeypatch.setenv("ALPHA_VANTAGE_API_KEY", "owner-alpha")
    monkeypatch.setattr(sirius_brain, "ENV_GROQ_LLM_KEY", "owner-groq")
    monkeypatch.setattr(sirius_brain, "ENV_K3_KEY", "owner-kimi")
    monkeypatch.setattr(sirius_brain, "AsyncOpenAI", FakeLLM)
    monkeypatch.setattr(openai, "AsyncOpenAI", FakeLLM)
    monkeypatch.setattr(floorplan, "normalize_plan", lambda plan: plan)
    sirius_brain._k3_clients.clear()
    infos._news_cache.update({"t": 0.0, "key": "", "data": None})
    infos._hn_cache.update({"t": 0.0, "stories": None})
    nummarius_api._stock_hist.clear()
    FakeLLM.calls = []
    calls = []
    responses = {}
    original = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        host = request.url.host
        if host in responses:
            return responses[host](request)
        if host == "hacker-news.firebaseio.com":
            if request.url.path.endswith("topstories.json"):
                return httpx.Response(200, json=[1])
            return httpx.Response(200, json={"title": "Story", "score": 1, "by": "x"})
        if host == "openlibrary.org":
            return httpx.Response(200, json={"docs": [{"title": "Livre"}]})
        if host == "query1.finance.yahoo.com":
            return httpx.Response(200, json={"chart": {"result": [{"timestamp": [1, 2],
                                  "indicators": {"quote": [{"close": [10.0, 11.0]}]}}]}})
        return httpx.Response(404, json={})

    def client_factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return original(transport=httpx.MockTransport(handler), **kwargs)

    for module in (infos, nummarius_api):
        monkeypatch.setattr(module.httpx, "AsyncClient", client_factory)
    app = FastAPI()
    app.add_middleware(access.ProviderAccessMiddleware, db=db)
    app.include_router(infos.make_infos_router(), prefix="/api")
    app.include_router(floorplan.make_floorplan_router(lambda *args, **kwargs: True), prefix="/api")
    app.include_router(nummarius_api.make_nummarius_router(db), prefix="/api")
    app.include_router(modules_api.make_modules_router(db), prefix="/api")
    app.include_router(make_pantheon_oracle_router(db, lambda *args, **kwargs: True, auth_api.require_user), prefix="/api")
    client = TestClient(app)
    client.headers["Authorization"] = "Bearer " + auth_api.create_access_token(user)
    return client, user, calls, responses


def owner_secrets_sent(calls):
    secrets = ("owner-news", "owner-weather", "owner-countries", "owner-europeana", "owner-alpha")
    return [str(request.url) + str(request.headers) for request in calls
            if any(secret in str(request.url) + str(request.headers) for secret in secrets)]


@pytest.mark.parametrize("path", [
    "/api/news/headlines", "/api/weather/current?city=Paris", "/api/country?name=France", "/api/europeana/search?q=Paris",
])
def test_expired_owner_only_services_explicit_error_without_owner_call(modules, path):
    client, _, calls, _ = modules
    response = client.get(path)
    assert response.status_code == 403
    assert response.json()["detail"] == access.OWNER_ONLY_EXPIRED
    assert "locaux restent accessibles" in response.json()["detail"]
    assert calls == []


def test_unconfigured_service_keeps_its_own_error(modules, monkeypatch):
    from routes import infos
    client, _, calls, _ = modules
    monkeypatch.setattr(infos, "OPENWEATHER_API_KEY", None)
    response = client.get("/api/weather/current?city=Paris")
    assert response.status_code == 503 and response.json()["detail"] == "OPENWEATHER_API_KEY absente"
    assert calls == []


def test_unrelated_upstream_error_is_not_rewritten_to_trial_error(modules, db):
    client, user, calls, responses = modules
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    responses["api.openweathermap.org"] = lambda request: httpx.Response(404, json={})
    response = client.get("/api/weather/current?city=Nowhere")
    assert response.status_code == 404 and response.json()["detail"] == "Ville introuvable"
    assert "owner-weather" in str(calls[0].url)


def test_expired_documentary_uses_only_free_sources(modules):
    client, _, calls, _ = modules
    response = client.post("/api/documentary", json={"sujet": "Paris"})
    assert response.status_code == 200
    assert "openlibrary_ouvrages" in response.json()["sources"]
    assert not [request for request in calls if request.url.host == "api.europeana.eu"]
    assert owner_secrets_sent(calls) == []


def test_expired_technews_returns_raw_titles_without_owner_llm(modules):
    client, _, _, _ = modules
    response = client.post("/api/technews/bulletin", json={"keys": {}})
    assert response.status_code == 200 and "titres bruts" in response.json()["bulletin"]
    assert FakeLLM.calls == []
    personal = client.post("/api/technews/bulletin", json={"keys": {"k3": "personal-kimi"}})
    assert personal.status_code == 200 and personal.json()["bulletin"] == FakeLLM.content
    assert FakeLLM.calls == ["personal-kimi"]


def test_expired_floorplan_personal_key_invalid_key_and_missing_key(modules):
    client, _, _, _ = modules
    FakeLLM.content = '{"rooms": []}'
    try:
        denied = client.post("/api/floorplan", json={"description": "T2"})
        assert denied.status_code == 403 and denied.json()["detail"] == access.PERSONAL_REQUIRED
        wrong = client.post("/api/floorplan", json={"description": "T2", "keys": {"k3": "personal-kimi"}})
        assert wrong.status_code == 403 and wrong.json()["detail"] == access.PERSONAL_REQUIRED
        ok = client.post("/api/floorplan", json={"description": "T2", "keys": {"groq_key": "personal-groq"}})
        assert ok.status_code == 200 and ok.json() == {"rooms": []}
        bad = client.post("/api/floorplan", json={"description": "T2", "keys": {"groq_key": "bad-groq"}})
        assert bad.status_code == 500 and "owner" not in bad.text
    finally:
        FakeLLM.content = '{"reponse": "Coach OK"}'
    assert "owner-groq" not in FakeLLM.calls
    assert set(FakeLLM.calls) == {"personal-groq", "bad-groq"}


def test_expired_agora_coach_personal_key_invalid_key_and_missing_key(modules):
    client, _, _, _ = modules
    denied = client.post("/api/agora/coach", json={"history": []})
    assert denied.status_code == 403 and denied.json()["detail"] == access.PERSONAL_REQUIRED
    ok = client.post("/api/agora/coach", json={"history": [], "keys": {"k3": "personal-kimi"}})
    assert ok.status_code == 200 and ok.json()["reponse"] == "Coach OK"
    bad = client.post("/api/agora/coach", json={"history": [], "keys": {"k3": "bad-kimi"}})
    assert bad.status_code == 200 and "indisponible" in bad.json()["reponse"]
    assert "owner-kimi" not in FakeLLM.calls


def test_trial_active_partial_vault_keeps_owner_for_other_providers_and_charges_quota(modules, db, monkeypatch):
    import usage_quota
    client, user, _, _ = modules
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "2")
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    FakeLLM.content = '{"rooms": []}'
    try:
        partial = {"k3": "personal-kimi", "gmaps": "personal-maps", "serp": "personal-serp"}
        ok = client.post("/api/floorplan", json={"description": "T2", "keys": partial})
        assert ok.status_code == 200 and FakeLLM.calls == ["owner-groq"]
        own_bad = client.post("/api/floorplan", json={"description": "T2", "keys": {**partial, "groq_key": "bad-groq"}})
        assert own_bad.status_code == 500 and FakeLLM.calls == ["owner-groq", "bad-groq"]
        summary = asyncio.run(usage_quota.usage_summary(db, {**user, "trial_started_at": access.utc_now()}))
        assert summary["usage"]["chat"] == 1
        client.post("/api/floorplan", json={"description": "T2", "keys": partial})
        blocked = client.post("/api/floorplan", json={"description": "T2", "keys": partial})
        assert blocked.status_code == 429
        assert FakeLLM.calls.count("owner-groq") == 2
    finally:
        FakeLLM.content = '{"reponse": "Coach OK"}'


def test_ocr_route_has_no_provider_path():
    import inspect
    import sirius_brain
    source = inspect.getsource(sirius_brain.ocr_screen)
    assert source.strip() == "async def ocr_screen(img): return {}"


def test_expired_nummarius_uses_personal_alpha_or_free_source_never_owner(modules):
    client, _, calls, responses = modules
    seen_keys = []
    def alpha(request):
        key = request.url.params.get("apikey")
        seen_keys.append(key)
        if key != "personal-alpha":
            return httpx.Response(200, json={"Error Message": "invalid"})
        return httpx.Response(200, json={"Time Series (Daily)": {"2026-01-01": {"4. close": "5"}, "2026-01-02": {"4. close": "6"}}})
    responses["www.alphavantage.co"] = alpha
    free = client.get("/api/nummarius/history/AAPL")
    assert free.status_code == 200 and seen_keys == []
    import nummarius_api
    nummarius_api._stock_hist.clear()
    personal = client.get("/api/nummarius/history/AAPL", headers={"X-Sirius-Alphavantage-Key": "personal-alpha"})
    assert personal.status_code == 200 and [p["v"] for p in personal.json()["points"]] == [5.0, 6.0]
    nummarius_api._stock_hist.clear()
    bad = client.get("/api/nummarius/history/AAPL", headers={"X-Sirius-Alphavantage-Key": "bad-alpha"})
    assert bad.status_code == 200 and [p["v"] for p in bad.json()["points"]] == [10.0, 11.0]
    assert seen_keys == ["personal-alpha", "bad-alpha"]
    assert owner_secrets_sent(calls) == []


def test_trial_quota_charged_only_for_owner_use_and_personal_keys_bypass_block(modules, db, monkeypatch):
    client, user, calls, responses = modules
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    responses["api.openweathermap.org"] = lambda request: httpx.Response(200, json={"name": "Paris", "main": {"temp": 1}})

    def used():
        doc = asyncio.run(db.usage_quota.find_one({"user_id": user["user_id"]})) or {}
        return int(doc.get("chat") or 0)

    FakeLLM.content = '{"rooms": []}'
    try:
        personal = client.post("/api/floorplan", json={"description": "T2", "keys": {"groq_key": "personal-groq"}})
        assert personal.status_code == 200 and used() == 0
        monkeypatch.delenv("EUROPEANA_API_KEY")
        free = client.post("/api/documentary", json={"sujet": "Paris"})
        assert free.status_code == 200 and used() == 0
        owner = client.get("/api/weather/current?city=Paris")
        assert owner.status_code == 200 and used() == 1
        blocked = client.get("/api/weather/current?city=Paris")
        assert blocked.status_code == 429 and "Limite quotidienne" in blocked.json()["detail"]
        assert used() == 1
        still_personal = client.post("/api/floorplan", json={"description": "T2", "keys": {"groq_key": "personal-groq"}})
        assert still_personal.status_code == 200
        no_key = client.post("/api/floorplan", json={"description": "T2"})
        assert no_key.status_code == 429
    finally:
        FakeLLM.content = '{"reponse": "Coach OK"}'
    assert "owner-groq" not in FakeLLM.calls
    assert len([r for r in calls if r.url.host == "api.openweathermap.org"]) == 1


@pytest.mark.parametrize("status,expected", [
    (200, {"ok": True}),
    (401, {"ok": False}),
    (403, {"ok": False}),
    (500, {"ok": False, "status": "unverifiable"}),
])
def test_fal_key_validation_uses_read_only_authenticated_endpoint(server_api, monkeypatch, status, expected):
    client, _, server = server_api
    seen = []
    def provider(request):
        seen.append(request)
        return httpx.Response(status, json={"prices": []})
    mock_server_http(monkeypatch, server, provider)
    response = client.post("/api/keys/validate", json={"service": "fal", "key": "personal-fal"})
    body = response.json()
    assert response.status_code == 200
    assert {k: body[k] for k in expected} == expected
    if status != 500:
        assert "status" not in body
    assert "personal-fal" not in response.text
    assert len(seen) == 1
    assert seen[0].url.host == "api.fal.ai" and seen[0].url.path == "/v1/models/pricing"
    assert seen[0].method == "GET" and seen[0].headers["authorization"] == "Key personal-fal"


@pytest.mark.parametrize("service", ["gmaps", "google_maps", "maps"])
def test_gmaps_browser_key_is_unverifiable_without_any_upstream_call(server_api, monkeypatch, service):
    client, _, server = server_api
    seen = []
    def provider(request):
        seen.append(request)
        return httpx.Response(200, json={"status": "OK"})
    mock_server_http(monkeypatch, server, provider)
    response = client.post("/api/keys/validate", json={"service": service, "key": "AIza-personal-browser"})
    assert response.status_code == 200
    assert response.json() == {
        "ok": False,
        "status": "unverifiable",
        "message": "Clé de carte utilisée dans le navigateur : testez l’ouverture de la carte. "
                   "La vérification côté serveur ne confirme pas les restrictions de votre clé.",
    }
    assert "AIza-personal-browser" not in response.text
    assert seen == []


def _status_services(client):
    response = client.get("/api/setup/status")
    assert response.status_code == 200
    return {service["id"]: service for service in response.json()["services"]}


@pytest.mark.parametrize("env_name", ["GROQ_KEY", "K3_API_KEY"])
def test_status_aggregate_chat_is_configured_from_groq_or_kimi_during_trial(server_api, monkeypatch, env_name):
    client, user, server = server_api
    asyncio.run(server.db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    for name in ("GROQ_KEY", "GROQ_API_KEY", "K3_API_KEY", "DANIEL_DEV_K3", "GOOGLE_TTS_API_KEY",
                 "GOOGLE_CLOUD_TTS_API_KEY", "GEMINI_TTS_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(env_name, "owner-private")
    services = _status_services(client)
    assert (services["chat"]["state"], services["chat"]["scope"]) == ("configured", "owner")
    assert services["chat"]["providers"] == ["groq", "k3"]
    expected_stt = "configured" if env_name == "GROQ_KEY" else "not_configured"
    assert (services["stt"]["state"], services["stt"]["scope"]) == (expected_stt, "owner")
    assert (services["tts"]["state"], services["tts"]["scope"]) == ("available", "local")
    monkeypatch.setenv("GEMINI_TTS_API_KEY", "owner-voice-private")
    assert (_status_services(client)["tts"]["state"]) == "configured"


def _as_local_admin(client, server):
    admin = account(uid="local-admin", role="admin")
    asyncio.run(server.db.users.insert_one(admin))
    client.headers["Authorization"] = "Bearer " + auth_api.create_access_token(admin)


def _link_cloud(monkeypatch, server, chat=True, stt=True, tts=True):
    monkeypatch.setattr(server.cloud_link, "relay_allowed", lambda: True)
    monkeypatch.setattr(server.cloud_link, "load_state", lambda: {"access_token": "cloud-private", "email": "me@cloud.test"})
    monkeypatch.setattr(server.cloud_link, "should_relay_chat", lambda keys: chat and not any(
        str((keys or {}).get(k) or "").strip() for k in ("groq_key", "groq_real", "k3", "groq")))
    monkeypatch.setattr(server.cloud_link, "should_relay_stt", lambda key: stt)
    monkeypatch.setattr(server.cloud_link, "should_relay_tts", lambda env: tts)


_REMOTE_EXPIRED = {
    "mode": "trial_then_personal", "role": "user", "access_token": "remote-secret",
    "trial": {"state": "expired", "started_at": "2026-10-01T00:00:00+00:00",
              "expires_at": "2026-10-08T00:00:00+00:00", "remaining_seconds": 0, "token": "remote-secret"},
    "quotas": {"enabled": False},
    "services": [
        {"id": "chat", "state": "not_configured", "scope": "personal", "description": "remote-secret"},
        {"id": "stt", "state": "not_configured", "scope": "personal"},
        {"id": "tts", "state": "available", "scope": "local"},
        {"id": "groq", "state": "not_configured", "scope": "personal"},
        {"id": "google_tts", "state": "weird", "scope": "owner"},
    ],
}


def test_linked_desktop_admin_status_reflects_cloud_account_not_local_admin(server_api, monkeypatch):
    client, _, server = server_api
    _as_local_admin(client, server)
    for name in ("GROQ_KEY", "GROQ_API_KEY", "K3_API_KEY", "DANIEL_DEV_K3"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SERP_API_KEY", "local-serp-private")
    _link_cloud(monkeypatch, server)
    calls = []

    async def remote(path):
        calls.append(path)
        return _REMOTE_EXPIRED
    monkeypatch.setattr(server.cloud_link, "relay_get_json", remote)
    response = client.get("/api/setup/status")
    assert response.status_code == 200 and calls == ["/api/setup/status"]
    payload = response.json()
    assert payload["source"] == "cloud" and payload["role"] == "user" and payload["local_role"] == "admin"
    assert payload["trial"] == {k: _REMOTE_EXPIRED["trial"][k] for k in ("state", "started_at", "expires_at", "remaining_seconds")}
    assert payload["quotas"] == {"enabled": False}
    assert payload["cloud"]["account"]["trial"]["state"] == "expired"
    assert payload["cloud"]["linked"] is True and payload["cloud"]["email"] == "me@cloud.test"
    services = {item["id"]: item for item in payload["services"]}
    assert (services["chat"]["state"], services["chat"]["scope"]) == ("not_configured", "personal")
    assert services["chat"]["relayed"] is True
    assert services["google_tts"]["state"] == "restricted"
    # Local tools keep the local admin view.
    assert (services["serp"]["state"], services["serp"]["scope"]) == ("configured", "owner")
    assert "administrateur" in services["serp"]["description"]
    for secret in ("remote-secret", "cloud-private", "local-serp-private"):
        assert secret not in response.text


def test_linked_desktop_cloud_active_trial_marks_relayed_chat_configured(server_api, monkeypatch):
    client, _, server = server_api
    _as_local_admin(client, server)
    _link_cloud(monkeypatch, server)
    remote = {**_REMOTE_EXPIRED, "trial": {"state": "active", "started_at": "a", "expires_at": "b", "remaining_seconds": 5},
              "quotas": {"enabled": True, "usage": {"chat": 1}},
              "services": [{"id": "chat", "state": "configured", "scope": "owner"}]}

    async def relay(path):
        return remote
    monkeypatch.setattr(server.cloud_link, "relay_get_json", relay)
    payload = client.get("/api/setup/status").json()
    chat = next(item for item in payload["services"] if item["id"] == "chat")
    assert (chat["state"], chat["scope"]) == ("configured", "cloud")
    assert payload["trial"]["state"] == "active" and payload["quotas"]["enabled"] is True


@pytest.mark.parametrize("remote_status,expected", [(401, 503), (502, 503), (404, 503), (403, 403)])
def test_linked_desktop_status_never_falls_back_to_local_admin_when_cloud_fails(server_api, monkeypatch, remote_status, expected):
    client, _, server = server_api
    _as_local_admin(client, server)
    _link_cloud(monkeypatch, server)

    async def failing(path):
        raise HTTPException(status_code=remote_status, detail="Refus cloud.")
    monkeypatch.setattr(server.cloud_link, "relay_get_json", failing)
    response = client.get("/api/setup/status")
    assert response.status_code == expected
    assert "admin" not in response.text


def test_partial_relay_failure_keeps_local_account_and_restricts_relayed_voice(server_api, monkeypatch):
    client, _, server = server_api
    _as_local_admin(client, server)
    monkeypatch.setenv("GROQ_KEY", "local-groq-private")
    for name in ("GOOGLE_TTS_API_KEY", "GOOGLE_CLOUD_TTS_API_KEY", "GEMINI_TTS_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    _link_cloud(monkeypatch, server, chat=False, stt=False, tts=True)

    async def failing(path):
        raise HTTPException(status_code=502, detail="Cloud injoignable.")
    monkeypatch.setattr(server.cloud_link, "relay_get_json", failing)
    response = client.get("/api/setup/status")
    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "local" and payload["trial"]["state"] == "admin"
    assert payload["cloud"]["error"] == "Cloud injoignable." and payload["cloud"]["account"] is None
    services = {item["id"]: item for item in payload["services"]}
    assert services["chat"]["state"] == "configured" and services["chat"]["scope"] == "owner"
    assert services["tts"]["state"] == "restricted" and services["gemini_tts"]["state"] == "restricted"
    assert "local-groq-private" not in response.text


def test_linked_desktop_test_chat_is_decided_by_cloud_account(server_api, monkeypatch):
    client, _, server = server_api
    _as_local_admin(client, server)
    for name in ("GROQ_KEY", "GROQ_API_KEY", "K3_API_KEY", "DANIEL_DEV_K3"):
        monkeypatch.delenv(name, raising=False)
    _link_cloud(monkeypatch, server)
    sent = []

    async def expired(path, payload):
        sent.append((path, payload))
        raise HTTPException(status_code=403, detail=access.PERSONAL_REQUIRED)
    monkeypatch.setattr(server.cloud_link, "relay_json", expired)
    response = client.post("/api/setup/test-chat", json={"keys": {}})
    assert response.status_code == 403 and response.json()["detail"] == access.PERSONAL_REQUIRED
    assert sent == [("/api/setup/test-chat", {"keys": {}})]

    async def ok(path, payload):
        return {"ok": True, "provider": "groq", "message": "Connexion Groq réussie avec l'essai SIRIUS.", "token": "x"}
    monkeypatch.setattr(server.cloud_link, "relay_json", ok)
    body = client.post("/api/setup/test-chat", json={"keys": {}}).json()
    assert body == {"ok": True, "provider": "groq", "source": "cloud", "message": "Connexion Groq réussie avec l'essai SIRIUS."}

    async def unexpired_session(path, payload):
        raise HTTPException(status_code=401, detail="Non relié")
    monkeypatch.setattr(server.cloud_link, "relay_json", unexpired_session)
    assert client.post("/api/setup/test-chat", json={"keys": {}}).status_code == 503


def test_linked_desktop_test_chat_with_personal_key_stays_local_and_never_relays(server_api, monkeypatch):
    client, _, server = server_api
    _as_local_admin(client, server)
    _link_cloud(monkeypatch, server)

    async def forbidden(*args, **kwargs):
        raise AssertionError("relay must not be used with a personal key")
    monkeypatch.setattr(server.cloud_link, "relay_json", forbidden)
    original = httpx.AsyncClient
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda **kwargs: original(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"choices": [{"message": {"content": "OK"}}]})), **kwargs))
    body = client.post("/api/setup/test-chat", json={"keys": {"groq_key": "personal-groq"}}).json()
    assert body["ok"] is True and body["source"] == "personal"
    relayed = []

    async def relay(path, payload):
        relayed.append(payload)
        return {"ok": True, "provider": "groq", "message": "OK cloud"}
    monkeypatch.setattr(server.cloud_link, "relay_json", relay)
    # Keys for other services do not stop the cloud account's chat, and are never forwarded.
    response = client.post("/api/setup/test-chat", json={"keys": {"serp": "only-serp", "gmaps": "maps"}})
    assert response.json()["source"] == "cloud" and relayed == [{"keys": {}}]


def test_intent_uses_personal_groq_and_never_owner_or_quota_with_personal_vault(server_api, monkeypatch):
    import sirius_brain
    client, user, server = server_api
    monkeypatch.setattr(server, "parse_intent", sirius_brain.parse_intent)
    monkeypatch.setattr(sirius_brain, "ENV_GROQ_LLM_KEY", "owner-intent-private")
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    created = []

    class Completions:
        def __init__(self, key):
            self.key = key

        async def create(self, **kwargs):
            created.append(self.key)
            if self.key == "bad-personal":
                raise RuntimeError("refusé")
            message = type("M", (), {"content": '{"action": "open_app", "app": "edge"}'})
            return type("R", (), {"choices": [type("C", (), {"message": message})]})

    class FakeClient:
        def __init__(self, api_key, **kwargs):
            self.chat = type("Chat", (), {"completions": Completions(api_key)})()

    monkeypatch.setattr(sirius_brain, "AsyncOpenAI", FakeClient)
    monkeypatch.setattr(sirius_brain, "client", FakeClient("owner-intent-private"))
    text = "ouvre le navigateur web stp"
    # Expired: personal key used, invalid personal key falls back to the local parser only.
    ok = client.post("/api/intent", json={"text": text, "keys": {"groq_key": "good-personal"}})
    assert ok.json() == {"action": "open_app", "app": "edge"}
    bad = client.post("/api/intent", json={"text": text, "keys": {"groq_key": "bad-personal", "x": None}})
    assert bad.status_code == 200 and bad.json() == {"action": "general", "query": text}
    assert client.post("/api/intent", json={"text": text}).json() == {"action": "general", "query": text}
    assert "owner-intent-private" not in created and set(created) == {"good-personal", "bad-personal"}
    # Active trial: a vault without Groq (Kimi/Maps only) still gets trial Groq, charged once.
    asyncio.run(server.db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))
    created.clear()
    partial = {"k3": "personal-kimi", "gmaps": "personal-maps"}
    assert client.post("/api/intent", json={"text": text, "keys": partial}).json()["action"] == "open_app"
    assert created == ["owner-intent-private"]
    assert client.post("/api/intent", json={"text": text, "keys": partial}).status_code == 429
    # Own Groq key keeps working past the trial quota and is never replaced by the owner's.
    assert client.post("/api/intent", json={"text": text, "keys": {**partial, "groq_key": "good-personal"}}).json()["action"] == "open_app"
    bad = client.post("/api/intent", json={"text": text, "keys": {**partial, "groq_key": "bad-personal"}})
    assert bad.json() == {"action": "general", "query": text}
    assert created[:2] == ["owner-intent-private", "good-personal"]
    assert set(created[2:]) == {"bad-personal"}


def _capture_background(monkeypatch, server):
    import contextvars
    import types
    captured = []
    proxy = types.SimpleNamespace(**{name: getattr(asyncio, name) for name in dir(asyncio) if not name.startswith("__")})
    proxy.create_task = lambda coro: captured.append((contextvars.copy_context(), coro))
    monkeypatch.setattr(server, "asyncio", proxy)

    def run_next():
        ctx, coro = captured.pop(0)
        ctx.run(asyncio.run, coro)
    return captured, run_next


def test_background_memory_extraction_uses_daily_quota_limit_expiry_and_personal_key(server_api, db, monkeypatch):
    import sirius_brain
    client, user, server = server_api
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "2")
    seen = []
    async def memory(*args):
        return []
    async def stream(**kwargs):
        yield "réponse"
    async def extract(prompt, answer):
        seen.append(access.provider_key("groq", "owner-bg"))
        return []
    monkeypatch.setattr(server, "_gather_memory_context", memory)
    monkeypatch.setattr(server, "should_extract_memory", lambda *args: True)
    monkeypatch.setattr(sirius_brain, "ask_sirius_stream", stream)
    monkeypatch.setattr(sirius_brain, "extract_memory_background", extract)
    captured, run_next = _capture_background(monkeypatch, server)
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))

    assert client.post("/api/chat/stream", json={"text": "je m'appelle Daniel"}).status_code == 200
    assert _usage(db, user) == 1 and len(captured) == 1
    run_next()  # owner key after the response: charged on the same daily quota
    assert seen == ["owner-bg"] and _usage(db, user) == 2

    # Limit reached: the background task never reaches the owner key and charges nothing more.
    assert client.post("/api/chat/stream", json={"text": "je m'appelle Daniel", "keys": {"k3": "personal-kimi"}}).status_code == 200
    run_next()
    assert seen == ["owner-bg"] and _usage(db, user) == 2

    # Personal Groq key: used even at the limit, never replaced by the owner key, never charged.
    assert client.post("/api/chat/stream", json={"text": "je m'appelle Daniel", "keys": {"groq_key": "personal-groq"}}).status_code == 200
    run_next()
    assert seen == ["owner-bg", "personal-groq"] and _usage(db, user) == 2

    # Expiry between the response and the background task: no owner key, nothing charged.
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "10")
    assert client.post("/api/chat/stream", json={"text": "je m'appelle Daniel", "keys": {"k3": "personal-kimi"}}).status_code == 200
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now() - timedelta(days=7, seconds=1)}}))
    run_next()
    assert seen == ["owner-bg", "personal-groq", ""] and _usage(db, user) == 2


def test_scheduled_summary_charges_owner_quota_and_stops_at_limit(db, monkeypatch):
    import episodic
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "1")
    monkeypatch.setattr(episodic, "add_episode", lambda *args, **kwargs: None)
    user = account(started=access.utc_now())
    seen = []

    async def scenario():
        await db.users.insert_one(user)
        for name in ("a", "b"):
            await db.sirius_chats.insert_one({
                "session_id": f"{user['user_id']}:{name}",
                "updated_at": (access.utc_now() - timedelta(hours=1)).isoformat(),
                "history": [{"role": "user", "content": "test"}] * 4,
            })
        async def summarize(history):
            seen.append(access.provider_key("groq", "owner-summary"))
            return {"resume": "résumé", "faits": []}
        return await episodic.condense_idle_sessions(db, summarize, enforce_accounts=True)
    assert asyncio.run(scenario()) == 1
    assert seen == ["owner-summary"] and _usage(db, user) == 1


def test_nummarius_alerts_charged_only_when_owner_alpha_is_used(modules, db, monkeypatch):
    import nummarius_api
    client, user, calls, _ = modules
    monkeypatch.setenv("SIRIUS_QUOTA_CHAT", "2")
    asyncio.run(db.users.update_one({"user_id": user["user_id"]}, {"$set": {"trial_started_at": access.utc_now()}}))

    def owner_alpha_calls():
        return [r for r in calls if r.url.host == "www.alphavantage.co" and "owner-alpha" in str(r.url)]

    created = client.post("/api/nummarius/alerts", json={"asset_id": "AAPL", "threshold": 1})
    assert created.status_code == 200 and _usage(db, user) == 0
    assert client.get("/api/nummarius/alerts").status_code == 200
    assert len(owner_alpha_calls()) == 4 and _usage(db, user) == 1
    assert client.get("/api/nummarius/alerts").status_code == 200  # cache: no owner use, refunded
    assert len(owner_alpha_calls()) == 4 and _usage(db, user) == 1
    nummarius_api._stock_hist.clear()
    personal = client.get("/api/nummarius/alerts", headers={"X-Sirius-Alphavantage-Key": "personal-alpha"})
    assert personal.status_code == 200 and len(owner_alpha_calls()) == 4 and _usage(db, user) == 1
    nummarius_api._stock_hist.clear()
    assert client.get("/api/nummarius/alerts").status_code == 200
    assert len(owner_alpha_calls()) == 8 and _usage(db, user) == 2
    # Limit reached: free fallback only, never the owner key, still answered.
    nummarius_api._stock_hist.clear()
    limited = client.get("/api/nummarius/alerts")
    assert limited.status_code == 200 and limited.json()["alerts"][0]["current_value"] == 11.0
    assert len(owner_alpha_calls()) == 8 and _usage(db, user) == 2


def test_expired_nummarius_alerts_never_use_owner_alpha(modules, db):
    client, user, calls, _ = modules
    assert client.get("/api/nummarius/alerts").status_code == 200
    assert owner_secrets_sent(calls) == [] and _usage(db, user) == 0


def test_frontend_kimi_field_groq_is_personal_kimi_not_groq(modules):
    # Frontend vault field "groq" historically holds the Kimi K3 key; "groq_key" holds Groq.
    client, _, _, _ = modules
    bulletin = client.post("/api/technews/bulletin", json={"keys": {"groq": "personal-kimi"}})
    assert bulletin.status_code == 200 and bulletin.json()["bulletin"] == FakeLLM.content
    coach = client.post("/api/agora/coach", json={"history": [], "keys": {"groq": "personal-kimi"}})
    assert coach.status_code == 200 and coach.json()["reponse"] == "Coach OK"
    plan = client.post("/api/floorplan", json={"description": "T2", "keys": {"groq": "personal-kimi"}})
    assert plan.status_code == 403 and plan.json()["detail"] == access.PERSONAL_REQUIRED
    assert FakeLLM.calls == ["personal-kimi", "personal-kimi"]
    with access.provider_scope(account(), {"groq": "personal-kimi", "groq_key": "personal-groq"}):
        assert access.provider_key("k3", "owner-kimi") == "personal-kimi"
        assert access.provider_key("groq", "owner-groq") == "personal-groq"

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createAppTester } = require("zapier-platform-core");
const nock = require("nock");
const App = require("../index");
const { baseUrl } = require("../client");
const tester = createAppTester(App);
const authData = { apiUrl: "https://sirius.example/api", apiKey: "szk_test" };
nock.disableNetConnect();
afterEach(() => {
  assert.equal(nock.isDone(), true, "All mocked API requests must have been made.");
  nock.cleanAll();
});

test("SDK authenticates and handles expiry using the real HTTP middleware", async () => {
  nock("https://sirius.example", { reqheaders: { "X-Sirius-Api-Key": "szk_test" } })
    .get("/api/integrations/zapier/me").reply(200, { id: "key", label: "Test" });
  const result = await tester(App.authentication.test, { authData });
  assert.equal(result.label, "Test");
  nock("https://sirius.example").get("/api/integrations/zapier/me").reply(401, { detail: "expired" });
  await assert.rejects(tester(App.authentication.test, { authData }), /expiree ou revoquee/);
});

test("SDK subscription, sample and unsubscription use persisted subscribeData", async () => {
  nock("https://sirius.example")
    .post("/api/integrations/zapier/hooks", { event: "dossier.created", target_url: "https://hooks.zapier.com/hooks/standard/test" })
    .reply(201, { id: "hook", secret: "secret" });
  const subscribeData = await tester(App.triggers.new_dossier.operation.performSubscribe, {
    authData, targetUrl: "https://hooks.zapier.com/hooks/standard/test",
  });
  assert.equal(subscribeData.id, "hook");
  nock("https://sirius.example").get("/api/integrations/zapier/samples/dossier.created").reply(200, []);
  assert.deepEqual(await tester(App.triggers.new_dossier.operation.performList, { authData }), []);
  nock("https://sirius.example").delete("/api/integrations/zapier/hooks/hook").reply(200, { unsubscribed: true });
  assert.equal((await tester(App.triggers.new_dossier.operation.performUnsubscribe, {
    authData, subscribeData,
  })).unsubscribed, true);
});

test("SDK executes search and action with the exact stable UUID", async () => {
  nock("https://sirius.example").get("/api/integrations/zapier/dossiers").query({ title: "Projet", id: "" })
    .reply(200, [{ id: "d1", title: "Projet" }]);
  assert.equal((await tester(App.searches.find_dossier.operation.perform, {
    authData, inputData: { title: "Projet" },
  }))[0].id, "d1");
  const inputData = { dossier_id: "d1", text: "Note", request_id: "00000000-0000-4000-8000-000000000001" };
  nock("https://sirius.example").post("/api/integrations/zapier/notes", inputData)
    .reply(200, { id: inputData.request_id, text: "Note" });
  assert.equal((await tester(App.creates.add_note.operation.perform, { authData, inputData })).id, inputData.request_id);
});

test("URL validation rejects credentials, query strings, HTTP and extra paths", () => {
  for (const url of ["http://localhost/api", "https://u:p@sirius.example/api",
    "https://sirius.example/api?token=x", "https://sirius.example/api#x", "https://sirius.example/no"]) {
    assert.throws(() => baseUrl(url));
  }
  assert.equal(baseUrl(authData.apiUrl), "https://sirius.example/api/integrations/zapier");
});

test("hook validates secret and type, returns a stable deduplication id", async () => {
  const body = { id: "dossier.created:one", event: "dossier.created",
    resource_id: "one", title: "Projet", created_at: "2026-01-01T12:00:00Z" };
  const bundle = { authData, subscribeData: { secret: "test-secret" },
    cleanedRequest: { headers: { "X-Sirius-Hook-Secret": "test-secret" }, content: body } };
  assert.deepEqual(await tester(App.triggers.new_dossier.operation.perform, bundle), [body]);
  await assert.rejects(tester(App.triggers.meeting_ready.operation.perform, bundle), /non conforme/);
  bundle.cleanedRequest.headers = {};
  await assert.rejects(tester(App.triggers.new_dossier.operation.perform, bundle), /Secret/);
});

test("transport sends key only in header and preserves the note UUID", async () => {
  const { request } = require("../client");
  let seen;
  const z = { request: async (options) => {
    seen = options;
    return { status: 200, json: { id: "stable" }, throwForStatus() {} };
  } };
  const body = { request_id: "stable" };
  assert.deepEqual(await request(z, { authData }, "/notes", { method: "POST", body }), { id: "stable" });
  assert.equal(seen.headers["X-Sirius-Api-Key"], authData.apiKey);
  assert.equal(seen.url.includes(authData.apiKey), false);
  assert.equal(seen.redirect, "error");
  assert.deepEqual(seen.body, body);
});

test("authentication expiry and rate limiting are explicit", async () => {
  const { request } = require("../client");
  class ExpiredAuthError extends Error {}
  class ThrottledError extends Error {}
  for (const [status, expected] of [[401, ExpiredAuthError], [429, ThrottledError]]) {
    const z = { errors: { ExpiredAuthError, ThrottledError },
      request: async () => ({ status }) };
    await assert.rejects(request(z, { authData }, "/me"), expected);
  }
});

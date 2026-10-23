"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeHandler: customHandler } = require("../custom");
const { makeHandler: homeHandler } = require("../smart-home");
const { api, ApiError } = require("../api");
const model = require("../models/fr-FR.json");

const SKILL = "amzn1.ask.skill.example";
const TOKEN = "saa_" + "a".repeat(43);
const DEVICE = "a".repeat(64);

function custom(intent, token = TOKEN) {
  return {
    version: "1.0",
    session: { new: true, sessionId: "session", application: { applicationId: SKILL }, user: { userId: "alexa-user" } },
    context: { System: { application: { applicationId: SKILL }, user: { userId: "alexa-user", ...(token ? { accessToken: token } : {}) } } },
    request: { type: intent ? "IntentRequest" : "LaunchRequest", requestId: "request",
      timestamp: new Date().toISOString(), locale: "fr-FR", ...(intent ? { intent: { name: intent } } : {}) },
  };
}

function smart(namespace = "Alexa.PowerController", name = "TurnOn", payload = {}) {
  return { directive: {
    header: { namespace, name, payloadVersion: "3", messageId: "message-1", correlationToken: "correlation" },
    endpoint: { endpointId: DEVICE, scope: { type: "BearerToken", token: TOKEN } },
    payload,
  } };
}

const state = { state: { powerState: "ON", brightness: 50 }, observed_at: "2026-01-01T12:00:00.000Z" };

test("custom skill links account without exposing data", async () => {
  const handler = customHandler(() => assert.fail("No API call"), SKILL);
  const reply = await handler(custom("ListDossiersIntent", null), {});
  assert.equal(reply.response.card.type, "LinkAccount");
  assert.equal(reply.response.shouldEndSession, true);
});

test("custom skill rejects missing Skill ID configuration", () => {
  assert.throws(() => customHandler(api, ""));
});

test("custom skill verifies application ID before reading any data", async () => {
  const handler = customHandler(() => assert.fail("Wrong skill must not call SIRIUS"), SKILL);
  const event = custom("ListDossiersIntent");
  event.context.System.application.applicationId = "amzn1.ask.skill.attacker";
  event.session.application.applicationId = "amzn1.ask.skill.attacker";
  await assert.rejects(handler(event, {}), /verification failed/);
});

test("custom skill escapes provider text rather than inserting SSML", async () => {
  const handler = customHandler(async () => ({ items: [{ title: '<audio src="evil"/> & secret' }] }), SKILL);
  const reply = await handler(custom("ListDossiersIntent"), {});
  const text = reply.response.outputSpeech.ssml;
  assert.ok(text.includes("&lt;audio"));
  assert.ok(!text.includes("<audio"));
  assert.ok(text.includes("&amp;"));
});

test("custom title slot is bounded and URL encoded; only dossier lookup occurs", async () => {
  let called;
  const handler = customHandler(async (path, token) => {
    called = { path, token }; return { items: [] };
  }, SKILL);
  const event = custom("FindDossierIntent");
  event.request.intent.slots = { titre: { name: "titre", value: "Client & été" } };
  await handler(event, {});
  assert.equal(called.path, "/api/integrations/alexa/dossiers?title=Client%20%26%20%C3%A9t%C3%A9");
  assert.equal(called.token, TOKEN);
});

test("custom meeting warns about incomplete capture and limits readout", async () => {
  const handler = customHandler(async () => ({
    items: [{ title: "Réunion", summary: "z".repeat(5000), capture_complete: false }],
  }), SKILL);
  const reply = await handler(custom("LatestMeetingIntent"), {});
  assert.match(reply.response.outputSpeech.ssml, /capture déclarée incomplète/);
  assert.ok(reply.response.outputSpeech.ssml.length < 2100);
});

test("custom authentication failure gives LinkAccount, not fabricated data", async () => {
  const handler = customHandler(async () => { throw new ApiError(401); }, SKILL);
  assert.equal((await handler(custom("ListDossiersIntent"), {})).response.card.type, "LinkAccount");
});

test("custom launch, help, stop and unsupported intent do not call an API", async () => {
  const handler = customHandler(() => assert.fail("No API call"), SKILL);
  for (const intent of [null, "AMAZON.HelpIntent", "AMAZON.StopIntent", "AMAZON.FallbackIntent", "TurnOn"]) {
    const reply = await handler(custom(intent), {});
    assert.ok(reply.response.outputSpeech);
  }
  const event = custom();
  event.request.type = "SessionEndedRequest";
  assert.ok((await handler(event, {})).response);
});

test("French model separates search title slots from native Smart Home", () => {
  const intents = model.interactionModel.languageModel.intents;
  assert.equal(intents.find((i) => i.name === "FindDossierIntent").slots[0].type, "AMAZON.SearchQuery");
  assert.ok(!intents.some((i) => /Power|Brightness|TurnOn/.test(i.name)));
});

test("Smart Home discovery only exposes returned authorized endpoints", async () => {
  const handler = homeHandler(async (path, token) => {
    assert.equal(path, "/api/integrations/tuya/alexa/discovery");
    assert.equal(token, TOKEN);
    return { devices: [{ endpoint_id: DEVICE, name: "Bureau", category: "LIGHT", brightness: true }] };
  });
  const reply = await handler(smart("Alexa.Discovery", "Discover", { scope: { type: "BearerToken", token: TOKEN } }));
  assert.equal(reply.event.header.namespace, "Alexa.Discovery");
  assert.equal(reply.event.header.name, "Discover.Response");
  const endpoint = reply.event.payload.endpoints[0];
  assert.equal(endpoint.endpointId, DEVICE);
  assert.ok(endpoint.capabilities.some((c) => c.interface === "Alexa.BrightnessController"));
  assert.ok(endpoint.capabilities.slice(1).every((c) => !c.properties.proactivelyReported));
});

test("Smart Home command carries idempotency ID, reports confirmed state and correlation", async () => {
  const handler = homeHandler(async (path, token, body) => {
    assert.equal(path, "/api/integrations/tuya/alexa/command");
    assert.equal(token, TOKEN);
    assert.deepEqual(body, { endpoint_id: DEVICE, message_id: "message-1", action: "TurnOn" });
    return state;
  });
  const reply = await handler(smart());
  assert.equal(reply.event.header.correlationToken, "correlation");
  assert.equal(reply.event.header.name, "Response");
  assert.equal(reply.context.properties[0].value, "ON");
  assert.ok(!JSON.stringify(reply).includes(TOKEN));
});

test("Smart Home handles native SetBrightness, AdjustBrightness and ReportState", async () => {
  const calls = [];
  const handler = homeHandler(async (path, token, body) => { calls.push({ path, body }); return state; });
  await handler(smart("Alexa.BrightnessController", "SetBrightness", { brightness: 50 }));
  await handler(smart("Alexa.BrightnessController", "AdjustBrightness", { brightnessDelta: -25 }));
  const report = await handler(smart("Alexa", "ReportState"));
  assert.equal(calls[0].body.value, 50);
  assert.equal(calls[1].body.value, -25);
  assert.equal(calls[2].path, `/api/integrations/tuya/alexa/state/${DEVICE}`);
  assert.equal(report.event.header.name, "StateReport");
});

test("Smart Home invalid payload and forbidden interfaces never reach SIRIUS", async () => {
  const handler = homeHandler(() => assert.fail("No API call"));
  for (const event of [
    smart("Alexa.LockController", "Unlock"),
    smart("Alexa.BrightnessController", "SetBrightness", { brightness: 101 }),
    smart("Alexa.BrightnessController", "SetBrightness", { brightness: "50" }),
    smart("Alexa.BrightnessController", "AdjustBrightness", { brightnessDelta: -101 }),
    {},
  ]) assert.equal((await handler(event)).event.header.name, "ErrorResponse");
});

test("Smart Home missing token, removed device and uncertain result return errors without retry", async () => {
  const noToken = smart();
  delete noToken.directive.endpoint.scope;
  assert.equal((await homeHandler(() => assert.fail())(noToken)).event.payload.type, "EXPIRED_AUTHORIZATION_CREDENTIAL");
  for (const [status, expected] of [[401, "EXPIRED_AUTHORIZATION_CREDENTIAL"], [403, "INSUFFICIENT_PERMISSIONS"],
    [404, "NO_SUCH_ENDPOINT"], [409, "ENDPOINT_BUSY"], [504, "INTERNAL_ERROR"]]) {
    let calls = 0;
    const reply = await homeHandler(async () => { calls++; throw new ApiError(status); })(smart());
    assert.equal(calls, 1);
    assert.equal(reply.event.payload.type, expected);
    assert.ok(!reply.context);
  }
});

test("Smart Home never reports success from malformed state", async () => {
  const reply = await homeHandler(async () => ({ state: { powerState: "ON" } }))(smart());
  assert.equal(reply.event.header.name, "ErrorResponse");
});

test("HTTPS client rejects unsafe origins and non-Alexa tokens before networking", async () => {
  for (const origin of ["http://127.0.0.1", "https://user:pass@example.test", "https://example.test/path"]) {
    process.env.SIRIUS_API_ORIGIN = origin;
    await assert.rejects(api("/api/integrations/alexa/dossiers", TOKEN, undefined, () => assert.fail()));
  }
  process.env.SIRIUS_API_ORIGIN = "https://sirius.example";
  await assert.rejects(api("/api/integrations/alexa/dossiers", "session-jwt", undefined, () => assert.fail()));
  await assert.rejects(api("/api/integrations/../../auth", TOKEN, undefined, () => assert.fail()));
  assert.deepEqual(await api("/api/integrations/alexa/dossiers?title=Projet..2026", TOKEN, undefined,
    async () => new Response('{"items":[]}')), { items: [] });
});

test("HTTPS transport fixes destination, disables redirects, bounds response and never retries errors", async () => {
  process.env.SIRIUS_API_ORIGIN = "https://sirius.example";
  let calls = 0;
  const result = await api("/api/integrations/alexa/dossiers", TOKEN, undefined, async (url, options) => {
    calls++;
    assert.equal(url.origin, "https://sirius.example");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(options.signal);
    return new Response('{"items":[]}');
  });
  assert.deepEqual(result, { items: [] });
  assert.equal(calls, 1);
  await assert.rejects(api("/api/integrations/alexa/dossiers", TOKEN, undefined,
    async () => new Response("x".repeat(96001))));
  await assert.rejects(api("/api/integrations/alexa/dossiers", TOKEN, undefined,
    async () => new Response("denied", { status: 403 })), { status: 403 });
});

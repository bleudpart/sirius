import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { ConsentGate, publishSlack, safeSlackText, TranscriptionQueue, wav } from "../src/capture";
import { apiRoot, SiriusClient } from "../../shared/client";
import prism from "prism-media";
import { generateDependencyReport } from "@discordjs/voice";

const pcm = () => Buffer.alloc(48000 * 4);

test("tous les accords individuels sont requis, sans ajout implicite d'un participant", () => {
  const gate = new ConsentGate([{ id: "123456", label: "Daniel" }, { id: "234567", label: "Martin" }]);
  assert.equal(gate.ready(), false);
  gate.accept("123456"); assert.equal(gate.ready(), false);
  assert.throws(() => gate.accept("999999"));
  gate.accept("234567"); assert.equal(gate.ready(), true);
  assert.equal(gate.unchanged(["123456", "234567", "999999"]), false);
  assert.equal(gate.unchanged(["123456"]), false);
  assert.equal(gate.unchanged(["234567", "123456"]), true);
});

test("groupe vide, dupliqué ou trop grand refusé", () => {
  for (const roster of [[], [{ id: "123456", label: "A" }, { id: "123456", label: "B" }],
    Array.from({ length: 11 }, (_, index) => ({ id: String(index), label: "x" }))])
    assert.throws(() => new ConsentGate(roster));
});

test("WAV exact PCM stéréo 48 kHz 16 bits, sans fichier temporaire", () => {
  const value = wav(pcm());
  assert.equal(value.subarray(0, 4).toString(), "RIFF");
  assert.equal(value.readUInt32LE(24), 48000);
  assert.equal(value.readUInt16LE(22), 2);
  assert.equal(value.readUInt16LE(34), 16);
  assert.equal(value.readUInt32LE(40), 192000);
  assert.equal(value.length, 192044);
  assert.throws(() => wav(Buffer.alloc(0)));
  assert.throws(() => wav(Buffer.alloc(3)));
  assert.throws(() => wav(Buffer.alloc(192000 * 16)));
});

test("SDK voix et décodeur Opus chargés localement sans réseau", () => {
  const decoder = new prism.opus.Decoder({ channels: 2, rate: 48000, frameSize: 960 });
  decoder.destroy();
  assert.match(generateDependencyReport(), /0.19.2/);
});

test("une trame PCM est réellement encodée puis décodée via Opus", async () => {
  const encoder = new prism.opus.Encoder({ channels: 2, rate: 48000, frameSize: 960 });
  const decoder = new prism.opus.Decoder({ channels: 2, rate: 48000, frameSize: 960 });
  const received: Buffer[] = [];
  decoder.on("data", (chunk: Buffer) => received.push(chunk));
  encoder.pipe(decoder);
  encoder.end(Buffer.alloc(960 * 2 * 2));
  await once(decoder, "end");
  assert.equal(Buffer.concat(received).length, 960 * 2 * 2);
  encoder.destroy(); decoder.destroy();
});

test("file de transcription séquentielle, bornée et sans répétition", async () => {
  const order: string[] = [];
  const queue = new TranscriptionQueue(async () => { order.push("stt"); return "Bonjour"; },
    async (sequence, speaker, text) => { order.push(`${sequence}:${speaker}:${text}`); },
    () => assert.fail("aucun échec attendu"));
  queue.push("123456", pcm()); queue.push("234567", pcm());
  await queue.close(false);
  assert.deepEqual(order, ["stt", "0:123456:Bonjour", "stt", "1:234567:Bonjour"]);
  queue.push("123456", pcm()); assert.equal(order.length, 4);
});

test("retrait d'accord annule les fragments non transmis, même après STT en cours", async () => {
  let resolve!: (text: string) => void;
  let calls = 0;
  const saved: string[] = [];
  const queue = new TranscriptionQueue(() => { calls++; return new Promise<string>((done) => { resolve = done; }); },
    async (_, __, text) => { saved.push(text); }, () => assert.fail("échec inattendu"));
  queue.push("123456", pcm()); queue.push("234567", pcm());
  await Promise.resolve();
  const closed = queue.close(true);
  resolve("ne pas sauvegarder");
  await closed;
  assert.equal(calls, 1); assert.deepEqual(saved, []);
});

test("backpressure refuse plus de six fragments en attente et signale l'arrêt", async () => {
  let failed = 0, sttCalls = 0;
  const queue = new TranscriptionQueue(async () => { sttCalls++; return "x"; }, async () => undefined, () => { failed++; });
  for (let index = 0; index < 8; index++) queue.push("123456", pcm());
  await queue.close(false);
  assert.equal(failed, 1); assert.equal(sttCalls, 0); assert.equal(queue.failed, true);
});

test("erreur de transcription ou de stockage ne déclenche jamais de retry", async () => {
  for (const failAt of ["stt", "save"]) {
    let failed = 0, sttCalls = 0, saveCalls = 0;
    const queue = new TranscriptionQueue(async () => {
      sttCalls++; if (failAt === "stt") throw new Error("failed"); return "x";
    }, async () => { saveCalls++; throw new Error("uncertain"); }, () => { failed++; });
    queue.push("123456", pcm()); queue.push("123456", pcm());
    await queue.close(false);
    assert.equal(sttCalls, 1); assert.equal(saveCalls, failAt === "save" ? 1 : 0);
    assert.equal(failed, 1);
  }
});

test("sorties trop longues stoppent la file avant stockage et limite 24 000 exacte", async () => {
  let failed = 0, saved = 0;
  const queue = new TranscriptionQueue(async () => "x".repeat(2000), async () => { saved++; }, () => { failed++; });
  for (let index = 0; index < 13; index++) {
    queue.push("123456", pcm());
    await new Promise((resolve) => setImmediate(resolve));
  }
  await queue.close(false);
  assert.equal(saved, 12); assert.equal(failed, 1);
});

test("limite 240 fragments exacte même si le STT ne trouve pas de parole", async () => {
  let calls = 0, failed = 0;
  const queue = new TranscriptionQueue(async () => { calls++; return ""; }, async () => assert.fail(), () => { failed++; });
  for (let index = 0; index < 241; index++) {
    queue.push("123456", pcm());
    await new Promise((resolve) => setImmediate(resolve));
  }
  await queue.close(false);
  assert.equal(calls, 240); assert.equal(failed, 1);
});

test("transport API refuse HTTP distant, credentials, fragments et URL sans /api", () => {
  for (const url of ["http://example.test/api", "https://secret@example.test/api", "https://example.test/api?token=x",
    "https://example.test/api#secret", "https://example.test/"])
    assert.throws(() => apiRoot(url));
  assert.equal(apiRoot("http://127.0.0.1:8001/api/"), "http://127.0.0.1:8001/api");
  assert.equal(apiRoot("https://example.test/api"), "https://example.test/api");
  assert.throws(() => new SiriusClient("https://example.test/api", ""));
});

test("validation transmet l'empreinte exacte et les affectations sans exécution implicite", async () => {
  const original = global.fetch;
  const calls: { url: string; options?: RequestInit }[] = [];
  global.fetch = async (input, options) => {
    calls.push({ url: String(input), options });
    return Response.json({ entry_id: "one", cross_user_delivery: false });
  };
  try {
    const client = new SiriusClient("https://example.test/api", "session");
    await client.approve({ id: "meeting-one", title: "x", state: "READY", participants: [],
      created_at: "", fingerprint: "a".repeat(64) }, "dossier-one", [{ task_index: 0, participant_id: "123456" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options?.redirect, "error");
    const payload = JSON.parse(String(calls[0].options?.body));
    assert.equal(payload.fingerprint, "a".repeat(64));
    assert.equal(payload.confirm, true);
    assert.equal(payload.assignments[0].participant_id, "123456");
    assert.equal(calls[0].options?.headers && new Headers(calls[0].options.headers).get("Authorization"), "Bearer session");
  } finally { global.fetch = original; }
});

test("STT utilise l'API SIRIUS existante et une erreur n'est pas rejouée", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (input, options) => {
    calls++;
    assert.equal(String(input), "https://example.test/api/stt");
    assert.equal(options?.method, "POST");
    assert.ok(options?.body instanceof FormData);
    return Response.json({ detail: "quota" }, { status: 429 });
  };
  try {
    await assert.rejects(new SiriusClient("https://example.test/api", "session").transcribe(wav(pcm())));
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});

test("commande Raycast transmet seulement le texte explicite et la session au chat", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (input, options) => {
    calls++; assert.equal(String(input), "https://example.test/api/chat");
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(body, { text: "Bonjour", session_id: "raycast-one", keys: { cerebras: "personal-key" } });
    return Response.json({ answer: "Bonjour Daniel" });
  };
  try {
    assert.equal((await new SiriusClient("https://example.test/api", "session", "personal-key")
      .ask("Bonjour", "raycast-one")).answer, "Bonjour Daniel");
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});

test("publication Slack échappe les mentions et refuse les réponses non confirmées", async () => {
  assert.equal(safeSlackText("<!channel> & <@U123>"), "&lt;!channel&gt; &amp; &lt;@U123&gt;");
  const original = global.fetch;
  let calls = 0;
  global.fetch = async (input, options) => {
    calls++;
    assert.equal(String(input), "https://slack.com/api/chat.postMessage");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.mrkdwn, false); assert.equal(body.parse, "none");
    assert.equal(body.unfurl_links, false); assert.equal(body.channel, "C12345");
    assert.equal(body.text, "&lt;!channel&gt;");
    return Response.json({ ok: false, error: "not_in_channel" });
  };
  try {
    await assert.rejects(publishSlack("secret-token", "C12345", "<!channel>"));
    assert.equal(calls, 1);
    await assert.rejects(publishSlack("", "C12345", "x")); assert.equal(calls, 1);
  } finally { global.fetch = original; }
});

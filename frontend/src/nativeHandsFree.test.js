import { createNativeHandsFree } from "./nativeHandsFree";

const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

function setup(transcribe = jest.fn(async () => ({ ok: true, data: { text: "quelle heure est-il" } })), identity = {}) {
  const events = {};
  const plugin = {
    available: jest.fn(async () => ({ available: true })),
    addListener: jest.fn(async (name, callback) => {
      events[name] = callback;
      return { remove: jest.fn(async () => {}) };
    }),
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    setSuppressed: jest.fn(async () => {}),
  };
  const onState = jest.fn();
  const onTranscript = jest.fn();
  const requireIdentity = identity.requireIdentity || jest.fn(async () => ({ ready: true, enrolled: true }));
  const verifyIdentity = identity.verifyIdentity || jest.fn(async () => ({ verified: true }));
  const controller = createNativeHandsFree({ plugin, transcribe, onState, onTranscript, requireIdentity, verifyIdentity });
  return { controller, plugin, events, transcribe, onState, onTranscript, requireIdentity, verifyIdentity };
}

test.each([false, undefined])("unrecognized or malformed speaker decision %s never transcribes TV audio", async (verified) => {
  const verifyIdentity = jest.fn(async () => ({ verified }));
  const { controller, events, transcribe, onTranscript, plugin } = setup(undefined, { verifyIdentity });
  await controller.setBlocked(false);
  await controller.start();
  events.utterance({ audio: btoa("RIFFtelevision") });
  await flush();
  expect(verifyIdentity).toHaveBeenCalledWith(expect.any(Blob), { signal: expect.any(AbortSignal) });
  expect(transcribe).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(plugin.setSuppressed).toHaveBeenLastCalledWith({ suppressed: false });
  await controller.stop();
});

test("missing profile or unavailable verifier blocks native microphone startup", async () => {
  const requireIdentity = jest.fn(async () => { throw new Error("Profil absent"); });
  const { controller, plugin, onState } = setup(undefined, { requireIdentity });
  await controller.start();
  expect(plugin.start).not.toHaveBeenCalled();
  expect(onState).toHaveBeenCalledWith({ phase: "error", message: "Profil absent" });
});

test("verification errors stop capture without permissive transcription fallback", async () => {
  const verifyIdentity = jest.fn(async () => { throw new Error("Serveur indisponible"); });
  const { controller, events, transcribe, onTranscript, onState } = setup(undefined, { verifyIdentity });
  await controller.setBlocked(false);
  await controller.start();
  events.utterance({ audio: btoa("RIFFtest") });
  await flush();
  expect(transcribe).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(controller.active).toBe(false);
  expect(onState).toHaveBeenCalledWith({ phase: "error", message: "Serveur indisponible" });
});

test("Stop discards a late successful identity verification", async () => {
  let finish;
  const verifyIdentity = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
  const { controller, events, transcribe, onTranscript } = setup(undefined, { verifyIdentity });
  await controller.setBlocked(false);
  await controller.start();
  events.utterance({ audio: btoa("RIFFtest") });
  await flush();
  await controller.stop();
  expect(verifyIdentity.mock.calls[0][1].signal.aborted).toBe(true);
  finish({ verified: true });
  await flush();
  expect(transcribe).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
});

test("native state remains verifying until identity succeeds, then becomes transcribing", async () => {
  let finish;
  const verifyIdentity = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
  const { controller, events, onState, transcribe } = setup(undefined, { verifyIdentity });
  await controller.setBlocked(false);
  await controller.start();
  onState.mockClear();
  events.utterance({ audio: btoa("RIFFtest") });
  await flush();
  expect(onState).toHaveBeenLastCalledWith({ phase: "verifying", message: expect.any(String) });
  expect(onState.mock.calls.some(([event]) => event.phase === "transcribing")).toBe(false);
  expect(transcribe).not.toHaveBeenCalled();
  finish({ verified: true });
  await flush();
  expect(onState).toHaveBeenCalledWith({ phase: "transcribing", message: expect.stringContaining("Voix vérifiée") });
  await controller.stop();
});
test("opens once, suppresses playback and resumes without reopening the microphone", async () => {
  const { controller, plugin } = setup();
  await controller.setBlocked(false);
  await controller.start();
  expect(plugin.start).toHaveBeenCalledWith({ diagnosticCapture: false });
  await controller.setBlocked(true);
  await controller.setBlocked(true);
  await controller.setBlocked(false);
  expect(plugin.start).toHaveBeenCalledTimes(1);
  expect(plugin.setSuppressed.mock.calls.map(([arg]) => arg.suppressed)).toEqual([false, true, false]);
  await controller.stop();
  expect(controller.active).toBe(false);
});

test("local diagnostic recording requires an explicit per-session option", async () => {
  const { controller, plugin } = setup();
  await controller.start({ diagnosticCapture: true });
  expect(plugin.start).toHaveBeenCalledWith({ diagnosticCapture: true });
  await controller.stop();
  await controller.start();
  expect(plugin.start).toHaveBeenLastCalledWith({ diagnosticCapture: false });
  await controller.stop();
});

test("uploads WAV once, ignores concurrent audio and remains blocked until response completes", async () => {
  let resolve;
  const transcribe = jest.fn(() => new Promise((done) => { resolve = done; }));
  const { controller, events, onTranscript, plugin, verifyIdentity } = setup(transcribe);
  await controller.setBlocked(false);
  await controller.start();
  events.utterance({ audio: btoa("RIFFtest"), durationMs: 500 });
  events.utterance({ audio: btoa("RIFFecho"), durationMs: 500 });
  await flush();
  expect(transcribe).toHaveBeenCalledTimes(1);
  expect(verifyIdentity.mock.invocationCallOrder[0]).toBeLessThan(transcribe.mock.invocationCallOrder[0]);
  expect(transcribe.mock.calls[0][0].get("file").type).toBe("audio/wav");
  resolve({ ok: true, data: { text: "quelle heure est-il" } });
  await flush();
  expect(onTranscript).toHaveBeenCalledWith("quelle heure est-il");
  events.utterance({ audio: btoa("RIFFecho") });
  await flush();
  expect(transcribe).toHaveBeenCalledTimes(1);
  await controller.setBlocked(false);
  expect(plugin.start).toHaveBeenCalledTimes(1);
  await controller.stop();
});

test("Stop aborts transcription and ignores a late result", async () => {
  let resolve;
  const { controller, events, transcribe, onTranscript } = setup(jest.fn(() => new Promise((done) => { resolve = done; })));
  await controller.setBlocked(false);
  await controller.start();
  events.utterance({ audio: btoa("RIFFtest") });
  await flush();
  await controller.stop();
  expect(transcribe.mock.calls[0][1].signal.aborted).toBe(true);
  resolve({ ok: true, data: { text: "ancienne demande" } });
  await flush();
  expect(onTranscript).not.toHaveBeenCalled();
});

test("a transcription error closes the session and is displayed", async () => {
  const { controller, events, onState, onTranscript } = setup(jest.fn(async () => ({ ok: false, data: { detail: "Quota dépassé." } })));
  await controller.setBlocked(false);
  await controller.start();
  events.utterance({ audio: btoa("RIFFtest") });
  await flush();
  expect(controller.active).toBe(false);
  expect(onState).toHaveBeenCalledWith({ phase: "error", message: "Quota dépassé." });
  expect(onTranscript).not.toHaveBeenCalled();
});

test("Stop while startup is pending never reactivates the microphone", async () => {
  const { controller, plugin, onState } = setup();
  let ready;
  plugin.start.mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
  await controller.setBlocked(false);
  const opening = controller.start();
  await flush();
  await controller.stop();
  ready();
  await opening;
  expect(plugin.setSuppressed).not.toHaveBeenCalled();
  expect(onState).not.toHaveBeenCalledWith({ phase: "ready", message: "" });
});

test("Prêt waits for fresh audio after the native resume guard", async () => {
  const { controller, events, onState } = setup();
  await controller.setBlocked(false);
  await controller.start();
  expect(onState).not.toHaveBeenCalledWith({ phase: "ready", message: "" });
  events.state({ phase: "ready", suppressed: true, listening: false });
  expect(onState).not.toHaveBeenCalledWith({ phase: "ready", message: "" });
  events.state({ phase: "ready", suppressed: false, listening: true });
  expect(onState).toHaveBeenCalledWith({ phase: "ready", message: "" });
  await controller.stop();
});

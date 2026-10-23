import { API_BASE_URL } from "./lib/api";
import { requireVoiceIdentity, verifyVoiceIdentity, enrollVoiceIdentity, deleteVoiceIdentity } from "./voiceIdentity";

const originalFetch = global.fetch;
beforeEach(() => { global.fetch = jest.fn(); });
afterEach(() => { global.fetch = originalFetch; });
const response = (data, ok = true) => ({ ok, json: async () => data });

test.each([
  { ready: false, enrolled: true },
  { ready: true, enrolled: false },
  { ready: "true", enrolled: true },
  {},
])("unavailable, missing and invalid profile status fails closed: %j", async (status) => {
  global.fetch.mockResolvedValue(response(status));
  await expect(requireVoiceIdentity()).rejects.toThrow();
});

test("verified readiness uses authenticated central API and does not upload audio", async () => {
  global.fetch.mockResolvedValue(response({ ready: true, enrolled: true }));
  await expect(requireVoiceIdentity()).resolves.toEqual({ ready: true, enrolled: true });
  expect(global.fetch).toHaveBeenCalledWith(`${API_BASE_URL}/voice-identity/status`, expect.objectContaining({ credentials: "include", method: "GET" }));
  expect(global.fetch.mock.calls[0][1].body).toBeUndefined();
});

test("model changes explain how to recreate the profile without treating it as a network outage", async () => {
  global.fetch.mockResolvedValue(response({ ready: false, enrolled: true, reason: "model_changed" }));
  await expect(requireVoiceIdentity()).rejects.toThrow("Supprimez l'ancienne empreinte");
});
test("only a literal boolean success verifies the utterance", async () => {
  const audio = new Blob(["audio"], { type: "audio/wav" });
  global.fetch.mockResolvedValue(response({ verified: false, reason: "speaker_mismatch" }));
  await expect(verifyVoiceIdentity(audio)).resolves.toMatchObject({ verified: false, message: expect.stringContaining("ignorée") });
  expect(global.fetch.mock.calls[0][1].body.get("file").type).toBe("audio/wav");
  global.fetch.mockResolvedValue(response({ verified: "true" }));
  await expect(verifyVoiceIdentity(audio)).rejects.toThrow("invalide");
  global.fetch.mockResolvedValue(response({ detail: "Indisponible" }, false));
  await expect(verifyVoiceIdentity(audio)).rejects.toThrow("Indisponible");
});

test("disabled protection and expired session give distinct recovery actions", async () => {
  global.fetch.mockResolvedValue(response({ ready: false, enrolled: false, reason: "operator_disabled" }));
  await expect(requireVoiceIdentity()).rejects.toThrow("terminer son installation");
  global.fetch.mockResolvedValue({ ...response({}, false), status: 401 });
  await expect(requireVoiceIdentity()).rejects.toThrow("Reconnectez-vous");
});

test("a verification deadline is explained but voluntary cancellation stays an AbortError", async () => {
  jest.useFakeTimers();
  global.fetch.mockImplementation((url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  try {
    const pending = verifyVoiceIdentity(new Blob(["voice"]));
    const failed = expect(pending).rejects.toThrow("délai prévu");
    jest.advanceTimersByTime(20000);
    await failed;
    const controller = new AbortController();
    const cancelled = verifyVoiceIdentity(new Blob(["voice"]), { signal: controller.signal });
    const checked = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await checked;
    expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
test.each(["operator_disabled", "not_enrolled", "model_changed", "profile_revoked", "busy", "invalid_audio_or_inference", "unknown_reason"])(
  "verification failure %s is fatal, not a normal speaker mismatch", async (reason) => {
    global.fetch.mockResolvedValue(response({ verified: false, reason }));
    await expect(verifyVoiceIdentity(new Blob(["voice"]))).rejects.toThrow("arrêtée");
  }
);

test("a match needs the explicit server success reason; short audio can safely resume", async () => {
  const audio = new Blob(["voice"]);
  global.fetch.mockResolvedValue(response({ verified: true, reason: "speaker_match" }));
  await expect(verifyVoiceIdentity(audio)).resolves.toMatchObject({ verified: true });
  global.fetch.mockResolvedValue(response({ verified: true, reason: "speaker_mismatch" }));
  await expect(verifyVoiceIdentity(audio)).rejects.toThrow("incohérente");
  global.fetch.mockResolvedValue(response({ verified: false, reason: "insufficient_audio" }));
  await expect(verifyVoiceIdentity(audio)).resolves.toMatchObject({ verified: false, message: expect.stringContaining("trop court") });
});
test("enrollment explicitly consents to the supplied new recordings, deletion uses its own endpoint", async () => {
  global.fetch.mockResolvedValue(response({ enrolled: true }));
  const samples = Array.from({ length: 3 }, () => ({ audio: new Blob(["voice"], { type: "audio/webm" }) }));
  await enrollVoiceIdentity(samples);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe(`${API_BASE_URL}/voice-identity/enroll`);
  expect(options.body.getAll("files")).toHaveLength(3);
  expect(options.body.get("consent")).toBe("true");
  expect(options.headers).toBeUndefined();
  await deleteVoiceIdentity();
  expect(global.fetch).toHaveBeenLastCalledWith(`${API_BASE_URL}/voice-identity/profile`, expect.objectContaining({ method: "DELETE", credentials: "include" }));
});

test("Stop aborts verification and late responses are not accepted", async () => {
  const controller = new AbortController();
  let finish;
  global.fetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = verifyVoiceIdentity(new Blob(["voice"]), { signal: controller.signal });
  controller.abort();
  finish(response({ verified: true }));
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

import { API_BASE_URL } from "../lib/api";
import { ASSISTANT_TIMEOUTS, streamConversation, requestConversation, requestAssistantIntent, requestTranscription } from "./assistantApi";

const originalFetch = global.fetch;
beforeEach(() => {
  jest.useFakeTimers();
  global.fetch = jest.fn();
});
afterEach(() => {
  expect(jest.getTimerCount()).toBe(0);
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const response = (data, ok = true) => ({ ok, status: ok ? 200 : 503, json: jest.fn(async () => data) });
const pendingUntilAbort = (signal) => new Promise((resolve, reject) => {
  signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
});

test("chat uses the central backend, preserves payload and current authenticated fetch", async () => {
  const payload = JSON.stringify({ text: "bonjour", session_id: "test", profile: { name: "Test" } });
  const parent = new AbortController();
  const remove = jest.spyOn(parent.signal, "removeEventListener");
  global.fetch.mockResolvedValue(response({ answer: "Bonjour" }));
  await expect(requestConversation(payload, { signal: parent.signal })).resolves.toEqual({
    ok: true, status: 200, data: { answer: "Bonjour" },
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(`${API_BASE_URL}/chat`, {
    method: "POST", credentials: "include", body: payload,
    headers: { "Content-Type": "application/json" }, signal: expect.any(AbortSignal),
  });
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("HTTP chat failure is returned for the existing local fallback without parsing its body", async () => {
  const failed = response(null, false);
  global.fetch.mockResolvedValue(failed);
  await expect(requestConversation("{}", {})).resolves.toEqual({ ok: false, status: 503, data: null });
  expect(failed.json).not.toHaveBeenCalled();
});

test("intent serializes text and exposes invalid JSON rather than a success-shaped default", async () => {
  global.fetch.mockResolvedValue(response({ action: "open" }));
  await expect(requestAssistantIntent("ouvre le module", {})).resolves.toMatchObject({ data: { action: "open" } });
  expect(global.fetch.mock.calls[0][0]).toBe(`${API_BASE_URL}/intent`);
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ text: "ouvre le module" });
  const parseError = new SyntaxError("Invalid JSON");
  global.fetch.mockResolvedValue({ ok: true, json: () => Promise.reject(parseError) });
  await expect(requestAssistantIntent("ouvre", {})).rejects.toBe(parseError);
});

test("transcription keeps FormData and leaves multipart headers to the browser", async () => {
  const form = new FormData();
  form.append("file", new Blob(["audio"]), "sirius-voice.webm");
  global.fetch.mockResolvedValue(response({ text: "bonjour" }));
  await expect(requestTranscription(form, {})).resolves.toMatchObject({ data: { text: "bonjour" } });
  expect(global.fetch.mock.calls[0][0]).toBe(`${API_BASE_URL}/stt`);
  expect(global.fetch.mock.calls[0][1].body).toBe(form);
  expect(global.fetch.mock.calls[0][1].headers).toBeUndefined();
});

test.each([
  ["conversation", () => requestConversation("{}", {}), ASSISTANT_TIMEOUTS.conversation],
  ["intent", () => requestAssistantIntent("ouvre", {}), ASSISTANT_TIMEOUTS.intent],
  ["transcription", () => requestTranscription(new FormData(), {}), ASSISTANT_TIMEOUTS.transcription],
  ["stream", () => streamConversation("{}", {}, () => {}), ASSISTANT_TIMEOUTS.stream],
])("%s aborts at its exact deadline without retry", async (name, request, deadline) => {
  let signal;
  global.fetch.mockImplementation((url, options) => {
    signal = options.signal;
    return pendingUntilAbort(signal);
  });
  const promise = request();
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  jest.advanceTimersByTime(deadline - 1);
  expect(signal.aborted).toBe(false);
  jest.advanceTimersByTime(1);
  await rejected;
  expect(signal.aborted).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("stream deadline remains active after headers while its consumer reads the body", async () => {
  let signal;
  global.fetch.mockImplementation(async (url, options) => {
    signal = options.signal;
    return response({});
  });
  const consume = jest.fn(() => pendingUntilAbort(signal));
  const promise = streamConversation("{}", {}, consume);
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  expect(consume).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(ASSISTANT_TIMEOUTS.stream);
  await rejected;
});

test("successful stream consumer receives the response and determines the return value", async () => {
  const streamed = { ok: true, body: { getReader: jest.fn() } };
  global.fetch.mockResolvedValue(streamed);
  const consume = jest.fn(async () => "completed");
  await expect(streamConversation("{}", {}, consume)).resolves.toBe("completed");
  expect(consume).toHaveBeenCalledWith(streamed);
  expect(global.fetch.mock.calls[0][0]).toBe(`${API_BASE_URL}/chat/stream`);
});

test("Stop cancels an active stream consumer, not only the wait for headers", async () => {
  const parent = new AbortController();
  let signal;
  global.fetch.mockImplementation(async (url, options) => {
    signal = options.signal;
    return response({});
  });
  const consume = jest.fn(() => pendingUntilAbort(signal));
  const promise = streamConversation("{}", { signal: parent.signal }, consume);
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  expect(consume).toHaveBeenCalledTimes(1);
  parent.abort();
  await rejected;
  expect(signal.aborted).toBe(true);
});

test("JSON deadline remains active until parsing completes", async () => {
  global.fetch.mockImplementation(async (url, { signal }) => ({
    ok: true, json: () => pendingUntilAbort(signal),
  }));
  const promise = requestAssistantIntent("ouvre", {});
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  jest.advanceTimersByTime(ASSISTANT_TIMEOUTS.intent);
  await rejected;
});

test("external cancellation aborts the active request and detaches its listener", async () => {
  const parent = new AbortController();
  const remove = jest.spyOn(parent.signal, "removeEventListener");
  global.fetch.mockImplementation((url, { signal }) => pendingUntilAbort(signal));
  const promise = requestConversation("{}", { signal: parent.signal });
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  parent.abort();
  await rejected;
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("an already canceled session sends nothing", async () => {
  const parent = new AbortController();
  parent.abort();
  await expect(requestConversation("{}", { signal: parent.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(global.fetch).not.toHaveBeenCalled();
});

test("a late result from an uncooperative fetch is rejected after Stop", async () => {
  const parent = new AbortController();
  let finish;
  global.fetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const promise = requestConversation("{}", { signal: parent.signal });
  const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  parent.abort();
  finish(response({ answer: "obsolete" }));
  await rejected;
});

test("network and stream-consumer errors propagate with timers and listeners cleaned up", async () => {
  const parent = new AbortController();
  const remove = jest.spyOn(parent.signal, "removeEventListener");
  const networkError = new TypeError("Network unavailable");
  global.fetch.mockRejectedValue(networkError);
  await expect(requestConversation("{}", { signal: parent.signal })).rejects.toBe(networkError);
  const streamError = new Error("Stream interrupted");
  global.fetch.mockResolvedValue(response({}));
  await expect(streamConversation("{}", { signal: parent.signal }, () => { throw streamError; })).rejects.toBe(streamError);
  expect(remove).toHaveBeenCalledTimes(2);
});

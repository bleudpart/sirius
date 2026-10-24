import { Capacitor, registerPlugin } from "@capacitor/core";
import { hasNativeRemoteVoice, playNativeRemoteVoice, stopNativeRemoteVoice } from "./nativeRemoteVoice";
import { setSessionToken } from "./lib/sessionToken";

jest.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: jest.fn(() => "android"), isPluginAvailable: jest.fn(() => true) },
  registerPlugin: jest.fn(() => ({
    start: jest.fn().mockResolvedValue(),
    stop: jest.fn().mockResolvedValue(),
    addListener: jest.fn(),
  })),
}));

const plugin = registerPlugin.mock.results[0].value;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let emit;
let remove;
const options = { endpoint: "https://sirius.example/api/tts/gemini", items: [
  { body: { text: "Bonjour", voice: "Charon", keys: {} }, volume: 1 },
] };

beforeEach(() => {
  jest.clearAllMocks();
  Capacitor.getPlatform.mockReturnValue("android");
  Capacitor.isPluginAvailable.mockReturnValue(true);
  plugin.start.mockResolvedValue();
  plugin.stop.mockResolvedValue();
  localStorage.clear();
  setSessionToken("test-only-access-token");
  remove = jest.fn().mockResolvedValue();
  plugin.addListener.mockImplementation(async (_, callback) => { emit = callback; return { remove }; });
});
afterEach(async () => { stopNativeRemoteVoice(); await flush(); setSessionToken(null); });

test("only Android builds with the registered playback service use native playback", () => {
  expect(hasNativeRemoteVoice()).toBe(true);
  Capacitor.isPluginAvailable.mockReturnValueOnce(false);
  expect(hasNativeRemoteVoice()).toBe(false);
  Capacitor.getPlatform.mockReturnValueOnce("web");
  expect(hasNativeRemoteVoice()).toBe(false);
});

test("passes authentication in memory, awaits real completion and removes the listener", async () => {
  const onitemstart = jest.fn();
  const onitemend = jest.fn();
  const result = playNativeRemoteVoice({ ...options, onitemstart, onitemend });
  await flush();
  const request = plugin.start.mock.calls[0][0];
  expect(request).toMatchObject({ ...options, accessToken: "test-only-access-token" });
  emit({ id: "stale-id", phase: "started", index: 0 });
  expect(onitemstart).not.toHaveBeenCalled();
  emit({ id: request.id, phase: "started", index: 0 });
  emit({ id: request.id, phase: "ended", index: 0 });
  emit({ id: request.id, phase: "finished" });
  await result;
  expect(onitemstart).toHaveBeenCalledWith(0);
  expect(onitemend).toHaveBeenCalledWith(0);
  expect(remove).toHaveBeenCalledTimes(1);
});

test("cancellation rejects immediately and stops only the owned native session", async () => {
  const onitemend = jest.fn();
  const result = playNativeRemoteVoice({ ...options, onitemend });
  const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
  await flush();
  const { id } = plugin.start.mock.calls[0][0];
  stopNativeRemoteVoice();
  emit({ id, phase: "ended", index: 0 });
  await rejected;
  expect(plugin.stop).toHaveBeenCalledWith({ id });
  expect(onitemend).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledTimes(1);
});

test("cancellation while registering cannot start playback later", async () => {
  let registered;
  plugin.addListener.mockImplementationOnce(() => new Promise(resolve => { registered = resolve; }));
  const result = playNativeRemoteVoice(options);
  const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
  await flush();
  stopNativeRemoteVoice();
  registered({ remove });
  await rejected;
  expect(plugin.start).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledTimes(1);
});

test("cancellation settles before a delayed listener registration and removes the late handle", async () => {
  let registered;
  plugin.addListener.mockImplementationOnce(() => new Promise(resolve => { registered = resolve; }));
  const result = playNativeRemoteVoice(options);
  const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
  let settled = false;
  result.catch(() => { settled = true; });
  await flush();
  stopNativeRemoteVoice();
  await flush();
  try {
    expect(settled).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  } finally {
    registered({ remove });
    await rejected;
    await flush();
  }
  expect(plugin.start).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledTimes(1);
});

test("cancellation settles and removes its listener before a delayed start response", async () => {
  let started;
  plugin.start.mockImplementationOnce(() => new Promise(resolve => { started = resolve; }));
  const result = playNativeRemoteVoice(options);
  const rejected = expect(result).rejects.toMatchObject({ code: "cancelled" });
  let settled = false;
  result.catch(() => { settled = true; });
  await flush();
  stopNativeRemoteVoice();
  await flush();
  try {
    expect(settled).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    started();
    await rejected;
  }
});

test("a late listener from a replaced session is removed without touching its replacement", async () => {
  let registered;
  plugin.addListener.mockImplementationOnce(() => new Promise(resolve => { registered = resolve; }));
  const first = playNativeRemoteVoice(options);
  const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
  await flush();
  const second = playNativeRemoteVoice(options);
  await rejected;
  await flush();
  const lateRemove = jest.fn().mockResolvedValue();
  registered({ remove: lateRemove });
  await flush();
  expect(lateRemove).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  expect(plugin.start).toHaveBeenCalledTimes(1);
  emit({ id: plugin.start.mock.calls[0][0].id, phase: "finished" });
  await second;
  expect(remove).toHaveBeenCalledTimes(1);
});

test("cancellation while waiting for an earlier stop settles without starting out of order", async () => {
  const first = playNativeRemoteVoice(options);
  const firstRejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
  await flush();
  let stopped;
  plugin.stop.mockImplementationOnce(() => new Promise(resolve => { stopped = resolve; }));
  const second = playNativeRemoteVoice(options);
  const secondRejected = expect(second).rejects.toMatchObject({ code: "cancelled" });
  let settled = false;
  second.catch(() => { settled = true; });
  await flush();
  stopNativeRemoteVoice();
  await flush();
  try {
    expect(settled).toBe(true);
    expect(plugin.start).toHaveBeenCalledTimes(1);
  } finally {
    stopped();
    await Promise.all([firstRejected, secondRejected]);
    await flush();
  }
});

test.each(["finished", "error"])("native %s settles even while the start acknowledgement is pending", async (phase) => {
  let startFailed;
  plugin.start.mockImplementationOnce(() => new Promise((_, reject) => { startFailed = reject; }));
  const result = playNativeRemoteVoice(options);
  let settled = false;
  result.then(() => { settled = true; }, () => { settled = true; });
  const checked = phase === "finished"
    ? expect(result).resolves.toBeUndefined()
    : expect(result).rejects.toMatchObject({ code: "remote-playback", index: 0 });
  await flush();
  emit({ id: plugin.start.mock.calls[0][0].id, phase, code: "remote-playback", index: 0 });
  await flush();
  try {
    expect(settled).toBe(true);
    expect(remove).toHaveBeenCalledTimes(1);
  } finally {
    startFailed(new Error("Late bridge rejection"));
    await checked;
    await flush();
  }
});

test("native errors reject with their item position without inventing a completion", async () => {
  const onitemend = jest.fn();
  const result = playNativeRemoteVoice({ ...options, onitemend });
  const rejected = expect(result).rejects.toMatchObject({ code: "remote-playback", index: 0 });
  await flush();
  emit({ id: plugin.start.mock.calls[0][0].id, phase: "error", code: "remote-playback", index: 0 });
  await rejected;
  expect(onitemend).not.toHaveBeenCalled();
});

test("replacement stops the previous session before starting a new one and ignores stale events", async () => {
  const onitemend = jest.fn();
  const first = playNativeRemoteVoice({ ...options, onitemend });
  const rejected = expect(first).rejects.toMatchObject({ code: "cancelled" });
  await flush();
  const oldEmit = emit;
  const oldId = plugin.start.mock.calls[0][0].id;
  let stopped;
  plugin.stop.mockImplementationOnce(() => new Promise(resolve => { stopped = resolve; }));
  const second = playNativeRemoteVoice(options);
  await flush();
  expect(plugin.start).toHaveBeenCalledTimes(1);
  oldEmit({ id: oldId, phase: "ended", index: 0 });
  expect(onitemend).not.toHaveBeenCalled();
  stopped();
  await rejected;
  await flush();
  expect(plugin.start).toHaveBeenCalledTimes(2);
  emit({ id: plugin.start.mock.calls[1][0].id, phase: "finished" });
  await second;
});

test("a service start rejection removes its listener and does not invent an ended event", async () => {
  plugin.start.mockRejectedValueOnce(Object.assign(new Error("App inactive"), { code: "BACKGROUND_START" }));
  const onitemend = jest.fn();
  await expect(playNativeRemoteVoice({ ...options, onitemend })).rejects.toMatchObject({ code: "BACKGROUND_START" });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(onitemend).not.toHaveBeenCalled();
});

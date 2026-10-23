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

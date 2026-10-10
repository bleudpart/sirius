import { createNativeRecognition } from "./nativeSpeechRecognition";

function provider() {
  let event;
  let resolve;
  let reject;
  const remove = jest.fn(async () => {});
  const plugin = {
    available: jest.fn(async () => ({ available: true })),
    addListener: jest.fn(async (_, callback) => { event = callback; return { remove }; }),
    start: jest.fn(() => new Promise((done, fail) => { resolve = done; reject = fail; })),
    cancel: jest.fn(async () => { reject?.(Object.assign(new Error("Cancelled"), { code: "CANCELLED" })); }),
    finish: jest.fn(async () => {}),
  };
  return { plugin, remove, event: (value) => event(value), resolve: (text, alternatives) => resolve({ text, alternatives }) };
}

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("native results and partial events belong only to their capture", async () => {
  const fake = provider();
  const native = createNativeRecognition(fake.plugin);
  const onEvent = jest.fn();
  const result = native.listen({ signal: new AbortController().signal, onEvent });
  await tick();
  const id = fake.plugin.start.mock.calls[0][0].id;
  fake.event({ id: "stale", text: "Ancien texte" });
  fake.event({ id, phase: "partial", text: "Ouvre le journal" });
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(native.active).toBe(true);
  fake.resolve("Ouvre le journal");
  expect(await result).toBe("Ouvre le journal");
  expect(native.active).toBe(false);
  expect(fake.remove).toHaveBeenCalledTimes(1);
});

test("aborting a capture cancels the plugin and removes its listener", async () => {
  const fake = provider();
  const native = createNativeRecognition(fake.plugin);
  const controller = new AbortController();
  const result = native.listen({ signal: controller.signal, onEvent: jest.fn() });
  const rejected = expect(result).rejects.toMatchObject({ code: "CANCELLED" });
  await tick();
  controller.abort();
  await rejected;
  expect(fake.plugin.cancel).toHaveBeenCalledTimes(1);
  expect(fake.remove).toHaveBeenCalledTimes(1);
  expect(native.active).toBe(false);
});

test("uses the actual Android alternative containing Zirius rather than discarding all but its first guess", async () => {
  const fake = provider();
  const native = createNativeRecognition(fake.plugin);
  const result = native.listen({ signal: new AbortController().signal, onEvent: jest.fn() });
  await tick();
  fake.resolve("bonjour jus", [
    { text: "bonjour jus", confidence: 0.71 },
    { text: "bonjour Zirius", confidence: 0.68 },
  ]);
  expect(await result).toBe("bonjour SIRIUS");
});

test("never invents Zirius when Android offers no matching alternative", async () => {
  const fake = provider();
  const native = createNativeRecognition(fake.plugin);
  const result = native.listen({ signal: new AbortController().signal, onEvent: jest.fn() });
  await tick();
  fake.resolve("bonjour jus", [{ text: "bonjour jus", confidence: 0.71 }]);
  expect(await result).toBe("bonjour jus");
});

test("unsupported on-device recognition fails explicitly without starting network recognition", async () => {
  const fake = provider();
  fake.plugin.available.mockResolvedValue({ available: false });
  const native = createNativeRecognition(fake.plugin);
  await expect(native.listen({ signal: new AbortController().signal, onEvent: jest.fn() }))
    .rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect(fake.plugin.start).not.toHaveBeenCalled();
});

test("cancellation while installing a listener cannot start the native microphone late", async () => {
  const fake = provider();
  let install;
  fake.plugin.addListener.mockImplementation(() => new Promise((resolve) => { install = resolve; }));
  const native = createNativeRecognition(fake.plugin);
  const result = native.listen({ signal: new AbortController().signal, onEvent: jest.fn() });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await tick();
  await native.cancel();
  install({ remove: fake.remove });
  await rejected;
  expect(fake.plugin.start).not.toHaveBeenCalled();
  expect(fake.remove).toHaveBeenCalled();
});

test("cancellation while checking device support cannot open a microphone during playback", async () => {
  const fake = provider();
  let available;
  fake.plugin.available.mockImplementation(() => new Promise((resolve) => { available = resolve; }));
  const native = createNativeRecognition(fake.plugin);
  const result = native.listen({ signal: new AbortController().signal, onEvent: jest.fn() });
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await tick();
  await native.cancel();
  available({ available: true });
  await rejected;
  expect(fake.plugin.start).not.toHaveBeenCalled();
  expect(fake.plugin.addListener).not.toHaveBeenCalled();
  expect(native.active).toBe(false);
});

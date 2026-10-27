import { haccpFetch } from "./haccpRequest";

let oldFetch;
beforeEach(() => { oldFetch = global.fetch; jest.useFakeTimers(); });
afterEach(() => { global.fetch = oldFetch; jest.useRealTimers(); });

test("timeouts fail explicitly rather than leaving the kitchen waiting indefinitely", async () => {
  global.fetch = jest.fn((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  const promise = haccpFetch("/test");
  const assertion = expect(promise).rejects.toThrow("Délai dépassé");
  jest.advanceTimersByTime(45000);
  await assertion;
});

test("external cancellation is preserved and successful requests clear timers", async () => {
  global.fetch = jest.fn(async () => ({ ok: true }));
  await haccpFetch("/test");
  expect(jest.getTimerCount()).toBe(0);
  expect(global.fetch.mock.calls[0][1].credentials).toBe("include");
});

test("timeout also covers a stalled response body after headers arrive", async () => {
  let signal;
  global.fetch = jest.fn(async (url, options) => {
    signal = options.signal;
    return {
      json: () => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    };
  });
  const promise = haccpFetch("/test", {}, (response) => response.json());
  const assertion = expect(promise).rejects.toThrow("Délai dépassé");
  await Promise.resolve();
  jest.advanceTimersByTime(45000);
  await assertion;
  expect(signal.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
});

test("external cancellation during body download remains an AbortError", async () => {
  const controller = new AbortController();
  global.fetch = jest.fn(async (url, options) => ({
    blob: () => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }),
  }));
  const promise = haccpFetch("/photo", { signal: controller.signal }, (response) => response.blob());
  const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
  await Promise.resolve();
  controller.abort();
  await assertion;
  expect(jest.getTimerCount()).toBe(0);
});

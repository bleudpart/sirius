import { readAccountSetup, validatePersonalService } from "./accountSetup";

test("status preserves a cloud-session failure instead of displaying the local admin view", async () => {
  const fetchImpl = jest.fn().mockResolvedValue({
    ok: false, status: 503, json: async () => ({ detail: "Session Cloud expirée : reconnectez votre compte." }),
  });
  await expect(readAccountSetup(fetchImpl)).rejects.toThrow("Session Cloud expirée");
});

test("a stuck service status check times out explicitly", async () => {
  jest.useFakeTimers();
  try {
    const fetchImpl = jest.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const result = expect(readAccountSetup(fetchImpl)).rejects.toThrow("dépassé le délai");
    jest.advanceTimersByTime(20000);
    await result;
  } finally {
    jest.useRealTimers();
  }
});

test("unverifiable validation remains distinct from a successful provider check", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true, json: async () => ({ ok: false, status: "unverifiable", message: "Clé non vérifiable." }),
  });
  try {
    expect(await validatePersonalService("fal", "personal-fal-test")).toMatchObject({
      ok: false, status: "unverifiable",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

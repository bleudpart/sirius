import { collectVoiceDiagnostic } from "./voiceDiagnostic";
import { API_BASE_URL } from "./lib/api";

const browser = () => ({
  onLine: true, mediaDevices: { getUserMedia: jest.fn() },
  permissions: { query: jest.fn(async () => ({ state: "granted" })) },
});
const dependencies = () => ({
  services: jest.fn(async () => ({ services: [{ id: "chat", state: "configured" }] })),
  identity: jest.fn(async () => ({ ready: true, enrolled: true })),
  browser: browser(), recorderAvailable: true,
});

test("passive checks never open or record the microphone and do not claim the hardware/voice works", async () => {
  const deps = dependencies();
  const report = await collectVoiceDiagnostic(deps);
  expect(deps.browser.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  expect(deps.browser.permissions.query).toHaveBeenCalledWith({ name: "microphone" });
  expect(report.checks.find((check) => check.id === "server").state).toBe("ok");
  expect(report.checks.find((check) => check.id === "identity").state).toBe("ok");
  for (const id of ["capture", "permission", "network", "voice"]) {
    expect(report.checks.find((check) => check.id === id).state).toBe("unknown");
  }
});

test("one unavailable service does not hide other results and never blames Wi-Fi", async () => {
  const deps = dependencies();
  deps.services.mockRejectedValue(new DOMException("Timeout", "AbortError"));
  deps.identity.mockResolvedValue({ ready: true, enrolled: false });
  deps.browser.permissions.query.mockResolvedValue({ state: "denied" });
  const report = await collectVoiceDiagnostic(deps);
  expect(report.checks.find((check) => check.id === "server")).toMatchObject({ state: "error", detail: expect.stringContaining("ne prouve pas") });
  expect(report.checks.find((check) => check.id === "identity").detail).toContain("Enregistrez votre voix");
  expect(report.checks.find((check) => check.id === "permission").detail).toContain("Microphone refusé");
});

test("offline, missing capture and unreadable permissions are reported distinctly", async () => {
  const deps = dependencies();
  deps.browser = { onLine: false };
  deps.recorderAvailable = false;
  const report = await collectVoiceDiagnostic(deps);
  expect(report.checks.find((check) => check.id === "network").state).toBe("error");
  expect(report.checks.find((check) => check.id === "capture").state).toBe("error");
  expect(report.checks.find((check) => check.id === "permission")).toMatchObject({ state: "unknown", detail: expect.stringContaining("non lisible") });
});

test("closing cancels a pending diagnostic and ignores late server success", async () => {
  const deps = dependencies();
  const controller = new AbortController();
  let finish;
  deps.identity.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const pending = collectVoiceDiagnostic({ ...deps, signal: controller.signal });
  controller.abort();
  finish({ ready: true, enrolled: true });
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
});

test("default requests are authenticated GETs only, no chat or audio upload", async () => {
  const previous = global.fetch;
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    json: async () => url.endsWith("/setup/status")
      ? { services: [] } : { ready: false, enrolled: false },
  }));
  try {
    await collectVoiceDiagnostic({ browser: browser(), recorderAvailable: true });
    expect(global.fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      `${API_BASE_URL}/setup/status`, `${API_BASE_URL}/voice-identity/status`,
    ]);
    for (const [, options] of global.fetch.mock.calls) {
      expect(options).toMatchObject({ method: "GET", credentials: "include", signal: expect.any(AbortSignal) });
      expect(options.body).toBeUndefined();
    }
  } finally { global.fetch = previous; }
});

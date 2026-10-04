import { clearMailCache, enableMailCache, mailCacheAccount, readMailCache, syncMailCache } from "./mailCache";

const originalFetch = global.fetch;
const message = { id: "mail-1", de: "Client fictif", de_email: "client@example.com", sujet: "Document", recu: "2026-10-04T10:00:00Z", lu: false, apercu: "Un aperçu", body: "NE PAS CONSERVER", attachments: ["secret.pdf"], access_token: "NE PAS CONSERVER" };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn().mockImplementation(async (url) => response(
    /status$/.test(url) ? { connected: true, email: "owner@example.com" } : { mails: [message] }
  ));
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); localStorage.clear(); });

test("never caches without explicit consent and never creates an anonymous scope", async () => {
  expect(mailCacheAccount(null)).toBe("");
  expect(() => readMailCache("", "google")).toThrow("invalide");
  expect(readMailCache("a", "google").enabled).toBe(false);
  await expect(syncMailCache("a", "google")).rejects.toThrow("pas activé");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("uses authenticated backend, bounds previews and strips body, attachments and tokens", async () => {
  await enableMailCache("a", "google");
  global.fetch.mockImplementation(async (url) => response(/status$/.test(url)
    ? { connected: true, email: "owner@example.com" }
    : { mails: Array.from({ length: 80 }, (_, i) => ({ ...message, id: `mail-${i}`, apercu: "a".repeat(500) })) }));
  const cache = await syncMailCache("a", "google");
  expect(cache.mails).toHaveLength(25);
  expect(cache.mails[0].apercu).toHaveLength(140);
  expect(JSON.stringify(cache)).not.toContain("NE PAS CONSERVER");
  expect(cache.syncedAt).toMatch(/^\d{4}-/);
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/gmail/messages?top=25"), expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
  expect(readMailCache("b", "google").mails).toEqual([]);
  expect(readMailCache("a", "microsoft").mails).toEqual([]);
  await enableMailCache("a", "microsoft");
  expect((await syncMailCache("a", "microsoft")).mails).toHaveLength(50);
});

test("network failure preserves last snapshot and rejects instead of claiming a fresh sync", async () => {
  await enableMailCache("a", "google");
  const previous = await syncMailCache("a", "google");
  global.fetch.mockRejectedValue(new TypeError("offline"));
  await expect(syncMailCache("a", "google")).rejects.toThrow("offline");
  expect(readMailCache("a", "google")).toEqual(previous);
});

test("provider identity change or revoked authorization clears consent and old messages", async () => {
  await enableMailCache("a", "google");
  await syncMailCache("a", "google");
  global.fetch.mockResolvedValue(response({ connected: true, email: "different@example.com" }));
  await expect(syncMailCache("a", "google")).rejects.toThrow("compte mail connecté a changé");
  expect(readMailCache("a", "google").enabled).toBe(false);
  expect(readMailCache("a", "google").mails).toEqual([]);
  global.fetch.mockResolvedValue(response({ connected: true, email: "owner@example.com" }));
  await enableMailCache("a", "google");
  global.fetch.mockResolvedValue(response({}, 401));
  await expect(syncMailCache("a", "google")).rejects.toThrow("401");
  expect(readMailCache("a", "google").enabled).toBe(false);
});

test("erasure prevents an in-flight response from restoring messages", async () => {
  await enableMailCache("a", "google");
  let finish;
  global.fetch.mockImplementation(async (url) => /status$/.test(url)
    ? response({ connected: true, email: "owner@example.com" })
    : { ok: true, json: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = syncMailCache("a", "google");
  while (!finish) await Promise.resolve();
  clearMailCache("a", "google");
  finish({ mails: [message] });
  await expect(pending).rejects.toThrow("effacé ou modifié");
  expect(readMailCache("a", "google").mails).toEqual([]);
});

test("empty successful snapshot replaces old mail and bad payload does not overwrite it", async () => {
  await enableMailCache("a", "google");
  await syncMailCache("a", "google");
  global.fetch.mockImplementation(async (url) => response(/status$/.test(url)
    ? { connected: true, email: "owner@example.com" } : {}));
  await expect(syncMailCache("a", "google")).rejects.toThrow("messages absents");
  expect(readMailCache("a", "google").mails).toHaveLength(1);
  global.fetch.mockImplementation(async (url) => response(/status$/.test(url)
    ? { connected: true, email: "owner@example.com" } : { mails: [] }));
  expect((await syncMailCache("a", "google")).mails).toEqual([]);
});

test("quota and corrupt storage errors propagate, erasure can repair corruption", async () => {
  const key = "sirius_mail_cache_v1:a:google";
  localStorage.setItem(key, "{broken");
  expect(() => readMailCache("a", "google")).toThrow();
  clearMailCache("a", "google");
  expect(readMailCache("a", "google").enabled).toBe(false);
  const before = localStorage.getItem(key);
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  await expect(enableMailCache("a", "google")).rejects.toThrow("quota");
  expect(localStorage.getItem(key)).toBe(before);
});

test("abort during body consumption cannot persist a late response", async () => {
  await enableMailCache("a", "google");
  const controller = new AbortController();
  let finish;
  global.fetch.mockImplementation(async (url) => /status$/.test(url)
    ? response({ connected: true, email: "owner@example.com" })
    : { ok: true, json: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = syncMailCache("a", "google", controller.signal);
  while (!finish) await Promise.resolve();
  controller.abort();
  finish({ mails: [message] });
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  expect(readMailCache("a", "google").mails).toEqual([]);
});

test("old unauthorized response cannot wipe a newly reactivated cache", async () => {
  await enableMailCache("a", "google");
  let finish;
  global.fetch.mockImplementation(async (url) => /status$/.test(url)
    ? response({ connected: true, email: "owner@example.com" })
    : new Promise((resolve) => { finish = resolve; }));
  const pending = syncMailCache("a", "google");
  while (!finish) await Promise.resolve();
  clearMailCache("a", "google");
  await enableMailCache("a", "google");
  const reactivated = readMailCache("a", "google");
  finish(response({}, 401));
  await expect(pending).rejects.toThrow("401");
  expect(readMailCache("a", "google")).toEqual(reactivated);
});

test("exact 20-second deadline also covers JSON consumption", async () => {
  await enableMailCache("a", "google");
  jest.useFakeTimers();
  let finish;
  let signal;
  try {
    global.fetch.mockImplementation(async (url, options) => /status$/.test(url)
      ? response({ connected: true, email: "owner@example.com" })
      : { ok: true, json: () => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); } });
    const pending = syncMailCache("a", "google");
    while (!finish) await Promise.resolve();
    jest.advanceTimersByTime(19999);
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    finish({ mails: [message] });
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(readMailCache("a", "google").mails).toEqual([]);
  } finally { jest.useRealTimers(); }
});

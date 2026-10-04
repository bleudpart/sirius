import { act } from "react";
import { createRoot } from "react-dom/client";
import useMailCache from "./useMailCache";
import { enableMailCache, readMailCache } from "../services/mailCache";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let api;
function Harness({ user }) { api = useMailCache(user); return null; }
let host;
let root;
const originalFetch = global.fetch;
beforeEach(() => {
  localStorage.clear();
  jest.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  global.fetch = jest.fn().mockImplementation(async (url) => ({ ok: true, json: async () => /status$/.test(url)
    ? { connected: true, email: "owner@example.com" }
    : { mails: [{ id: "1", sujet: "Copie fictive", de: "Camille", apercu: "Bonjour" }] } }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
  localStorage.clear();
});

test("disabled cache makes no requests; activated cache syncs periodically only while visible", async () => {
  await act(async () => root.render(<Harness user={{ id: "a" }} />));
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => api.run("google", true));
  expect(api.providers.google.mails).toHaveLength(1);
  global.fetch.mockClear();
  await act(async () => jest.advanceTimersByTime(5 * 60 * 1000));
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/gmail/messages"), expect.anything());
  global.fetch.mockClear();
  jest.spyOn(document, "hidden", "get").mockReturnValue(true);
  await act(async () => jest.advanceTimersByTime(5 * 60 * 1000));
  expect(global.fetch).not.toHaveBeenCalled();
});

test("account switch aborts sync and cannot expose or persist the old account's late result", async () => {
  await enableMailCache("a", "google");
  let finish;
  let signal;
  global.fetch.mockImplementation(async (url, options) => /status$/.test(url)
    ? { ok: true, json: async () => ({ connected: true, email: "owner@example.com" }) }
    : { ok: true, json: () => { signal = options.signal; return new Promise((resolve) => { finish = resolve; }); } });
  await act(async () => root.render(<Harness user={{ id: "a" }} />));
  expect(finish).toBeDefined();
  await act(async () => root.render(<Harness user={{ id: "b" }} />));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ mails: [{ id: "1", sujet: "Secret ancien compte" }] }));
  expect(api.account).toBe("b");
  expect(api.providers.google.mails).toEqual([]);
  expect(readMailCache("a", "google").mails).toEqual([]);
});

test("clearing and reactivating keeps the new job busy when an old job finally completes", async () => {
  await act(async () => root.render(<Harness user={{ id: "a" }} />));
  await act(async () => api.run("google", true));
  const finish = [];
  global.fetch.mockImplementation(async (url) => /status$/.test(url)
    ? { ok: true, json: async () => ({ connected: true, email: "owner@example.com" }) }
    : { ok: true, json: () => new Promise((resolve) => finish.push(resolve)) });
  let oldJob;
  await act(async () => { oldJob = api.run("google"); });
  await act(async () => { api.clear("google"); });
  let newJob;
  await act(async () => { newJob = api.run("google", true); });
  expect(finish).toHaveLength(2);
  await act(async () => { finish[0]({ mails: [] }); await oldJob; });
  expect(api.busy.google).toBe(true);
  await act(async () => { finish[1]({ mails: [] }); await newJob; });
  expect(api.busy.google).toBe(false);
  expect(api.providers.google.enabled).toBe(true);
});

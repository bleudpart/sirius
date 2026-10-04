import { act } from "react";
import { createRoot } from "react-dom/client";
import ConnectionsPanel from "./ConnectionsPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let root;
let host;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ connected: true, email: "owner@example.com" }) });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); global.fetch = originalFetch; });

const button = (label) => Array.from(host.querySelectorAll("button")).find((entry) => entry.textContent.includes(label));
const response = (data) => ({ ok: true, json: async () => data });

test("authorization waiting can be stopped and restarted without disconnecting", async () => {
  const open = jest.spyOn(window, "open").mockImplementation(() => null);
  global.fetch.mockImplementation(async (url) => response(url.includes("external=true")
    ? { authorization_url: "https://accounts.google.com/authorize" } : { connected: false }));
  try {
    await act(async () => root.render(<ConnectionsPanel onClose={() => {}} />));
    await act(async () => button("Connecter Google").click());
    expect(host.textContent).toContain("Autorisation en cours");
    await act(async () => button("Arrêter l’attente").click());
    expect(button("Connecter Google").disabled).toBe(false);
    expect(global.fetch.mock.calls.some(([url]) => url.includes("disconnect"))).toBe(false);
    await act(async () => button("Connecter Google").click());
    expect(open).toHaveBeenCalledTimes(2);
  } finally { open.mockRestore(); }
});

test("stopping a pending authorization aborts it and ignores its late response", async () => {
  const open = jest.spyOn(window, "open").mockImplementation(() => null);
  let resolveAuthorization;
  let signal;
  global.fetch.mockImplementation((url, options) => {
    if (url.includes("external=true")) {
      signal = options.signal;
      return new Promise((resolve) => { resolveAuthorization = resolve; });
    }
    return Promise.resolve(response({ connected: false }));
  });
  try {
    await act(async () => root.render(<ConnectionsPanel onClose={() => {}} />));
    await act(async () => button("Connecter Google").click());
    await act(async () => button("Arrêter l’attente").click());
    expect(signal.aborted).toBe(true);
    await act(async () => resolveAuthorization(response({ authorization_url: "https://accounts.google.com/authorize" })));
    expect(open).not.toHaveBeenCalled();
    expect(button("Connecter Google").disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally { open.mockRestore(); }
});

test("manual status verification completes the waiting state", async () => {
  const open = jest.spyOn(window, "open").mockImplementation(() => null);
  let connected = false;
  global.fetch.mockImplementation(async (url) => response(url.includes("external=true")
    ? { authorization_url: "https://accounts.google.com/authorize" } : { connected }));
  try {
    await act(async () => root.render(<ConnectionsPanel onClose={() => {}} />));
    await act(async () => button("Connecter Google").click());
    connected = true;
    await act(async () => button("Vérifier l’état").click());
    expect(host.textContent).not.toContain("Autorisation en cours");
    expect(button("Arrêter l’attente")).toBeUndefined();
    expect(button("Déconnecter")).toBeDefined();
  } finally { open.mockRestore(); }
});

test("authorization errors are visible before the mail cache", async () => {
  const cache = { account: "a", providers: {}, errors: {}, busy: {}, clear: () => true, run: jest.fn() };
  global.fetch.mockImplementation(async (url) => url.includes("external=true")
    ? { ok: false, json: async () => ({ detail: "Google non configuré." }) }
    : response({ connected: false }));
  await act(async () => root.render(<ConnectionsPanel onClose={() => {}} mailCache={cache} />));
  await act(async () => button("Connecter Google").click());
  const alert = host.querySelector('[role="alert"]');
  expect(alert.textContent).toBe("Google non configuré.");
  expect(alert.compareDocumentPosition(host.querySelector(".mail-cache")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button("Connecter Google").disabled).toBe(false);
});

test("stopping waiting prevents further status polling", async () => {
  jest.useFakeTimers();
  const open = jest.spyOn(window, "open").mockImplementation(() => null);
  global.fetch.mockImplementation(async (url) => response(url.includes("external=true")
    ? { authorization_url: "https://accounts.google.com/authorize" } : { connected: false }));
  try {
    await act(async () => root.render(<ConnectionsPanel onClose={() => {}} />));
    await act(async () => button("Connecter Google").click());
    global.fetch.mockClear();
    await act(async () => jest.advanceTimersByTime(2000));
    expect(global.fetch).toHaveBeenCalledTimes(2);
    await act(async () => button("Arrêter l’attente").click());
    global.fetch.mockClear();
    await act(async () => jest.advanceTimersByTime(6000));
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.render(null));
    open.mockRestore();
    jest.useRealTimers();
  }
});

test("authorization timeout releases the button and reports the failure", async () => {
  jest.useFakeTimers();
  global.fetch.mockImplementation((url, options) => {
    if (!url.includes("external=true")) return Promise.resolve(response({ connected: false }));
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  });
  try {
    await act(async () => root.render(<ConnectionsPanel onClose={() => {}} />));
    await act(async () => button("Connecter Google").click());
    await act(async () => jest.advanceTimersByTime(20000));
    expect(button("Connecter Google").disabled).toBe(false);
    expect(host.querySelector('[role="alert"]').textContent).toContain("délai prévu");
  } finally {
    await act(async () => root.render(null));
    jest.useRealTimers();
  }
});

test("connected provider disconnection clears local consent before the server request", async () => {
  const order = [];
  const clear = jest.fn(() => { order.push("clear"); return true; });
  const cache = { account: "a", providers: {}, errors: {}, busy: {}, clear, run: jest.fn() };
  await act(async () => root.render(<ConnectionsPanel onClose={() => {}} mailCache={cache} />));
  expect(host.textContent).toContain("Aperçus mail sur cet appareil");
  global.fetch.mockImplementation(async () => { order.push("fetch"); return { ok: true, json: async () => ({ connected: false }) }; });
  await act(async () => host.querySelector(".connection-item .secondary").click());
  expect(clear).toHaveBeenCalledWith("google");
  expect(order[0]).toBe("clear");
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/calendar/disconnect"), expect.objectContaining({ method: "POST", credentials: "include" }));
});

test("failed erasure prevents provider changes and surfaces the error", async () => {
  const cache = { account: "a", providers: {}, errors: {}, busy: {}, clear: () => false, run: jest.fn() };
  await act(async () => root.render(<ConnectionsPanel onClose={() => {}} mailCache={cache} />));
  global.fetch.mockClear();
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => host.querySelector(".connection-item .secondary").click());
    expect(global.fetch).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]').textContent).toContain("Effacement du cache impossible");
  } finally { log.mockRestore(); }
});

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

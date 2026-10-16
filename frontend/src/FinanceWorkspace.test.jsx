import React, { act } from "react";
import { createRoot } from "react-dom/client";
import FinanceWorkspace from "./FinanceWorkspace";
import { localDateTime } from "./chronos";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const id = "a".repeat(32);
const emptyOverview = { alerts: { items: [], truncated: false }, routines: { items: [], truncated: false },
  notifications: [], events: [] };
const portfolio = { state: "COMPLETE", positions: [{ symbol: "AAPL", quantity: 2, value: 228, unrealized_pnl: 28,
  weight_pct: 100, source: { source: "Source test", source_url: "https://finance.yahoo.com/", as_of: "2026-10-16", age_calendar_days: 1 } }],
  total_value: 228, unrealized_pnl: 28, volatility_pct: 20, max_drawdown_pct: -5, series: [{ value: 200 }, { value: 228 }],
  limitations: ["Historique théorique, pas votre performance réelle."] };
const preview = { id, state: "WAITING_CONFIRMATION", summary: "Remplacer les positions déclarées",
  action: { kind: "portfolio", positions: [{ symbol: "AAPL", quantity: 1, average_cost: 0, currency: "USD" }] },
  expires_at: "2026-10-17T02:00:00Z" };
let host, root, originalFetch, originalCrypto;
beforeEach(() => {
  originalFetch = global.fetch; originalCrypto = global.crypto;
  global.crypto = { getRandomValues: (bytes) => require("crypto").randomFillSync(bytes) };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  global.fetch = jest.fn(async (url, options) => ({ ok: true, json: async () =>
    options.method === "POST" ? String(url).endsWith("/confirm") ? { state: "COMPLETED", result: { id } } : preview
      : String(url).endsWith("/portfolio") ? portfolio : String(url).includes("/actions/") ? preview : emptyOverview }));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); global.fetch = originalFetch; global.crypto = originalCrypto;
});
const mount = (props = {}) => act(async () => root.render(<FinanceWorkspace {...props} />));
const click = (text) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text).click());
const posts = () => global.fetch.mock.calls.filter(([, options]) => options.method === "POST");
const change = (element, value) => act(async () => {
  Object.getOwnPropertyDescriptor(element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set.call(element, value);
  element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
});

test("positions and risks use server values, chart and source; preview never confirms implicitly", async () => {
  await mount();
  expect(host.textContent).toContain("concentration > 35 %");
  expect(host.textContent).toContain("Source test");
  expect(host.querySelector('[aria-label="Historique théorique du portefeuille à quantités constantes"]')).not.toBeNull();
  await click("Prévisualiser le remplacement");
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0]).toContain("/actions/preview");
  expect(host.textContent).toContain("WAITING_CONFIRMATION");
  expect(host.querySelector("fieldset").disabled).toBe(true);
  await click("Fermer sans confirmer");
  expect(posts()).toHaveLength(1);
  expect(host.querySelector("fieldset").disabled).toBe(false);
});

test("confirmation uses exact persisted reference and does not create a new request", async () => {
  await mount(); await click("Prévisualiser le remplacement"); await click("Confirmer cet aperçu financier");
  expect(posts()).toHaveLength(2);
  expect(posts()[1][0]).toContain(`/actions/${id}/confirm`);
  expect(host.textContent).toContain("Modification confirmée et enregistrée");
  expect(host.textContent).not.toContain("WAITING_CONFIRMATION");
});

test("a lost preview response retries the identical CSV and request key", async () => {
  const original = global.fetch.getMockImplementation();
  let count = 0;
  global.fetch.mockImplementation(async (url, options) => {
    if (options.method === "POST" && ++count === 1) throw new Error("Réponse perdue");
    return original(url, options);
  });
  await mount(); await click("Prévisualiser le CSV");
  expect(host.textContent).toContain("Réponse perdue");
  expect(host.querySelector("fieldset").disabled).toBe(true);
  expect(host.querySelector("fieldset").contains(host.querySelector("textarea"))).toBe(true);
  await click("Réessayer le même aperçu");
  expect(posts()[0][1].body).toBe(posts()[1][1].body);
  const body = JSON.parse(posts()[0][1].body);
  expect(body.text).toContain("symbol,quantity,average_cost,currency");
  expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("NEMESIS and CHRONOS show the same persisted rules without allowing audit mutations", async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({
    ...emptyOverview, routines: { items: [{ id, symbols: ["AAPL"], recurrence: "daily", start_at: "2026-10-17T07:00:00Z", disabled: false }] },
    notifications: [{ id, created_at: "2026-10-17", text: "Bilan prêt", evidence: { run_id: "b".repeat(32) } }],
    events: [{ id, at: "2026-10-17", outcome: "CONFIRMED", summary: "Routine approuvée" }],
  }) });
  await mount({ auditOnly: true });
  expect(host.textContent).toContain("Routine approuvée");
  expect(host.textContent).toContain("Bilan prêt");
  expect(host.querySelector("fieldset")).toBeNull();
  expect(host.textContent).not.toContain("Préparer la suspension");
  expect(global.fetch.mock.calls.every(([url]) => !String(url).endsWith("/portfolio"))).toBe(true);
});

test("a blocked confirmation remains retryable with the same reference", async () => {
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => String(url).endsWith("/confirm")
    ? { ok: false, json: async () => ({ detail: "Stockage indisponible" }) } : original(url, options));
  await mount(); await click("Prévisualiser le remplacement"); await click("Confirmer cet aperçu financier");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Stockage indisponible");
  expect(host.textContent).toContain("WAITING_CONFIRMATION");
  expect(host.textContent).not.toContain("Modification confirmée et enregistrée");
});

test("unmounted account cannot receive the prior account result", async () => {
  let finish;
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => options.method === "POST"
    ? new Promise((resolve) => { finish = resolve; }) : original(url, options));
  await act(async () => root.render(<FinanceWorkspace key="one" />));
  await click("Prévisualiser le remplacement");
  await act(async () => root.render(<FinanceWorkspace key="two" />));
  await act(async () => finish({ ok: true, json: async () => preview }));
  expect(host.textContent).not.toContain("WAITING_CONFIRMATION");
});

test("no silent empty success after an invalid financial response", async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Réponse financière incomplète");
});

test("CHRONOS stages a UTC routine for explicitly selected symbols, never a calendar event", async () => {
  await mount({ routinesOnly: true });
  const stamp = new Date(); stamp.setDate(stamp.getDate() + 2); stamp.setHours(12, 0, 0, 0);
  await change(host.querySelector('input[type="datetime-local"]'), localDateTime(stamp));
  await click("Préparer la routine CHRONOS");
  const action = JSON.parse(posts()[0][1].body).action;
  expect(action).toEqual({ kind: "routine", symbols: ["AAPL"], period: "1y",
    start_at: stamp.toISOString(), recurrence: "daily", volatility_threshold_pct: 30 });
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/chronos/events"))).toBe(false);
});

test("MM200 alert preview does not use an invented price threshold", async () => {
  await mount();
  const select = [...host.querySelectorAll("select")].find((item) => [...item.options].some((option) => option.value === "cross_above_mm200"));
  await change(select, "cross_above_mm200");
  await click("Préparer la surveillance");
  expect(JSON.parse(posts()[0][1].body).action).toEqual({
    kind: "alert", symbol: "AAPL", condition: "cross_above_mm200", threshold: null,
  });
  expect(posts()).toHaveLength(1);
});

test("oversized CSV file is rejected before reading and cannot trigger an import", async () => {
  await mount();
  const input = host.querySelector('input[type="file"]');
  const text = jest.fn();
  Object.defineProperty(input, "files", { configurable: true, value: [{ size: 100001, text }] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(text).not.toHaveBeenCalled();
  expect(posts()).toHaveLength(0);
  expect(host.querySelector('[role="alert"]').textContent).toContain("CSV limité à 100 ko");
});

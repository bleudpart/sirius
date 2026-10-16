import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ArianeMarketRuns from "./ArianeMarketRuns";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const result = {
  id: "a".repeat(32), state: "COMPLETED", created_at: "2026-10-17T00:00:00Z",
  expires_at: "2026-10-18T00:00:00Z", config: { symbols: ["AAPL", "MSFT"], period: "1y" },
  steps: [
    { id: "analysis:AAPL", state: "COMPLETED", snapshot_age_calendar_days: 1,
      output: { source: "Yahoo Finance chart", source_url: "https://finance.yahoo.com/", as_of: "2026-10-16",
        currency: "USD", fetched_at: "2026-10-16T22:00:00Z", data_version: "version-AAPL",
        calculation_version: "nummarius-daily-v1", calculation_parameters: { rsi_wilder: 14 },
        volatility_20d_annualized_pct: 35 } },
    { id: "rules", state: "COMPLETED", output: { findings: [{ symbol: "AAPL", observed: 35, threshold: 30,
      explanation: "Pas une prévision." }], missing: [], rule_parameters: { volatility_threshold_pct: 30 } } },
    { id: "summary", state: "COMPLETED", output: { text: "Analyse descriptive. Aucun ordre ni alerte créé." } },
  ], trace: [{ id: "event", step: "analysis:AAPL", outcome: "COMPLETED", at: "2026-10-17T00:00:01Z" }],
};
let root, host, original, originalCrypto;
beforeEach(() => {
  original = global.fetch;
  originalCrypto = global.crypto;
  global.crypto = { getRandomValues: (bytes) => require("crypto").randomFillSync(bytes) };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  global.fetch = jest.fn(async (_url, options) => ({
    ok: true, json: async () => options.method ? result : { items: [result] },
  }));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); global.fetch = original; global.crypto = originalCrypto;
});
const mount = (auditOnly = false) => act(async () => root.render(<ArianeMarketRuns auditOnly={auditOnly} />));
const click = (text) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text).click());

test("launches an explicit read-only run and exposes source, rules, trace and missing portfolio", async () => {
  await mount();
  await click("Lancer les lectures et calculs");
  const creation = global.fetch.mock.calls.find(([, options]) => options.method === "POST");
  const body = JSON.parse(creation[1].body);
  expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(body.symbols).toEqual(["AAPL", "MSFT"]);
  expect(body.volatility_threshold_pct).toBe(30);
  expect(host.textContent).toContain("Analyse descriptive");
  expect(host.textContent).toContain("version-AAPL");
  expect(host.textContent).toContain("nummarius-daily-v1");
  expect(host.textContent).toContain("Journal NÉMÉSIS");
  expect(host.textContent).toContain("pas d'un portefeuille");
  expect(host.textContent).toContain("séparément des listes manuelles");
  expect(global.fetch.mock.calls.every(([url]) => !String(url).includes("/alerts") && !String(url).includes("/send"))).toBe(true);
});

test("lost response retries exactly the same request and locks its parameters", async () => {
  let posts = 0;
  global.fetch.mockImplementation(async (_url, options) => {
    if (options.method === "POST" && ++posts === 1) throw new Error("Coupure réseau");
    return { ok: true, json: async () => options.method ? result : { items: [] } };
  });
  await mount(); await click("Lancer les lectures et calculs");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Coupure réseau");
  expect(host.querySelector("fieldset").disabled).toBe(true);
  await click("Réessayer la même demande");
  const calls = global.fetch.mock.calls.filter(([, options]) => options.method === "POST");
  expect(calls[0][1].body).toBe(calls[1][1].body);
  expect(host.querySelector("fieldset").disabled).toBe(false);
});

test("NEMESIS only consults prior runs and cannot launch or resume a financial action", async () => {
  global.fetch.mockImplementation(async (url) => ({ ok: true, json: async () =>
    String(url).endsWith(result.id) ? { ...result, state: "BLOCKED" } : { items: [result] } }));
  await mount(true);
  expect(host.textContent).not.toContain("Lancer les lectures et calculs");
  await click(`Suivi ${result.id}`);
  expect(host.textContent).toContain("Bloqué");
  expect(host.textContent).not.toContain("Reprendre les étapes manquantes");
  expect(global.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

test("a blocked run keeps partial steps visible and resumes the same reference", async () => {
  const partial = { ...result, state: "BLOCKED", steps: result.steps.slice(0, 1) };
  global.fetch.mockImplementation(async (url, options) => ({ ok: true, json: async () =>
    options.method ? result : String(url).endsWith(result.id) ? partial : { items: [result] } }));
  await mount(); await click(`Suivi ${result.id}`);
  expect(host.textContent).toContain("Analyse incomplète");
  await click("Reprendre les étapes manquantes");
  expect(global.fetch.mock.calls.some(([url, options]) => String(url).endsWith(`/${result.id}/resume`) && options.method === "POST")).toBe(true);
  expect(host.textContent).toContain("Analyse descriptive");
});

test("invalid list response is not a silently successful empty history", async () => {
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Suivi ARIANE reçu incomplet");
});

test("a response arriving after the account workspace unmount cannot appear in the new workspace", async () => {
  let finish;
  global.fetch.mockImplementation(async (_url, options) => options.method
    ? new Promise((resolve) => { finish = resolve; })
    : { ok: true, json: async () => ({ items: [] }) });
  await act(async () => root.render(<ArianeMarketRuns key="account-one" />));
  await click("Lancer les lectures et calculs");
  await act(async () => root.render(<ArianeMarketRuns key="account-two" />));
  await act(async () => finish({ ok: true, json: async () => result }));
  expect(host.textContent).not.toContain(result.id);
  expect(host.textContent).not.toContain("Analyse descriptive");
});

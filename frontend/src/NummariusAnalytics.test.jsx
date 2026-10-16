import React, { act } from "react";
import { createRoot } from "react-dom/client";
import NummariusAnalytics, { marketNumber } from "./NummariusAnalytics";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fixture = (symbol = "AAPL") => ({
  symbol, label: symbol, currency: "USD", exchange: "NMS", exchange_timezone: "America/New_York",
  source: "Yahoo Finance chart", source_url: `https://finance.yahoo.com/quote/${symbol}/history/`,
  fetched_at: "2026-10-16T21:00:00+00:00", as_of: "2026-10-16", history_start: "2021-10-16",
  available_sessions: 1260, visible_sessions: 1, rejected_bars: 0, incomplete_sessions_excluded: 0,
  age_calendar_days: 1, cached: false, trend: "above_mm200",
  latest: { close: 105, mm20: 103, mm50: 100, mm100: 95, mm200: 90, rsi14: 65,
    macd: 1.2, macd_signal: 1, macd_histogram: .2, bollinger_lower: 95, bollinger_upper: 110, atr14: 2 },
  performance_pct: { "1d": 1, "1m": 3, "1y": 10, "5y": null },
  volatility_20d_annualized_pct: 20, max_drawdown_pct: -25, range_high: 108, range_low: 80,
  support_20d: 95, resistance_20d: 108, volume_average_20d: 10000,
  limitations: ["Performance hors dividendes."], splits: [],
  series: [{ date: "2026-10-16", open: 100, high: 108, low: 99, close: 105, volume: 12000, mm20: 103, mm50: 100, mm200: 90 }],
});

let root, host, originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  global.fetch = jest.fn(async (url) => ({
    ok: true, json: async () => String(url).includes("/compare?")
      ? { items: [{ symbol: "AAPL", status: "available", analysis: fixture() },
        { symbol: "TSLA", status: "unavailable", reason: "Source temporairement indisponible" }] }
      : fixture(String(url).includes("/MSFT?") ? "MSFT" : "AAPL"),
  }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); global.fetch = originalFetch; });
const mount = () => act(async () => root.render(<NummariusAnalytics />));
const click = async (text) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text).click());

test("shows deterministic indicators, source, missing long history and partial comparison without invented values", async () => {
  await mount();
  expect(host.textContent).toContain("MM200");
  expect(host.textContent).toContain("Source temporairement indisponible");
  expect(host.textContent).toContain("Historique insuffisant");
  expect(host.textContent).toContain("Performance hors dividendes");
  expect(host.querySelector("a").href).toContain("finance.yahoo.com");
  expect(host.querySelectorAll("table")).toHaveLength(2);
  expect(host.textContent).toContain("aucun passage d'ordre");
  expect(marketNumber(null)).toBe("Indisponible");
  expect(marketNumber(NaN)).toBe("Indisponible");
});

test("period and asset selection reload authenticated analysis, candles expose real OHLC", async () => {
  await mount();
  await click("5 ans");
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("analysis/AAPL?period=5y"))).toBe(true);
  const select = host.querySelector("select");
  await act(async () => { select.value = "MSFT"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("analysis/MSFT?period=5y"))).toBe(true);
  await click("Chandeliers OHLC");
  expect(host.textContent).toContain("120 dernières séances");
  expect(host.querySelector('[aria-label="2026-10-16, clôture 105 USD"]')).not.toBeNull();
  expect(global.fetch.mock.calls.every(([, options]) => options.credentials === "include")).toBe(true);
});

test("selection aborts obsolete results and never displays the previous asset while the next one loads", async () => {
  await mount();
  let resolve;
  global.fetch.mockImplementation((url) => String(url).includes("/analysis/MSFT?")
    ? new Promise((done) => { resolve = done; })
    : Promise.resolve({ ok: true, json: async () => ({ items: [] }) }));
  const select = host.querySelector("select");
  await act(async () => { select.value = "MSFT"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(host.textContent).toContain("Lecture de l'historique");
  expect(host.textContent).not.toContain("AAPL :");
  const options = global.fetch.mock.calls.find(([url]) => String(url).includes("analysis/MSFT?"))[1];
  act(() => root.unmount());
  expect(options.signal.aborted).toBe(true);
  await act(async () => resolve({ ok: true, json: async () => fixture("MSFT") }));
  root = createRoot(host);
});

test("provider failure and malformed response explicitly replace indicators, not a successful empty table", async () => {
  global.fetch.mockImplementation(async () => ({ ok: false, json: async () => ({ detail: "Marché hors service" }) }));
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Marché hors service");
  expect(host.textContent).toContain("Aucun indicateur estimé");
  expect(host.querySelector("svg")).toBeNull();
  global.fetch.mockImplementation(async () => ({ ok: true, json: async () => ({}) }));
  await click("Relire les données");
  expect(host.textContent).toContain("Analyse reçue incomplète");
});

test("old data are clearly flagged and deselecting every comparator asset requests no invented default", async () => {
  global.fetch.mockImplementation(async (url) => ({
    ok: true, json: async () => String(url).includes("/compare?")
      ? { items: [] } : { ...fixture(), age_calendar_days: 30 },
  }));
  await mount();
  expect(host.textContent).toContain("Données anciennes");
  for (const checkbox of [...host.querySelectorAll('input[type="checkbox"]')]) {
    await act(async () => checkbox.click());
  }
  expect(host.textContent).toContain("Sélectionnez au moins une action");
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("symbols=&"))).toBe(false);
});

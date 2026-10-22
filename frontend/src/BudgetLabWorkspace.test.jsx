import React, { act } from "react";
import { createRoot } from "react-dom/client";
import BudgetLabWorkspace from "./BudgetLabWorkspace";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, request, saved, decisions, experiments;
const analysis = { id: "analysis", first_date: "2026-01-02", last_date: "2026-03-02", transaction_count: 3,
  months: [{ month: "2026-01", income_cents: 100001, expenses_cents: 999, net_cents: 99002 }],
  candidates: [{ id: "music", label: "Musique", occurrences: 3, monthly_cents: 999,
    first_date: "2026-01-02", last_date: "2026-03-02", evidence: "Trois débits mensuels." }],
  limitations: ["Aucun virement ni résiliation."] };
beforeEach(() => {
  saved = []; decisions = []; experiments = [];
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  request = jest.fn(async (path, options = {}) => {
    if (path === "/budget/history") return { analyses: saved, decisions, experiments };
    if (path === "/lab/policy") return { cerebras: { enabled: false, reason: "Quota gratuit non vérifié." } };
    if (path === "/budget/analyze") { saved = [analysis]; return analysis; }
    if (path.includes("/usage/")) {
      const used = JSON.parse(options.body).used;
      const result = { id: "decision", analysis_id: "analysis", candidate_id: "music", used,
        executed: false, recommendation: used ? "Conserver." : "Vérifier le contrat.", potential_annual_cents: used ? 0 : 11988 };
      decisions = [result]; return result;
    }
    if (path === "/lab/local") {
      const result = { id: "run", cost_eur: 0, external_calls: 0, created_at: "2026-03-01",
        results: [{ tool: "csv_strict", correct: 6, cases: 6, elapsed_ms: 1 }], scope: "Données fictives." };
      experiments = [result]; return result;
    }
    throw new Error("Unexpected path " + path);
  });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = (props = {}) => act(async () => root.render(<BudgetLabWorkspace request={request} {...props} />));
const click = (text) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text).click());

test("no automatic import, experiment or external call; local consent required", async () => {
  await mount();
  expect(request.mock.calls.map(([path]) => path)).toEqual(["/budget/history", "/lab/policy"]);
  expect(host.textContent).toContain("Quota gratuit non vérifié");
  const launch = [...host.querySelectorAll("button")].find((button) => button.textContent === "Lancer cet essai local");
  expect(launch.disabled).toBe(true);
  await act(async () => host.querySelector('input[type="checkbox"]').click());
  await click("Lancer cet essai local");
  expect(request.mock.calls.filter(([path]) => path === "/lab/local")).toHaveLength(1);
  expect(host.textContent).toContain("6/6 cas corrects");
  expect(launch.disabled).toBe(true);
  expect(request.mock.calls.some(([path]) => /cerebras|https:/.test(path))).toBe(false);
});

test("CSV import stores a separate analysis and requires explicit usage confirmation", async () => {
  await mount();
  await act(async () => {
    const input = host.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input,
      "date,label,amount,currency\n2026-01-01,Musique,-9.99,EUR");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Analyser et enregistrer ce relevé");
  const posted = request.mock.calls.find(([path]) => path === "/budget/analyze");
  expect(JSON.parse(posted[1].body).text).toContain("-9.99");
  expect(host.textContent).toContain("Musique");
  expect(request.mock.calls.some(([path]) => path.includes("/usage/"))).toBe(false);
  await click("Je confirme ne plus l'utiliser");
  expect(host.textContent).toContain("Usage déclaré : inutilisé");
  expect(host.textContent).toContain("119,88");
  expect(host.textContent).toContain("Rien exécuté");
  await click("Je confirme l'utiliser");
  expect(host.textContent).toContain("Usage déclaré : utilisé");
  expect(request.mock.calls.filter(([path]) => path.includes("/usage/")).map(([, options]) => JSON.parse(options.body).used))
    .toEqual([false, true]);
});

test("audit mode can read history without starting experiments or changing usage", async () => {
  saved = [analysis];
  await mount({ auditOnly: true });
  await click("Relevé du 2026-01-02 au 2026-03-02 · 3 opérations");
  expect(host.textContent).toContain("Musique");
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(host.textContent).not.toContain("Je confirme l'utiliser");
  expect(request.mock.calls.every(([, options]) => !options?.method)).toBe(true);
});

test("storage errors and malformed responses do not show success and remain retryable", async () => {
  await mount();
  request.mockRejectedValueOnce(new Error("Stockage indisponible"));
  await click("Analyser et enregistrer ce relevé");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Stockage indisponible");
  expect(host.querySelector('[role="status"]')).toBeNull();
  request.mockResolvedValueOnce({});
  await click("Analyser et enregistrer ce relevé");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Analyse incomplète");
  await click("Analyser et enregistrer ce relevé");
  expect(host.querySelector('[role="status"]').textContent).toContain("Analyse enregistrée");
});

test("unmount aborts outstanding requests and prevents later state updates", async () => {
  let resolve;
  request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  act(() => root.render(<BudgetLabWorkspace request={request} />));
  const signal = request.mock.calls[0][1].signal;
  act(() => root.unmount());
  root = createRoot(host);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ analyses: [], decisions: [], experiments: [] }));
});

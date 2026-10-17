import { act } from "react";
import { createRoot } from "react-dom/client";
import ThemisPanel from "./ThemisPanel";

jest.mock("./voice", () => ({ speakAsCharacter: jest.fn() }));
jest.mock("./apiKeyStorage", () => ({ loadApiKeys: () => ({}) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const doc = { id: "invoice-1", kind: "facture", number: "FAC-1", client_id: "client-1", client_name: "Atelier Test",
  total_ttc: 120, paid: 0, status: "envoyé", due_date: "2020-01-01", emails: [] };
const item = { id: "item-1", name: "Papier", ref: "PAP-1", stock: 2, alert: 5, price: 6 };
const originalFetch = global.fetch;
let host;
let root;
const testId = id => host.querySelector(`[data-testid="${id}"]`) || document.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  global.fetch = jest.fn(async (url) => {
    const endpoint = String(url).split("/").pop();
    const data = {
      characters: { characters: [] },
      stats: { encaisse: 0, a_encaisser: 120, devis_en_cours: 0, factures_impayees: 1, commandes_actives: 0,
        nb_clients: 1, monthly: [], stock_alerts: [item], derniers_docs: [doc] },
      bilan: { echeances: [] },
      docs: { docs: [doc] }, orders: { orders: [] },
      clients: { clients: [{ id: "client-1", name: "Atelier Test", email: "test@example.test" }] },
      items: { items: [item] }, payments: { payments: [] }, pieces: { pieces: [] }, templates: { templates: [] },
    }[endpoint] || {};
    return { ok: true, json: async () => data };
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
});

test("invoice table exposes meaningful columns and keeps the original email preparation", async () => {
  await act(async () => root.render(<ThemisPanel onClose={jest.fn()} />));
  await act(async () => testId("themis-tab-docs").click());
  const table = testId("themis-docs-table");
  expect([...table.querySelectorAll("th")].map(el => el.textContent)).toEqual(["Document", "Client", "Montant TTC", "Statut", "Actions"]);
  expect(testId("themis-doc-status-FAC-1").getAttribute("aria-label")).toBe("Statut de FAC-1");
  expect(testId("themis-tab-docs").getAttribute("aria-current")).toBe("page");
  await act(async () => testId("themis-email-FAC-1").click());
  expect(testId("themis-email-to").value).toBe("test@example.test");
  expect(testId("themis-email-message").value).toContain("120.00");
  expect(global.fetch.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});

test("stock controls retain their adjustment payloads and have explicit names", async () => {
  await act(async () => root.render(<ThemisPanel onClose={jest.fn()} />));
  await act(async () => testId("themis-tab-stock").click());
  expect(testId("themis-items-table").querySelectorAll("th")).toHaveLength(5);
  const plus = testId("themis-stock-plus-Papier");
  expect(plus.getAttribute("aria-label")).toBe("Ajouter une unité : Papier");
  await act(async () => plus.click());
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining("/items/item-1/stock"),
    expect.objectContaining({ method: "PUT", body: JSON.stringify({ delta: 1, reason: "ajustement manuel" }) })
  );
  expect(testId("themis-stock-minus-Papier").getAttribute("aria-label")).toBe("Retirer une unité : Papier");
});

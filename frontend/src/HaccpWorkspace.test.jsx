import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpWorkspace, { HACCP_CAPTURE_URL } from "./HaccpWorkspace";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input");
const reply = (value, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => value });
beforeEach(() => {
  oldFetch = global.fetch; global.fetch = jest.fn(async () => reply([]));
  URL.createObjectURL = jest.fn(() => "blob:proof"); URL.revokeObjectURL = jest.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; jest.restoreAllMocks();
});
async function click(text) { await act(async () => button(text).click()); }
async function change(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function renderRegistry() {
  await act(async () => root.render(<HaccpWorkspace standalone />));
  await click("Registre / Contrôle");
}
async function search() {
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

test("QR points to the authenticated standalone capture without embedded credentials", async () => {
  await act(async () => root.render(<HaccpWorkspace />));
  await click("QR code réserve");
  expect(host.querySelector("svg")).not.toBeNull();
  expect(host.querySelector("a").href).toBe(HACCP_CAPTURE_URL);
  expect(HACCP_CAPTURE_URL).toBe("https://sirius-assistant.fr/haccp");
  expect(host.textContent).toContain("aucun accès sans connexion");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("search sends filters with session and renders only returned data", async () => {
  await renderRegistry();
  await change(field("Lot, produit"), "LOT42");
  await change(field("Du"), "2026-10-01");
  global.fetch.mockResolvedValue(reply([{ id: 8, nom_produit: "<script>poisson</script>", numero_lot: "LOT42", type_operation: "reception" }]));
  await search();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toContain("terme=LOT42");
  expect(url).toContain("date_debut=2026-10-01");
  expect(options.credentials).toBe("include");
  expect(host.textContent).toContain("<script>poisson</script>");
  expect(host.querySelector("script")).toBeNull();
});

test("category filter is sent to the registry and displayed but does not silently restrict the period CSV", async () => {
  await renderRegistry();
  const select = [...host.querySelectorAll("label")].find((label) => label.textContent.startsWith("Catégorie")).querySelector("select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "Poissons");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  global.fetch.mockResolvedValueOnce(reply([{ id: 8, nom_produit: "Saumon", numero_lot: "LOT42", categorie: "Poissons" }]));
  await search();
  expect(global.fetch.mock.calls[0][0]).toContain("categorie=Poissons");
  expect(host.textContent).toContain("Catégorie : Poissons");
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  global.fetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["id;categorie"]) });
  await click("Exporter");
  expect(global.fetch.mock.calls[1][0]).not.toContain("categorie=");
});

test("protected photo uses configured backend instead of trusting arbitrary image_url", async () => {
  await renderRegistry();
  global.fetch.mockResolvedValueOnce(reply([{ id: 8, nom_produit: "Saumon", numero_lot: "LOT42", image_url: "https://evil.test/image" }]));
  await search();
  global.fetch.mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "image/png" }), blob: async () => new Blob(["photo"], { type: "image/png" }) });
  await click("Voir la preuve");
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/api\/haccp\/registre\/8\/photo$/);
  expect(host.querySelector('[role="dialog"] img').src).toBe("blob:proof");
  await click("Fermer la preuve");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:proof");
});

test("failed search removes stale results and reports authentication failure", async () => {
  await renderRegistry();
  global.fetch.mockResolvedValueOnce(reply([{ id: 8, nom_produit: "Ancien", numero_lot: "LOT42" }]));
  await search();
  global.fetch.mockResolvedValueOnce(reply({ detail: "Authentification requise" }, false));
  await search();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Authentification requise");
  expect(host.textContent).not.toContain("Ancien");
});

test("CSV export sends date range only and creates a timestamped download", async () => {
  await renderRegistry();
  await change(field("Lot, produit"), "NOT-EXPORTED");
  await change(field("Du"), "2026-10-01");
  const clickLink = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  global.fetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["id;produit"], { type: "text/csv" }) });
  await click("Exporter");
  expect(global.fetch.mock.calls[0][0]).toContain("export-csv?date_debut=2026-10-01");
  expect(global.fetch.mock.calls[0][0]).not.toContain("terme");
  expect(clickLink).toHaveBeenCalled();
});

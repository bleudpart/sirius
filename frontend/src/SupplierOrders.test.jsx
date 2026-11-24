import { act } from "react";
import { createRoot } from "react-dom/client";
import SupplierOrdersManager, { SupplierOrderPortal } from "./SupplierOrders";
import { orderDecimal, supplierCart } from "./supplierOrdersApi";
import { createModuleRegistry } from "./moduleRegistry";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch, oldCrypto;
const uuid = "e9c1bde8-6ec5-4731-a930-b5e9d7e8558a";
const suppliers = [
  { id: "supplier-a", name: "Laiterie", email: "", version: "v1", price_basis: "HT", products: [
    { id: "lait", reference: "LAIT", name: "Lait entier", price: "0.10", unit: "litre" },
  ] },
  { id: "supplier-b", name: "Boucherie", email: "", version: "v2", price_basis: "TTC", products: [
    { id: "viande", reference: "BOEUF", name: "Bœuf", price: "0.3333", unit: "kg" },
  ] },
];
const catalog = { client_id: "client-1", client_name: "Restaurant essai", mode: "test", version: "a".repeat(64), suppliers };
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const receipt = {
  id: uuid, client_name: "Restaurant essai", contact: "Contact", delivery_address: "Adresse essai",
  note: "", status: "test_not_sent", created_at: "2026-11-24T18:00:00Z",
  supplier_orders: suppliers.map((supplier) => ({
    supplier_id: supplier.id, supplier_name: supplier.name, price_basis: supplier.price_basis,
    lines: supplier.products.map((row) => ({ ...row, quantity: "3", total: supplier.id === "supplier-a" ? "0.30" : "1.00" })),
    total: supplier.id === "supplier-a" ? "0.30" : "1.00", status: "test_not_sent",
  })),
};
const field = (text) => [...host.querySelectorAll("label")].find((label) => label.textContent.trim().startsWith(text))?.querySelector("input,textarea,select");
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
async function change(input, value) {
  await act(async () => {
    const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype
      : input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function click(text) { await act(async () => button(text).click()); }
async function submit(text) {
  await act(async () => button(text).closest("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function render(component = <SupplierOrderPortal />) { await act(async () => root.render(component)); }
async function fillCart() {
  await change(host.querySelector('[aria-label="Quantité Lait entier (Laiterie)"]'), "3");
  await change(host.querySelector('[aria-label="Quantité Bœuf (Boucherie)"]'), "3");
  await change(field("Votre nom"), "Contact");
  await change(field("Adresse"), "Adresse essai");
}
beforeEach(() => {
  oldFetch = global.fetch; oldCrypto = global.crypto;
  global.crypto = { randomUUID: () => uuid };
  sessionStorage.clear();
  window.history.replaceState(null, "", "/commandes#k=secret-client-token");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; global.crypto = oldCrypto;
  jest.restoreAllMocks(); sessionStorage.clear();
});

test("the empty portal contains no invented prices and never submits automatically", async () => {
  global.fetch = jest.fn(async () => reply({ ...catalog, suppliers: [] }));
  await render();
  expect(host.textContent).toContain("Les grilles arrivent bientôt");
  expect(host.textContent).toContain("aucun e-mail");
  expect(button("Valider").disabled).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].headers["X-Sirius-Order-Client"]).toBe("secret-client-token");
});

test("one validation submits both suppliers, using quantities as exact strings and no client-supplied prices", async () => {
  const writes = [];
  global.fetch = jest.fn(async (_url, options) => {
    if (options.method === "POST") { writes.push(JSON.parse(options.body)); return reply(receipt); }
    return reply(catalog);
  });
  await render(); await fillCart();
  expect(host.textContent).toContain("Total Laiterie : 0,30 € HT");
  expect(host.textContent).toContain("Total Boucherie : 1,00 € TTC");
  expect(writes).toHaveLength(0);
  await submit("Valider");
  expect(writes).toEqual([{
    request_id: uuid, catalog_version: catalog.version, contact: "Contact",
    delivery_address: "Adresse essai", note: "", lines: [
      { supplier_id: "supplier-a", product_id: "lait", quantity: "3" },
      { supplier_id: "supplier-b", product_id: "viande", quantity: "3" },
    ],
  }]);
  expect(host.textContent).toContain("Commande d’essai enregistrée — aucun e-mail envoyé");
  expect(sessionStorage.getItem("sirius_b2b_pending_client-1")).toBeNull();
});

test("an interrupted validation survives a reload and retries the identical request", async () => {
  let first = true;
  const writes = [];
  global.fetch = jest.fn(async (_url, options) => {
    if (options.method !== "POST") return reply(catalog);
    writes.push(JSON.parse(options.body));
    if (first) { first = false; throw new TypeError("Connexion interrompue"); }
    return reply(receipt);
  });
  await render(); await fillCart(); await submit("Valider");
  expect(host.textContent).toContain("Validation à reprendre");
  expect(sessionStorage.getItem("sirius_b2b_pending_client-1")).not.toBeNull();
  expect(host.querySelector('[aria-label="Quantité Lait entier (Laiterie)"]').closest("fieldset").disabled).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host); await render();
  expect(host.textContent).toContain("Validation à reprendre");
  await submit("Réessayer la même validation");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(host.textContent).toContain("Commande d’essai enregistrée");
});

test("changed prices require reloading and do not look like a saved order", async () => {
  global.fetch = jest.fn(async (_url, options) => options.method === "POST"
    ? reply({ detail: "Les tarifs ont changé." }, 409) : reply(catalog));
  await render(); await fillCart(); await submit("Valider");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Les tarifs ont changé");
  expect(host.textContent).not.toContain("Commande d’essai enregistrée");
  expect(button("Valider").disabled).toBe(true);
  expect(sessionStorage.getItem("sirius_b2b_pending_client-1")).toBeNull();
  await click("Recharger les tarifs");
  expect(host.querySelector('[aria-label="Quantité Lait entier (Laiterie)"]').value).toBe("");
});

test("a confirmed order stays visible and blocks a new order if recovery storage cannot be cleared", async () => {
  global.fetch = jest.fn(async (_url, options) => reply(options.method === "POST" ? receipt : catalog));
  await render(); await fillCart();
  jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("Stockage bloqué"); });
  await submit("Valider");
  expect(host.textContent).toContain("Commande d’essai enregistrée — aucun e-mail envoyé");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Ne repassez pas commande");
  expect(button("Nouvelle commande").disabled).toBe(true);
  expect(sessionStorage.getItem("sirius_b2b_pending_client-1")).not.toBeNull();
});

test("unavailable session storage prevents validation rather than risking duplicate orders", async () => {
  global.fetch = jest.fn(async () => reply(catalog));
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Stockage désactivé"); });
  await render();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Stockage désactivé");
  expect(button("Valider")).toBeUndefined();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("management can start empty and save a new supplier grid without any real sending", async () => {
  const workspace = { suppliers: [], clients: [], orders: [], mode: "test" };
  const writes = [];
  global.fetch = jest.fn(async (url, options) => {
    if (options.method === "POST" && url.endsWith("/suppliers")) {
      const row = { ...JSON.parse(options.body), id: "supplier-new", products: [], version: "v1" };
      workspace.suppliers = [row]; return reply(row);
    }
    if (options.method === "PUT") {
      const body = JSON.parse(options.body); writes.push(body);
      workspace.suppliers = [{ ...workspace.suppliers[0], ...body.supplier, products: body.products, version: "v2" }];
      return reply({ saved: true });
    }
    return reply(workspace);
  });
  await render(<SupplierOrdersManager />);
  expect(host.textContent).toContain("Les grilles pourront être complétées ou importées demain");
  await change(field("Nom du fournisseur"), "Fournisseur essai");
  await submit("Ajouter le fournisseur");
  await click("Ajouter un produit");
  const editor = host.querySelector('[aria-label="Grille Fournisseur essai"]');
  const productInputs = editor.querySelectorAll(".b2b-product-edit input");
  for (const [index, value] of ["REF", "Lait essai", "litre", "1,2345"].entries()) await change(productInputs[index], value);
  await submit("Enregistrer le fournisseur");
  expect(writes[0]).toEqual({
    version: "v1", supplier: { name: "Fournisseur essai", email: "", price_basis: "HT" },
    products: [{ reference: "REF", name: "Lait essai", unit: "litre", price: "1.2345" }],
  });
  expect(host.textContent).toContain("Grille enregistrée pour le portail");
});

test("decimal cart calculations remain exact, including large amounts and invalid precision", () => {
  expect(supplierCart(suppliers, { lait: "3", viande: "3" }).map((group) => group.total)).toEqual(["0.30", "1.00"]);
  const large = [{ ...suppliers[0], products: [{ ...suppliers[0].products[0], price: "999999999.9999" }] }];
  expect(supplierCart(large, { lait: "999999999.9999" })[0].total).toBe("999999999999800000.00");
  for (const invalid of ["0", "-1", "1e2", "0.00001", "1000000000"]) {
    expect(() => orderDecimal(invalid, true)).toThrow();
  }
});

test("the module registry opens supplier management inside PLUTOS", () => {
  const openWorkModule = jest.fn();
  const entry = createModuleRegistry({ icons: {}, actions: { openWorkModule }, state: {}, user: null })
    .find((item) => item.id === "supplier-orders");
  entry.run();
  expect(openWorkModule).toHaveBeenCalledWith("pricing");
});

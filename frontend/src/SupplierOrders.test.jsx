import { act } from "react";
import { createRoot } from "react-dom/client";
import SupplierOrdersManager, { FriendSupplierManager, SupplierOrderPortal } from "./SupplierOrders";
import { orderDecimal, supplierCart } from "./supplierOrdersApi";
import { createModuleRegistry } from "./moduleRegistry";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch, oldCrypto, oldTitle;
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
  oldFetch = global.fetch; oldCrypto = global.crypto; oldTitle = document.title;
  global.crypto = { randomUUID: () => uuid };
  sessionStorage.clear();
  window.history.replaceState(null, "", "/commandes#k=secret-client-token");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; global.crypto = oldCrypto; document.title = oldTitle;
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
  expect(host.textContent).toContain("Les grilles pourront être complétées ou importées plus tard");
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

test("the owner creates and revokes a separate private management link", async () => {
  const workspace = { suppliers: [], clients: [], orders: [], manager_links: [], portal_name: "Portail de commandes" };
  const link = { id: "manager-1", name: "Commercial", active: true, created_at: "2026-11-24T18:00:00Z" };
  const url = "https://sirius-assistant.fr/portail/gestion#k=private-manager-token";
  global.fetch = jest.fn(async (path, options) => {
    if (options.method === "POST" && path.endsWith("/manager-links")) {
      workspace.manager_links = [link]; return reply({ link, url });
    }
    if (options.method === "DELETE") {
      workspace.manager_links = [{ ...link, active: false }]; return reply({ active: false });
    }
    return reply(workspace);
  });
  await render(<SupplierOrdersManager />);
  await submit("Créer le lien commercial");
  expect(field("Lien commercial privé").value).toBe(url);
  expect(host.textContent).toContain("Toute personne possédant le lien pourra gérer ces données");
  await click("Révoquer l’accès commercial de Commercial");
  await click("Confirmer la révocation commerciale");
  expect(field("Lien commercial privé")).toBeUndefined();
  expect(host.textContent).toContain("Commercial — Révoqué");
});

test("PLUTOS creates an invitation for an empty independent trial", async () => {
  const invitation = "https://sirius-assistant.fr/portail/gestion#activation=test-invitation";
  global.fetch = jest.fn(async (path, options) => path.endsWith("/independent-portals")
    ? reply({ url: invitation }) : reply({ suppliers: [], clients: [], orders: [], manager_links: [] }));
  await render(<SupplierOrdersManager />);
  await click("Créer une invitation pour son essai");
  expect(field("Invitation privée").value).toBe(invitation);
  expect(host.textContent).toContain("Son espace commence vide");
  expect(host.textContent).toContain("Ne l’activez pas vous-même");
});

test("the invited commercial activates a trial and receives private management and recovery links", async () => {
  const links = {
    url: "https://sirius-assistant.fr/portail/gestion#k=manager-token",
    recovery_url: "https://sirius-assistant.fr/portail/gestion#recuperation=recovery-token",
  };
  global.fetch = jest.fn(async (path) => path.endsWith("/activate") ? reply(links)
    : reply({ suppliers: [], clients: [], orders: [], independent: true }));
  window.history.replaceState(null, "", "/portail/gestion#activation=setup-token");
  await render(<FriendSupplierManager />);
  expect(host.textContent).toContain("Cet essai n’est pas une mise en service définitive");
  expect(host.textContent).toContain("une première version pour découvrir ton projet");
  expect(host.textContent).toContain("aucun e-mail n’est envoyé et aucun paiement n’est demandé");
  expect(host.textContent).toContain("l’administrateur de l’hébergement peut accéder aux données");
  expect(global.fetch).not.toHaveBeenCalled();
  await click("Activer mon essai");
  expect(global.fetch.mock.calls[0][0]).toContain("/public/supplier-orders/independent/activate");
  expect(global.fetch.mock.calls[0][1].credentials).toBe("omit");
  expect(global.fetch.mock.calls[0][1].headers["X-Order-Setup"]).toBe("setup-token");
  expect(field("Lien privé de gestion").value).toBe(links.url);
  expect(field("Lien privé de secours").value).toBe(links.recovery_url);
  expect(host.querySelector("a")).toBeNull();
  await act(async () => host.querySelector('input[type="checkbox"]').click());
  expect(host.textContent).toContain("Ouvrir mon espace d’essai");
  await act(async () => {
    window.history.replaceState(null, "", "/portail/gestion#k=manager-token");
    window.dispatchEvent(new Event("hashchange"));
  });
  expect(host.textContent).toContain("indépendant du compte");
  expect(global.fetch.mock.calls[1][1].headers["X-Order-Manager"]).toBe("manager-token");
});

test("the private recovery link replaces the manager access without a ΣIRIUS session", async () => {
  const link = "https://sirius-assistant.fr/portail/gestion#k=recovered-manager";
  global.fetch = jest.fn(async () => reply({ url: link }));
  window.history.replaceState(null, "", "/portail/gestion#recuperation=recovery-token");
  await render(<FriendSupplierManager />);
  await click("Créer un nouveau lien de gestion");
  expect(global.fetch.mock.calls[0][0]).toContain("/public/supplier-orders/independent/recover");
  expect(global.fetch.mock.calls[0][1].credentials).toBe("omit");
  expect(global.fetch.mock.calls[0][1].headers["X-Order-Recovery"]).toBe("recovery-token");
  expect(field("Lien privé de gestion").value).toBe(link);
});

test("the independent commercial can replace the management link without using an account", async () => {
  const newLink = "https://sirius-assistant.fr/portail/gestion#k=new-manager-token";
  global.fetch = jest.fn(async (path, options) => {
    expect(options.credentials).toBe("omit");
    if (path.endsWith("/rotate")) return reply({ url: newLink });
    return reply({ suppliers: [], clients: [], orders: [], independent: true });
  });
  window.history.replaceState(null, "", "/portail/gestion#k=old-manager-token");
  await render(<FriendSupplierManager />);
  expect(host.textContent).toContain("indépendant du compte");
  expect(host.textContent).not.toContain("partagés avec le titulaire");
  await click("Remplacer mon lien de gestion");
  expect(field("Nouveau lien privé").value).toBe(newLink);
  expect(host.textContent).toContain("L’ancien lien est désactivé");
  await act(async () => {
    window.history.replaceState(null, "", "/portail/gestion#k=new-manager-token");
    window.dispatchEvent(new Event("hashchange"));
  });
  expect(host.textContent).toContain("indépendant du compte");
  expect(host.textContent).not.toContain("L’ancien lien est désactivé");
  expect(global.fetch.mock.calls.at(-1)[1].headers["X-Order-Manager"]).toBe("new-manager-token");
});

test("the commercial uses only its private link, sees a neutral portal, and can name it", async () => {
  const workspace = { suppliers: [], clients: [], orders: [], portal_name: "Portail de commandes" };
  global.fetch = jest.fn(async (path, options) => {
    expect(options.credentials).toBe("omit");
    expect(options.headers["X-Order-Manager"]).toBe("secret-commercial");
    if (options.method === "PUT" && path.endsWith("/settings")) {
      workspace.portal_name = JSON.parse(options.body).name;
      return reply({ portal_name: workspace.portal_name });
    }
    return reply(workspace);
  });
  window.history.replaceState(null, "", "/portail/gestion#k=secret-commercial");
  await render(<FriendSupplierManager />);
  expect(host.textContent).not.toContain("ΣIRIUS");
  expect(button("Créer le lien commercial")).toBeUndefined();
  expect(host.textContent).toContain("partagés avec le titulaire du compte qui a créé ce lien");
  expect(host.textContent).toContain("Il peut aussi les consulter et les modifier");
  await change(field("Nom du portail"), "Le projet commercial");
  await submit("Enregistrer le nom");
  expect(host.querySelector("h1").textContent).toBe("Le projet commercial");
  expect(document.title).toBe("Le projet commercial");
});

test("the client sees the chosen portal name without a commercial or account login", async () => {
  global.fetch = jest.fn(async () => reply({ ...catalog, portal_name: "Le projet commercial" }));
  await render();
  expect(host.textContent).toContain("Le projet commercial");
  expect(host.textContent).not.toContain("ΣIRIUS");
  expect(document.title).toBe("Le projet commercial");
  expect(global.fetch.mock.calls[0][1].credentials).toBe("omit");
});

test("the commercial portal does not use a signed-in account when its private link is missing", async () => {
  global.fetch = jest.fn();
  window.history.replaceState(null, "", "/portail/gestion");
  await render(<FriendSupplierManager />);
  expect(host.textContent).toContain("Ouvrez le lien commercial privé");
  expect(global.fetch).not.toHaveBeenCalled();
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

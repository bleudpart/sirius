import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpWorkspace, { HACCP_CAPTURE_URL } from "./HaccpWorkspace";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch, oldWakeLock;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input");
const reply = (value, ok = true) => ({ ok, status: ok ? 200 : 401, json: async () => value });
beforeEach(() => {
  oldFetch = global.fetch;
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith("/enterprise/context")) return reply({ company: { id: "company-1", name: "Le Groupe" } });
    if (url.endsWith("/enterprise/sites")) return reply({ items: [{ id: "site-1", name: "Le Papillon", active: true }] });
    if (url.includes("/haccp/receptions/dossier")) return reply({
      restaurant_name: "Le Papillon",
      restaurant_slug: "le-papillon",
      directory: "uploads/le-papillon",
      directory_existed: false,
      items: [],
      total: 0,
    });
    return reply([]);
  });
  localStorage.clear();
  oldWakeLock = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
  URL.createObjectURL = jest.fn(() => "blob:proof"); URL.revokeObjectURL = jest.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; jest.restoreAllMocks();
  if (oldWakeLock) Object.defineProperty(navigator, "wakeLock", oldWakeLock);
  else delete navigator.wakeLock;
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
  global.fetch.mockClear();
  await click("Registre / Contrôle");
}
async function search() {
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

test("QR points to the authenticated standalone capture and loads its active establishment", async () => {
  await act(async () => root.render(<HaccpWorkspace />));
  await click("QR code réserve");
  expect(host.querySelector("svg")).not.toBeNull();
  expect(host.querySelector("a").href).toBe(HACCP_CAPTURE_URL);
  expect(HACCP_CAPTURE_URL).toBe("https://sirius-assistant.fr/haccp");
  expect(host.textContent).toContain("aucun accès sans connexion");
  expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/enterprise\/context$/), expect.any(Object));
});

test("existing restaurant folders require resuming before scans and show saved documents", async () => {
  global.fetch.mockImplementation(async (url) => {
    if (url.endsWith("/enterprise/context")) return reply({ company: { id: "company-1", name: "Le Groupe" } });
    if (url.endsWith("/enterprise/sites")) return reply({ items: [{ id: "site-1", name: "Le Papillon", active: true }] });
    if (url.includes("/haccp/receptions/dossier")) return reply({
      restaurant_name: "Le Papillon", restaurant_slug: "le-papillon",
      directory: "uploads/le-papillon", directory_existed: true,
      items: [{ name: "le-papillon_reception_20261029_225501_a8f9c321.jpg" }], total: 1,
    });
    return reply([]);
  });
  await act(async () => root.render(<HaccpWorkspace />));
  expect(host.textContent).toContain("Dossier en cours : le-papillon");
  expect(host.textContent).toContain("le-papillon_reception_20261029_225501_a8f9c321.jpg");
  expect(button("Reprendre / Continuer")).not.toBeNull();
  expect(host.querySelector(".haccp-capture-fields").disabled).toBe(true);
  await click("Reprendre / Continuer");
  expect(host.querySelector(".haccp-capture-fields").disabled).toBe(false);
});

test("late dossier responses cannot replace the currently selected establishment", async () => {
  let resolveFirst;
  let resolveSecond;
  global.fetch.mockImplementation(async (url) => {
    if (url.endsWith("/enterprise/context")) return reply({ company: { id: "company-1", name: "Le Groupe" } });
    if (url.endsWith("/enterprise/sites")) return reply({ items: [
      { id: "site-1", name: "Le Papillon", active: true },
      { id: "site-2", name: "La Sirène", active: true },
    ] });
    if (url.includes("/haccp/receptions/dossier")) {
      return new Promise((resolve) => {
        if (url.includes("Le+Papillon")) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    }
    return reply([]);
  });
  await act(async () => root.render(<HaccpWorkspace />));
  const select = host.querySelector(".haccp-establishment select");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "Le Papillon");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "La Sirène");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => resolveSecond(reply({
    restaurant_name: "La Sirène", restaurant_slug: "la-sirene", directory_existed: false, items: [],
  })));
  expect(host.textContent).toContain("Dossier en cours : la-sirene");
  await act(async () => resolveFirst(reply({
    restaurant_name: "Le Papillon", restaurant_slug: "le-papillon", directory_existed: false, items: [],
  })));
  expect(host.textContent).toContain("Dossier en cours : la-sirene");
  expect(host.textContent).not.toContain("Dossier en cours : le-papillon");
});

test("simplified kitchen workspace presents the oversized scan flow without hiding the safety review", async () => {
  await act(async () => root.render(<HaccpWorkspace standalone />));
  await click("Cuisine simplifiée");
  expect(host.querySelector(".haccp-kitchen")).not.toBeNull();
  expect(host.querySelector("button.haccp-kitchen-scan")).not.toBeNull();
  expect(host.textContent).toContain("vérifiez le produit, le lot et la date avant de confirmer l’impression");
  expect(host.textContent).not.toContain("J’ai vérifié le produit, le lot et la DLC — imprimer");
});

test("standalone scan page requests screen wake lock and reacquires it after release on return", async () => {
  let releaseListener;
  const lock = {
    addEventListener: jest.fn((_event, listener) => { releaseListener = listener; }),
    release: jest.fn().mockResolvedValue(),
  };
  const request = jest.fn().mockResolvedValue(lock);
  Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
  await act(async () => {
    root.render(<HaccpWorkspace standalone />);
    await Promise.resolve();
  });
  expect(request).toHaveBeenCalledWith("screen");
  expect(host.textContent).toContain("Écran maintenu allumé pendant le service.");
  await act(async () => {
    releaseListener();
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Écran maintenu allumé pendant le service.");
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

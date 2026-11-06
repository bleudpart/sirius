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
  await act(async () => root.render(<HaccpWorkspace standalone initialTab="capture" />));
  global.fetch.mockClear();
  await click("Registre / Contrôle");
}
async function search() {
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

test("QR code Cuisine creates a revocable kitchen link for the active establishment", async () => {
  const kitchenUrl = "https://sirius-assistant.fr/cuisine#k=abcdefghijklmnopqrstuvwxyz";
  const base = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options = {}) => {
    if (url.endsWith("/haccp/cuisine/lien")) return reply(options.method === "POST"
      ? { active: true, url: kitchenUrl, restaurant_name: "Le Papillon" } : { active: false });
    return base(url, options);
  });
  await act(async () => root.render(<HaccpWorkspace initialTab="capture" />));
  await click("QR code Cuisine");
  expect(host.textContent).toContain("Aucun QR code actif");
  await click("Créer le QR code pour Le Papillon");
  const [, options] = global.fetch.mock.calls.find(([url, opts]) => url.endsWith("/haccp/cuisine/lien") && opts?.method === "POST");
  expect(JSON.parse(options.body)).toEqual({ restaurant_name: "Le Papillon" });
  expect(host.querySelector('section[aria-label="QR code Cuisine"] svg')).not.toBeNull();
  expect(host.textContent).toContain("seulement de photographier");
  expect(HACCP_CAPTURE_URL).toBe("https://sirius-assistant.fr/haccp");
});

test.each([
  ["qr", "QR code Cuisine"],
  ["closing", "Bilan HACCP de fin de service"],
  ["registre", "Contrôle sanitaire"],
])("%s section uses the shared workspace card", async (tab, label) => {
  await act(async () => root.render(<HaccpWorkspace initialTab={tab} />));
  const section = host.querySelector(`section[aria-label="${label}"]`);
  expect(section).not.toBeNull();
  expect(section.classList.contains("workspace-surface")).toBe(true);
  expect(section.classList.contains("haccp-card")).toBe(true);
});

test("closing report shows scoped priorities, opens the exact source record and requires human PDF confirmation", async () => {
  let day;
  const report = () => ({
    date: day, fuseau: "Europe/Paris", genere_le: `${day}T16:00:00+00:00`,
    etiquettes_enregistrees: 2, impressions_confirmees: 1, impressions_sans_date: 1,
    statut: "attention",
    revision: "a".repeat(64),
    limites: ["Le registre ne confirme pas le stock réel."],
    priorites: [{
      code: "dates", niveau: "urgent", titre: "Dates proches ou dépassées",
      action: "Vérifier physiquement le produit.", total: 1, autres_fiches: 0,
      fiches: [{
        etiquette_id: 73, produit: "Soupe TEST", lot: "LOT-73", type_operation: "preparation",
        motif: "Date à vérifier aujourd'hui.", date_cible: day, statut_impression: null,
      }],
    }],
  });
  global.fetch.mockImplementation(async (url, options = {}) => {
    if (url.includes("/registre/cloture?")) {
      day = new URL(url).searchParams.get("date");
      return reply(report());
    }
    if (url.endsWith("/registre/73/donnees")) return reply({
      id: 73, nom_produit: "Soupe TEST", numero_lot: "LOT-73", type_operation: "preparation",
      date_fabrication: `${day}T07:00:00Z`, dlc_secondaire: `${day}T22:00:00Z`,
      conditions_conservation: "Entre 0 et +3 °C.", image_url: null,
    });
    if (url.endsWith("/registre/cloture/pdf") && options.method === "POST") {
      return {
        ok: true, status: 200, headers: { get: () => "application/pdf" },
        blob: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      };
    }
    return reply([]);
  });
  const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await act(async () => root.render(<HaccpWorkspace initialTab="closing" />));
  expect(host.querySelector('[aria-label="Bilan HACCP de fin de service"]')).not.toBeNull();
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(host.textContent).toContain("2Étiquettes enregistrées");
  expect(host.textContent).toContain("Le registre ne confirme pas le stock réel.");
  expect(button("Valider et télécharger le PDF").disabled).toBe(true);

  expect(button("Ouvrir la fiche").disabled).toBe(false);
  await click("Ouvrir la fiche");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(global.fetch.mock.calls.some(([url]) => url.endsWith("/registre/73/donnees"))).toBe(true);
  expect(host.querySelector('[role="dialog"]').textContent).toContain("Soupe TEST");
  expect(host.querySelector('[role="dialog"]').textContent).toContain("Entre 0 et +3 °C.");
  await act(async () => host.querySelector('[role="dialog"] button').click());
  await click("Fin de service");

  await change(field("Nom du responsable"), "Responsable Test");
  const checkbox = host.querySelector('.haccp-closing-validation input[type="checkbox"]');
  await act(async () => checkbox.click());
  expect(button("Valider et télécharger le PDF").disabled).toBe(false);
  await click("Valider et télécharger le PDF");
  const pdfCall = global.fetch.mock.calls.find(([url]) => url.endsWith("/registre/cloture/pdf"));
  expect(JSON.parse(pdfCall[1].body)).toEqual({
    date: day, revision: "a".repeat(64), nom_responsable: "Responsable Test",
    confirme_verification_humaine: true,
  });
  expect(anchorClick).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("PDF téléchargé après votre validation nominative.");
});

test("closing PDF does not download when the registry changed after manager review", async () => {
  global.fetch.mockImplementation(async (url, options = {}) => {
    if (url.includes("/registre/cloture?")) {
      const day = new URL(url).searchParams.get("date");
      return reply({
        date: day, fuseau: "Europe/Paris", genere_le: `${day}T16:00:00+00:00`,
        etiquettes_enregistrees: 0, impressions_confirmees: 0, impressions_sans_date: 0,
        statut: "aucune_alerte_enregistree", revision: "b".repeat(64), priorites: [], limites: [],
      });
    }
    if (url.endsWith("/registre/cloture/pdf") && options.method === "POST") {
      return { ok: false, status: 409, json: async () => ({ detail: "Le registre a changé depuis le bilan." }) };
    }
    return reply([]);
  });
  const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await act(async () => root.render(<HaccpWorkspace initialTab="closing" />));
  const day = field("Date du service").value;
  expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await change(field("Nom du responsable"), "Responsable Test");
  const checkbox = host.querySelector('.haccp-closing-validation input[type="checkbox"]');
  await act(async () => checkbox.click());
  expect(button("Valider et télécharger le PDF").disabled).toBe(false);
  await click("Valider et télécharger le PDF");
  const pdfCalls = global.fetch.mock.calls.filter(([url]) => url.endsWith("/registre/cloture/pdf"));
  expect(pdfCalls).toHaveLength(1);
  expect(JSON.parse(pdfCalls[0][1].body)).toEqual({
    date: day, revision: "b".repeat(64), nom_responsable: "Responsable Test",
    confirme_verification_humaine: true,
  });
  expect(host.querySelector('[role="alert"]').textContent).toContain("Le registre a changé");
  expect(anchorClick).not.toHaveBeenCalled();
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
  await act(async () => root.render(<HaccpWorkspace initialTab="capture" />));
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
  await act(async () => root.render(<HaccpWorkspace initialTab="capture" />));
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

test("the kitchen screen opens by default with only photo and find buttons, and the full mode stays reachable", async () => {
  await act(async () => root.render(<HaccpWorkspace standalone />));
  expect(host.querySelector(".haccp-simple")).not.toBeNull();
  expect(host.querySelector(".haccp-navigation")).toBeNull();
  expect(host.querySelector('[aria-label="Dossier de l’établissement"]')).toBeNull();
  expect(button("PHOTO")).not.toBeUndefined();
  expect(button("RETROUVER")).not.toBeUndefined();
  expect(host.textContent).not.toContain("Opérateur");
  await click("Mode complet");
  expect(host.querySelector(".haccp-navigation")).not.toBeNull();
  await click("Cuisine simplifiée");
  expect(host.querySelector(".haccp-simple")).not.toBeNull();
});

test("preparation is accessible in the shared workspace and uses the active establishment dossier", async () => {
  await act(async () => root.render(<HaccpWorkspace standalone initialTab="capture" />));
  await click("Préparation / DLC");
  expect(host.querySelector('[aria-label="Étiquette de préparation"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Dossier de l’établissement"]')).not.toBeNull();
  expect(host.textContent).toContain("Le Papillon");
  expect(host.querySelector("video")).toBeNull();
  expect(field("Durée de conservation").value).toBe("");
});

test("archived preparations reopen without requesting or inventing a photo", async () => {
  await renderRegistry();
  global.fetch.mockResolvedValueOnce(reply([{
    id: 9, nom_produit: "Soupe TEST", numero_lot: "PREP-TEST", type_operation: "preparation",
    conforme_reception: true, date_fabrication: "2026-11-02T07:00:00Z",
    dlc_secondaire: "2026-11-05T07:00:00Z", conditions_conservation: "Entre 0 et +3 °C, bac fermé.",
    duree_conservation_heures: 72, justification_duree: "PMS test", image_url: null,
  }]));
  await search();
  global.fetch.mockClear();
  await click("Voir la préparation / imprimer");
  const dialog = host.querySelector('[role="dialog"]');
  expect(dialog.getAttribute("aria-label")).toBe("Fiche de préparation");
  expect(dialog.querySelector("img")).toBeNull();
  expect(dialog.querySelector("video")).toBeNull();
  expect(dialog.textContent).toContain("Entre 0 et +3 °C, bac fermé.");
  expect(dialog.textContent).toContain("DLC exacte");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("receipt destinations are connected to the workspace and its active establishment", async () => {
  await act(async () => root.render(<HaccpWorkspace standalone initialTab="capture" />));
  global.fetch.mockResolvedValueOnce(reply({ items: [], total: 0, offset: 0, limit: 25 }));
  await click("Réceptions / Lots");
  expect(host.querySelector('[aria-label="Suivi des réceptions fournisseurs"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Dossier de l’établissement"]')).not.toBeNull();
  expect(host.querySelector("video")).toBeNull();
  expect(global.fetch).toHaveBeenLastCalledWith(
    expect.stringMatching(/\/receptions\?offset=0&limit=25&restaurant_name=Le\+Papillon$/), expect.any(Object),
  );
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
    root.render(<HaccpWorkspace standalone initialTab="capture" />);
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

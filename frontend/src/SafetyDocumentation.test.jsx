import { act } from "react";
import { createRoot } from "react-dom/client";
import SafetyDocumentation from "./SafetyDocumentation";
import HaccpModule from "./HaccpModule";
import { editableSafetyDocument, emptySafetyDossier, planningTotals, planningWeekTables, safetyPayload, safetyPrintHtml, shiftMinutes } from "./safetyDocuments";
import { findModuleForCommand, MODULE_ALIASES } from "./moduleCommandRouting";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, originalFetch;
const documentData = {
  ...emptySafetyDossier(), id: "safety-version-1", created_at: "2026-10-23T10:00:00Z",
  etablissement: "Cuisine", responsable: "Responsable",
  accueil: [{ personne: "Employé A", poste: "Cuisine", date_accueil: "2026-10-23",
    accueillant: "Chef", consignes_remises: "Livret", observations: "" }],
};
const reply = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith("/current")) return reply({ document: documentData });
    if (url.endsWith("/personnel-securite")) return reply({ items: [documentData], truncated: false });
    if (url.endsWith("/overview")) return reply({});
    if (url.endsWith("/trace")) return reply({ items: [] });
    return reply({ document: documentData });
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch; jest.restoreAllMocks();
});
const render = async (node = <SafetyDocumentation />) => act(async () => root.render(node));
const button = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.includes(text));
async function change(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("personnel and safety is a real HACCP tab with five editable printable chapters", async () => {
  await render(<HaccpModule initialSource={{ kind: "safety" }} onClose={jest.fn()} />);
  expect(host.querySelector('[data-testid="haccp-section-safety"]')).not.toBeNull();
  for (const key of ["accueil", "formations", "incendie", "evacuations", "verifications"]) {
    expect(host.querySelector(`[data-testid="safety-${key}"]`)).not.toBeNull();
  }
  expect(host.textContent).toContain("pas un registre unique du personnel");
  expect(host.textContent).toContain("aucune conformité");
  expect(host.textContent).toContain("sans données de santé");
  expect(host.textContent).toContain("Notice d'utilisation — documentation en français");
  expect(global.fetch.mock.calls.find(([url]) => url.endsWith("/personnel-securite/current"))[1].credentials).toBe("include");
});

test("new entries can be edited and saving appends a full version before printing", async () => {
  await render();
  const formation = host.querySelector('[data-testid="safety-formations"]');
  await act(async () => [...formation.querySelectorAll("button")].find((b) => b.textContent.includes("AJOUTER")).click());
  expect(formation.querySelectorAll(".safety-entry")).toHaveLength(1);
  const inputs = formation.querySelectorAll("input");
  await change(inputs[0], "Employé A");
  await change(inputs[1], "Formation sécurité");
  await change(inputs[2], "2026-10-23");
  expect(button("IMPRIMER LE DOSSIER").disabled).toBe(true);
  global.fetch.mockImplementationOnce(async (url, options) => {
    expect(url).toMatch(/\/api\/haccp\/personnel-securite$/);
    const body = JSON.parse(options.body);
    expect(body.formations[0].formation).toBe("Formation sécurité");
    expect(body.formations[0].renouvellement).toBeNull();
    expect(body.incendie.date_validation).toBeNull();
    expect(body).not.toHaveProperty("id");
    return reply({ document: { ...body, id: "safety-version-2", created_at: "2026-10-23T11:00:00Z" } });
  });
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Nouvelle version des cahiers enregistrée");
  expect(button("IMPRIMER LE DOSSIER").disabled).toBe(false);
});

test("failed save retains edits and visibly reports failure", async () => {
  await render();
  await change(host.querySelector('input'), "À conserver");
  global.fetch.mockResolvedValueOnce(reply({ detail: "Permission refusée." }, false, 403));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Permission refusée");
  expect(host.querySelector("input").value).toBe("À conserver");
  expect(button("IMPRIMER LE DOSSIER").disabled).toBe(true);
});

test("failed load is not presented as an empty successful register", async () => {
  global.fetch.mockRejectedValue(new Error("Service indisponible"));
  await render();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Service indisponible");
  expect(button("IMPRIMER LE DOSSIER").disabled).toBe(true);
});

test("dirty register prompts before leaving HACCP tab or closing", async () => {
  const onClose = jest.fn();
  jest.spyOn(window, "confirm").mockReturnValue(false);
  await render(<HaccpModule initialSource={{ kind: "safety" }} onClose={onClose} />);
  await change(host.querySelector("input"), "Modifié");
  await act(async () => host.querySelector('[data-testid="haccp-tab-trace"]').click());
  expect(host.querySelector('[data-testid="haccp-section-safety"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid="haccp-close-btn"]').click());
  expect(onClose).not.toHaveBeenCalled();
});

test("individual chapter print contains only that chapter, with safe text and signature fields", () => {
  const html = safetyPrintHtml({ ...documentData, etablissement: '<img onerror="bad">' }, "accueil");
  expect(new DOMParser().parseFromString(html, "text/html").body.textContent).toContain("Cahier d'accueil du personnel");
  expect(html).toContain("Employé A");
  expect(html).toContain("Signature personne accueillie");
  expect(html).toContain("A4 portrait");
  expect(html).toContain('lang="fr"');
  expect(html).toContain("23/10/2026");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("Cahier des formations");
  expect(html).not.toContain("Consignes de sécurité incendie");
});

test("full dossier prints all chapters and marks empty chapters as templates, never verified records", () => {
  const html = safetyPrintHtml(documentData);
  expect(new DOMParser().parseFromString(html, "text/html").querySelectorAll("section.chapter")).toHaveLength(7);
  expect(html).toContain("modèle vierge à compléter");
  expect(html).toContain("aucune vérification ou formation attestée");
  expect(html).toContain("pas une attestation de conformité");
  expect(html).toContain("validation");
  expect(html).not.toContain("prime-screen");
});

test("fire instructions remain empty unless the user enters site-specific information", () => {
  const form = emptySafetyDossier();
  expect(form.incendie.alerte).toBe("");
  expect(form.incendie.evacuation).toBe("");
  expect(safetyPayload(form).incendie.date_validation).toBeNull();
  expect(safetyPrintHtml(documentData, "incendie")).toContain("À compléter");
  expect(() => safetyPrintHtml(documentData, "unknown")).toThrow();
});

test("optional dates round trip without making a saved document dirty", () => {
  const saved = { ...documentData, incendie: { ...documentData.incendie, date_validation: null } };
  const edit = editableSafetyDocument(saved);
  expect(edit.incendie.date_validation).toBe("");
  expect(safetyPayload(edit).incendie.date_validation).toBeNull();
});

const shift = (updates = {}) => ({
  personne: "Employé A", poste: "Cuisine", date_service: "2026-10-23",
  debut: "08:00", fin: "16:00", lendemain: "non", pause_minutes: 30, observations: "", ...updates,
});
test("kitchen and dining room schedules are independently editable sections", async () => {
  await render();
  for (const key of ["planning_cuisine", "planning_salle"]) {
    const section = host.querySelector(`[data-testid="safety-${key}"]`);
    expect(section).not.toBeNull();
    await act(async () => [...section.querySelectorAll("button")].find((b) => b.textContent.includes("AJOUTER")).click());
    expect(section.querySelector('input[type="time"]')).not.toBeNull();
  }
  expect(button("IMPRIMER LE DOSSIER").disabled).toBe(true);
});
test.each([
  [shift(), 450], [shift({ debut: "22:00", fin: "02:00", lendemain: "oui" }), 210],
  [shift({ debut: "22:00", fin: "02:00" }), null],
  [shift({ debut: "08:00", fin: "08:00" }), null],
  [shift({ pause_minutes: 480 }), null], [shift({ fin: "25:00" }), null],
])("planning duration checks overnight and breaks", (row, expected) => {
  expect(shiftMinutes(row)).toBe(expected);
});
test("weekly totals do not combine different weeks and printable grids show Monday to Sunday", () => {
  const rows = [shift(), shift({ date_service: "2026-10-24" }), shift({ date_service: "2026-10-26" })];
  expect(planningTotals(rows)).toEqual([
    { semaine: "2026-10-19", personne: "Employé A", minutes: 900 },
    { semaine: "2026-10-26", personne: "Employé A", minutes: 450 },
  ]);
  const html = safetyPrintHtml({ ...documentData, planning_cuisine: rows }, "planning_cuisine");
  expect(html).toContain("Planning du personnel de cuisine");
  expect(html).toContain("A4 landscape");
  expect(html).toContain("Lundi");
  expect(html).toContain("Dimanche");
  expect(html).toContain("15 h 00");
  expect(html).toContain("Pause 30 min");
  expect(planningWeekTables([])).toContain("semaine du");
});

test("overnight services and split shifts are allocated to their start week across a year boundary", () => {
  const rows = [
    shift({ date_service: "2026-12-31", debut: "22:00", fin: "02:00", lendemain: "oui" }),
    shift({ date_service: "2027-01-01", debut: "10:00", fin: "12:00", pause_minutes: 0 }),
    shift({ date_service: "2027-01-01", debut: "18:00", fin: "20:00", pause_minutes: 0 }),
  ];
  expect(planningTotals(rows)).toEqual([{ semaine: "2026-12-28", personne: "Employé A", minutes: 450 }]);
  const html = safetyPrintHtml({ ...documentData, planning_salle: rows }, "planning_salle");
  expect(html).toContain("28/12/2026");
  expect(html).toContain("(+1 jour)");
  expect(html).not.toContain("Planning du personnel de cuisine");
});

test("invalid planning times block API writes and preserve the service for correction", async () => {
  const invalid = { ...documentData, planning_cuisine: [shift({ fin: "02:00" })] };
  global.fetch.mockImplementation(async (url) => reply(url.endsWith("/current")
    ? { document: invalid } : { items: [invalid], truncated: false }));
  await render();
  const before = global.fetch.mock.calls.length;
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(global.fetch.mock.calls).toHaveLength(before);
  expect(host.querySelector('[role="alert"]').textContent).toContain("Horaires de planning invalides");
  expect(host.querySelector('[data-testid="safety-planning_cuisine"] input[type="time"]').value).toBe("08:00");
});

test.each(["ouvre le cahier du personnel", "ouvre la sécurité incendie", "affiche les exercices d'évacuation"])(
  "routes safety documentation command to HACCP: %s", (command) => {
    expect(findModuleForCommand(command, [{ id: "haccp", label: "HACCP" }], MODULE_ALIASES).item?.id).toBe("haccp");
  });

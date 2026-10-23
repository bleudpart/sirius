import { act } from "react";
import { createRoot } from "react-dom/client";
import SectionSheets, { buildSheetHtml, loadTemperatureSheetRows, printSheet, SHEETS, temperatureSheetKind } from "./HaccpSheets";
import HaccpModule from "./HaccpModule";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, originalFetch;
const reply = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = jest.fn(async (url) => reply(url.endsWith("/current") ? { document: null } : { items: [], truncated: false }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch; jest.restoreAllMocks();
});
async function change(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const button = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.includes(text));
const template = SHEETS.find((s) => s.id === "frigo");
const savedSheet = (updates = {}) => ({
  titre: template.titre, sous: template.sous, etablissement: "Cuisine", periode: "Semaine 43",
  responsable: "", equipement: "Frigo 1", cible: "Selon PMS", remarques: "",
  colonnes: [...template.colonnes], lignes: [["23/10/2026", "08:00", "Frigo 1", "3", "0 à 4", "Test", ""]],
  id: "saved-sheet", created_at: "2026-10-23T10:00:00Z", ...updates,
});

test("French sheets include separate frigo, freezer, cold room, dry stock and packing models", async () => {
  await act(async () => root.render(<SectionSheets />));
  for (const id of ["frigo", "congelateur", "chambre_froide", "epicerie", "boitage"]) {
    expect(host.querySelector(`[data-testid="haccp-sheet-edit-${id}"]`)).not.toBeNull();
  }
  expect(host.textContent).toContain("MODIFIER / REMPLIR");
});

test("sheet cases and headings are editable; rows can be added and duplicated then saved before print", async () => {
  await act(async () => root.render(<SectionSheets />));
  await act(async () => host.querySelector('[data-testid="haccp-sheet-edit-frigo"]').click());
  const inputs = host.querySelectorAll("input");
  await change(inputs[2], "Cuisine");
  await change(host.querySelector('textarea[aria-label="Ligne 1, Date"]'), "23/10/2026");
  await change(host.querySelector('textarea[aria-label="Ligne 1, T° relevée (°C)"]'), "3");
  await act(async () => host.querySelector('[aria-label="Dupliquer la ligne 1"]').click());
  expect(host.querySelector('textarea[aria-label="Ligne 2, T° relevée (°C)"]').value).toBe("3");
  await act(async () => button("AJOUTER UNE LIGNE").click());
  expect(host.querySelectorAll("tbody tr")).toHaveLength(8);
  expect(button("IMPRIMER / PDF").disabled).toBe(true);
  global.fetch.mockImplementationOnce(async (url, options) => {
    const body = JSON.parse(options.body);
    expect(url).toMatch(/\/haccp\/feuilles\/frigo$/);
    expect(body.etablissement).toBe("Cuisine");
    expect(body.lignes[0][3]).toBe("3");
    return reply({ document: { ...body, id: "sheet-version", created_at: "2026-10-23T10:00:00Z" } });
  });
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Feuille enregistrée");
  expect(button("IMPRIMER / PDF").disabled).toBe(false);
});

test("failed save preserves edited cells and reports an error instead of printing", async () => {
  await act(async () => root.render(<SectionSheets />));
  await act(async () => host.querySelector('[data-testid="haccp-sheet-edit-epicerie"]').click());
  await change(host.querySelector('textarea[aria-label="Ligne 1, Produit / fournisseur"]'), "Farine");
  global.fetch.mockResolvedValueOnce(reply({ detail: "Service indisponible" }, false, 503));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Service indisponible");
  expect(host.querySelector('textarea[aria-label="Ligne 1, Produit / fournisseur"]').value).toBe("Farine");
});

test("temperature prefills select only the intended equipment, including legacy cold rooms", async () => {
  const equipment = [
    { id: "fridge", nom: "Frigo", type: "frigo", min: 0, max: 4 },
    { id: "freezer", nom: "Congélateur", type: "congelateur", min: -30, max: -18 },
    { id: "room", nom: "Chambre froide positive", type: "frigo", min: 0, max: 4 },
    { id: "room2", nom: "Négatif", type: "chambre_froide_negative", min: -30, max: -18 },
  ];
  global.fetch.mockImplementation(async (url) => reply({ items: url.endsWith("/equipements") ? equipment : equipment.map((item, i) =>
    ({ equipement_id: item.id, equipement: item.nom, valeur: i, created_at: "2026-10-23T08:00:00Z", releve_par: "Test" })) }));
  expect((await loadTemperatureSheetRows("frigo")).map((row) => row[2])).toEqual(["Frigo"]);
  expect((await loadTemperatureSheetRows("congelateur")).map((row) => row[2])).toEqual(["Congélateur"]);
  expect((await loadTemperatureSheetRows("chambre_froide")).map((row) => row[2])).toEqual(["Négatif", "Chambre froide positive"]);
  expect(temperatureSheetKind(equipment[2])).toBe("chambre_froide");
});

test("failed prefill never silently prints a blank sheet; popup blocking is explained", async () => {
  const events = [];
  const listener = (event) => events.push(event.detail);
  window.addEventListener("haccp-error", listener);
  const write = jest.fn(), close = jest.fn();
  jest.spyOn(window, "open").mockReturnValue({ document: { write, close: jest.fn() }, close });
  global.fetch.mockResolvedValue(reply({}, false, 401));
  expect(await printSheet(template, true)).toBe(false);
  expect(write).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalled();
  expect(events[0]).toContain("refusé");
  window.open.mockReturnValue(null);
  expect(await printSheet(template)).toBe(false);
  expect(events[1]).toContain("bloquée");
  window.removeEventListener("haccp-error", listener);
});

test("saved sheet print uses all edited headings, rows, metadata and safe text without auto script", () => {
  const html = buildSheetHtml({ ...template, titre: "Ma feuille", colonnes: ["Jour", "Valeur"], lignes: 0 },
    [["23/10/2026", '<img onerror="bad">']], { etablissement: "Cuisine & salle", periode: "Semaine test",
      id: "version-test", created_at: "2026-10-23", remarques: "Action\nÀ contrôler" });
  expect(html).toContain("Ma feuille");
  expect(html).toContain("Cuisine &amp; salle");
  expect(html).toContain("Action<br>À contrôler");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<script>");
});

test("saved sheet reopens, prints its saved cells, and a new blank sheet keeps the previous version", async () => {
  const append = document.body.appendChild.bind(document.body);
  jest.spyOn(document.body, "appendChild").mockImplementation((node) => {
    const result = append(node);
    if (node.tagName === "IFRAME") {
      node.contentWindow.focus = jest.fn();
      node.contentWindow.print = jest.fn();
    }
    return result;
  });
  const saved = savedSheet();
  global.fetch.mockImplementation(async (url) => reply(url.endsWith("/current") ? { document: saved } : { items: [saved], truncated: false }));
  await act(async () => root.render(<SectionSheets />));
  await act(async () => host.querySelector('[data-testid="haccp-sheet-edit-frigo"]').click());
  expect(host.querySelector('textarea[aria-label="Ligne 1, T° relevée (°C)"]').value).toBe("3");
  await act(async () => button("IMPRIMER / PDF").click());
  const iframe = document.querySelector('iframe[title="Document de prévention à imprimer"]');
  const printed = new DOMParser().parseFromString(iframe.srcdoc, "text/html");
  expect(printed.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(printed.body.textContent).toContain("Frigo 1");
  expect(printed.body.textContent).toContain("Semaine 43");
  expect(printed.body.textContent).toContain("saved-sheet");
  expect(iframe.contentWindow.print).toHaveBeenCalledTimes(1);
  await act(async () => button("NOUVELLE FEUILLE VIERGE").click());
  expect(host.querySelector("textarea").value).toBe("");
  expect(host.querySelector('option[value="saved-sheet"]')).not.toBeNull();
  expect(button("IMPRIMER / PDF").disabled).toBe(true);
});

test("row deletion and version switching preserve originals and require confirmation before losing edits", async () => {
  const saved = savedSheet();
  global.fetch.mockImplementation(async (url) => reply(url.endsWith("/versions")
    ? { items: [saved], truncated: false } : { document: saved }));
  jest.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => root.render(<SectionSheets />));
  await act(async () => host.querySelector('[data-testid="haccp-sheet-edit-frigo"]').click());
  await act(async () => host.querySelector('[aria-label="Supprimer la ligne 1"]').click());
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  window.confirm.mockReturnValue(true);
  await act(async () => host.querySelector('[aria-label="Supprimer la ligne 1"]').click());
  expect(host.querySelectorAll("tbody tr")).toHaveLength(0);
  window.confirm.mockReturnValue(false);
  await act(async () => button("RETOUR AUX FEUILLES").click());
  expect(host.querySelector('[data-testid="haccp-sheet-editor"]')).not.toBeNull();
  const before = global.fetch.mock.calls.length;
  await act(async () => host.querySelector("select").dispatchEvent(new Event("change", { bubbles: true })));
  expect(global.fetch.mock.calls).toHaveLength(before);
  window.confirm.mockReturnValue(true);
  await act(async () => host.querySelector("select").dispatchEvent(new Event("change", { bubbles: true })));
  expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(global.fetch.mock.calls.at(-1)[0]).toMatch(/\/frigo\/versions\/saved-sheet$/);
});

test("dirty sheet blocks a change of HACCP tab, close and incoming source navigation", async () => {
  global.fetch.mockImplementation(async (url) => reply(url.endsWith("/overview") ? {} :
    url.endsWith("/current") ? { document: null } : { items: [], truncated: false }));
  const onClose = jest.fn();
  jest.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => root.render(<HaccpModule onClose={onClose} />));
  await act(async () => host.querySelector('[data-testid="haccp-tab-sheets"]').click());
  await act(async () => host.querySelector('[data-testid="haccp-sheet-edit-frigo"]').click());
  await change(host.querySelector("textarea"), "À conserver");
  await act(async () => host.querySelector('[data-testid="haccp-tab-trace"]').click());
  expect(host.querySelector('[data-testid="haccp-sheet-editor"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid="haccp-close-btn"]').click());
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => root.render(<HaccpModule onClose={onClose} initialSource={{ kind: "safety" }} />));
  expect(host.querySelector('[data-testid="haccp-sheet-editor"]')).not.toBeNull();
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
});

test("copying original readings restores the source headings and requires saving the editable copy", async () => {
  await act(async () => root.render(<SectionSheets />));
  await act(async () => host.querySelector('[data-testid="haccp-sheet-edit-frigo"]').click());
  await change(host.querySelector('[aria-label="Intitulé colonne 1"]'), "Jour modifié");
  global.fetch.mockImplementation(async (url) => reply({ items: url.endsWith("/equipements")
    ? [{ id: "fridge", nom: "Frigo 1", type: "frigo", min: 0, max: 4 }]
    : [{ equipement_id: "fridge", valeur: 3, created_at: "2026-10-23T08:00:00Z" }] }));
  await act(async () => button("COPIER LES RELEVÉS").click());
  expect(host.querySelector('[aria-label="Intitulé colonne 1"]').value).toBe("Date");
  expect(host.querySelector('textarea[aria-label="Ligne 1, T° relevée (°C)"]').value).toBe("3");
  expect(button("IMPRIMER / PDF").disabled).toBe(true);
  expect(global.fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
});

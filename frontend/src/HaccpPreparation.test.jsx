import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpPreparation from "./HaccpPreparation";
import * as printer from "./HaccpPrinter";
import { printHaccpDocument } from "./haccpDocuments";
import { setLanguage } from "./i18n/domTranslator";

jest.mock("./haccpDocuments", () => ({
  ...jest.requireActual("./haccpDocuments"),
  printHaccpDocument: jest.fn(),
}));
global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch, oldCrypto, oldMediaDevices, getUserMedia;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input,textarea,select");
const reply = (data, ok = true) => ({ ok, status: ok ? 201 : 422, json: async () => data });
const record = {
  id: 8, type_operation: "preparation", nom_produit: "Soupe TEST", numero_lot: "PREP-TEST",
  conforme_reception: true, type_date: "inconnue", dlc_ou_ddm: null, operateur: "Cuisine",
  date_fabrication: "2026-11-02T07:15:00Z", dlc_secondaire: "2026-11-05T07:15:00Z",
  duree_conservation_heures: 72, justification_duree: "PMS test",
  conditions_conservation: "Entre 0 et +3 °C, en bac fermé.", restaurant_name: "Le Papillon",
  chemin_donnees: "haccp.sqlite3#etiquettes_haccp/8", image_url: null, chemin_photo: null,
};
beforeEach(() => {
  oldFetch = global.fetch;
  global.fetch = jest.fn(async () => reply(record));
  oldCrypto = global.crypto;
  global.crypto = { randomUUID: jest.fn(() => "9582f6d4-d5ba-4607-8772-051912e656cb") };
  oldMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  getUserMedia = jest.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  printHaccpDocument.mockClear();
});
afterEach(async () => {
  await act(async () => { await setLanguage("fr"); root.unmount(); });
  host.remove();
  global.fetch = oldFetch;
  global.crypto = oldCrypto;
  localStorage.removeItem("sirius_cuisine_print_device_id");
  if (oldMediaDevices) Object.defineProperty(navigator, "mediaDevices", oldMediaDevices);
  else delete navigator.mediaDevices;
  jest.restoreAllMocks();
});
async function render(props = {}, list = { version: 0, noms: [], duree_heures: null, reference_pms: "" }) {
  const fetch = global.fetch;
  global.fetch = (url, options) => url.includes("/preparations/liste") && options?.method !== "PUT"
    ? Promise.resolve(reply(list)) : fetch(url, options);
  try {
    await act(async () => root.render(<HaccpPreparation establishmentName="Le Papillon" sessionReady {...props} />));
  } finally {
    global.fetch = fetch;
  }
}
async function change(input, value) {
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype
      : input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function complete() {
  await change(field("Nom du produit"), "Soupe TEST");
  await change(field("Date et heure"), "2026-11-02T08:15");
  await change(field("Durée"), "72");
  await change(field("Conditions"), "Entre 0 et +3 °C, en bac fermé.");
  await change(field("Référence"), "PMS test");
  await act(async () => field("Je confirme").click());
}
async function submit() {
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function click(text) {
  await act(async () => button(text).click());
}

test("preparation never starts the camera or guesses morning time, temperature or J+3", async () => {
  await render();
  for (const name of ["Nom du produit", "Date et heure", "Durée", "Conditions", "Référence"]) {
    expect(field(name).value).toBe("");
  }
  expect(button("Calculer la DLC").disabled).toBe(true);
  expect(host.querySelector("video")).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("a QR preparation uses mobile printing only after the user reviews it", async () => {
  global.fetch = jest.fn(async (url) => url.endsWith("/mobile/demandes")
    ? reply({ job: { id: "job", label_id: 8, status: "pending", transport: "mobile" } })
    : reply(record));
  await render({ kitchenToken: "qr-token", mobilePrinting: true });
  await complete();
  await submit();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await click("J’ai vérifié");
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/impression\/mobile\/demandes$/);
  expect(global.fetch.mock.calls[1][1].headers["X-Sirius-Cuisine"]).toBe("qr-token");
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).reviewed).toBe(true);
});

test("the shared list applies its confirmed PMS duration without guessing fabrication time", async () => {
  const list = { version: 1, noms: ["Soupe TEST", "Sauce"], duree_heures: 72, reference_pms: "PMS en vigueur" };
  await render({ kitchenToken: "qr-token" }, list);
  await change(field("Préparation enregistrée"), "Soupe TEST");
  expect(field("Nom du produit").value).toBe("Soupe TEST");
  expect(field("Durée de conservation").value).toBe("72");
  expect(field("Conditions").value).toBe("Voir les conditions du PMS en vigueur");
  expect(field("Référence de la règle").value).toBe("PMS en vigueur");
  expect(field("Date et heure").value).toBe("");
  expect(field("Je confirme").checked).toBe(false);
  expect(button("Calculer la DLC").disabled).toBe(true);

  jest.useFakeTimers(); jest.setSystemTime(new Date("2026-11-02T07:15:00Z"));
  await click("Fabrication maintenant");
  expect(field("Date et heure").value).toBe("2026-11-02T08:15");
  expect(field("Décalage UTC").value).toBe("+01:00");
  await act(async () => field("Je confirme").click());
  await submit();
  const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
  expect(payload).toEqual(expect.objectContaining({
    nom_produit: "Soupe TEST", date_fabrication: "2026-11-02T08:15:00+01:00",
    duree_conservation_heures: 72, justification_duree: "PMS en vigueur", regle_confirmee: true, liste_version: 1,
  }));
  expect(host.textContent).toContain("DLC interne exacte");
});

test("editing a selected product clears its prefilled rule", async () => {
  await render({}, { version: 1, noms: ["Soupe TEST"], duree_heures: 72, reference_pms: "PMS en vigueur" });
  await change(field("Préparation enregistrée"), "Soupe TEST");
  await change(field("Nom du produit"), "Autre produit");
  expect(field("Durée de conservation").value).toBe("");
  expect(field("Conditions").value).toBe("");
  expect(field("Référence de la règle").value).toBe("");
  expect(field("Je confirme").checked).toBe(false);
});

test("a stale shared rule is cleared and reloaded before another preparation", async () => {
  const list = { version: 1, noms: ["Soupe TEST"], duree_heures: 72, reference_pms: "PMS en vigueur" };
  await render({}, list);
  global.fetch.mockResolvedValueOnce({ ...reply({ detail: "La liste des préparations a changé." }, false), status: 412 })
    .mockResolvedValueOnce(reply({ ...list, version: 2, duree_heures: 24 }));
  await change(field("Préparation enregistrée"), "Soupe TEST");
  await change(field("Date et heure"), "2026-11-02T08:15");
  await act(async () => field("Je confirme").click());
  await submit();
  expect(host.textContent).toContain("La liste des préparations a changé.");
  expect(field("Durée de conservation").value).toBe("");
  expect(field("Je confirme").checked).toBe(false);
  await change(field("Préparation enregistrée"), "Soupe TEST");
  expect(field("Durée de conservation").value).toBe("24");
});

test("the QR saves a list with prudent per-product durations only after confirmation", async () => {
  await render({ kitchenToken: "qr-token" });
  const noms = ["Pommes caramel", "Sauce mayonnaise", "Bac inox rumsteak"];
  const regles = {
    "Pommes caramel": { heures: 72, conditions: expect.stringContaining("cuite") },
    "Sauce mayonnaise": { heures: 24, conditions: expect.stringContaining("ANSES") },
    "Bac inox rumsteak": { heures: 48, conditions: expect.stringContaining("Viande") },
  };
  await change(field("Liste des préparations"), noms.join("\n"));
  expect(host.querySelector('[aria-label="Heures de conservation : Sauce mayonnaise"]').value).toBe("24");
  await change(host.querySelector('[aria-label="Heures de conservation : Pommes caramel"]'), "48");
  expect(field("Référence PMS commune").value).toContain("ΣIRIUS");
  await change(field("Référence PMS commune"), "PMS en vigueur");
  expect(button("Enregistrer la liste").disabled).toBe(true);
  await click("Recalculer toutes les durées");
  await act(async () => host.querySelector(".haccp-preparation-list input[type=checkbox]").click());
  global.fetch.mockImplementationOnce(async (url, options) => {
    const sent = JSON.parse(options.body);
    return reply({ version: 1, noms: sent.noms, duree_heures: sent.duree_heures, reference_pms: sent.reference_pms, regles: sent.regles });
  });
  await click("Enregistrer la liste");
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/haccp\/preparations\/liste$/);
  expect(options.method).toBe("PUT");
  expect(options.headers["X-Sirius-Cuisine"]).toBe("qr-token");
  expect(JSON.parse(options.body)).toEqual({
    restaurant_name: "Le Papillon", version: 0, noms, duree_heures: 24,
    reference_pms: "PMS en vigueur", regles, regle_confirmee: true,
  });
  expect(host.textContent).toContain("Liste enregistrée pour tous les téléphones");
  await change(field("Préparation enregistrée"), "Sauce mayonnaise");
  expect(field("Durée de conservation").value).toBe("24");
  expect(field("Conditions").value).toContain("ANSES");
  await change(field("Date et heure"), "2026-11-02T08:15");
  await act(async () => field("Je confirme").click());
  global.fetch.mockResolvedValueOnce(reply(record));
  await submit();
  expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual(expect.objectContaining({
    duree_conservation_heures: 24, liste_version: 1,
  }));
});

test("a conflicting list edit is not silently discarded", async () => {
  const list = { version: 1, noms: ["Soupe"], duree_heures: 72, reference_pms: "PMS en vigueur" };
  await render({}, list);
  global.fetch.mockResolvedValueOnce(reply({ detail: "La liste a changé sur un autre appareil." }, false));
  await change(field("Liste des préparations"), "Soupe\nSauce");
  await act(async () => host.querySelector(".haccp-preparation-list input[type=checkbox]").click());
  await click("Enregistrer la liste");
  expect(host.textContent).toContain("La liste a changé sur un autre appareil.");
  expect(field("Liste des préparations").value).toBe("Soupe\nSauce");
});

test("language changes translate list controls and confirmation without changing product names", async () => {
  await render({}, { version: 1, noms: ["Enregistrer"], duree_heures: 72, reference_pms: "PMS" });
  await act(async () => { await setLanguage("en"); });
  expect(host.querySelector('option[value="Enregistrer"]').textContent).toBe("Enregistrer");
  expect(host.textContent).toContain("Select a preparation");
  await change(host.querySelector(".haccp-preparation-list textarea"), "");
  await act(async () => host.querySelector(".haccp-preparation-list input[type=checkbox]").click());
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  await click("Save the list");
  expect(confirm).toHaveBeenCalledWith("1 preparation(s) will be removed from this list. Continue?");
});

test.each([{ sessionReady: false }, { establishmentName: "" }])("dossier prerequisites gate preparation %p", async (props) => {
  await render(props);
  expect(host.querySelector("fieldset").disabled).toBe(true);
  expect(host.textContent).toContain("Reprendre / Continuer");
  await submit();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("a confirmed preparation sends exact local fabrication and renders the server deadline without printing", async () => {
  await render();
  await complete();
  expect(button("Calculer la DLC").disabled).toBe(false);
  await submit();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/haccp\/preparations$/);
  expect(options.credentials).toBe("include");
  expect(options.headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(options.body)).toEqual({
    nom_produit: "Soupe TEST", numero_lot: null, restaurant_name: "Le Papillon", operateur: "Cuisine",
    date_fabrication: "2026-11-02T08:15", duree_conservation_heures: 72,
    conditions_conservation: record.conditions_conservation, justification_duree: "PMS test",
    regle_confirmee: true, capture_id: "9582f6d4-d5ba-4607-8772-051912e656cb",
  });
  expect(host.textContent).toContain("Fabrication : 02/11/2026 08:15:00");
  expect(host.textContent).toContain("DLC interne exacte : 05/11/2026 08:15:00");
  expect(host.textContent).toContain(record.conditions_conservation);
  expect(host.textContent).toContain("Déclaration archivée");
  expect(host.textContent).not.toContain("Illisible ou absente");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(printHaccpDocument).not.toHaveBeenCalled();
});

test.each([
  ["Nom du produit", "Autre préparation"], ["Date et heure", "2026-11-02T09:00"],
  ["Durée", "24"], ["Conditions", "Autres conditions validées"], ["Référence", "Autre PMS"],
])("editing %s invalidates rule confirmation", async (name, value) => {
  await render();
  await complete();
  await change(field(name), value);
  expect(field("Je confirme").checked).toBe(false);
  expect(button("Calculer la DLC").disabled).toBe(true);
  await submit();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("browser print uses only the saved preparation HTML after explicit action", async () => {
  await render();
  await complete();
  await submit();
  global.fetch.mockResolvedValueOnce({ ok: true, text: async () => "<html>PREPARATION TEST</html>" });
  await click("Imprimer l’étiquette de préparation manuellement");
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/registre\/8\/etiquette$/);
  expect(printHaccpDocument).toHaveBeenCalledWith("<html>PREPARATION TEST</html>", expect.anything(), expect.any(Function));
});

test("direct printing carries the preparation type and waits for human review", async () => {
  const print = jest.spyOn(printer, "printHaccpLabel").mockResolvedValue({ status: "pending", transport: "windows" });
  await render();
  await complete();
  await submit();
  expect(print).not.toHaveBeenCalled();
  await click("J’ai vérifié : valider et imprimer");
  expect(print).toHaveBeenCalledWith(8, "preparation");
});

test("a lost response retries the same UUID and never starts a second submission while pending", async () => {
  let resolve;
  global.fetch.mockRejectedValueOnce(new Error("Connexion perdue"))
    .mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render();
  await complete();
  await submit();
  expect(host.textContent).toContain("Connexion perdue");
  await act(async () => {
    host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(global.crypto.randomUUID).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].body).toBe(global.fetch.mock.calls[1][1].body);
  await act(async () => resolve(reply(record)));
  expect(host.textContent).toContain("Préparation enregistrée");
});

test("changing an uncertain submission cannot silently generate a second label", async () => {
  global.fetch.mockRejectedValueOnce(new Error("Connexion perdue"));
  await render();
  await complete();
  await submit();
  await change(field("Nom du produit"), "Autre produit");
  await act(async () => field("Je confirme").click());
  await submit();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Une tentative existe déjà");
  await click("Nouvelle préparation");
  expect(field("Nom du produit").value).toBe("");
  expect(field("Durée").value).toBe("");
  expect(field("Je confirme").checked).toBe(false);
});

test("validation errors explain ambiguous fabrication times instead of hiding the server detail", async () => {
  global.fetch.mockResolvedValueOnce(reply({ detail: [{ msg: "Value error, Heure ambigue en Europe/Paris." }] }, false));
  await render();
  await complete();
  await submit();
  expect(host.textContent).toContain("Heure ambigue en Europe/Paris.");
  expect(printHaccpDocument).not.toHaveBeenCalled();
});

test("a rejected fabrication can be corrected without losing the product or making an uncertain duplicate", async () => {
  global.fetch.mockResolvedValueOnce(reply({ detail: "La fabrication ne peut pas etre dans le futur." }, false));
  await render();
  await complete();
  await submit();
  await change(field("Date et heure"), "2026-11-02T08:00");
  await act(async () => field("Je confirme").click());
  await submit();
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).date_fabrication).toBe("2026-11-02T08:00");
  expect(host.textContent).toContain("Préparation enregistrée");
});

test("a repeated autumn time carries the selected UTC offset and must be reconfirmed", async () => {
  await render();
  await complete();
  await change(field("Date et heure"), "2026-10-25T02:30");
  await act(async () => {
    const select = field("Décalage UTC");
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "+02:00");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(field("Je confirme").checked).toBe(false);
  await act(async () => field("Je confirme").click());
  await submit();
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).date_fabrication).toBe("2026-10-25T02:30+02:00");
});

test("malformed results never become printable preparations", async () => {
  global.fetch.mockResolvedValueOnce(reply({ id: 8, type_operation: "preparation" }));
  await render();
  await complete();
  await submit();
  expect(host.textContent).toContain("Réponse de préparation invalide");
  expect(button("J’ai vérifié")).toBeUndefined();
  expect(printHaccpDocument).not.toHaveBeenCalled();
});

test("the next product clears its time, duration and conditions instead of reusing a default", async () => {
  await render();
  await complete();
  await submit();
  await click("Nouvelle préparation");
  for (const name of ["Nom du produit", "Date et heure", "Durée", "Conditions", "Référence"]) {
    expect(field(name).value).toBe("");
  }
  expect(field("Je confirme").checked).toBe(false);
  expect(button("Calculer la DLC").disabled).toBe(true);
});

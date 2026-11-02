import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpPreparation from "./HaccpPreparation";
import * as printer from "./HaccpPrinter";
import { printHaccpDocument } from "./haccpDocuments";

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
  await act(async () => root.unmount());
  host.remove();
  global.fetch = oldFetch;
  global.crypto = oldCrypto;
  if (oldMediaDevices) Object.defineProperty(navigator, "mediaDevices", oldMediaDevices);
  else delete navigator.mediaDevices;
  jest.restoreAllMocks();
});
async function render(props = {}) {
  await act(async () => root.render(<HaccpPreparation establishmentName="Le Papillon" sessionReady {...props} />));
}
async function change(input, value) {
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
  expect(host.textContent).toContain("DLC exacte : 05/11/2026 08:15:00");
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

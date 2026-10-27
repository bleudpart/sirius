import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpLabelCapture from "./HaccpLabelCapture";
import HaccpModule from "./HaccpModule";
import { printHaccpDocument } from "./haccpDocuments";

jest.mock("./haccpDocuments", () => ({
  ...jest.requireActual("./haccpDocuments"),
  printHaccpDocument: jest.fn(),
}));
global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, originalFetch, originalCrypto;
const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 422, json: async () => data });
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input,textarea");
const record = {
  id: 8, type_operation: "ouverture", nom_produit: "Saumon", numero_lot: "LOT42",
  type_date: "DLC", dlc_ou_ddm: "2099-12-31", conforme_reception: true,
  date_ouverture: "2026-10-27T12:00:00Z", dlc_secondaire: "2026-10-30T12:00:00Z",
  duree_conservation_heures: 72, justification_duree: "Notice fabricant",
};
beforeEach(() => {
  URL.createObjectURL = jest.fn(() => "blob:test-photo");
  URL.revokeObjectURL = jest.fn();
  originalCrypto = global.crypto;
  global.crypto = { randomUUID: jest.fn(() => "23fd6fd1-9af7-4ab9-854c-46216281c265") };
  originalFetch = global.fetch;
  global.fetch = jest.fn(async () => reply(record));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  printHaccpDocument.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch; global.crypto = originalCrypto; jest.restoreAllMocks();
});
async function change(input, value) {
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choosePhoto() {
  const input = host.querySelector('input[type="file"]');
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "label.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
async function submit() {
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
async function click(text) { await act(async () => button(text).click()); }
async function enableRule() {
  await click("Ouverture produit");
  await act(async () => field("Appliquer").click());
  await change(field("Durée après"), "72");
  await change(field("Justification"), "Notice fabricant");
  await act(async () => field("Je confirme").click());
}

test("capture is connected to the existing traceability section without removing legacy entries", async () => {
  global.fetch.mockResolvedValue(reply({ items: [] }));
  await act(async () => root.render(<HaccpModule />));
  expect(host.querySelector('[aria-label="Capture des étiquettes ΣIRIUS"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="haccp-trace-add"]')).not.toBeNull();
  const shortcut = host.querySelector("a.haccp-capture-link");
  expect(shortcut.href).toBe("https://sirius-assistant.fr/haccp");
  expect(shortcut.target).toBe("_blank");
  expect(shortcut.rel).toBe("noopener noreferrer");
  expect(shortcut.textContent).toBe("Scanner une étiquette");
});

test("reception stays the default and camera formats are explicit", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  const input = host.querySelector('input[type="file"]');
  expect(input.getAttribute("capture")).toBe("environment");
  expect(input.accept).toBe("image/jpeg,image/png,image/webp");
  expect(button("Réception").getAttribute("aria-pressed")).toBe("true");
  expect(button("Scanner étiquette").disabled).toBe(false);
  expect(button("Scanner étiquette").classList.contains("haccp-scan")).toBe(true);
  expect(button("Scanner étiquette").classList.contains("cmd-send")).toBe(false);
  expect(button("Scanner étiquette").querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  await choosePhoto();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/haccp\/etiquettes\/scan$/);
  expect(options.credentials).toBe("include");
  expect(options.headers).toBeUndefined();
  expect(JSON.parse(options.body.get("operation"))).toEqual({ type_operation: "reception" });
});

test("opening without a rule is explicit and never defaults to three days", async () => {
  global.fetch.mockResolvedValue(reply({ ...record, conforme_reception: false, dlc_secondaire: null,
    commentaire_anomalie: "Sans règle", duree_conservation_heures: null }));
  await act(async () => root.render(<HaccpLabelCapture />));
  await click("Ouverture produit");
  expect(host.textContent).toContain("sans DLC secondaire");
  expect(field("Durée après")).toBeUndefined();
  await choosePhoto();
  expect(JSON.parse(global.fetch.mock.calls[0][1].body.get("operation"))).toEqual({ type_operation: "ouverture" });
  expect(button("Imprimer")).toBeUndefined();
  expect(host.textContent).toContain("Vérification requise");
});

test("opening sends only a confirmed rule; printing fetches the saved protected document on demand", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  await enableRule(); await choosePhoto();
  expect(JSON.parse(global.fetch.mock.calls[0][1].body.get("operation"))).toEqual({
    type_operation: "ouverture", duree_conservation_heures: 72,
    justification_duree: "Notice fabricant", regle_confirmee: true,
  });
  expect(printHaccpDocument).not.toHaveBeenCalled();
  expect(host.textContent).toContain("DLC secondaire");
  global.fetch.mockResolvedValueOnce({ ok: true, text: async () => "<html>Étiquette enregistrée</html>" });
  await click("Imprimer");
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/registre\/8\/etiquette$/);
  expect(global.fetch.mock.calls[1][1].credentials).toBe("include");
  expect(printHaccpDocument).toHaveBeenCalledWith("<html>Étiquette enregistrée</html>", expect.anything(), expect.any(Function));
});

test("changing the duration invalidates confirmation and never submits an unconfirmed rule", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  await enableRule();
  await change(field("Durée après"), "12"); await choosePhoto();
  expect(field("Je confirme").checked).toBe(false);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]').textContent).toContain("confirmez");
});

test("scan failure is visible, keeps the photo and never prints or retries automatically", async () => {
  global.fetch.mockResolvedValue(reply({ detail: "Vision indisponible" }, false));
  await act(async () => root.render(<HaccpLabelCapture />));
  await choosePhoto();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Vision indisponible");
  expect(button("Réessayer la même photo").disabled).toBe(false);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(printHaccpDocument).not.toHaveBeenCalled();
});

test("expired label refusal is shown and never passed to the print helper", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  await enableRule(); await choosePhoto();
  global.fetch.mockResolvedValueOnce(reply({ detail: "DLC secondaire dépassée" }, false));
  await click("Imprimer");
  expect(host.querySelector('[role="alert"]').textContent).toContain("DLC secondaire dépassée");
  expect(printHaccpDocument).not.toHaveBeenCalled();
});

test("automatic printing requires review after extraction and uses only the saved label id", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  await enableRule(); await choosePhoto();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  global.fetch.mockResolvedValueOnce(reply({ id: "job1", label_id: 8, status: "pending" }));
  await click("J’ai vérifié : valider et imprimer");
  const [url, options] = global.fetch.mock.calls[1];
  expect(url).toMatch(/\/haccp\/impression\/demandes$/);
  expect(JSON.parse(options.body)).toEqual({ label_id: 8, reviewed: true });
  expect(host.textContent).toContain("En attente du poste Windows");
  expect(printHaccpDocument).not.toHaveBeenCalled();
});

test("retry after lost response reuses capture UUID and shows the original photograph", async () => {
  global.fetch.mockRejectedValueOnce(new Error("Connexion perdue")).mockResolvedValueOnce(reply(record));
  await act(async () => root.render(<HaccpLabelCapture />));
  await choosePhoto();
  const first = global.fetch.mock.calls[0][1].body.get("capture_id");
  expect(host.querySelector('img[alt="Photo originale à relire avant validation"]')).not.toBeNull();
  await submit();
  expect(global.fetch.mock.calls[1][1].body.get("capture_id")).toBe(first);
  expect(first).toMatch(/^[a-f0-9-]{36}$/);
});

test("the next product always requires confirmation again and hides the previous photograph", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  await enableRule(); await choosePhoto();
  expect(host.querySelector("form")).toBeNull();
  await click("Scanner une autre");
  expect(field("Je confirme").checked).toBe(false);
  expect(button("Scanner étiquette").disabled).toBe(true);
  expect(host.querySelector("img")).toBeNull();
});

test("a saved opening resumes review without uploading another photo", async () => {
  await act(async () => root.render(<HaccpLabelCapture savedRecord={record} />));
  expect(host.querySelector("form")).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
  global.fetch.mockResolvedValueOnce(reply({ id: "job1", label_id: 8, status: "pending" }));
  await click("J’ai vérifié : valider et imprimer");
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ label_id: 8, reviewed: true });
});

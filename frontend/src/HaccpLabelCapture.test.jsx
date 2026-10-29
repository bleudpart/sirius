import { act } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Camera, CameraDirection, CameraResultType, CameraSource } from "@capacitor/camera";
import HaccpLabelCapture from "./HaccpLabelCapture";
import HaccpModule from "./HaccpModule";
import { printHaccpDocument } from "./haccpDocuments";

jest.mock("./haccpDocuments", () => ({
  ...jest.requireActual("./haccpDocuments"),
  printHaccpDocument: jest.fn(),
}));
jest.mock("@capacitor/camera", () => ({
  Camera: { getPhoto: jest.fn() },
  CameraDirection: { Rear: "REAR" },
  CameraResultType: { Uri: "uri" },
  CameraSource: { Camera: "CAMERA" },
}));
jest.mock("@capacitor/app", () => ({
  App: { addListener: jest.fn() },
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
  Camera.getPhoto.mockReset();
  App.addListener.mockReset().mockResolvedValue({ remove: jest.fn() });
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

test("Android shortcut keeps the scanner inside the native app, including from the registry or another module tab", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  global.fetch.mockResolvedValue(reply({ items: [] }));
  await act(async () => root.render(<HaccpModule />));
  expect(host.querySelector("a.haccp-capture-link")).toBeNull();
  await click("Registre / Contrôle");
  expect(host.querySelector('[aria-label="Capture des étiquettes ΣIRIUS"]')).toBeNull();
  await act(async () => host.querySelector("button.haccp-capture-link").click());
  expect(host.querySelector('[aria-label="Capture des étiquettes ΣIRIUS"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid="haccp-tab-temp"]').click());
  await act(async () => host.querySelector("button.haccp-capture-link").click());
  expect(host.querySelector('[aria-label="Capture des étiquettes ΣIRIUS"]')).not.toBeNull();
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

function nativeCamera() {
  jest.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
  Camera.getPhoto.mockResolvedValue({ webPath: "capacitor://photo.jpg", format: "jpeg" });
}

test("native scan opens the rear camera directly and uploads the photo without a gallery picker", async () => {
  nativeCamera();
  global.fetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["photo"], { type: "image/jpeg" }) })
    .mockResolvedValueOnce(reply(record));
  await act(async () => root.render(<HaccpLabelCapture />));
  const picker = jest.spyOn(host.querySelector('input[type="file"]'), "click");
  await click("Scanner étiquette");
  expect(Camera.getPhoto).toHaveBeenCalledWith({
    source: CameraSource.Camera, resultType: CameraResultType.Uri, direction: CameraDirection.Rear,
    quality: 90, width: 2400, height: 2400, correctOrientation: true, allowEditing: false, saveToGallery: false,
  });
  expect(picker).not.toHaveBeenCalled();
  const body = global.fetch.mock.calls[1][1].body;
  expect(body.get("file").type).toBe("image/jpeg");
  expect(body.get("file").name).toBe("etiquette.jpeg");
  expect(JSON.parse(body.get("operation"))).toEqual({ type_operation: "reception" });
  expect(body.get("capture_id")).toBeTruthy();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("web scan keeps the file picker and never invokes the native camera", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  const picker = jest.spyOn(host.querySelector('input[type="file"]'), "click").mockImplementation(() => {});
  await click("Scanner étiquette");
  expect(picker).toHaveBeenCalledTimes(1);
  expect(Camera.getPhoto).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each([
  new Error("User cancelled photos app"),
  Object.assign(new Error("Cancelled"), { code: "OS-PLUG-CAMR-0006" }),
])("camera cancellation leaves the form usable and never uploads", async (failure) => {
  nativeCamera();
  Camera.getPhoto.mockRejectedValue(failure);
  await act(async () => root.render(<HaccpLabelCapture />));
  await click("Scanner étiquette");
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("Scanner étiquette").disabled).toBe(false);
});

test("permission errors stay explicit and never fall back to the gallery", async () => {
  nativeCamera();
  Camera.getPhoto.mockRejectedValue(new Error("Camera permission denied"));
  await act(async () => root.render(<HaccpLabelCapture />));
  const picker = jest.spyOn(host.querySelector('input[type="file"]'), "click");
  await click("Scanner étiquette");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Camera permission denied");
  expect(global.fetch).not.toHaveBeenCalled();
  expect(picker).not.toHaveBeenCalled();
});

test("an unreadable captured photo is not uploaded", async () => {
  nativeCamera();
  global.fetch.mockResolvedValueOnce({ ok: false });
  await act(async () => root.render(<HaccpLabelCapture />));
  await click("Scanner étiquette");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]').textContent).toContain("ne peut pas être lue");
});

test("rapid double tap launches only one camera and preserves the opening rule", async () => {
  nativeCamera();
  let resolvePhoto;
  Camera.getPhoto.mockReturnValue(new Promise((resolve) => { resolvePhoto = resolve; }));
  global.fetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["photo"]) })
    .mockResolvedValueOnce(reply(record));
  await act(async () => root.render(<HaccpLabelCapture />));
  await enableRule();
  await act(async () => { button("Scanner étiquette").click(); button("Scanner étiquette").click(); });
  expect(Camera.getPhoto).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => resolvePhoto({ webPath: "capacitor://photo.jpg", format: "jpeg" }));
  expect(JSON.parse(global.fetch.mock.calls[1][1].body.get("operation"))).toEqual({
    type_operation: "ouverture", duree_conservation_heures: 72,
    justification_duree: "Notice fabricant", regle_confirmee: true,
  });
});

test("a server failure retries the same native photo with the same capture id without reopening the camera", async () => {
  nativeCamera();
  global.fetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(["photo"]) })
    .mockResolvedValueOnce(reply({ detail: "Réseau coupé" }, false)).mockResolvedValueOnce(reply(record));
  await act(async () => root.render(<HaccpLabelCapture />));
  await click("Scanner étiquette");
  const first = global.fetch.mock.calls[1][1].body.get("capture_id");
  await click("Réessayer");
  expect(global.fetch.mock.calls[2][1].body.get("capture_id")).toBe(first);
  expect(Camera.getPhoto).toHaveBeenCalledTimes(1);
});

test("restored camera result never submits with lost operator or PMS context", async () => {
  nativeCamera();
  await act(async () => root.render(<HaccpLabelCapture />));
  const callback = App.addListener.mock.calls.find(([name]) => name === "appRestoredResult")[1];
  await act(async () => callback({ pluginId: "Camera", success: true, data: { webPath: "restored.jpg" } }));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Aucune photo restaurée");
});

test("scan result confirms classified photo and SQLite archive without certifying a measured temperature", async () => {
  const archived = {
    ...record, type_operation: "reception", categorie: "Poissons", temperature_conforme: null,
    chemin_photo: "receptions/poissons/compte/2026-10-29_saumon_lot42_unique.png",
    chemin_donnees: "haccp.sqlite3#etiquettes_haccp/8", date_reception: "2026-10-29T10:00:00Z",
  };
  global.fetch.mockResolvedValueOnce(reply(archived));
  await act(async () => root.render(<HaccpLabelCapture />));
  await choosePhoto();
  expect(host.textContent).toContain("Catégorie : Poissons");
  expect(host.textContent).toContain("Photo et métadonnées archivées");
  expect(host.textContent).toContain(archived.chemin_photo);
  expect(host.textContent).toContain(archived.chemin_donnees);
  expect(host.textContent).toContain("Température réelle : non vérifiée");
  expect(host.textContent).toContain("pas sur le téléphone");
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

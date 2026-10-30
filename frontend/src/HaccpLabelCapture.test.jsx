import { act } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import * as haccpPrinter from "./HaccpPrinter";
import HaccpLabelCapture from "./HaccpLabelCapture";
import HaccpModule from "./HaccpModule";
import { printHaccpDocument } from "./haccpDocuments";

jest.mock("./haccpDocuments", () => ({
  ...jest.requireActual("./haccpDocuments"),
  printHaccpDocument: jest.fn(),
}));
global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, originalFetch, originalCrypto, originalMediaDevices, cameraTrack, getUserMedia;
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
  originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  cameraTrack = { stop: jest.fn() };
  getUserMedia = jest.fn().mockResolvedValue({ getTracks: () => [cameraTrack] });
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  originalFetch = global.fetch;
  global.fetch = jest.fn(async () => reply(record));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  printHaccpDocument.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch; global.crypto = originalCrypto; jest.restoreAllMocks();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else delete navigator.mediaDevices;
  jest.useRealTimers();
});
async function change(input, value) {
  await act(async () => {
    const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choosePhoto() {
  const video = host.querySelector("video");
  Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
  const canvas = host.querySelector("canvas");
  const drawImage = jest.fn();
  Object.defineProperty(canvas, "getContext", { configurable: true, value: jest.fn(() => ({ drawImage })) });
  Object.defineProperty(canvas, "toBlob", {
    configurable: true,
    value: (callback) => callback(new Blob(["photo"], { type: "image/jpeg" })),
  });
  await click("Capturer l’étiquette");
  return { canvas, drawImage };
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

test("reception opens the rear live camera and captures full-resolution video without a file picker", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  expect(getUserMedia).toHaveBeenCalledWith({
    video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  const video = host.querySelector("video");
  expect(video.autoplay).toBe(true);
  expect(video.playsInline).toBe(true);
  expect(video.muted).toBe(true);
  expect(host.querySelector('input[type="file"]')).toBeNull();
  expect(button("Réception").getAttribute("aria-pressed")).toBe("true");
  expect(button("Capturer l’étiquette").disabled).toBe(false);
  const { canvas, drawImage } = await choosePhoto();
  expect(canvas.width).toBe(1920);
  expect(canvas.height).toBe(1080);
  expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 1920, 1080);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/haccp\/etiquettes\/scan$/);
  expect(options.credentials).toBe("include");
  expect(options.headers).toBeUndefined();
  expect(options.body.get("file").type).toBe("image/jpeg");
  expect(options.body.get("file").name).toBe("etiquette.jpg");
  expect(JSON.parse(options.body.get("operation"))).toEqual({ type_operation: "reception" });
});

test("camera permission failures stay explicit and can be retried", async () => {
  getUserMedia.mockRejectedValueOnce(new Error("Camera permission denied"));
  await act(async () => root.render(<HaccpLabelCapture />));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Camera permission denied");
  expect(global.fetch).not.toHaveBeenCalled();
  getUserMedia.mockResolvedValueOnce({ getTracks: () => [cameraTrack] });
  await click("Réessayer l’accès caméra");
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button("Capturer l’étiquette").disabled).toBe(false);
});

test("video playback failure releases the camera and can be retried", async () => {
  HTMLMediaElement.prototype.play.mockRejectedValueOnce(new Error("Playback blocked"));
  await act(async () => root.render(<HaccpLabelCapture />));
  expect(cameraTrack.stop).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="alert"]').textContent).toContain("Playback blocked");
  getUserMedia.mockResolvedValueOnce({ getTracks: () => [cameraTrack] });
  await click("Réessayer l’accès caméra");
  expect(getUserMedia).toHaveBeenCalledTimes(2);
  expect(button("Capturer l’étiquette").disabled).toBe(false);
});

test("camera capture failure leaves the live stream available for another attempt", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  const video = host.querySelector("video");
  Object.defineProperty(video, "videoWidth", { configurable: true, value: 0 });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: 0 });
  await click("Capturer l’étiquette");
  expect(host.querySelector('[role="alert"]').textContent).toContain("flux vidéo n’est pas encore prêt");
  expect(global.fetch).not.toHaveBeenCalled();
  expect(button("Capturer l’étiquette").disabled).toBe(false);
});

test("rapid double tap captures once and preserves the opening rule", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  await enableRule();
  const video = host.querySelector("video");
  Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
  const canvas = host.querySelector("canvas");
  const drawImage = jest.fn();
  Object.defineProperty(canvas, "getContext", { configurable: true, value: jest.fn(() => ({ drawImage })) });
  let resolveBlob;
  Object.defineProperty(canvas, "toBlob", {
    configurable: true,
    value: (callback) => { resolveBlob = callback; },
  });
  await act(async () => {
    button("Capturer l’étiquette").click();
    button("Capturer l’étiquette").click();
  });
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => resolveBlob(new Blob(["photo"], { type: "image/jpeg" })));
  expect(JSON.parse(global.fetch.mock.calls[0][1].body.get("operation"))).toEqual({
    type_operation: "ouverture", duree_conservation_heures: 72,
    justification_duree: "Notice fabricant", regle_confirmee: true,
  });
});

test("a server failure retries the same captured image with the same capture id", async () => {
  global.fetch.mockResolvedValueOnce(reply({ detail: "Réseau coupé" }, false))
    .mockResolvedValueOnce(reply(record));
  await act(async () => root.render(<HaccpLabelCapture />));
  await choosePhoto();
  const first = global.fetch.mock.calls[0][1].body.get("capture_id");
  await click("Réessayer la même photo sans doublon");
  expect(global.fetch.mock.calls[1][1].body.get("capture_id")).toBe(first);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

test("camera tracks stop when the capture component unmounts", async () => {
  await act(async () => root.render(<HaccpLabelCapture />));
  expect(host.querySelector("video").srcObject).not.toBeNull();
  await act(async () => root.unmount());
  expect(cameraTrack.stop).toHaveBeenCalledTimes(1);
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

test("simplified kitchen scan archives first and requires an explicit review before printing", async () => {
  await act(async () => root.render(<HaccpLabelCapture kitchenMode />));
  expect(host.querySelector(".haccp-kitchen-scan")).not.toBeNull();
  await choosePhoto();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/etiquettes\/scan$/);
  expect(host.textContent).toContain("Saumon · Lot LOT42");
  expect(host.textContent).toContain("J’ai vérifié le produit, le lot et la DLC — imprimer");
  expect(host.querySelector(".haccp-kitchen-print")).not.toBeNull();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("kitchen mode shows temporary accepted-print feedback and resets without reloading", async () => {
  jest.useFakeTimers();
  const print = jest.spyOn(haccpPrinter, "printHaccpOpening").mockResolvedValue({
    status: "accepted", transport: "windows", detail: "Transmis à Windows",
  });
  await act(async () => root.render(<HaccpLabelCapture kitchenMode />));
  await enableRule();
  global.fetch.mockResolvedValueOnce(reply({ ...record, type_operation: "ouverture" }));
  await choosePhoto();
  expect(print).not.toHaveBeenCalled();
  await click("J’ai vérifié le produit, le lot et la DLC");
  expect(print).toHaveBeenCalledWith(record.id);
  expect(host.querySelector(".haccp-print-success").textContent).toContain("Demande d’impression envoyée");
  expect(host.querySelector(".haccp-print-success").textContent).toContain("vérifiez la sortie papier");
  await act(async () => { jest.advanceTimersByTime(1500); });
  expect(host.querySelector(".haccp-print-success")).toBeNull();
  expect(button("Capturer l’étiquette")).not.toBeNull();
  jest.useRealTimers();
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
  expect(button("Capturer l’étiquette").disabled).toBe(true);
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
  expect(host.querySelector("form")).not.toBeNull();
  expect(button("Capturer l’étiquette").disabled).toBe(true);
  await click("Scanner une autre");
  expect(field("Je confirme").checked).toBe(false);
  expect(button("Capturer l’étiquette").disabled).toBe(true);
  await act(async () => field("Je confirme").click());
  expect(button("Capturer l’étiquette").disabled).toBe(false);
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

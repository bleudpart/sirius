import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpDlcSnap from "./HaccpDlcSnap";
import { compressPhoto, fitWithin } from "./haccpPhotoCompress";

jest.mock("./haccpPhotoCompress", () => ({
  ...jest.requireActual("./haccpPhotoCompress"),
  compressPhoto: jest.fn(),
}));
global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, originalFetch, originalCrypto;
const jpeg = new Blob(["jpeg"], { type: "image/jpeg" });
const saved = { id: 4, created_at: "2026-11-14T09:05:07Z" };

beforeEach(() => {
  URL.createObjectURL = jest.fn(() => "blob:dlc");
  URL.revokeObjectURL = jest.fn();
  originalCrypto = global.crypto;
  global.crypto = { randomUUID: jest.fn(() => "23fd6fd1-9af7-4ab9-854c-46216281c265") };
  originalFetch = global.fetch;
  compressPhoto.mockResolvedValue(jpeg);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch; global.crypto = originalCrypto;
});

async function shoot() {
  const input = host.querySelector("[data-testid=dlc-snap-input]");
  const photo = new File(["raw"], "IMG_0001.HEIC.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { configurable: true, value: [photo] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  return photo;
}
const click = (id) => act(async () => host.querySelector(`[data-testid=${id}]`).click());

test("ouvre l'appareil photo arrière, compresse puis envoie au nom du compte connecté", async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 201, json: async () => saved }));
  const onCaptureSaved = jest.fn();
  await act(async () => root.render(<HaccpDlcSnap establishmentName="Le Papillon" onCaptureSaved={onCaptureSaved} />));
  const input = host.querySelector("[data-testid=dlc-snap-input]");
  expect(input.getAttribute("accept")).toBe("image/*");
  expect(input.getAttribute("capture")).toBe("environment");

  const photo = await shoot();
  expect(compressPhoto).toHaveBeenCalledWith(photo);
  expect(host.querySelector("img").getAttribute("src")).toBe("blob:dlc");
  await click("dlc-snap-send");

  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/haccp\/etiquettes\/scan$/);
  expect(options.method).toBe("POST");
  const body = options.body;
  expect(body.get("file").type).toBe("image/jpeg");
  expect(body.get("file").name).toBe("etiquette.jpg");
  expect(body.get("restaurant_name")).toBe("Le Papillon");
  expect(JSON.parse(body.get("operation"))).toEqual({ type_operation: "reception" });
  expect(body.get("capture_id")).toBe("23fd6fd1-9af7-4ab9-854c-46216281c265");
  expect(body.get("operateur_compte")).toBe("true");
  expect(host.querySelector("time").getAttribute("dateTime")).toBe(saved.created_at);
  expect(onCaptureSaved).toHaveBeenCalledWith(saved);
});

test("un échec garde la photo et renvoie la même capture pour éviter les doublons", async () => {
  global.fetch = jest.fn()
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce({ ok: true, status: 201, json: async () => saved });
  await act(async () => root.render(<HaccpDlcSnap establishmentName="Le Papillon" kitchenToken="qr" />));
  await shoot();
  await click("dlc-snap-send");
  expect(host.querySelector("[data-step=retry] img")).not.toBeNull();
  await click("dlc-snap-send");
  const ids = global.fetch.mock.calls.map(([, options]) => options.body.get("capture_id"));
  expect(ids[0]).toBe(ids[1]);
  expect(global.fetch.mock.calls[1][1].headers).toEqual({ "X-Sirius-Cuisine": "qr" });
  expect(global.fetch.mock.calls[1][1].body.get("operateur_compte")).toBeNull();
  expect(host.querySelector("[data-testid=dlc-snap-done]")).not.toBeNull();
});

test("une photo illisible affiche la croix rouge puis permet de recommencer", async () => {
  compressPhoto.mockRejectedValueOnce(new Error("Image illisible."));
  await act(async () => root.render(<HaccpDlcSnap establishmentName="Le Papillon" />));
  await shoot();
  await click("dlc-snap-error");
  expect(host.querySelector("[data-testid=dlc-snap-camera]")).not.toBeNull();
});

test("réduit le plus grand côté à 1200 px sans agrandir les petites photos", () => {
  expect(fitWithin(4032, 3024)).toEqual({ width: 1200, height: 900 });
  expect(fitWithin(3024, 4032)).toEqual({ width: 900, height: 1200 });
  expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
});

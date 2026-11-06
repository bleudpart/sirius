import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpKitchen from "./HaccpKitchen";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch, oldCrypto;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text) || item.getAttribute("aria-label") === text);
const reply = (value, ok = true, status = ok ? 200 : 500) => ({
  ok, status, json: async () => value,
  headers: { get: () => "image/jpeg" }, blob: async () => new Blob(["x"], { type: "image/jpeg" }),
});
async function pickPhoto() {
  const input = host.querySelector('[data-testid="photo-fichier"]');
  const file = new File(["img"], "etiquette.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
beforeEach(() => {
  oldFetch = global.fetch;
  oldCrypto = global.crypto;
  delete navigator.mediaDevices;
  global.crypto = { randomUUID: jest.fn()
    .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
    .mockReturnValue("22222222-2222-4222-8222-222222222222") };
  URL.createObjectURL = jest.fn(() => "blob:photo"); URL.revokeObjectURL = jest.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; global.crypto = oldCrypto; jest.restoreAllMocks();
});

test("a photo is analysed and saved at once, without operator, rule or confirmation", async () => {
  const onSaved = jest.fn();
  global.fetch = jest.fn(async () => reply({ id: 4, nom_produit: "Saumon", conforme_reception: true, type_date: "DLC", dlc_ou_ddm: "12/11/2026" }));
  await act(async () => root.render(<HaccpKitchen establishmentName="Le Papillon" onCaptureSaved={onSaved} />));
  expect(host.querySelectorAll("input:not([type=file])")).toHaveLength(0);
  await pickPhoto();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/haccp\/etiquettes\/scan$/);
  expect(options.method).toBe("POST");
  expect(options.body.get("operateur")).toBe("Cuisine");
  expect(options.body.get("restaurant_name")).toBe("Le Papillon");
  expect(JSON.parse(options.body.get("operation"))).toEqual({ type_operation: "reception" });
  expect(host.textContent).toContain("Enregistré");
  expect(host.textContent).toContain("Saumon");
  expect(host.textContent).toContain("12/11/2026");
  expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
  expect(button("PHOTO").disabled).toBe(false);
});

test("an anomaly is saved and shown in orange with a single clear instruction", async () => {
  global.fetch = jest.fn(async () => reply({ id: 5, nom_produit: "Crème", conforme_reception: false }));
  await act(async () => root.render(<HaccpKitchen establishmentName="Le Papillon" />));
  await pickPhoto();
  expect(host.querySelector(".haccp-simple-result.is-warning")).not.toBeNull();
  expect(host.textContent).toContain("appeler le chef");
});

test("a failed upload can be resent with the same capture id, so no duplicate is created", async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce(reply({ detail: "Réseau coupé" }, false))
    .mockResolvedValueOnce(reply({ id: 6, nom_produit: "Beurre", conforme_reception: true }));
  await act(async () => root.render(<HaccpKitchen establishmentName="Le Papillon" />));
  await pickPhoto();
  expect(host.textContent).toContain("Pas enregistré");
  await act(async () => button("Encore").click());
  const ids = global.fetch.mock.calls.map(([, options]) => options.body.get("capture_id"));
  expect(ids[0]).toBe(ids[1]);
  expect(host.textContent).toContain("Beurre");
});

test("find lists recent products and opens the product photo", async () => {
  global.fetch = jest.fn(async (url) => url.includes("/recherche")
    ? reply([{ id: 7, nom_produit: "Poulet", numero_lot: "L7", conforme_reception: true, type_operation: "reception", date_reception: "2026-11-06T09:00:00Z" }])
    : reply(null));
  await act(async () => root.render(<HaccpKitchen establishmentName="Le Papillon" />));
  await act(async () => button("RETROUVER").click());
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/registre\/recherche\?date_debut=\d{4}-\d{2}-\d{2}$/);
  expect(host.textContent).toContain("Poulet");
  await act(async () => button("Poulet").click());
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/registre\/7\/photo$/);
  expect(host.querySelector('[role="dialog"] img').getAttribute("src")).toBe("blob:photo");
  await act(async () => button("PHOTO").click());
  expect(host.querySelector(".haccp-simple-shoot")).not.toBeNull();
});

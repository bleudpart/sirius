import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpKitchen, { dayLabel, kitchenReason } from "./HaccpKitchen";

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

test("the warning says why in a few words", async () => {
  global.fetch = jest.fn(async () => reply({
    id: 9, nom_produit: "Crème", conforme_reception: false, type_date: "DLC", dlc_ou_ddm: "2026-11-01",
    commentaire_anomalie: "DLC depassee a la reception.",
  }));
  await act(async () => root.render(<HaccpKitchen establishmentName="Le Papillon" />));
  await pickPhoto();
  expect(host.querySelector(".haccp-simple-result .haccp-simple-reason").textContent).toBe("DLC dépassée");
});

test("kitchenReason keeps the most important reason short", () => {
  const base = { conforme_reception: false, type_operation: "reception", type_date: "DLC", dlc_ou_ddm: "2026-11-20" };
  expect(kitchenReason({ ...base, conforme_reception: true })).toBe("");
  expect(kitchenReason({ ...base, numero_lot: "ILLISIBLE" })).toBe("Produit ou lot illisible");
  expect(kitchenReason({ ...base, type_date: "inconnue" })).toBe("Date pas lue");
  expect(kitchenReason({ ...base, champs_incertains: ["numero_lot", "allergenes", "traces_allergenes"] })).toBe("Mal lu : lot, allergènes");
  expect(kitchenReason({ ...base, allergenes_lecture: "partielle" })).toBe("Allergènes à vérifier");
  expect(kitchenReason(base)).toBe("À vérifier");
});

test("the list shows the reason under a product to check", async () => {
  global.fetch = jest.fn(async (url) => url.includes("/recherche")
    ? reply([{ id: 10, nom_produit: "Jambon", numero_lot: "L10", conforme_reception: false, type_operation: "reception",
      type_date: "inconnue", date_reception: "2026-11-06T09:00:00Z" }])
    : reply(null));
  await act(async () => root.render(<HaccpKitchen establishmentName="Le Papillon" />));
  await act(async () => button("RETROUVER").click());
  expect(host.querySelector(".haccp-simple-list .haccp-simple-reason").textContent).toBe("Date pas lue");
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
  expect(host.querySelector(".haccp-simple-list")).toBeNull();
  await act(async () => button("LISTE").click());
  expect(host.textContent).toContain("Poulet");
  await act(async () => button("PHOTO").click());
  expect(host.querySelector(".haccp-simple-shoot")).not.toBeNull();
});

test("typing searches by itself, without pressing a button", async () => {
  jest.useFakeTimers();
  try {
    global.fetch = jest.fn(async () => reply([]));
    await act(async () => root.render(<HaccpKitchen establishmentName="Le Papillon" />));
    await act(async () => button("RETROUVER").click());
    const input = host.querySelector('input[aria-label="Produit ou lot"]');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    await act(async () => { setValue.call(input, "sau"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { setValue.call(input, "saumon"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(400); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[1][0]).toMatch(/\/registre\/recherche\?terme=saumon$/);
    expect(host.textContent).toContain("Rien trouvé pour « saumon »");
  } finally {
    jest.useRealTimers();
  }
});

test("dayLabel groups records as today, yesterday or a named day", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  expect(dayLabel("2026-11-10T06:00:00Z", now)).toBe("Aujourd'hui");
  expect(dayLabel("2026-11-09T20:00:00Z", now)).toBe("Hier");
  expect(dayLabel("2026-11-06T09:00:00Z", now)).toBe("Vendredi 6 novembre");
  expect(dayLabel(null, now)).toBe("Sans date");
});

test("a kitchen token is sent on scan, search and photo requests", async () => {
  global.fetch = jest.fn(async (url) => url.includes("/recherche")
    ? reply([{ id: 8, nom_produit: "Thon", conforme_reception: true, type_operation: "reception" }])
    : reply({ id: 8, nom_produit: "Thon", conforme_reception: true }));
  await act(async () => root.render(<HaccpKitchen kitchenToken="jeton-cuisine-0123456789" establishmentName="Le Papillon" />));
  await pickPhoto();
  await act(async () => button("RETROUVER").click());
  await act(async () => button("Thon").click());
  expect(global.fetch).toHaveBeenCalledTimes(3);
  for (const [, options] of global.fetch.mock.calls) {
    expect(options.headers).toEqual({ "X-Sirius-Cuisine": "jeton-cuisine-0123456789" });
  }
});

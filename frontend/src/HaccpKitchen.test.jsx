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
  expect(host.querySelector(".haccp-simple-result .haccp-simple-reason").textContent).toBe("Date à vérifier");
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
  expect(kitchenReason({ ...base, type_date: "inconnue" })).toBe("Date à vérifier");
  expect(kitchenReason({ ...base, dlc_ou_ddm: null })).toBe("Date à vérifier");
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
  expect(host.querySelector(".haccp-simple-list .haccp-simple-reason").textContent).toBe("Date à vérifier");
  await act(async () => button("Jambon").click());
  expect(host.querySelector('[role="dialog"] .haccp-simple-reason').textContent).toContain("Date à vérifier");
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

const TOKEN_HEADER = { "X-Sirius-Cuisine": "jeton-cuisine-0123456789" };
const opened = {
  id: 9, type_operation: "ouverture", nom_produit: "Crème", numero_lot: "L9", conforme_reception: true,
  type_date: "DLC", dlc_ou_ddm: "2099-12-31", date_ouverture: "2026-11-02T10:00:00Z",
  dlc_secondaire: "2026-11-05T10:00:00Z", duree_conservation_heures: 72, justification_duree: "Notice fabricant",
};

test("OUVERTURE creates an opening label with the QR token and prints through the restaurant PC", async () => {
  navigator.mediaDevices = { getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop: jest.fn() }] }) };
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  global.fetch = jest.fn(async (url) => url.endsWith("/impression/demandes")
    ? reply({ id: "j1", label_id: 9, status: "pending", transport: "windows" })
    : reply(opened));
  await act(async () => root.render(<HaccpKitchen kitchenToken="jeton-cuisine-0123456789" establishmentName="Le Papillon" />));
  await act(async () => button("OUVERTURE").click());
  expect(host.textContent).toContain("Cuisine · Ouverture d’un produit");
  expect(button("Réception")).toBeUndefined();
  expect([...host.querySelectorAll("label")].some((label) => label.textContent.startsWith("Opérateur"))).toBe(false);
  expect(host.querySelectorAll('input:not([type=file]),textarea')).toHaveLength(0);
  expect(host.textContent).toContain("calcule la DLC automatiquement");
  const video = host.querySelector("video");
  Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
  const canvas = host.querySelector("canvas.haccp-capture-canvas");
  Object.defineProperty(canvas, "getContext", { configurable: true, value: () => ({ drawImage: jest.fn() }) });
  Object.defineProperty(canvas, "toBlob", { configurable: true, value: (done) => done(new Blob(["p"], { type: "image/jpeg" })) });
  await act(async () => button("Capturer l’étiquette").click());
  const [scanUrl, scan] = global.fetch.mock.calls[0];
  expect(scanUrl).toMatch(/\/etiquettes\/scan$/);
  expect(scan.headers).toEqual(TOKEN_HEADER);
  expect(JSON.parse(scan.body.get("operation"))).toEqual({ type_operation: "ouverture" });
  expect(scan.body.get("ouverture_automatique")).toBe("true");
  await act(async () => button("J’ai vérifié le produit, le lot et la DLC").click());
  const [printUrl, print] = global.fetch.mock.calls[1];
  expect(printUrl).toMatch(/\/haccp\/impression\/demandes$/);
  expect(print.headers).toEqual({ "Content-Type": "application/json", ...TOKEN_HEADER });
  expect(JSON.parse(print.body)).toEqual({ label_id: 9, reviewed: true });
  expect(host.textContent).toContain("En attente du poste Windows");
});

test("PRÉPARATION saves the preparation with the QR token and without an operator field", async () => {
  global.fetch = jest.fn(async () => reply({
    id: 10, type_operation: "preparation", nom_produit: "Soupe", numero_lot: "PREP-1", conforme_reception: true,
    date_fabrication: "2026-11-02T07:15:00Z", dlc_secondaire: "2026-11-05T07:15:00Z",
    conditions_conservation: "0 à 3 °C", duree_conservation_heures: 72, justification_duree: "PMS",
  }));
  await act(async () => root.render(<HaccpKitchen kitchenToken="jeton-cuisine-0123456789" establishmentName="Le Papillon" />));
  await act(async () => button("PRÉPARATION").click());
  expect(host.querySelector('section[aria-label="Étiquette de préparation"]')).not.toBeNull();
  expect([...host.querySelectorAll("label")].some((label) => label.textContent.startsWith("Opérateur"))).toBe(false);
  expect(host.textContent).not.toContain("Configurer l’imprimante");
  const field = (text) => [...host.querySelectorAll("label")].find((label) => label.textContent.trim().startsWith(text))?.querySelector("input,textarea");
  const type = async (input, value) => act(async () => {
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await type(field("Nom du produit"), "Soupe");
  await type(field("Date et heure"), "2026-11-02T08:15");
  await type(field("Durée"), "72");
  await type(field("Conditions"), "0 à 3 °C");
  await type(field("Référence"), "PMS");
  await act(async () => field("Je confirme").click());
  await act(async () => button("Calculer la DLC").click());
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/haccp\/preparations$/);
  expect(options.headers).toEqual({ "Content-Type": "application/json", ...TOKEN_HEADER });
  expect(host.textContent).toContain("J’ai vérifié");
  await act(async () => button("PHOTO").click());
  expect(button("OUVERTURE")).not.toBeUndefined();
});

test("invoice photo is archived with visible products and lots, then retrieved without account", async () => {
  const document = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type_document: "facture", restaurant_name: "Le Papillon",
    reference: "F-1", fournisseur: "Fournisseur TEST", created_at: "2026-11-13T18:00:00Z",
    lignes: [{ produit: "Crème", lot: "L1", categorie: "Produits Laitiers" },
      { produit: "Lait", lot: null, categorie: "Produits Laitiers" },
      { produit: "Boeuf", lot: "B1", categorie: "Viandes" },
      { produit: "Riz", lot: "R1", categorie: "Épicerie" },
      { produit: "Article ambigu", lot: null, categorie: "Non classé" }],
    incertitudes: ["Lot du lait absent"],
  };
  const onSaved = jest.fn();
  global.fetch = jest.fn(async (url) => url.includes("?") ? reply([document]) : reply(document));
  await act(async () => root.render(<HaccpKitchen kitchenToken="jeton-cuisine-0123456789"
    establishmentName="Le Papillon" onCaptureSaved={onSaved} />));
  await act(async () => button("Facture / Bon").click());
  await pickPhoto();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/receptions\/documents$/);
  expect(options.headers).toEqual(TOKEN_HEADER);
  expect(options.body.get("restaurant_name")).toBe("Le Papillon");
  expect(host.textContent).toContain("Document archivé dans le dossier");
  expect(host.textContent).toContain("Crème");
  expect(host.textContent).toContain("Absent ou illisible");
  expect([...host.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual([
    "Boucherie / Charcuterie", "Crémerie", "Épicerie", "Non classé",
  ]);
  expect(onSaved).not.toHaveBeenCalled();
  await act(async () => button("DOCUMENTS REÇUS").click());
  expect(global.fetch.mock.calls[1][0]).toContain("/receptions/documents?restaurant_name=Le+Papillon");
  expect(host.textContent).toContain("Facture · F-1");
  await act(async () => button("Facture · F-1").click());
  expect(global.fetch.mock.calls[2][0]).toMatch(/\/receptions\/documents\/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\/photo$/);
  expect(host.textContent).toContain("Lot du lait absent");
  expect(host.querySelector("img").src).toContain("blob:photo");
});

test("a timed-out document upload retries the same photo and capture ID, not the label scanner", async () => {
  global.fetch = jest.fn().mockRejectedValueOnce(new Error("Connexion coupée"))
    .mockResolvedValue(reply({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type_document: "bon_livraison",
      restaurant_name: "Le Papillon", lignes: [], incertitudes: ["Lecture partielle"],
    }));
  await act(async () => root.render(<HaccpKitchen kitchenToken="jeton-cuisine-0123456789" establishmentName="Le Papillon" />));
  await act(async () => button("Facture / Bon").click());
  await pickPhoto();
  await act(async () => button("Étiquette produit").click());
  await act(async () => button("Encore").click());
  expect(global.fetch.mock.calls[0][0]).toBe(global.fetch.mock.calls[1][0]);
  expect(global.fetch.mock.calls[0][1].body.get("capture_id")).toBe(global.fetch.mock.calls[1][1].body.get("capture_id"));
  expect(host.textContent).toContain("Document archivé");
});

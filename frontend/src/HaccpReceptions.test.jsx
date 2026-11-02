import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpReceptions, { HaccpDeconditionnement } from "./HaccpReceptions";
import HaccpReceptionStatus from "./HaccpReceptionStatus";
import * as documents from "./haccpDocuments";
import * as printer from "./HaccpPrinter";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch, oldCrypto, oldMediaDevices, getUserMedia;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input,textarea,select");
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
function distribution(id = 7, overrides = {}) {
  const destinations = ["traceabilite", "stock", "allergenes", "achats"].map((destination) => ({
    destination, statut: overrides[destination] || "done",
    tentatives: overrides[destination] === "pending" ? 0 : 1,
    erreur: overrides[destination] === "error" ? "Écriture indisponible" : null,
  }));
  return {
    reception_id: id, destinations, controle_physique_effectue: false,
    statut: destinations.every((item) => item.statut === "done") ? "complete"
      : destinations.every((item) => item.statut === "pending") ? "pending" : "partial",
  };
}
const source = {
  id: 7, reception_source_id: 7, type_operation: "reception", restaurant_name: "Le Papillon",
  nom_produit: "TEST <script>viande</script>", numero_lot: "LOT42", conforme_reception: true,
  type_date: "DLC", dlc_ou_ddm: "2099-12-31", date_reception: "2099-12-01T08:00:00Z",
  fournisseur_ou_marque: "Fournisseur TEST", agrement_sanitaire: "FR 75.111.001 CE",
  origines: { naissance: "France", elevage: ["France"], abattage: "France", decoupe: "Belgique" },
  poids_net: { valeur: "3.50025", unite: "kg" }, temperature_stockage: "0 à +3 °C (TEST)",
  allergenes: ["Moutarde"], traces_allergenes: ["Lait"], mentions_traces: "Peut contenir du lait.",
  allergenes_lecture: "complete", champs_incertains: [],
  chemin_image_brute: "receptions/scope/capture/REC_TEST_DATE_LOT42.png",
  empreinte_image_brute: "a".repeat(64), distribution: distribution(),
};
const opened = {
  ...source, id: 8, type_operation: "ouverture", distribution: null,
  date_ouverture: "2099-12-01T08:15:00Z", dlc_secondaire: "2099-12-04T08:15:00Z",
  duree_conservation_heures: 72, justification_duree: "PMS TEST : entre 0 et +3 C", regle_confirmee: true,
};
const page = (items = [source], extra = {}) => ({ items, total: items.length, offset: 0, limit: 25, ...extra });
const report = (extra = {}) => ({
  ok: true, erreurs: [], total: 1, offset: 0, verifiees: 1, prochain_offset: null,
  derniere_empreinte: "b".repeat(64), ...extra,
});
beforeEach(() => {
  oldFetch = global.fetch;
  global.fetch = jest.fn(async () => reply(page()));
  oldCrypto = global.crypto;
  global.crypto = { randomUUID: jest.fn(() => "9582f6d4-d5ba-4607-8772-051912e656cb") };
  oldMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  getUserMedia = jest.fn();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
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
const render = (element) => act(async () => root.render(element));
const click = (text) => act(async () => button(text).click());
const submit = () => act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
async function change(input, value) {
  await act(async () => {
    const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype
      : input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function confirmOpening() {
  await change(field("Référence fabricant"), "PMS TEST : entre 0 et +3 C");
  await act(async () => field("Je viens").click());
}

test("the receipt view uses the active establishment and reads all four destinations without a camera", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/receptions\?offset=0&limit=25&restaurant_name=Le\+Papillon$/);
  expect(global.fetch.mock.calls[0][1].credentials).toBe("include");
  expect(field("Destination").options).toHaveLength(5);
  expect(host.textContent).toContain("Quatre destinations enregistrées");
  expect(host.querySelector("script")).toBeNull();
  expect(getUserMedia).not.toHaveBeenCalled();
});

test("changing destination never renders the previous rows with the next schema", async () => {
  const base = { reception_id: 7, product: source.nom_produit, supplier: source.fournisseur_ou_marque, lot: source.numero_lot };
  const cases = [
    ["traceabilite", { ...base, document: { etiquette: source }, entry_hash: "b".repeat(64), sequence: 1 }, "Preuve source et empreinte"],
    ["stock", { ...base, date_type: "DLC", deadline: source.dlc_ou_ddm, declared_weight_kg: "3.50025" }, "Quantité reçue à confirmer"],
    ["allergenes", { ...base, allergens: ["Moutarde"], traces: [], new_allergens: ["Moutarde"], new_traces: [], review_required: true }, "Nouveaux allergènes présents"],
    ["achats", { ...base, net_weight: source.poids_net }, "À rapprocher du BL et de la facture"],
    ["receptions", source, "Quatre destinations enregistrées"],
  ];
  await render(<HaccpReceptions />);
  await click("Vérifier / déconditionner");
  for (const [destination, item, expected] of cases) {
    let resolve;
    global.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await change(field("Destination"), destination);
    expect(host.querySelector(".haccp-records")).toBeNull();
    expect(host.querySelector(".haccp-reception-detail")).toBeNull();
    await act(async () => resolve(reply(page([item], { destination }))));
    expect(host.querySelector(".haccp-records").textContent).toContain(expected);
    expect(getUserMedia).not.toHaveBeenCalled();
  }
});

test("receipt details separate origins, declared weight, presences and traces", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  await click("Vérifier / déconditionner");
  expect(document.activeElement).toBe(button("Fermer la réception"));
  expect(host.textContent).toContain("Belgique");
  expect(host.textContent).toContain("3.50025 kg");
  expect(host.textContent).toContain("Allergènes présents détectés : Moutarde");
  expect(host.textContent).toContain("Traces possibles : Lait");
  expect(host.textContent).toContain("aucune absence d’allergène n’est certifiée");
  expect(host.textContent).toContain("Distribution technique effectuée (4/4)");
  expect(getUserMedia).not.toHaveBeenCalled();
});

test("partial distribution is explicit and retry is idempotent even on double click", async () => {
  await render(<HaccpReceptionStatus record={{ ...source, distribution: distribution(7, { stock: "error" }) }} />);
  expect(host.textContent).toContain("Distribution incomplète");
  expect(host.textContent).toContain("Écriture indisponible");
  let resolve;
  global.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => { button("Reprendre sans doublon").click(); button("Reprendre sans doublon").click(); });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/receptions\/7\/reprise$/);
  expect(global.fetch.mock.calls[0][1].method).toBe("POST");
  await act(async () => resolve(reply(distribution())));
  expect(host.textContent).toContain("Distribution technique effectuée (4/4)");
  expect(button("Reprendre sans doublon")).toBeUndefined();
});

test.each(["Reprendre sans doublon", "Actualiser la distribution"])("%s updates the list without losing an opening draft", async (action) => {
  global.fetch.mockResolvedValueOnce(reply(page([{ ...source, distribution: distribution(7, { stock: "error" }) }])));
  await render(<HaccpReceptions />);
  await click("Vérifier / déconditionner");
  await change(field("Durée après ouverture"), "24");
  await change(field("Référence fabricant"), "PMS TEST en cours");
  global.fetch.mockResolvedValueOnce(reply(distribution()));
  await click(action);
  expect(host.querySelector(".haccp-records").textContent).toContain("Quatre destinations enregistrées");
  expect(host.querySelector(".haccp-records").textContent).not.toContain("Distribution à vérifier");
  expect(field("Durée après ouverture").value).toBe("24");
  expect(field("Référence fabricant").value).toBe("PMS TEST en cours");
  await click("Fermer la réception");
  expect(document.activeElement).toBe(button("Vérifier / déconditionner"));
  await click("Vérifier / déconditionner");
  expect(host.textContent).toContain("Distribution technique effectuée (4/4)");
  expect(button("Reprendre sans doublon")).toBeUndefined();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("new supplier allergens are prominent immediately after capture even when distribution succeeded", async () => {
  await render(<HaccpReceptionStatus record={{ ...source, distribution: {
    ...distribution(), observation_allergenes: {
      lecture: "complete", verification_requise: true, reference_reception_id: 6,
      nouveaux_allergenes: ["Moutarde"], nouvelles_traces: ["Lait"],
    },
  } }} />);
  expect(host.textContent).toContain("Distribution technique effectuée (4/4)");
  const alert = host.querySelector('[role="alert"]');
  expect(alert.textContent).toContain("Nouveaux allergènes présents : Moutarde");
  expect(alert.textContent).toContain("Nouvelles traces possibles : Lait");
});

test.each([
  { ...distribution(), destinations: [] },
  { ...distribution(7, { stock: "error" }), statut: "complete" },
  { ...distribution(), reception_id: 99 },
  { ...distribution(), destinations: [...distribution().destinations.slice(1), distribution().destinations[1]] },
])("malformed states never claim four successful destinations %#", async (invalid) => {
  await render(<HaccpReceptionStatus record={{ ...source, distribution: invalid }} />);
  expect(host.textContent).toMatch(/invalide|incohérent/);
  expect(host.textContent).not.toContain("Distribution technique effectuée");
  expect(button("Reprendre sans doublon")).toBeUndefined();
});

test("a late initial state cannot overwrite a more recent refresh", async () => {
  let resolve;
  global.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockResolvedValueOnce(reply(distribution()));
  await render(<HaccpReceptionStatus record={{ ...source, distribution: null }} />);
  await click("Actualiser la distribution");
  await act(async () => resolve(reply(distribution(7, { stock: "pending" }))));
  expect(host.textContent).toContain("Distribution technique effectuée (4/4)");
});

test("original downloads use the configured API, not an arbitrary returned URL", async () => {
  const download = jest.spyOn(documents, "downloadHaccpBlob").mockImplementation(() => {});
  const blob = new Blob(["original"], { type: "image/png" });
  global.fetch.mockResolvedValueOnce({ ok: true, blob: async () => blob });
  await render(<HaccpReceptionStatus record={{ ...source, image_brute_url: "https://untrusted.test/original" }} />);
  await click("Télécharger l’original");
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/haccp\/receptions\/7\/original$/);
  expect(download).toHaveBeenCalledWith(blob, "REC_TEST_DATE_LOT42.png");
});

test("an invalid original is not downloaded and the integrity error is visible", async () => {
  const download = jest.spyOn(documents, "downloadHaccpBlob").mockImplementation(() => {});
  global.fetch.mockResolvedValueOnce(reply({ detail: "Intégrité de la preuve invalide" }, 409));
  await render(<HaccpReceptionStatus record={source} />);
  await click("Télécharger l’original");
  expect(download).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Intégrité de la preuve invalide");
});

test("72 hours is only a suggestion: rule and real opening confirmation are mandatory", async () => {
  await render(<HaccpDeconditionnement record={source} />);
  expect(field("Durée").value).toBe("72");
  expect(field("Référence fabricant").value).toBe("");
  expect(field("Je viens").checked).toBe(false);
  expect(button("Enregistrer l’ouverture").disabled).toBe(true);
  await submit();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Vérifiez la réception");
});

test("confirmed opening reuses the receipt and only prepares the existing print flow", async () => {
  const print = jest.spyOn(printer, "printHaccpLabel").mockResolvedValue({ status: "pending", transport: "windows" });
  global.fetch.mockResolvedValueOnce(reply(opened, 201));
  await render(<HaccpDeconditionnement record={source} />);
  await confirmOpening();
  await submit();
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/receptions\/7\/ouverture$/);
  expect(JSON.parse(options.body)).toEqual({
    type_operation: "ouverture", duree_conservation_heures: 72, justification_duree: "PMS TEST : entre 0 et +3 C",
    operateur: "Cuisine", regle_confirmee: true, ouverture_effectuee: true,
    capture_id: "9582f6d4-d5ba-4607-8772-051912e656cb",
  });
  expect(print).not.toHaveBeenCalled();
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(host.textContent).toContain("DLC secondaire");
  await click("J’ai vérifié : valider et imprimer");
  expect(print).toHaveBeenCalledWith(8, "ouverture");
});

test("uncertain labels cannot be deconditioned through the form", async () => {
  await render(<HaccpDeconditionnement record={{ ...source, conforme_reception: false }} />);
  expect(host.querySelector("fieldset").disabled).toBe(true);
  expect(host.textContent).toContain("Lecture incertaine");
  await submit();
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each([
  ["Durée", "24"], ["Référence fabricant", "PMS différent"], ["Opérateur", "Autre opérateur"],
])("editing %s invalidates the opening confirmation", async (name, value) => {
  await render(<HaccpDeconditionnement record={source} />);
  await confirmOpening();
  await change(field(name), value);
  expect(field("Je viens").checked).toBe(false);
  expect(button("Enregistrer l’ouverture").disabled).toBe(true);
});

test("a lost response retries the same UUID and refuses changed data", async () => {
  global.fetch.mockRejectedValueOnce(new Error("Connexion perdue")).mockResolvedValueOnce(reply(opened, 201));
  await render(<HaccpDeconditionnement record={source} />);
  await confirmOpening();
  await submit();
  expect(host.textContent).toContain("Connexion perdue");
  const first = global.fetch.mock.calls[0][1].body;
  await change(field("Durée"), "24");
  await act(async () => field("Je viens").click());
  await submit();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Une tentative existe déjà");
  await change(field("Durée"), "72");
  await act(async () => field("Je viens").click());
  await submit();
  expect(global.fetch.mock.calls[1][1].body).toBe(first);
  expect(global.crypto.randomUUID).toHaveBeenCalledTimes(1);
});

test("invalid opening replies cannot enable printing", async () => {
  global.fetch.mockResolvedValueOnce(reply({ ...opened, reception_source_id: 42 }));
  await render(<HaccpDeconditionnement record={source} />);
  await confirmOpening();
  await submit();
  expect(host.textContent).toContain("Réponse d’ouverture invalide");
  expect(button("J’ai vérifié : valider et imprimer")).toBeUndefined();
});

test("stock and purchase views never infer received quantities or confirmed suppliers", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  global.fetch.mockResolvedValueOnce(reply(page([{
    reception_id: 7, product: "Viande TEST", supplier: "Fournisseur", lot: "42", date_type: "DLC",
    deadline: null, alert_at: "2099-12-01T08:00:00Z", alerte: true, date_depassee: false,
    declared_weight_kg: null, storage: null,
  }], { destination: "stock" })));
  await change(field("Destination"), "stock");
  expect(host.textContent).toContain("FEFO");
  expect(host.textContent).toContain("Alerte 48 h");
  expect(host.textContent).toContain("Quantité reçue à confirmer");
  expect(host.textContent).toContain("Date inconnue");
  global.fetch.mockResolvedValueOnce(reply(page([{
    reception_id: 7, product: "Viande TEST", supplier: null, lot: "42", received_at: null, net_weight: null,
  }], { destination: "achats" })));
  await change(field("Destination"), "achats");
  expect(host.textContent).toContain("fournisseur commercial, quantité et prix à confirmer");
  expect(global.fetch.mock.calls[2][0]).toContain("/destinations/achats?");
});

test("allergen alerts are observations and do not claim changes to the dish matrix", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  global.fetch.mockResolvedValueOnce(reply(page([{
    reception_id: 7, product: "Viande TEST", supplier: "Fournisseur", allergens: ["Moutarde"], traces: ["Lait"],
    new_allergens: ["Moutarde"], new_traces: [], review_required: true, baseline_id: 6, reading_status: "complete",
  }], { destination: "allergenes" })));
  await change(field("Destination"), "allergenes");
  expect(host.textContent).toContain("Nouveaux allergènes présents : Moutarde");
  expect(host.textContent).toContain("aucune recette ni matrice de la carte n’est modifiée");
});

test("receipt pagination requests the next offset and retains its establishment filter", async () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    ...source, id: index + 1, reception_source_id: index + 1, distribution: distribution(index + 1),
  }));
  global.fetch.mockResolvedValueOnce(reply(page(many, { total: 26 })))
    .mockResolvedValueOnce(reply(page([{ ...source, id: 26, reception_source_id: 26, distribution: distribution(26) }],
      { offset: 25, total: 26 })));
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  await click("Page suivante");
  expect(global.fetch.mock.calls[1][0]).toContain("offset=25&limit=25&restaurant_name=Le+Papillon");
  expect(button("Page suivante").disabled).toBe(true);
  expect(button("Page précédente").disabled).toBe(false);
});

test("failed refresh clears stale receipts and surfaces the server error", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  global.fetch.mockResolvedValueOnce(reply({ detail: "Authentification requise" }, 401));
  await click("Actualiser les réceptions");
  expect(host.querySelector(".haccp-records")).toBeNull();
  expect(host.textContent).toContain("Authentification requise");
});

test("stale establishment responses cannot replace a newer selection", async () => {
  let resolve;
  global.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockResolvedValueOnce(reply(page([{ ...source, nom_produit: "SITE B" }])));
  await render(<HaccpReceptions establishmentName="Site A" />);
  await render(<HaccpReceptions establishmentName="Site B" />);
  await act(async () => resolve(reply(page([{ ...source, nom_produit: "SITE A" }]))));
  expect(host.textContent).toContain("SITE B");
  expect(host.textContent).not.toContain("SITE A");
});

test("invalid projection shapes are reported rather than rendered as empty safe values", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  global.fetch.mockResolvedValueOnce(reply(page([{ reception_id: 7, product: "Viande TEST" }], { destination: "allergenes" })));
  await change(field("Destination"), "allergenes");
  expect(host.textContent).toContain("fiche de réception est invalide");
  expect(host.querySelector(".haccp-records")).toBeNull();
});

test("integrity checks read every page and retain earlier failures", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  global.fetch.mockResolvedValueOnce(reply(report({ total: 2, verifiees: 1, prochain_offset: 1, ok: false, erreurs: ["Original 7 modifié"] })))
    .mockResolvedValueOnce(reply(report({ total: 2, offset: 1, verifiees: 1 })));
  await click("Vérifier journal et originaux");
  expect(global.fetch.mock.calls[2][0]).toContain("/integrite?offset=1&limit=20");
  expect(host.textContent).toContain("Original 7 modifié");
  expect(host.textContent).not.toContain("sans anomalie détectée");
  expect(host.textContent).toContain("ni un archivage WORM certifié");
});

test("complete integrity verification reports the exact count", async () => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  global.fetch.mockResolvedValueOnce(reply(report({ total: 2, verifiees: 1, prochain_offset: 1 })))
    .mockResolvedValueOnce(reply(report({ total: 2, offset: 1, verifiees: 1 })));
  await click("Vérifier journal et originaux");
  expect(host.textContent).toContain("2 entrée(s) vérifiée(s), sans anomalie détectée");
});

test.each([
  { ...report({ total: 2 }), prochain_offset: 0 },
  { ...report({ total: 2 }), verifiees: 1 },
  { ...report(), derniere_empreinte: {} },
])("incomplete or malformed integrity reports never appear successful %#", async (invalid) => {
  await render(<HaccpReceptions establishmentName="Le Papillon" />);
  global.fetch.mockResolvedValueOnce(reply(invalid));
  await click("Vérifier journal et originaux");
  expect(host.textContent).toMatch(/invalide|ne couvre pas toutes/);
  expect(host.textContent).not.toContain("sans anomalie détectée");
});

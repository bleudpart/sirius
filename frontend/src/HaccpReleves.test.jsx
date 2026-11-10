import { act } from "react";
import { createRoot } from "react-dom/client";
import HaccpReleves from "./HaccpReleves";

jest.mock("./HaccpSignature", () => function Signature({ onChange }) {
  return <button type="button" onClick={() => onChange("data:image/png;base64,c2lnbmF0dXJl")}>Signer</button>;
});

global.IS_REACT_ACT_ENVIRONMENT = true;
const captureId = "11111111-1111-4111-8111-111111111111";
const previousId = "22222222-2222-4222-8222-222222222222";
const definitions = [
  { id: "temperature", titre: "Relevé de température", champs: [
    { key: "usage", label: "Contrôle", type: "select", required: true, options: ["Enceinte froide"] },
    { key: "equipement", label: "Équipement ou lieu", type: "text", required: true },
    { key: "temperature", label: "Température relevée (°C)", type: "number", required: true },
  ] },
  { id: "tracabilite", titre: "Traçabilité", champs: [
    { key: "etiquette_id", label: "Photo d'étiquette conservée", type: "etiquette", required: true },
  ] },
];
const saved = {
  id: captureId, titre: "Relevé de température", created_at: "2026-11-10T09:00:00Z",
  operateur: "Alex", colonnes: ["Équipement"], lignes: [["Frigo"]], champs: {},
};
const reply = (data, ok = true) => ({
  ok, status: ok ? 200 : 503, json: async () => data,
  headers: { get: () => "image/jpeg" }, blob: async () => new Blob(["photo"], { type: "image/jpeg" }),
});
let host, root, oldFetch, oldCrypto;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input,select");

async function setValue(input, value) {
  const prototype = input.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
async function click(text) { await act(async () => button(text).click()); }
async function submit(text = "Enregistrer") {
  await act(async () => {
    const event = new Event("submit", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "submitter", { value: button(text) });
    host.querySelector("form").dispatchEvent(event);
  });
}
async function fill() {
  await click("Nouveau relevé");
  await setValue(field("Nom de l'opérateur"), "Alex");
  await setValue(field("Contrôle"), "Enceinte froide");
  await setValue(field("Équipement"), "Frigo");
  await setValue(field("Température"), "3,2");
  await click("Signer");
}

beforeEach(() => {
  oldFetch = global.fetch; oldCrypto = global.crypto;
  global.crypto = { randomUUID: () => captureId };
  URL.createObjectURL = jest.fn(() => "blob:etiquette");
  URL.revokeObjectURL = jest.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = oldFetch; global.crypto = oldCrypto;
  delete window.siriusHaccpPrinter;
  localStorage.removeItem("sirius_haccp_word_relay_enabled");
  jest.restoreAllMocks();
});

test("QR saves with one capture ID after a failure and protects the unfinished form", async () => {
  let attempts = 0;
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (options.method === "POST") {
      attempts += 1;
      return attempts === 1 ? reply({ detail: "Réseau coupé" }, false) : reply({ releve: saved });
    }
    throw new Error(`Unexpected ${url}`);
  });
  const onBack = jest.fn();
  jest.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" kitchenToken="token" onBack={onBack} />));
  await fill();
  await click("RELEVÉS");
  expect(window.confirm).toHaveBeenCalled();
  expect(field("Nom de l'opérateur").value).toBe("Alex");
  await submit();
  expect(host.textContent).toContain("Réseau coupé");
  expect(field("Température").value).toBe("3,2");
  await submit();
  expect(host.textContent).toContain("Relevé enregistré");
  const posts = global.fetch.mock.calls.filter(([, options]) => options.method === "POST");
  expect(posts.map(([, options]) => JSON.parse(options.body).capture_id)).toEqual([captureId, captureId]);
  expect(posts[0][1].headers["X-Sirius-Cuisine"]).toBe("token");
  expect(onBack).not.toHaveBeenCalled();
});

test("the model list can be retried after a network error", async () => {
  global.fetch = jest.fn()
    .mockResolvedValueOnce(reply({ detail: "Réseau coupé" }, false))
    .mockResolvedValueOnce(reply({ modeles: definitions }));
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" />));
  expect(host.textContent).toContain("Réseau coupé");
  await click("Réessayer");
  expect(button("Nouveau relevé").disabled).toBe(false);
  expect(host.textContent).not.toContain("Réseau coupé");
});

test("the form cannot be left while saving is in progress", async () => {
  let finish;
  const saving = jest.fn();
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (url.endsWith("/releves")) return new Promise((resolve) => { finish = resolve; });
    throw new Error(`Unexpected ${url}`);
  });
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" onSavingChange={saving} />));
  await fill();
  await submit();
  expect(button("RELEVÉS").disabled).toBe(true);
  expect(host.textContent).toContain("Enregistrement en cours");
  expect(saving).toHaveBeenLastCalledWith(true);
  await act(async () => finish(reply({ releve: saved })));
  expect(host.textContent).toContain("Relevé enregistré");
  expect(saving).toHaveBeenLastCalledWith(false);
});

test("an uncertain print request retries with the same ID and shows the Windows confirmation", async () => {
  let requests = 0;
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (url.endsWith("/releves")) return reply({ releve: saved });
    if (url.endsWith(`/${captureId}/impression`)) {
      requests += 1;
      return requests === 1 ? reply({ detail: "Connexion perdue" }, false)
        : reply({ id: JSON.parse(options.body).id, status: "accepted", detail: "Commande transmise à Windows ; vérifiez la sortie papier." });
    }
    throw new Error(`Unexpected ${url}`);
  });
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" />));
  await fill();
  await submit("Enregistrer et imprimer");
  expect(host.textContent).toContain("Connexion perdue");
  await click("Imprimer depuis le PC");
  const prints = global.fetch.mock.calls.filter(([url]) => url.endsWith(`/${captureId}/impression`));
  expect(JSON.parse(prints[0][1].body).id).toBe(JSON.parse(prints[1][1].body).id);
  expect(JSON.parse(prints[0][1].body).previous_job_id).toBeNull();
  expect(host.textContent).toContain("vérifiez la sortie papier");
  expect(host.textContent).not.toContain("Une autre demande existe déjà");
});

test("retrying a confirmed reprint also keeps the same ID", async () => {
  let requests = 0;
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (url.endsWith("/releves")) return reply({ items: [saved], truncated: false });
    if (url.endsWith(`/${captureId}`)) return reply({ releve: saved });
    if (url.endsWith(`/${captureId}/impression`) && !options.method) {
      return reply({ job: { id: previousId, status: "accepted", detail: "Vérifiez la sortie papier." } });
    }
    if (url.endsWith(`/${captureId}/impression`) && options.method === "POST") {
      requests += 1;
      return requests === 1 ? reply({ detail: "Connexion perdue" }, false)
        : reply({ id: JSON.parse(options.body).id, status: "accepted", detail: "Vérifiez la sortie papier." });
    }
    throw new Error(`Unexpected ${url}`);
  });
  jest.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" />));
  await click("Voir les relevés");
  await click("Relevé de température");
  await click("Nouvelle impression");
  expect(host.textContent).toContain("Connexion perdue");
  await click("Nouvelle impression");
  const prints = global.fetch.mock.calls.filter(([url, options]) => url.endsWith("/impression") && options.method === "POST");
  expect(JSON.parse(prints[0][1].body).id).toBe(JSON.parse(prints[1][1].body).id);
  expect(JSON.parse(prints[0][1].body).previous_job_id).toBe(previousId);
  expect(window.confirm).toHaveBeenCalledTimes(2);
});

test("a newer print request is shown before a reprint can be explicitly confirmed", async () => {
  let requests = 0;
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (url.endsWith("/releves")) return reply({ releve: saved });
    if (url.endsWith(`/${captureId}/impression`) && options.method === "POST") {
      requests += 1;
      return requests === 1 ? reply({ id: previousId, status: "accepted", detail: "Vérifiez la sortie papier." })
        : reply({ id: JSON.parse(options.body).id, status: "pending" });
    }
    throw new Error(`Unexpected ${url}`);
  });
  jest.spyOn(window, "confirm").mockReturnValue(true);
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" />));
  await fill();
  await submit("Enregistrer et imprimer");
  expect(requests).toBe(1);
  expect(host.textContent).toContain("Une autre demande existe déjà");
  await click("Nouvelle impression");
  const prints = global.fetch.mock.calls.filter(([url, options]) => url.endsWith("/impression") && options.method === "POST");
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(JSON.parse(prints[1][1].body).previous_job_id).toBe(previousId);
  expect(host.textContent).toContain("En attente du PC Windows");
});

test("a pending print can be cancelled before the PC claims it", async () => {
  const pending = { id: previousId, status: "pending", detail: null };
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (url.endsWith("/releves")) return reply({ items: [saved], truncated: false });
    if (url.endsWith(`/${captureId}`)) return reply({ releve: saved });
    if (url.endsWith(`/${captureId}/impression`)) return reply({ job: pending });
    if (url.endsWith(`/${previousId}/annulation`) && options.method === "POST") {
      return reply({ ...pending, status: "cancelled", detail: "Demande annulée avant transmission au PC." });
    }
    throw new Error(`Unexpected ${url}`);
  });
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" kitchenToken="token" />));
  await click("Voir les relevés");
  await click("Relevé de température");
  expect(host.textContent).toContain("En attente du PC Windows");
  await click("Annuler la demande");
  expect(host.textContent).toContain("Demande annulée");
  expect(button("Annuler la demande")).toBeUndefined();
  const request = global.fetch.mock.calls.find(([url]) => url.endsWith("/annulation"));
  expect(request[1].headers["X-Sirius-Cuisine"]).toBe("token");
});

test("traceability finds an older photo and previews it with QR authorization", async () => {
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (url.includes("/registre/recherche")) return reply([
      { id: 8, nom_produit: "Saumon", numero_lot: "A", type_operation: "reception", restaurant_name: "Cuisine" },
      { id: 9, nom_produit: "Autre", numero_lot: "B", type_operation: "reception", restaurant_name: "Autre restaurant" },
    ]);
    if (url.endsWith("/registre/8/photo")) return reply(null);
    throw new Error(`Unexpected ${url}`);
  });
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" kitchenToken="token" />));
  await setValue(field("Type de relevé"), "tracabilite");
  await click("Nouveau relevé");
  expect(host.textContent).toContain("Saumon");
  expect(host.textContent).not.toContain("Autre restaurant");
  await setValue(host.querySelector('[aria-label="Rechercher une photo par produit ou lot"]'), "Saumon");
  await click("Rechercher");
  expect(global.fetch.mock.calls.some(([url]) => url.includes("terme=Saumon"))).toBe(true);
  await setValue(field("Photo d'étiquette"), "8");
  await click("Voir la photo");
  const request = global.fetch.mock.calls.find(([url]) => url.endsWith("/registre/8/photo"));
  expect(request[1].headers["X-Sirius-Cuisine"]).toBe("token");
  expect(host.querySelector('img[alt="Étiquette archivée"]').src).toBe("blob:etiquette");
  await click("Fermer la photo");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:etiquette");
});

test("photo loading failures are explicit and retryable", async () => {
  let attempts = 0;
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith("/modeles")) return reply({ modeles: definitions });
    if (url.includes("/registre/recherche")) {
      attempts += 1;
      return attempts === 1 ? reply({ detail: "Registre indisponible" }, false) : reply([]);
    }
    throw new Error(`Unexpected ${url}`);
  });
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" />));
  await setValue(field("Type de relevé"), "tracabilite");
  await click("Nouveau relevé");
  expect(host.textContent).toContain("Registre indisponible");
  expect(host.textContent).not.toContain("Aucune photo trouvée");
  await click("Réessayer les photos");
  expect(host.textContent).toContain("Aucune photo trouvée");
});

test("the Word relay is opt-in and only offered on Windows", async () => {
  global.fetch = jest.fn(async () => reply({ modeles: definitions }));
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" />));
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  window.siriusHaccpPrinter = {};
  await act(async () => root.render(<HaccpReleves establishmentName="Cuisine" />));
  const checkbox = host.querySelector('input[type="checkbox"]');
  expect(checkbox.checked).toBe(false);
  await act(async () => checkbox.click());
  expect(localStorage.getItem("sirius_haccp_word_relay_enabled")).toBe("true");
  await act(async () => checkbox.click());
  expect(localStorage.getItem("sirius_haccp_word_relay_enabled")).toBe("false");
});

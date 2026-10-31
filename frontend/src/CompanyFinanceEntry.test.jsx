import React, { act } from "react";
import { createRoot } from "react-dom/client";
import CompanyFinanceEntry from "./CompanyFinanceEntry";
import { API_BASE_URL } from "./lib/api";
import {
  BANK_CSV_TEMPLATE, ENTRY_KINDS, ENTRY_KIND_HELP, INVALID_PAYLOAD_MESSAGE, MAX_ENTRY_LIST, MUTATION_TIMEOUT_MESSAGE,
  formatTimestamp, localToday,
} from "./companyFinance";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NNBSP = "\u202f";
const NBSP = "\u00a0";
const euros = (amount) => `${amount.replace(/ /g, NNBSP)}${NBSP}€`;
const percent = (value) => `${value}${NBSP}%`;

const COMPANY_ID = "company_a";
const BASE = `/finance/${COMPANY_ID}`;
const PROFILE = Object.freeze({ id: COMPANY_ID, name: "Brasserie du Port", sector: "HOSPITALITY", currency: "EUR" });
const QUERY = Object.freeze({ start_date: "2025-03-01", end_date: "2025-03-31", comparison: "year_ago" });
const DEMO_QUERY = Object.freeze({ start_date: "2025-01-01", end_date: "2025-12-31", comparison: "year_ago" });
const MARCH = `start_date=2025-03-01&end_date=2025-03-31&limit=${MAX_ENTRY_LIST}`;
const JOURNAL = `GET ${BASE}/ingestions?limit=50`;
const BATCH_ID = "0d6f2a52-8c1e-4b7a-9f3e-5a2b7c9d1e40";
const ACTOR = "user_7f3a";
const IMPORTED_AT = "2025-03-31T08:30:00Z";
const CREATED = "Pièce enregistrée et tracée : le tableau de bord en tiendra compte au prochain calcul.";
const REFUSED = "Pièce non enregistrée : corrigez les champs signalés.";

const entry = (kind, id, values, origin = "manual") => ({ id, kind, origin, values });
const SALE = entry("revenues", 41, {
  date: "2025-03-14", amount_ht: "1250.50", amount_ttc: "1375.55", vat_rate: "10.0000",
  payment_method: "CARD", allocation: "FOOD", business_reference: "Z-0314",
});
const POS_SALE = entry("revenues", 42, {
  date: "2025-03-15", amount_ht: "980.00", amount_ttc: "1078.00", vat_rate: "10.0000",
  payment_method: "CASH", allocation: "BEVERAGE", business_reference: "Z-0315",
}, "pos_webhook");
const SALE_ROW = ["14/03/2025", euros("1 250,50"), euros("1 375,55"), percent("10"), "Carte bancaire", "Aliments", "Z-0314", "Saisie manuelle", "Supprimer"];
const POS_ROW = ["15/03/2025", euros("980,00"), euros("1 078,00"), percent("10"), "Espèces", "Boissons", "Z-0315", "Caisse (POS)", "Supprimer"];
const DELETE_SALE = `Supprimer la pièce 14/03/2025 · ${euros("1 250,50")}`;
const DEMO_ENTRIES = Object.freeze({
  revenues: [entry("revenues", 3, {
    date: "2025-12-28", amount_ht: "1240.00", amount_ttc: "1488.00", vat_rate: "20.0000",
    payment_method: "CARD", allocation: "MERCHANDISE", business_reference: "Z-2025-362", ticket_count: 54,
  }, "demo")],
  inventories: [
    entry("inventories", 2, { date: "2026-01-01", allocation: "MERCHANDISE", value: "42150.00" }, "demo"),
    entry("inventories", 1, { date: "2023-01-01", allocation: "MERCHANDISE", value: "38900.00" }, "demo"),
  ],
});
const BATCH = Object.freeze({
  batch_id: BATCH_ID, source: "bank_statement_csv", created_at: IMPORTED_AT, record_count: 12, duplicate_count: 3,
  remaining_count: 11, notes: [], warnings: ["2 lignes sans montant ignorées."],
});
const IMPORT_RESULT = Object.freeze({
  record_count: 2, duplicate_count: 1, review_required: true,
  notes: ["Format détecté : CSV point-virgule, dates JJ/MM/AAAA."], warnings: ["1 ligne sans montant ignorée."],
});
const EVENTS = Object.freeze([
  {
    id: 3, actor: "pos_webhook", action: "import", entry_kind: "pos_webhook", entry_id: null,
    summary: "Import Caisse (POS) : 1 écriture(s)", created_at: "2025-03-15T22:05:00Z",
  },
  { id: 2, actor: ACTOR, action: "create", entry_kind: "revenues", entry_id: "41", summary: "Recette du 14/03/2025", created_at: "2025-03-14T21:40:00Z" },
  { id: 1, actor: ACTOR, action: "profile", entry_kind: "profile", entry_id: null, summary: "", created_at: "2025-03-01T09:00:00Z" },
]);

let host;
let root;
let originalFetch;
let consoleErrors;

const clone = (value) => JSON.parse(JSON.stringify(value));
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const anchorDate = ({ values }) => values.date ?? values.active_from ?? "";
const newestFirst = (a, b) => anchorDate(b).localeCompare(anchorDate(a)) || b.id - a.id;

// Faux serveur à état : pièces, imports et journal d’audit évoluent comme sur le backend réel.
function serve({ profile = PROFILE, entries = {}, batches = [], events = [], computed = {}, routes = {} } = {}) {
  const state = {
    profile: profile && { ...profile },
    entries: Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, clone(entries[kind] ?? [])])),
    batches: clone(batches),
    events: clone(events),
    imports: new Map(),
    nextId: 100,
  };
  const trace = (action, entryKind, summary) => state.events.unshift({
    id: state.events.length + 1, actor: ACTOR, action, entry_kind: entryKind, entry_id: null, summary,
    created_at: "2025-03-31T10:00:00Z",
  });
  global.fetch = jest.fn((url, init = {}) => {
    const method = init.method ?? "GET";
    const [path, search = ""] = String(url).slice(API_BASE_URL.length).split("?");
    const params = new URLSearchParams(search);
    const route = routes[`${method} ${path}`];
    if (route) return route({ params, init, state });
    const demo = path.match(/^\/finance\/demo\/[A-Z]+\/entries\/(\w+)$/);
    if (demo && method === "GET") return reply(200, { kind: demo[1], entries: clone(DEMO_ENTRIES[demo[1]] ?? []), truncated: false });
    if (path === `${BASE}/profile` && method === "GET") return reply(200, { profile: state.profile });
    if (path === `${BASE}/profile` && method === "PUT") {
      state.profile = { id: COMPANY_ID, ...JSON.parse(init.body) };
      trace("profile", "profile", `Profil : ${state.profile.name}`);
      return reply(200, state.profile);
    }
    const [, kind, entryId] = path.match(new RegExp(`^${BASE}/entries/(\\w+)(?:/(\\d+))?$`)) ?? [];
    if (kind && !entryId && method === "GET") {
      const [start, end] = [params.get("start_date"), params.get("end_date")];
      const inPeriod = ({ values }) => !values.date || ((!start || values.date >= start) && (!end || values.date <= end));
      return reply(200, { kind, entries: clone(state.entries[kind].filter(inPeriod).sort(newestFirst)), truncated: false });
    }
    if (kind && !entryId && method === "POST") {
      const created = entry(kind, state.nextId++, { ...JSON.parse(init.body), ...computed[kind] });
      state.entries[kind].push(created);
      trace("create", kind, `Saisie de la pièce n° ${created.id}`);
      return reply(201, created);
    }
    if (kind && entryId && method === "DELETE") {
      state.entries[kind] = state.entries[kind].filter((item) => item.id !== Number(entryId));
      trace("delete", kind, `Suppression de la pièce n° ${entryId}`);
      return reply(204, null);
    }
    if (path === `${BASE}/ingestions` && method === "GET") return reply(200, { batches: clone(state.batches), truncated: false });
    const upload = path.match(new RegExp(`^${BASE}/ingestions/(bank_statement_csv|bank_statement_ofx)$`));
    if (upload && method === "POST") {
      const key = init.headers["Idempotency-Key"];
      if (state.imports.has(key)) return reply(200, { ...state.imports.get(key), replayed: true });
      const result = {
        batch_id: BATCH_ID, company_id: COMPANY_ID, source: upload[1], payload_sha256: "a".repeat(64), replayed: false, ...IMPORT_RESULT,
      };
      state.imports.set(key, result);
      state.batches.unshift({
        batch_id: BATCH_ID, source: upload[1], created_at: IMPORTED_AT, record_count: result.record_count,
        duplicate_count: result.duplicate_count, remaining_count: result.record_count, notes: result.notes, warnings: result.warnings,
      });
      trace("import", upload[1], `Import : ${result.record_count} écriture(s)`);
      return reply(200, result);
    }
    const batch = path.match(new RegExp(`^${BASE}/ingestions/([0-9a-f-]{36})$`));
    if (batch && method === "DELETE") {
      state.batches = state.batches.filter((item) => item.batch_id !== batch[1]);
      trace("revert", "bank_statement_csv", "Annulation d’import");
      return reply(204, null);
    }
    if (path === `${BASE}/audit` && method === "GET") return reply(200, { events: clone(state.events) });
    return reply(404, { detail: `Route inattendue : ${method} ${path}` });
  });
  return state;
}

const calls = () => global.fetch.mock.calls.map(([url, init = {}]) => ({
  request: `${init.method ?? "GET"} ${String(url).slice(API_BASE_URL.length)}`,
  init,
}));
const requests = () => calls().map((call) => call.request);
const requestsAfter = (count) => requests().slice(count).sort();
const mutations = () => requests().filter((request) => !request.startsWith("GET "));
const $ = (selector, scope = host) => scope.querySelector(selector);
const $$ = (selector, scope = host) => [...scope.querySelectorAll(selector)];
const textOf = (node) => node.textContent.trim();
const profileCard = () => $(".company-finance-profile");
const importCard = () => $(".company-finance-import");
const journal = () => $(".company-finance-journal");
const ledger = () => $(".company-finance-ledger");
const entryForm = () => $("form.company-finance-entry-form");
const entryList = () => $(".company-finance-entry-list");
const auditLog = () => $("details.company-finance-audit");
const caption = (scope = entryList()) => textOf($("caption", scope));
const headers = (scope = entryList()) => $$("thead th", scope).map(textOf);
const rows = (scope = entryList()) => $$("tbody tr", scope).map((row) => [...row.cells].map(textOf));
const alerts = (scope = host) => $$('[role="alert"]', scope).map(textOf);
const feedback = (scope = host) => $$(".company-finance-feedback", scope).map(textOf);
const facts = () => $$(".company-finance-facts > div", profileCard()).map((item) => [textOf($("dt", item)), textOf($("dd", item))]);
const fieldNames = () => $$("[name]", entryForm()).map((node) => node.name);
const labelOf = (id) => textOf($(`label[for="${id}"]`));
const valueOf = (id) => $(`#${id}`).value;
const selectedFile = () => $("#company-finance-bank-file ~ small");
const findButton = (label, scope = host) => $$("button", scope).find((node) => textOf(node) === label);
const buttonLabelled = (label, scope = host) => $$("button", scope).find((node) => node.getAttribute("aria-label") === label);

async function click(target) {
  if (!target) throw new Error("Bouton introuvable.");
  await act(async () => target.click());
}

async function renderEntry(props = {}) {
  await act(async () => root.render(
    <CompanyFinanceEntry companyId={COMPANY_ID} companyName="Entreprise test" query={QUERY} {...props} />,
  ));
}

async function setValue(id, value) {
  const input = $(`#${id}`);
  if (!input) throw new Error(`Champ introuvable : ${id}`);
  const select = input instanceof HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor((select ? HTMLSelectElement : HTMLInputElement).prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
  });
}

async function fill(kind, values) {
  for (const [name, value] of Object.entries(values)) await setValue(`company-finance-${kind}-${name}`, value);
}

async function chooseFile(file) {
  const input = $("#company-finance-bank-file");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

async function openAudit() {
  const details = auditLog();
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

const readBytes = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

beforeEach(() => {
  originalFetch = global.fetch;
  consoleErrors = [];
  jest.spyOn(console, "error").mockImplementation((...args) => consoleErrors.push(args.map(String).join(" ")));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  jest.useRealTimers();
  const errors = consoleErrors;
  jest.restoreAllMocks();
  expect(errors).toEqual([]);
});

describe("démonstration fictive", () => {
  test("pièces fictives en lecture seule : ni profil, ni saisie, ni import, ni journal d’audit", async () => {
    serve();
    await renderEntry({ companyId: null, demoSector: "RETAIL", query: DEMO_QUERY });
    expect(requests()).toEqual([`GET /finance/demo/RETAIL/entries/revenues?start_date=2025-01-01&end_date=2025-12-31&limit=${MAX_ENTRY_LIST}`]);
    expect(textOf($('.company-finance-demo-banner[role="note"]')))
      .toBe("Pièces fictives de démonstration, en lecture seule : la saisie et l’import sont réservés à votre entreprise.");
    expect(textOf($("#company-finance-ledger-title"))).toBe("Pièces de démonstration");
    expect($$("form, input, select, details")).toHaveLength(0);
    expect(profileCard()).toBeNull();
    expect(caption()).toBe("Recettes · du 01/01/2025 au 31/12/2025 · 1 pièce");
    expect(headers()).toEqual(["Date", "HT", "TTC", "TVA", "Paiement", "Z de caisse / ticket", "Tickets", "Origine"]);
    expect(rows()).toEqual([
      ["28/12/2025", euros("1 240,00"), euros("1 488,00"), percent("20"), "Carte bancaire", "Z-2025-362", "54", "Démonstration fictive"],
    ]);

    await click(findButton("Inventaires"));
    expect(requests().at(-1)).toBe(`GET /finance/demo/RETAIL/entries/inventories?limit=${MAX_ENTRY_LIST}`);
    expect(findButton("Inventaires").getAttribute("aria-pressed")).toBe("true");
    expect(findButton("Recettes").getAttribute("aria-pressed")).toBe("false");
    expect(textOf($(".company-finance-intro"))).toBe(ENTRY_KIND_HELP.inventories);
    expect(caption()).toBe("Inventaires · toutes dates, les plus récentes d’abord · 2 pièces");
    expect(rows()).toEqual([
      ["01/01/2026", "Marchandises", euros("42 150,00"), "Démonstration fictive"],
      ["01/01/2023", "Marchandises", euros("38 900,00"), "Démonstration fictive"],
    ]);
    expect(findButton("Supprimer")).toBeUndefined();
    expect(requests().every((request) => request.startsWith("GET /finance/demo/RETAIL/"))).toBe(true);
  });
});

describe("profil financier", () => {
  test("profil absent : création avec le nom prérempli, puis ouverture de l’import et de la saisie", async () => {
    serve({ profile: null });
    await renderEntry();
    expect(requests()).toEqual([`GET ${BASE}/profile`]);
    expect(textOf($("#company-finance-profile-title"))).toBe("Créer le profil financier");
    expect(valueOf("company-finance-profile-name")).toBe("Entreprise test");
    expect(valueOf("company-finance-profile-sector")).toBe("HOSPITALITY");
    expect(valueOf("company-finance-profile-currency")).toBe("EUR");
    expect(findButton("Annuler", profileCard())).toBeUndefined();
    expect(importCard()).toBeNull();
    expect(ledger()).toBeNull();
    expect(auditLog()).toBeNull();

    await setValue("company-finance-profile-name", "   ");
    await click(findButton("Enregistrer le profil"));
    expect(alerts(profileCard())).toEqual(["Indiquez le nom de l’entreprise (160 caractères au maximum)."]);
    expect(requests()).toHaveLength(1);

    await setValue("company-finance-profile-name", "  Maçonnerie Durand  ");
    await setValue("company-finance-profile-sector", "CONSTRUCTION");
    await click(findButton("Enregistrer le profil"));
    const { request, init } = calls()[1];
    expect(request).toBe(`PUT ${BASE}/profile`);
    expect(init).toEqual(expect.objectContaining({ credentials: "include", headers: { "Content-Type": "application/json" } }));
    expect(JSON.parse(init.body)).toEqual({ name: "Maçonnerie Durand", sector: "CONSTRUCTION", currency: "EUR" });
    expect(feedback(profileCard())).toEqual(["Profil enregistré."]);
    expect(alerts(profileCard())).toEqual([]);
    expect(textOf($("#company-finance-profile-title"))).toBe("Profil financier");
    expect(facts()).toEqual([["Entreprise", "Maçonnerie Durand"], ["Secteur", "BTP & artisanat"], ["Devise", "EUR"]]);
    expect(requestsAfter(2)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);
    expect(fieldNames()).toEqual(["date", "amount_ht", "vat_rate", "payment_method", "business_reference"]);
    expect(labelOf("company-finance-revenues-business_reference")).toBe("Chantier / devis");
    expect(textOf($("#company-finance-revenues-business_reference-help"))).toBe("Indispensable pour la marge par chantier.");
    expect(valueOf("company-finance-revenues-vat_rate")).toBe("20");
    expect(valueOf("company-finance-revenues-payment_method")).toBe("TRANSFER");
  });

  test("réponse incomplète après enregistrement : profil à vérifier, ni import ni saisie ouverts", async () => {
    serve({
      profile: null,
      routes: { [`PUT ${BASE}/profile`]: () => reply(200, { id: COMPANY_ID, name: "Entreprise test", sector: "BAKERY", currency: "EUR" }) },
    });
    await renderEntry();
    await click(findButton("Enregistrer le profil"));
    expect(alerts(profileCard())).toEqual(["Réponse du serveur incomplète : rechargez la page pour vérifier le profil."]);
    expect(feedback(profileCard())).toEqual([]);
    expect(findButton("Enregistrer le profil")).toBeDefined();
    expect(importCard()).toBeNull();
    expect(ledger()).toBeNull();
  });

  test.each([
    ["session expirée", 401, { detail: "Not authenticated" }, "Session expirée : reconnectez-vous pour accéder à la finance d’entreprise."],
    ["accès refusé", 403, { detail: "Forbidden" }, "Accès refusé à cette ressource financière."],
    ["service indisponible", 503, { detail: "Service Unavailable" }, "Service financier indisponible (HTTP 503). Réessayez sans modifier vos données."],
    ["profil incohérent", 200, { profile: { id: COMPANY_ID, name: "X", sector: "BAKERY", currency: "EUR" } }, INVALID_PAYLOAD_MESSAGE],
  ])("%s au chargement du profil : message explicite et aucune saisie possible", async (_, status, body, message) => {
    serve({ routes: { [`GET ${BASE}/profile`]: () => reply(status, body) } });
    await renderEntry();
    expect(alerts()).toEqual([message]);
    expect(requests()).toEqual([`GET ${BASE}/profile`]);
    expect($$("form")).toHaveLength(0);
  });

  test("profil existant : modification annulable, puis changement de secteur appliqué à la saisie", async () => {
    serve();
    await renderEntry();
    expect(facts()).toEqual([["Entreprise", "Brasserie du Port"], ["Secteur", "Restauration & alimentaire"], ["Devise", "EUR"]]);
    expect(fieldNames()).toContain("allocation");
    const before = requests().length;

    await click(findButton("Modifier le profil"));
    expect(textOf($("small", profileCard())))
      .toBe("Changer de secteur modifie les indicateurs métier ; les pièces déjà saisies sont conservées.");
    await setValue("company-finance-profile-sector", "RETAIL");
    await click(findButton("Annuler", profileCard()));
    expect(facts()[1]).toEqual(["Secteur", "Restauration & alimentaire"]);
    await click(findButton("Modifier le profil"));
    expect(valueOf("company-finance-profile-sector")).toBe("HOSPITALITY");
    expect(requests()).toHaveLength(before);

    await setValue("company-finance-profile-sector", "RETAIL");
    await click(findButton("Enregistrer le profil"));
    expect(calls()[before].request).toBe(`PUT ${BASE}/profile`);
    expect(JSON.parse(calls()[before].init.body)).toEqual({ name: "Brasserie du Port", sector: "RETAIL", currency: "EUR" });
    expect(facts()[1]).toEqual(["Secteur", "Commerce & retail"]);
    expect(fieldNames()).toEqual(["date", "amount_ht", "vat_rate", "payment_method", "business_reference", "ticket_count"]);
    expect(requestsAfter(before + 1)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);
  });
});

describe("saisie des pièces", () => {
  test("recette : erreurs signalées champ par champ, puis enregistrement exact et liste rechargée", async () => {
    serve({ computed: { revenues: { amount_ttc: "1375.55" } } });
    await renderEntry();
    expect(entryForm().getAttribute("aria-label")).toBe("Nouvelle pièce : Recettes");
    expect(fieldNames()).toEqual(["date", "amount_ht", "vat_rate", "payment_method", "allocation", "business_reference"]);
    expect(labelOf("company-finance-revenues-amount_ht")).toBe("Montant HT *");
    expect(labelOf("company-finance-revenues-business_reference")).toBe("Z de caisse / ticket");
    expect(valueOf("company-finance-revenues-date")).toBe(localToday());
    expect(caption()).toBe("Recettes · du 01/03/2025 au 31/03/2025 · 0 pièce");
    expect(rows()).toEqual([["Aucune pièce sur cette période."]]);

    await setValue("company-finance-revenues-vat_rate", "120");
    await click(findButton("Enregistrer la pièce"));
    expect(alerts(entryForm())).toEqual([REFUSED]);
    const amount = $("#company-finance-revenues-amount_ht");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(amount.getAttribute("aria-describedby"))
      .toBe("company-finance-revenues-amount_ht-help company-finance-revenues-amount_ht-error");
    expect(textOf($("#company-finance-revenues-amount_ht-error"))).toBe("Champ obligatoire.");
    expect(textOf($("#company-finance-revenues-vat_rate-error"))).toBe("Valeur supérieure au maximum autorisé (100).");
    expect(mutations()).toEqual([]);

    await setValue("company-finance-revenues-amount_ht", "1 250,50");
    expect(amount.hasAttribute("aria-invalid")).toBe(false);
    expect($("#company-finance-revenues-amount_ht-error")).toBeNull();
    await fill("revenues", { vat_rate: "10", date: "2025-03-14", business_reference: "Z-0314" });
    const before = requests().length;
    await click(findButton("Enregistrer la pièce"));
    const { request, init } = calls()[before];
    expect(request).toBe(`POST ${BASE}/entries/revenues`);
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({
      date: "2025-03-14", amount_ht: "1250.50", vat_rate: "10", payment_method: "CARD", allocation: "FOOD", business_reference: "Z-0314",
    });
    expect(feedback(entryForm())).toEqual([CREATED]);
    expect(alerts(entryForm())).toEqual([]);
    expect(valueOf("company-finance-revenues-amount_ht")).toBe("");
    expect(valueOf("company-finance-revenues-business_reference")).toBe("");
    expect(valueOf("company-finance-revenues-date")).toBe("2025-03-14");
    expect(requestsAfter(before + 1)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);
    expect(caption()).toBe("Recettes · du 01/03/2025 au 31/03/2025 · 1 pièce");
    expect(rows()).toEqual([SALE_ROW]);
  });

  test("achat et charges récurrentes : les champs suivent les choix saisis", async () => {
    serve({ computed: { expenses: { amount_ttc: "105.50", deductible_vat: "0.00" } } });
    await renderEntry();
    await click(findButton("Achats"));
    expect(requests().at(-1)).toBe(`GET ${BASE}/entries/expenses?${MARCH}`);
    expect(entryForm().getAttribute("aria-label")).toBe("Nouvelle pièce : Achats");
    expect(fieldNames()).toEqual([
      "date", "supplier", "amount_ht", "vat_mode", "vat_rate", "vat_deductible", "category", "allocation", "business_reference",
    ]);
    expect($$("#company-finance-expenses-allocation option").map(textOf)).toEqual(["Aliments", "Boissons"]);
    expect(valueOf("company-finance-expenses-vat_rate")).toBe("5,5");

    await setValue("company-finance-expenses-vat_mode", "amount");
    await setValue("company-finance-expenses-category", "FRAIS_GENERAUX");
    await click($("#company-finance-expenses-vat_deductible"));
    expect(fieldNames()).toEqual(["date", "supplier", "amount_ht", "vat_mode", "amount_vat", "vat_deductible", "category", "business_reference"]);
    await fill("expenses", { date: "2025-03-10", supplier: "Metro Cash & Carry", amount_ht: "100", amount_vat: "5,50" });
    const before = requests().length;
    await click(findButton("Enregistrer la pièce"));
    expect(calls()[before].request).toBe(`POST ${BASE}/entries/expenses`);
    expect(JSON.parse(calls()[before].init.body)).toEqual({
      date: "2025-03-10", supplier: "Metro Cash & Carry", amount_ht: "100", amount_vat: "5.50", vat_deductible: false, category: "FRAIS_GENERAUX",
    });
    expect(headers()).toEqual(["Date", "Fournisseur", "Catégorie", "HT", "TVA", "TTC", "TVA déductible", "Famille", "Référence", "Origine", "Action"]);
    expect(rows()).toEqual([[
      "10/03/2025", "Metro Cash & Carry", "Frais généraux", euros("100,00"), euros("5,50"), euros("105,50"), euros("0,00"),
      "—", "—", "Saisie manuelle", "Supprimer",
    ]]);

    await click(findButton("Charges récurrentes"));
    expect(requests().at(-1)).toBe(`GET ${BASE}/entries/overheads?${MARCH}`);
    expect(caption()).toBe("Charges récurrentes · charges actives du 01/03/2025 au 31/03/2025 · 0 pièce");
    expect(labelOf("company-finance-overheads-monthly_amount_ht")).toBe("Loyer mensuel HT *");
    await setValue("company-finance-overheads-category", "LOAN");
    expect(labelOf("company-finance-overheads-monthly_amount_ht")).toBe("Mensualité d’emprunt (capital + intérêts) *");
    expect(fieldNames()).toEqual(["label", "category", "monthly_amount_ht", "loan_principal", "active_from", "active_to"]);
    await setValue("company-finance-overheads-category", "PAYROLL");
    expect(labelOf("company-finance-overheads-monthly_amount_ht")).toBe("Salaires bruts mensuels *");
    expect(fieldNames()).toEqual(["label", "category", "monthly_amount_ht", "employer_charges", "active_from", "active_to"]);
  });

  test("bilan : pièce ponctuelle listée toutes dates, totaux contrôlés avant envoi", async () => {
    serve();
    await renderEntry();
    await click(findButton("Bilans"));
    expect(requests().at(-1)).toBe(`GET ${BASE}/entries/balance_sheets?limit=${MAX_ENTRY_LIST}`);
    expect(caption()).toBe("Bilans · toutes dates, les plus récentes d’abord · 0 pièce");
    expect(rows()).toEqual([["Aucune pièce enregistrée."]]);
    expect(valueOf("company-finance-balance_sheets-date")).toBe(`${Number(localToday().slice(0, 4)) - 1}-12-31`);

    await fill("balance_sheets", {
      date: "2024-12-31", equity: "85 000", financial_debt: "120 000", inventory: "18 000", trade_receivables: "9 500",
      cash: "12 000", total_assets: "30 000",
    });
    await click(findButton("Enregistrer la pièce"));
    expect(alerts(entryForm())).toEqual([REFUSED]);
    expect(textOf($("#company-finance-balance_sheets-total_assets-error")))
      .toBe("Le total du bilan doit couvrir stocks, créances clients et disponibilités.");
    expect(mutations()).toEqual([]);

    await setValue("company-finance-balance_sheets-total_assets", "260 000");
    const before = requests().length;
    await click(findButton("Enregistrer la pièce"));
    expect(JSON.parse(calls()[before].init.body)).toEqual({
      date: "2024-12-31", equity: "85000", financial_debt: "120000", inventory: "18000", trade_receivables: "9500",
      cash: "12000", total_assets: "260000",
    });
    expect(requestsAfter(before + 1)).toEqual([`GET ${BASE}/entries/balance_sheets?limit=${MAX_ENTRY_LIST}`, JOURNAL]);
    expect(rows()).toEqual([[
      "31/12/2024", euros("85 000,00"), euros("120 000,00"), euros("18 000,00"), euros("9 500,00"), "—", "—",
      euros("12 000,00"), euros("260 000,00"), "Saisie manuelle", "Supprimer",
    ]]);
    expect(valueOf("company-finance-balance_sheets-date")).toBe("2024-12-31");
  });

  test("suppression : confirmation explicite, puis pièce retirée de la liste", async () => {
    serve({ entries: { revenues: [SALE, POS_SALE] } });
    await renderEntry();
    expect(rows()).toEqual([POS_ROW, SALE_ROW]);
    await click(buttonLabelled(DELETE_SALE));
    const row = $$("tbody tr", entryList())[1];
    expect(findButton("Confirmer la suppression", row)).toBeDefined();
    await click(findButton("Garder", row));
    expect(buttonLabelled(DELETE_SALE)).toBeDefined();
    expect(mutations()).toEqual([]);

    await click(buttonLabelled(DELETE_SALE));
    const before = requests().length;
    await click(findButton("Confirmer la suppression"));
    expect(calls()[before]).toEqual({
      request: `DELETE ${BASE}/entries/revenues/41`,
      init: expect.objectContaining({ method: "DELETE", credentials: "include" }),
    });
    expect(feedback(entryList())).toEqual(["Pièce supprimée et tracée dans le journal d’audit."]);
    expect(requestsAfter(before + 1)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);
    expect(rows()).toEqual([POS_ROW]);
  });

  test("refus du serveur : son message est affiché, la saisie est conservée et rien n’est rechargé", async () => {
    serve({ routes: { [`POST ${BASE}/entries/revenues`]: () => reply(409, { detail: "La devise du profil est verrouillée : EUR." }) } });
    await renderEntry();
    await fill("revenues", { amount_ht: "80", date: "2025-03-14" });
    const before = requests().length;
    await click(findButton("Enregistrer la pièce"));
    expect(alerts(entryForm())).toEqual(["La devise du profil est verrouillée : EUR."]);
    expect(valueOf("company-finance-revenues-amount_ht")).toBe("80");
    expect(requests()).toHaveLength(before + 1);
  });

  test("délai de 30 secondes dépassé : message prudent, saisie conservée pour vérification", async () => {
    jest.useFakeTimers();
    serve({
      routes: {
        [`POST ${BASE}/entries/revenues`]: ({ init }) => new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
      },
    });
    await renderEntry();
    await fill("revenues", { amount_ht: "1 250,50", date: "2025-03-14" });
    await click(findButton("Enregistrer la pièce"));
    const submit = $('button[type="submit"]', entryForm());
    expect(submit.disabled).toBe(true);
    expect(textOf(submit)).toBe("Enregistrement…");
    await act(async () => jest.advanceTimersByTime(30000));
    expect(alerts(entryForm())).toEqual([MUTATION_TIMEOUT_MESSAGE]);
    expect(calls().at(-1).init.signal.aborted).toBe(true);
    expect(submit.disabled).toBe(false);
    expect(valueOf("company-finance-revenues-amount_ht")).toBe("1 250,50");
  });

  test("quitter la saisie pendant un envoi : aucune mise à jour ni rechargement après démontage", async () => {
    let answer;
    serve({ routes: { [`POST ${BASE}/entries/revenues`]: () => new Promise((resolve) => { answer = resolve; }) } });
    await renderEntry();
    await fill("revenues", { amount_ht: "80", date: "2025-03-14" });
    await click(findButton("Enregistrer la pièce"));
    const before = requests().length;
    await act(async () => root.render(<p>Tableau de bord</p>));
    await act(async () => answer({ ok: true, status: 201, json: async () => entry("revenues", 100, {}) }));
    expect(textOf(host)).toBe("Tableau de bord");
    expect(requests()).toHaveLength(before);
  });
});

describe("import de relevé bancaire", () => {
  const statement = () => new File(
    ["\ufeffDate;Libellé;Débit;Crédit\r\n03/03/2025;PRLV LOYER MARS;1 200,00;\r\n05/03/2025;REMISE CB;;2 450,80\r\n"],
    "releve-mars-2025.csv",
    { type: "text/csv", lastModified: 1741000000000 },
  );

  test("fichier absent, d’un autre format ou vide : refus explicite et aucun envoi", async () => {
    serve();
    await renderEntry();
    expect(textOf($("p", journal()))).toBe("Aucun import pour l’instant.");
    await click(findButton("Importer le relevé"));
    expect(alerts(importCard())).toEqual(["Choisissez un relevé bancaire (.csv, .ofx ou .qfx)."]);

    await chooseFile(new File(["%PDF-1.7"], "releve.pdf", { type: "application/pdf" }));
    expect(alerts(importCard())).toEqual([]);
    expect(textOf(selectedFile())).toBe("releve.pdf · 1 Kio");
    await click(findButton("Importer le relevé"));
    expect(alerts(importCard())).toEqual(["Choisissez un relevé .csv, .ofx ou .qfx exporté depuis la banque."]);

    await chooseFile(new File([], "vide.csv", { type: "text/csv" }));
    await click(findButton("Importer le relevé"));
    expect(alerts(importCard())).toEqual(["Le fichier est vide."]);
    expect(mutations()).toEqual([]);
  });

  test("relevé CSV : envoi brut avec clé d’idempotence, résumé, journal à jour ; le renvoi n’ajoute rien", async () => {
    serve();
    await renderEntry();
    const file = statement();
    await chooseFile(file);
    expect(textOf(selectedFile())).toBe("releve-mars-2025.csv · 1 Kio");
    const before = requests().length;
    await click(findButton("Importer le relevé"));
    const { request, init } = calls()[before];
    const key = `bank-${file.size}-1741000000000-releve-mars-2025.csv`;
    expect(request).toBe(`POST ${BASE}/ingestions/bank_statement_csv`);
    expect(init.body).toBe(file);
    expect(init.headers).toEqual({ "Content-Type": "text/csv", "Idempotency-Key": key });
    const result = $(".company-finance-import-result");
    expect(textOf($("strong", result))).toBe("2 écritures importées, 1 doublon ignoré.");
    expect(result.textContent).toContain("Contrôle recommandé : vérifiez les avertissements ci-dessous avant de présenter les chiffres.");
    expect($$(".company-finance-warnings li", result).map(textOf)).toEqual(["1 ligne sans montant ignorée."]);
    expect($$(".company-finance-notes li", result).map(textOf)).toEqual(["Format détecté : CSV point-virgule, dates JJ/MM/AAAA."]);
    expect(selectedFile()).toBeNull();
    expect(requestsAfter(before + 1)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);
    expect(rows(journal())).toHaveLength(1);
    expect(rows(journal())[0].slice(0, 5)).toEqual([formatTimestamp(IMPORTED_AT), "Relevé bancaire CSV", "2", "1", "2"]);
    expect(textOf($("summary", journal()))).toBe("2 remarques");

    await chooseFile(file);
    await click(findButton("Importer le relevé"));
    const sent = calls().filter((call) => call.request === `POST ${BASE}/ingestions/bank_statement_csv`);
    expect(sent.map((call) => call.init.headers["Idempotency-Key"])).toEqual([key, key]);
    expect(textOf($("strong", $(".company-finance-import-result"))))
      .toBe("Ce relevé avait déjà été importé avec la même clé : aucune écriture dupliquée.");
    expect(rows(journal())).toHaveLength(1);
  });

  test("annulation d’un import : confirmation, retrait des écritures restantes, journal à jour", async () => {
    serve({ batches: [BATCH] });
    await renderEntry();
    expect(caption(journal())).toBe("Imports les plus récents");
    expect(headers(journal())).toEqual(["Date", "Source", "Écritures", "Doublons ignorés", "Encore présentes", "Remarques", "Action"]);
    expect(rows(journal())[0].slice(0, 5)).toEqual([formatTimestamp(IMPORTED_AT), "Relevé bancaire CSV", "12", "3", "11"]);
    expect(textOf($("summary", journal()))).toBe("1 remarque");

    await click(findButton("Annuler l’import"));
    expect(findButton("Confirmer : retirer 11 écritures")).toBeDefined();
    await click(findButton("Garder", journal()));
    expect(findButton("Confirmer : retirer 11 écritures")).toBeUndefined();
    expect(mutations()).toEqual([]);

    await click(findButton("Annuler l’import"));
    const before = requests().length;
    await click(findButton("Confirmer : retirer 11 écritures"));
    expect(calls()[before]).toEqual({
      request: `DELETE ${BASE}/ingestions/${BATCH_ID}`,
      init: expect.objectContaining({ method: "DELETE", credentials: "include" }),
    });
    expect(feedback(journal())).toEqual(["Import annulé : ses écritures restantes ont été retirées."]);
    expect(requestsAfter(before + 1)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);
    expect(textOf($("p", journal()))).toBe("Aucun import pour l’instant.");
  });

  test("modèle CSV vierge : fichier UTF-8 avec BOM et en-têtes reconnus par l’import", async () => {
    serve();
    await renderEntry();
    await click(findButton("Modèle CSV vierge"));
    expect(alerts(importCard())).toEqual(["Téléchargement indisponible dans ce navigateur."]);

    jest.useFakeTimers();
    const downloads = [];
    URL.createObjectURL = jest.fn(() => "blob:modele");
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function download() {
      downloads.push(this.download);
    });
    await click(findButton("Modèle CSV vierge"));
    expect(downloads).toEqual(["modele-releve-bancaire-sirius.csv"]);
    expect(alerts(importCard())).toEqual([]);
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("text/csv;charset=utf-8");
    jest.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:modele");
    jest.useRealTimers();
    const bytes = await readBytes(blob);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(Buffer.from(bytes).toString("utf8")).toBe(BANK_CSV_TEMPLATE);
    // Même en-tête que le test de contrat backend (tests/test_finance_bank_statements.py).
    expect(BANK_CSV_TEMPLATE).toBe("\ufeffDate;Libellé;Débit;Crédit;Référence\r\n");
    expect(mutations()).toEqual([]);
  });
});

describe("journal d’audit et rechargements", () => {
  test("le journal d’audit ne se charge qu’à l’ouverture, puis suit chaque modification", async () => {
    serve({ entries: { revenues: [SALE] }, events: EVENTS });
    await renderEntry();
    expect(textOf($("summary", auditLog()))).toBe("Journal d’audit : qui a saisi, importé, supprimé ou modifié, et quand");
    expect(requests()).not.toContain(`GET ${BASE}/audit`);
    await openAudit();
    expect(requests().at(-1)).toBe(`GET ${BASE}/audit`);
    expect(headers(auditLog())).toEqual(["Date", "Auteur (identifiant)", "Action", "Objet", "Détail"]);
    expect(rows(auditLog())).toEqual([
      [formatTimestamp("2025-03-15T22:05:00Z"), "Caisse (POS)", "Import", "Caisse (POS)", "Import Caisse (POS) : 1 écriture(s)"],
      [formatTimestamp("2025-03-14T21:40:00Z"), ACTOR, "Saisie", "Recettes", "Recette du 14/03/2025"],
      [formatTimestamp("2025-03-01T09:00:00Z"), ACTOR, "Profil", "Profil", "—"],
    ]);

    await click(buttonLabelled(DELETE_SALE));
    const before = requests().length;
    await click(findButton("Confirmer la suppression"));
    expect(requestsAfter(before + 1)).toEqual([`GET ${BASE}/audit`, `GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);
    expect(rows(auditLog())).toHaveLength(4);
    expect(rows(auditLog())[0].slice(1)).toEqual([ACTOR, "Suppression", "Recettes", "Suppression de la pièce n° 41"]);
  });

  test("« Actualiser » et la période du tableau de bord rechargent les bonnes listes, sans relire le profil", async () => {
    serve({
      entries: {
        revenues: [SALE],
        inventories: [entry("inventories", 7, { date: "2025-03-01", allocation: "FOOD", value: "3200.00" })],
      },
    });
    await renderEntry();
    expect(requests()[0]).toBe(`GET ${BASE}/profile`);
    expect(requestsAfter(1)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);

    let before = requests().length;
    await renderEntry({ reloadKey: 1 });
    expect(requestsAfter(before)).toEqual([`GET ${BASE}/entries/revenues?${MARCH}`, JOURNAL]);

    before = requests().length;
    await renderEntry({ reloadKey: 1, query: { ...QUERY, start_date: "2025-04-01", end_date: "2025-04-30" } });
    expect(requestsAfter(before)).toEqual([`GET ${BASE}/entries/revenues?start_date=2025-04-01&end_date=2025-04-30&limit=${MAX_ENTRY_LIST}`]);
    expect(caption()).toBe("Recettes · du 01/04/2025 au 30/04/2025 · 0 pièce");
    expect(rows()).toEqual([["Aucune pièce sur cette période."]]);

    await click(findButton("Inventaires"));
    expect(rows()).toEqual([["01/03/2025", "Aliments", euros("3 200,00"), "Saisie manuelle", "Supprimer"]]);
    before = requests().length;
    await renderEntry({ reloadKey: 1, query: { ...QUERY, start_date: "2025-05-01", end_date: "2025-05-31" } });
    expect(requests()).toHaveLength(before);
    expect(requests().filter((request) => request === `GET ${BASE}/profile`)).toHaveLength(1);
  });

  test("liste indisponible puis tronquée : l’utilisateur est prévenu et la saisie reste possible", async () => {
    let failing = true;
    serve({
      routes: {
        [`GET ${BASE}/entries/revenues`]: () => (failing
          ? reply(500, { detail: "Internal Server Error" })
          : reply(200, { kind: "revenues", entries: [SALE], truncated: true })),
      },
    });
    await renderEntry();
    expect(alerts(entryList())).toEqual(["Service financier indisponible (HTTP 500). Réessayez sans modifier vos données."]);
    expect(entryForm()).not.toBeNull();
    failing = false;
    await renderEntry({ reloadKey: 1 });
    expect(alerts(entryList())).toEqual([]);
    expect(textOf($('[role="status"]', entryList())))
      .toBe(`Liste limitée aux ${MAX_ENTRY_LIST} pièces les plus récentes : réduisez la période pour tout afficher.`);
    expect(rows()).toEqual([SALE_ROW]);
  });
});

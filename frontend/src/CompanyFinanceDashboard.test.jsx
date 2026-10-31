import React, { act } from "react";
import { createRoot } from "react-dom/client";
import CompanyFinanceDashboard from "./CompanyFinanceDashboard";
import PortusNummarius from "./PortusNummarius";
import { API_BASE_URL } from "./lib/api";
import fixtures from "./__fixtures__/financeDashboardV2.json";
import {
  DEMO_NOTICE, DEMO_WINDOW_MESSAGE, INVALID_PAYLOAD_MESSAGE, SECTORS, SECTOR_KEYS, SECTOR_METRICS, TIMEOUT_MESSAGE,
  defaultQuery, financeCsvFilename, formatMetric, localToday, periodPresets,
} from "./companyFinance";

jest.mock("./voice", () => ({ speakAsCharacter: jest.fn() }));
jest.mock("recharts", () => ({
  AreaChart: () => null, Area: () => null, XAxis: () => null, YAxis: () => null,
  Tooltip: () => null, ResponsiveContainer: () => null, CartesianGrid: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NNBSP = "\u202f";
const NBSP = "\u00a0";
const COMPANY = Object.freeze({ id: "company_a", name: "Entreprise test" });
const CONTEXT = Object.freeze({ company: COMPANY, membership: { company_id: COMPANY.id, role: "manager" } });
const PROFILE_MISSING = "Profil financier d’entreprise introuvable : créez-le dans « Saisie & imports ».";
const SOURCES = Object.freeze({ CONSTRUCTION: fixtures.dashboard, ...fixtures.sectors });
const DEMO_2025 = "start_date=2025-01-01&end_date=2025-12-31&comparison=year_ago";
const originalPrint = window.print;
let host;
let root;
let originalFetch;
let consoleErrors;

const clone = (value) => JSON.parse(JSON.stringify(value));
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const realQuery = () => defaultQuery(false, localToday());
const dashboardPath = ({ start_date: start, end_date: end, comparison = "year_ago" }) =>
  `/finance/${COMPANY.id}/dashboard?start_date=${start}&end_date=${end}&comparison=${comparison}`;
const descriptionOf = (sector) => fixtures.catalog.companies.find((item) => item.company.sector === sector).description;

// Vraie réponse du moteur recalée sur la requête : période, comparaison, entreprise et nature des données.
function payloadFor(sector, params, { demo = false } = {}) {
  const data = clone(SOURCES[sector]);
  data.demo = demo;
  if (!demo) data.company = { ...data.company, ...COMPANY };
  data.period = { start_date: params.get("start_date"), end_date: params.get("end_date") };
  data.monthly = data.monthly.slice(0, 1).map((point) => ({ ...point, period: { ...data.period } }));
  const comparison = params.get("comparison");
  data.comparison = comparison === "none" ? null : { ...data.comparison, mode: comparison };
  return data;
}

// Faux serveur : toute URL inattendue reçoit un 404 visible dans l’interface.
function serve({ context = () => reply(200, CONTEXT), sector = "SERVICES", dashboard = null, routes = {}, fallback = null } = {}) {
  global.fetch = jest.fn((url, init = {}) => {
    const [path, search = ""] = String(url).slice(API_BASE_URL.length).split("?");
    const params = new URLSearchParams(search);
    if (routes[path]) return routes[path](params, init);
    if (path === "/enterprise/context") return context();
    if (path === "/finance/demo/companies") return reply(200, fixtures.catalog);
    const demo = path.match(/^\/finance\/demo\/([A-Z]+)\/dashboard$/);
    if (demo) return reply(200, payloadFor(demo[1], params, { demo: true }));
    if (path === `/finance/${COMPANY.id}/dashboard`) {
      return dashboard ? dashboard(params, init) : reply(200, payloadFor(sector, params));
    }
    return fallback ? fallback(path) : reply(404, { detail: `Route inattendue : ${path}` });
  });
}

const paths = () => global.fetch.mock.calls.map(([url]) => String(url).slice(API_BASE_URL.length));
const lastPath = () => paths().at(-1);
const report = () => host.querySelector('[data-testid="company-finance-report"]');
const heading = () => host.querySelector("#company-finance-heading").textContent;
const badge = () => host.querySelector(".company-finance-badge").textContent.trim();
const periodForm = () => host.querySelector('form[aria-label="Période analysée"]');
const submitButton = () => periodForm().querySelector('button[type="submit"]');
const formAlert = () => periodForm().querySelector('[role="alert"]');
const loadError = () => host.querySelector('.company-finance-error [role="alert"]');
const feedback = () => report().querySelector(".company-finance-feedback")?.textContent ?? null;
const card = (metric) => report().querySelector(`.company-finance-metric[data-metric="${metric}"]`);
const findButton = (label, scope = host) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === label);

async function click(target) {
  if (!target) throw new Error("Bouton introuvable.");
  await act(async () => target.click());
}

async function renderDashboard() {
  await act(async () => root.render(<CompanyFinanceDashboard />));
}

async function setValue(id, value) {
  const input = host.querySelector(`#${id}`);
  const select = input instanceof HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor((select ? HTMLSelectElement : HTMLInputElement).prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event(select ? "change" : "input", { bubbles: true }));
  });
}

async function submitPeriod() {
  await act(async () => periodForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
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
  window.print = originalPrint;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  document.getElementById("sirius-print-root")?.remove();
  jest.useRealTimers();
  const errors = consoleErrors;
  jest.restoreAllMocks();
  expect(errors).toEqual([]);
});

describe("données réelles de l’entreprise", () => {
  test.each(SECTOR_KEYS)("%s : rapport complet calculé pour l’entreprise rattachée", async (sector) => {
    serve({ sector });
    await renderDashboard();
    expect(paths()).toEqual(["/enterprise/context", dashboardPath(realQuery())]);
    global.fetch.mock.calls.forEach(([, init]) => {
      expect(init).toEqual(expect.objectContaining({ method: "GET", credentials: "include" }));
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
    expect(heading()).toBe(COMPANY.name);
    expect(host.querySelector(".numm-tech-hero").textContent).toContain(SECTORS[sector]);
    expect(badge()).toBe("Lecture seule");
    const sectorGrid = report().querySelector('dl[aria-label="Indicateurs métier"]');
    expect([...sectorGrid.querySelectorAll("[data-metric]")].map((node) => node.dataset.metric)).toEqual([...SECTOR_METRICS[sector]]);
    const sig = [...report().querySelectorAll("table.company-finance-sig tbody tr")].map((row) => row.dataset.metric);
    expect(sig[0]).toBe("revenue_ht");
    expect(sig.at(-1)).toBe("caf_after_principal");
    const { common, company } = SOURCES[sector];
    expect(card("revenue_ht").querySelector("dd").textContent).toBe(formatMetric("revenue_ht", common.revenue_ht, company.currency));
    expect(report().querySelector('[aria-label="Marges par chantier"]') !== null).toBe(sector === "CONSTRUCTION");
    expect(report().textContent).not.toMatch(/NaN|undefined|\[object Object\]|\d[eE][+-]\d/);
    expect(host.textContent).not.toContain(DEMO_NOTICE);
    expect(host.querySelector('[role="note"]')).toBeNull();
  });

  test("valeurs négatives, non calculables, seuils et alertes triées par priorité", async () => {
    serve({
      dashboard: (params) => {
        const data = payloadFor("CONSTRUCTION", params);
        data.common.closing_cash = "-1520.40";
        data.banking.debt_service_coverage = "0.85";
        data.banking.cash_days = null;
        data.banking.loan_principal_repaid = "0.00";
        data.alerts = [
          { code: "ESTIMATE", severity: "info", message: "Indicateurs de gestion." },
          { code: "NEGATIVE_CASH", severity: "critical", message: "Trésorerie négative." },
          { code: "LOW_DSCR", severity: "warning", message: "Couverture des annuités insuffisante." },
        ];
        return reply(200, data);
      },
    });
    await renderDashboard();
    const closing = card("closing_cash").querySelector("dd");
    expect(closing.textContent).toBe(`−1${NNBSP}520,40${NBSP}€`);
    expect(closing.dataset.negative).toBe("true");
    expect(card("revenue_ht").querySelector("dd").textContent).toBe(`146${NNBSP}680,61${NBSP}€`);
    expect(card("revenue_ht").querySelector("dd").dataset.negative).toBeUndefined();
    expect(card("debt_service_coverage").dataset.status).toBe("critical");
    expect(card("debt_service_coverage").querySelector("dd").textContent).toBe(`0,85${NBSP}fois`);
    expect(card("debt_service_coverage").textContent).toContain("Seuil critique");
    expect(card("cash_days").dataset.status).toBeUndefined();
    expect(card("cash_days").querySelector("dd").textContent).toBe("Non calculable");
    expect(card("cash_days").textContent).toContain("Trésorerie de clôture négative.");
    const principal = report().querySelector('tr[data-metric="loan_principal_repaid"] td');
    expect(principal.textContent).toBe(`0,00${NBSP}€`);
    expect(principal.dataset.negative).toBeUndefined();
    const alerts = [...report().querySelectorAll(".company-finance-alerts li")];
    expect(alerts.map((item) => item.dataset.severity)).toEqual(["critical", "warning", "info"]);
    expect(alerts.map((item) => item.querySelector(".company-finance-alert-label").textContent))
      .toEqual(["Prioritaire", "À surveiller", "Information"]);
    expect(alerts[0].querySelector("p").textContent).toBe("Trésorerie négative.");
  });

  test.each([
    ["aucune entreprise rattachée", () => reply(200, { company: null, membership: null }), "Rattachement nécessaire",
      "Aucune entreprise rattachée à ce compte."],
    ["simple lecteur", () => reply(200, { company: COMPANY, membership: { company_id: COMPANY.id, role: "viewer" } }),
      "Accès entreprise", "réservé aux administrateurs et gestionnaires"],
    ["session expirée", () => reply(401, { detail: "Not authenticated" }), "Accès entreprise",
      "Session expirée : reconnectez-vous pour accéder à la finance d’entreprise."],
    ["serveur injoignable", () => Promise.reject(new TypeError("Failed to fetch")), "Accès entreprise",
      "Serveur ΣIRIUS injoignable"],
  ])("%s : aucun chiffre demandé, la démonstration reste accessible", async (_, context, title, message) => {
    serve({ context });
    await renderDashboard();
    expect(paths()).toEqual(["/enterprise/context"]);
    const notice = host.querySelector(".company-finance-notice");
    expect(notice.querySelector("h3").textContent).toBe(title);
    expect(notice.textContent).toContain(message);
    expect(report()).toBeNull();
    await click(findButton("Explorer la démonstration fictive"));
    expect(paths().slice(1)).toEqual(["/finance/demo/companies", `/finance/demo/HOSPITALITY/dashboard?${DEMO_2025}`]);
    expect(heading()).toBe(SOURCES.HOSPITALITY.company.name);
    expect(report().querySelector('[role="note"]').textContent).toBe(DEMO_NOTICE);
  });

  test.each([
    [403, { detail: "Entreprise inaccessible." }, "Entreprise inaccessible."],
    [404, { detail: "Not Found" }, "Ressource financière introuvable."],
    [429, {}, "Trop de requêtes : patientez quelques secondes avant de réessayer."],
    [503, null, "Service financier indisponible (HTTP 503). Réessayez sans modifier vos données."],
  ])("HTTP %i : message explicite en français, puis nouvel essai", async (status, body, message) => {
    let failures = 1;
    serve({
      dashboard: (params) => {
        failures -= 1;
        return failures >= 0 ? reply(status, body) : reply(200, payloadFor("SERVICES", params));
      },
    });
    await renderDashboard();
    expect(loadError().textContent).toBe(message);
    expect(report()).toBeNull();
    await click(findButton("Réessayer"));
    expect(loadError()).toBeNull();
    expect(report()).not.toBeNull();
    expect(paths().slice(1)).toEqual([dashboardPath(realQuery()), dashboardPath(realQuery())]);
  });

  test.each([
    ["montant transmis en nombre flottant", (data) => { data.common.revenue_ht = 146680.61; }],
    ["autre entreprise", (data) => { data.company.id = "company_b"; }],
    ["démonstration présentée comme réelle", (data) => { data.demo = true; }],
    ["période différente de la demande", (data) => { data.period.start_date = "2000-01-01"; }],
    ["ancienne méthode de calcul", (data) => { data.calculation_version = "1"; }],
  ])("réponse refusée (%s) : aucun chiffre affiché", async (_, corrupt) => {
    serve({
      dashboard: (params) => {
        const data = payloadFor("SERVICES", params);
        corrupt(data);
        return reply(200, data);
      },
    });
    await renderDashboard();
    expect(loadError().textContent).toBe(INVALID_PAYLOAD_MESSAGE);
    expect(report()).toBeNull();
    expect(findButton("Réessayer")).toBeDefined();
  });

  test("profil financier absent : invitation à configurer, puis formulaire de création", async () => {
    serve({
      dashboard: () => reply(404, { detail: PROFILE_MISSING }),
      routes: { [`/finance/${COMPANY.id}/profile`]: () => reply(200, { profile: null }) },
    });
    await renderDashboard();
    const notice = host.querySelector(".company-finance-notice");
    expect(notice.querySelector("h3").textContent).toBe("Profil financier à créer");
    expect(notice.querySelector('[role="status"]').textContent).toBe(PROFILE_MISSING);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await click(findButton("Configurer et saisir"));
    expect(findButton("Saisie & imports").getAttribute("aria-pressed")).toBe("true");
    expect(badge()).toBe("Saisie tracée");
    expect(host.querySelector("#company-finance-profile-title").textContent).toBe("Créer le profil financier");
    expect(host.querySelector("#company-finance-profile-name").value).toBe(COMPANY.name);
    expect(paths().slice(2)).toEqual([`/finance/${COMPANY.id}/profile`]);
  });

  test("pendant le calcul, le formulaire est verrouillé ; une réponse tardive est ignorée", async () => {
    let release;
    serve({
      dashboard: (params) => new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => payloadFor("SERVICES", params) });
      }),
    });
    await renderDashboard();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent.trim()).toBe("Chargement…");
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.textContent).toContain("Calcul sécurisé du tableau de bord…");
    const signal = global.fetch.mock.calls[1][1].signal;
    await click(findButton("Démonstration fictive"));
    expect(signal.aborted).toBe(true);
    await act(async () => release());
    expect(heading()).toBe(SOURCES.HOSPITALITY.company.name);
    expect(report().textContent).toContain(DEMO_NOTICE);
    expect(report().textContent).not.toContain(COMPANY.name);
  });
});

describe("période et comparaison", () => {
  test("les dates saisies ne sont appliquées qu’après validation explicite", async () => {
    serve();
    await renderDashboard();
    expect(submitButton().textContent.trim()).toBe("Actualiser");
    await setValue("company-finance-start", "2024-01-01");
    await setValue("company-finance-end", "2024-03-31");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(submitButton().textContent.trim()).toBe("Appliquer la période");
    expect(periodForm().textContent).toContain("Filtres modifiés, à appliquer.");
    await submitPeriod();
    expect(lastPath()).toBe(dashboardPath({ start_date: "2024-01-01", end_date: "2024-03-31" }));
    expect(report().querySelector("header").textContent).toContain("Période du 01/01/2024 au 31/03/2024 (91 jours)");
    expect(submitButton().textContent.trim()).toBe("Actualiser");
    expect(periodForm().textContent).toContain("Aucune écriture comptable effectuée.");
    await submitPeriod();
    expect(global.fetch).toHaveBeenCalledTimes(4);
    expect(lastPath()).toBe(paths()[2]);
  });

  test.each([
    ["fin avant début", "2026-01-31", "2026-01-01", "Saisissez une période valide"],
    ["plus de 10 ans", "2014-01-01", "2024-12-31", "Période limitée à 10 ans."],
    ["date effacée", "", "2024-12-31", "Saisissez une période valide"],
  ])("période invalide (%s) : message, aucune requête, rapport précédent conservé", async (_, start, end, message) => {
    serve();
    await renderDashboard();
    await setValue("company-finance-start", start);
    await setValue("company-finance-end", end);
    await submitPeriod();
    expect(formAlert().textContent).toContain(message);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(report()).not.toBeNull();
  });

  test("le mode de comparaison s’applique immédiatement", async () => {
    serve({ sector: "CONSTRUCTION" });
    await renderDashboard();
    const query = realQuery();
    expect(report().querySelector(".company-finance-comparison summary").textContent).toContain("Même période N-1");
    await setValue("company-finance-comparison", "previous");
    expect(lastPath()).toBe(dashboardPath({ ...query, comparison: "previous" }));
    expect(report().querySelector("table.company-finance-sig thead").textContent).toContain("Période précédente");
    expect(card("revenue_ht").textContent).toContain("vs période précédente");
    await setValue("company-finance-comparison", "none");
    expect(lastPath()).toBe(dashboardPath({ ...query, comparison: "none" }));
    expect(report().querySelector("header").textContent).toContain("Sans comparaison");
    expect(report().querySelector(".company-finance-comparison")).toBeNull();
    expect(report().querySelectorAll("table.company-finance-sig thead th")).toHaveLength(3);
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  test("une période rapide recalcule directement le tableau", async () => {
    serve();
    await renderDashboard();
    const presets = periodPresets(localToday());
    const group = host.querySelector('[aria-label="Périodes rapides"]');
    expect(findButton(presets[0].label, group).getAttribute("aria-pressed")).toBe("true");
    const preset = presets.find((item) => item.id === "previous-year");
    await click(findButton(preset.label, group));
    expect(lastPath()).toBe(dashboardPath(preset));
    expect(findButton(preset.label, group).getAttribute("aria-pressed")).toBe("true");
    expect(findButton(presets[0].label, group).getAttribute("aria-pressed")).toBe("false");
    expect(host.querySelector("#company-finance-start").value).toBe(preset.start_date);
    expect(host.querySelector("#company-finance-end").value).toBe(preset.end_date);
  });
});

describe("démonstration fictive", () => {
  test("catalogue, avertissements et entreprise fictive de chaque secteur, sans mélange avec le réel", async () => {
    serve();
    await renderDashboard();
    await click(findButton("Démonstration fictive"));
    expect(paths().slice(2)).toEqual(["/finance/demo/companies", `/finance/demo/HOSPITALITY/dashboard?${DEMO_2025}`]);
    const panel = host.querySelector(".company-finance-demo-panel");
    expect(panel.querySelector('[role="note"]').textContent).toBe(fixtures.catalog.notice);
    expect(panel.textContent).toContain(descriptionOf("HOSPITALITY"));
    expect(report().querySelector('[role="note"]').textContent).toBe(DEMO_NOTICE);
    expect(report().querySelector(".numm-tech-disclaimer").textContent).toContain(DEMO_NOTICE);
    expect(host.querySelector("#company-finance-start").value).toBe("2025-01-01");
    expect(host.querySelector("#company-finance-start").min).toBe("2023-01-01");
    await click(findButton(SECTORS.RETAIL, host.querySelector('[aria-label="Entreprise fictive"]')));
    expect(lastPath()).toBe(`/finance/demo/RETAIL/dashboard?${DEMO_2025}`);
    expect(heading()).toBe(SOURCES.RETAIL.company.name);
    expect(host.querySelector(".company-finance-demo-panel").textContent).toContain(descriptionOf("RETAIL"));
    await click(findButton("Mon entreprise"));
    expect(lastPath()).toBe(dashboardPath(realQuery()));
    expect(heading()).toBe(COMPANY.name);
    expect(host.textContent).not.toContain(DEMO_NOTICE);
    expect(host.querySelector(".company-finance-demo-panel")).toBeNull();
  });

  test("hors de la fenêtre 2023-2025 : message et aucune requête", async () => {
    serve();
    await renderDashboard();
    await click(findButton("Démonstration fictive"));
    const count = global.fetch.mock.calls.length;
    await setValue("company-finance-start", "2022-12-01");
    await submitPeriod();
    expect(formAlert().textContent).toBe(DEMO_WINDOW_MESSAGE);
    expect(global.fetch).toHaveBeenCalledTimes(count);
    await click(findButton("Année 2024", host.querySelector('[aria-label="Périodes rapides"]')));
    expect(lastPath()).toBe("/finance/demo/HOSPITALITY/dashboard?start_date=2024-01-01&end_date=2024-12-31&comparison=year_ago");
    expect(formAlert()).toBeNull();
  });

  test("les pièces de démonstration restent en lecture seule", async () => {
    serve({
      routes: {
        "/finance/demo/HOSPITALITY/entries/revenues": () => reply(200, { kind: "revenues", entries: [], truncated: false }),
      },
    });
    await renderDashboard();
    await click(findButton("Démonstration fictive"));
    await click(findButton("Saisie & imports"));
    expect(badge()).toBe("Lecture seule");
    expect(host.querySelector('[data-testid="company-finance-entry"]').textContent).toContain("Pièces fictives de démonstration, en lecture seule");
    expect(lastPath()).toBe("/finance/demo/HOSPITALITY/entries/revenues?start_date=2025-01-01&end_date=2025-12-31&limit=500");
    expect(host.querySelector('form[aria-label^="Nouvelle pièce"]')).toBeNull();
    expect(host.querySelector("#company-finance-bank-file")).toBeNull();
    expect(paths().some((path) => path.startsWith(`/finance/${COMPANY.id}/`) && !path.includes("/dashboard"))).toBe(false);
  });
});

describe("export et impression", () => {
  test("export CSV : fichier UTF-8 avec BOM, nommé d’après l’entreprise et la période", async () => {
    serve({ sector: "CONSTRUCTION" });
    await renderDashboard();
    await click(findButton("Export CSV"));
    expect(feedback()).toBe("Export indisponible dans ce navigateur.");

    jest.useFakeTimers();
    const downloads = [];
    URL.createObjectURL = jest.fn(() => "blob:finance");
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function download() {
      downloads.push(this.download);
    });
    await click(findButton("Export CSV"));
    expect(downloads).toEqual([financeCsvFilename({ company: COMPANY, period: realQuery() })]);
    expect(feedback()).toContain("Export CSV généré");
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("text/csv;charset=utf-8");
    jest.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:finance");
    jest.useRealTimers();
    const bytes = await readBytes(blob);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).toContain(COMPANY.name);
    expect(text).toContain("CH-2025-02 Rénovation de boutique");
  });

  test("impression : seul le rapport nettoyé est imprimé, puis la page est restaurée", async () => {
    serve({ sector: "CONSTRUCTION" });
    await renderDashboard();
    window.print = undefined;
    await click(findButton("Imprimer / PDF"));
    expect(feedback()).toBe("Impression indisponible dans cet environnement.");

    const title = document.title;
    let printed = null;
    window.print = jest.fn(() => {
      const printRoot = document.getElementById("sirius-print-root");
      printed = {
        title: document.title,
        text: printRoot.textContent,
        buttons: printRoot.querySelectorAll("button").length,
        closedDetails: [...printRoot.querySelectorAll("details")].filter((item) => !item.open).length,
        ids: printRoot.querySelectorAll("[id]").length,
      };
    });
    await click(findButton("Imprimer / PDF"));
    const query = realQuery();
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(printed).toEqual({
      title: `ΣIRIUS – ${COMPANY.name} – ${query.start_date} au ${query.end_date}`,
      text: expect.stringContaining("Formation du résultat"),
      buttons: 0,
      closedDetails: 0,
      ids: 0,
    });
    expect(printed.text).toContain("Méthode et définitions des indicateurs");
    expect(printed.text).not.toContain("Impression indisponible");
    expect(feedback()).toBeNull();
    await act(async () => window.dispatchEvent(new Event("afterprint")));
    expect(document.getElementById("sirius-print-root")).toBeNull();
    expect(document.title).toBe(title);
  });
});

describe("robustesse et intégration", () => {
  test("délai maximal de 30 secondes : message visible et nouvel essai possible", async () => {
    jest.useFakeTimers();
    serve({
      dashboard: (params, { signal }) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    });
    await renderDashboard();
    expect(host.textContent).toContain("Calcul sécurisé du tableau de bord…");
    await act(async () => jest.advanceTimersByTime(30000));
    expect(loadError().textContent).toBe(TIMEOUT_MESSAGE);
    expect(global.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(submitButton().disabled).toBe(false);
    expect(findButton("Réessayer")).toBeDefined();
  });

  test("quitter l’onglet annule les requêtes en cours et ignore les réponses tardives", async () => {
    let finish;
    global.fetch = jest.fn(() => new Promise((resolve) => { finish = resolve; }));
    await renderDashboard();
    const signal = global.fetch.mock.calls[0][1].signal;
    await act(async () => root.render(<p>Autre fenêtre</p>));
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ ok: true, status: 200, json: async () => CONTEXT }));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("Autre fenêtre");
  });

  test("NUMMARIUS garde sa fenêtre et ses onglets ; la finance ne se charge qu’à la demande", async () => {
    serve({ fallback: (path) => reply(200, path.endsWith("/alerts") ? { alerts: [] } : { assets: [], errors: [] }) });
    const onClose = jest.fn();
    await act(async () => root.render(<PortusNummarius onClose={onClose} />));
    expect(paths().some((path) => path.includes("/enterprise/") || path.includes("/finance/"))).toBe(false);
    const panel = host.querySelector('[data-testid="nummarius-panel"]');
    const tab = [...host.querySelectorAll("nav button")].find((button) => button.textContent === "Finance d’entreprise");
    await click(tab);
    expect(host.querySelector('[data-testid="nummarius-panel"]')).toBe(panel);
    expect(host.querySelectorAll("nav button")).toHaveLength(4);
    expect(tab.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector('[data-testid="nummarius-refresh-btn"]')).toBeNull();
    expect(host.querySelector('[data-testid="company-finance-dashboard"]')).not.toBeNull();
    expect(paths().filter((path) => path.startsWith("/enterprise/") || path.startsWith("/finance/")))
      .toEqual(["/enterprise/context", dashboardPath(realQuery())]);
    await click(host.querySelector('[data-testid="nummarius-close-btn"]'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

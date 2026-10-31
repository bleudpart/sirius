import React, { act } from "react";
import { createRoot } from "react-dom/client";
import CompanyFinanceDashboard from "./CompanyFinanceDashboard";
import CompanyFinanceSimulation from "./CompanyFinanceSimulation";
import { API_BASE_URL } from "./lib/api";
import fixtures from "./__fixtures__/financeDashboardV2.json";
import simulation from "./__fixtures__/financeSimulation.json";
import {
  DEMO_NOTICE, INVALID_PAYLOAD_MESSAGE, NOT_CERTIFIED_NOTICE, SECTORS, SIMULATION_DISCLAIMER, SIMULATION_LEVERS,
  SIMULATION_NOTICE, THRESHOLDS, TIMEOUT_MESSAGE, defaultQuery, describePeriod, localToday, periodPresets,
} from "./companyFinance";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NNBSP = "\u202f";
const NBSP = "\u00a0";
const MINUS = "\u2212";
// « -1 476,00 » → « −1 476,00 € » : espaces fines insécables, vrai signe moins, espace insécable avant l’euro.
const eur = (text) => `${text.replace(/ /g, NNBSP).replace("-", MINUS)}${NBSP}€`;
const COMPANY = Object.freeze({ id: "company_a", name: "Entreprise test" });
const CONTEXT = Object.freeze({ company: COMPANY, membership: { company_id: COMPANY.id, role: "manager" } });
const PROFILE_MISSING = "Profil financier d’entreprise introuvable : créez-le dans « Saisie & imports ».";
const QUERY = Object.freeze({ start_date: "2025-01-01", end_date: "2025-12-31", comparison: "year_ago" });
const PERIOD = "start_date=2025-01-01&end_date=2025-12-31";
const STRESS = `/finance/${COMPANY.id}/stress-test`;
const DEMO_STRESS = "/finance/demo/HOSPITALITY/stress-test";
// Saisie telle qu’un gérant la tape : signe moins typographique, espaces de milliers, virgule décimale.
const RUPTURE_INPUT = Object.freeze({
  delta_ca_percent: `${MINUS}15`, delta_cout_matiere_percent: "+5", charge_fixe_additionnelle_mensuelle: "2 800,00",
  investissement_emprunt_mensualite: "450", duree_mois: "6", jours_ouverture_mois: "30", solde_tresorerie_actuel: "15 000",
});
const RUPTURE_LEVERS = Object.freeze({
  delta_ca_percent: "-15", delta_cout_matiere_percent: "5", charge_fixe_additionnelle_mensuelle: "2800.00",
  investissement_emprunt_mensualite: "450", duree_mois: 6, jours_ouverture_mois: "30", solde_tresorerie_actuel: "15000",
});
const RUPTURE_BODY = Object.freeze({ id_entreprise: COMPANY.id, ...RUPTURE_LEVERS });
const NO_CASH_INPUT = Object.freeze({
  delta_ca_percent: "5", delta_cout_matiere_percent: "0", charge_fixe_additionnelle_mensuelle: "2800",
  investissement_emprunt_mensualite: "0", duree_mois: "12", jours_ouverture_mois: "30", solde_tresorerie_actuel: "",
});
const DEMO_VALUES = ["-15", "5", "2800", "450", "6", "26", ""];
const originalPrint = window.print;
let host;
let root;
let originalFetch;
let consoleErrors;

const clone = (value) => JSON.parse(JSON.stringify(value));
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
// Requête sans réponse : seule une annulation la termine.
const pending = (params, { signal }) => new Promise((_, reject) => {
  signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
});

// Vraie réponse du moteur (backend/tests/test_finance_simulation.py), recalée sur la période demandée.
function responseFor(name, params) {
  const data = clone(simulation.cases[name].response);
  data.periode_reference = { start_date: params.get("start_date"), end_date: params.get("end_date") };
  return data;
}

// Faux serveur : tableau de bord en attente, stress test « rupture » ; toute URL inattendue reçoit un 404 visible.
function serve({ stress = (params) => reply(200, responseFor("rupture", params)) } = {}) {
  global.fetch = jest.fn((url, init = {}) => {
    const [path, search = ""] = String(url).slice(API_BASE_URL.length).split("?");
    const params = new URLSearchParams(search);
    if (path === STRESS) return stress(params, init);
    if (path === DEMO_STRESS) return reply(200, responseFor("demo", params));
    if (path === "/enterprise/context") return reply(200, CONTEXT);
    if (path === "/finance/demo/companies") return reply(200, fixtures.catalog);
    if (path.endsWith("/dashboard")) return pending(params, init);
    return reply(404, { detail: `Route inattendue : ${path}` });
  });
}

const pathOf = ([url]) => String(url).slice(API_BASE_URL.length);
const paths = () => global.fetch.mock.calls.map(pathOf);
const stressCalls = () => global.fetch.mock.calls.filter((call) => pathOf(call).includes("/stress-test"));
const bodyOf = (call) => JSON.parse(call[1].body);
const simReport = () => host.querySelector('[data-testid="company-finance-simulation-report"]');
const simForm = () => host.querySelector(".company-finance-simulation-form");
const launchButton = () => simForm().querySelector('button[type="submit"]');
const field = (name) => host.querySelector(`#company-finance-sim-${name}`);
const fieldValues = () => SIMULATION_LEVERS.map((item) => field(item.name).value);
const fieldError = (name) => host.querySelector(`#company-finance-sim-${name}-error`)?.textContent ?? null;
const formAlert = () => simForm().querySelector('[role="alert"]')?.textContent ?? null;
const editedNote = () => simForm().querySelector('[role="status"]')?.textContent.trim() ?? null;
const loadError = () => host.querySelector('.company-finance-error [role="alert"]')?.textContent ?? null;
const feedback = () => simReport().querySelector(".company-finance-feedback")?.textContent ?? null;
const card = (metric) => simReport().querySelector(`.company-finance-metric[data-metric="${metric}"]`);
const cardValue = (metric) => card(metric).querySelector("dd").textContent;
const cardNotes = (metric) => [...card(metric).querySelectorAll("small")].map((node) => node.textContent);
const cells = (row) => [...row.querySelectorAll("th, td")].map((cell) => cell.textContent);
const tableRow = (metric) => cells(simReport().querySelector(`tr[data-metric="${metric}"]`));
const cashSection = () => simReport().querySelector('[aria-labelledby="company-finance-sim-cash"]');
const milestones = () => [...cashSection().querySelectorAll("tr[data-milestone]")].map(cells);
const rupture = () => host.querySelector('[data-testid="company-finance-rupture"]');
const ruptureTexts = () => [...rupture().querySelectorAll("p")].map((node) => node.textContent);
const severities = () => [...simReport().querySelectorAll(".company-finance-alerts li")].map((node) => node.dataset.severity);
const findButton = (label, scope = host) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
const reportHead = () => simReport().querySelector(".company-finance-report-head p:not(.company-finance-kicker)").textContent;
const realQuery = () => defaultQuery(false, localToday());
const stressPath = ({ start_date: start, end_date: end }) => `${STRESS}?start_date=${start}&end_date=${end}`;
const heading = () => host.querySelector("#company-finance-heading").textContent;
const badge = () => host.querySelector(".company-finance-badge").textContent.trim();
const periodForm = () => host.querySelector('form[aria-label="Période analysée"]');
const filterNote = () => periodForm().querySelector(".company-finance-filter-note").textContent;
const pressed = (label) => findButton(label).getAttribute("aria-pressed");
const NEUTRAL_VALUES = ["0", "0", "0", "0", "12", "30", ""];

async function click(target) {
  if (!target) throw new Error("Bouton introuvable.");
  await act(async () => target.click());
}

async function fill(values) {
  for (const [name, value] of Object.entries(values)) {
    const input = field(name);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

async function launch() {
  await act(async () => simForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

async function renderSimulation(props = {}) {
  await act(async () => root.render(<CompanyFinanceSimulation companyId={COMPANY.id} query={QUERY} {...props} />));
}

async function renderDashboard() {
  await act(async () => root.render(<CompanyFinanceDashboard />));
}

async function simulate(values = RUPTURE_INPUT, props = {}) {
  await renderSimulation(props);
  await fill(values);
  await launch();
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

describe("simulation d’une entreprise réelle", () => {
  test("rien n’est calculé avant le clic ; formulaire accessible, scénario neutre par défaut", async () => {
    serve();
    await renderSimulation();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(simReport()).toBeNull();
    expect(fieldValues()).toEqual(NEUTRAL_VALUES);
    const revenue = field("delta_ca_percent");
    expect(host.querySelector(`label[for="${revenue.id}"]`).textContent).toBe("Variation du chiffre d’affaires (%)");
    expect(host.querySelector('label[for="company-finance-sim-solde_tresorerie_actuel"]').textContent)
      .toBe("Solde de trésorerie actuel (facultatif)");
    expect(revenue.required).toBe(true);
    expect(field("solde_tresorerie_actuel").required).toBe(false);
    expect(revenue.getAttribute("aria-describedby")).toBe(`${revenue.id}-help`);
    expect(revenue.hasAttribute("aria-invalid")).toBe(false);
    // Leviers signés : clavier complet sur mobile pour garder le signe moins.
    expect(revenue.hasAttribute("inputmode")).toBe(false);
    expect(field("duree_mois").getAttribute("inputmode")).toBe("numeric");
    expect(field("investissement_emprunt_mensualite").getAttribute("inputmode")).toBe("decimal");
    expect(simForm().textContent).toContain("moyennes mensuelles HT du 01/01/2025 au 31/12/2025");
    expect(simForm().textContent).toContain("aucune pièce, aucun solde ni aucun journal d’audit n’est modifié");
    expect(launchButton().textContent.trim()).toBe("Lancer la simulation");
  });

  test("rupture : saisie à la française, charge utile exacte et rapport complet pour le banquier", async () => {
    serve();
    const onSaved = jest.fn();
    await simulate(RUPTURE_INPUT, { onSaved });
    expect(paths()).toEqual([`${STRESS}?${PERIOD}`]);
    const [, init] = global.fetch.mock.calls[0];
    expect(init).toEqual(expect.objectContaining({
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(bodyOf(global.fetch.mock.calls[0])).toEqual(RUPTURE_BODY);
    expect(onSaved).toHaveBeenCalledWith({ values: { ...RUPTURE_INPUT }, request: { levers: RUPTURE_LEVERS } });
    expect(formAlert()).toBeNull();
    expect(launchButton().disabled).toBe(false);

    const report = simReport();
    const [sector, projection] = [...report.querySelectorAll(".company-finance-report-head p:not(.company-finance-kicker)")];
    expect(report.querySelector(".company-finance-kicker").textContent).toBe("ΣIRIUS · STRESS TEST");
    expect(report.querySelector("#company-finance-sim-title").textContent).toBe(COMPANY.name);
    expect(sector.textContent).toBe(`${SECTORS.HOSPITALITY} · Référence du 01/01/2025 au 31/12/2025 (12${NBSP}mois) · EUR`);
    expect(projection.textContent).toMatch(new RegExp(`^Projection sur 6${NBSP}mois · Calculé le .+ · méthode v1$`));
    expect([...report.querySelectorAll("[data-lever]")].map((node) => node.textContent)).toEqual([
      `Variation du chiffre d’affaires : ${MINUS}15${NBSP}%`,
      `Variation du coût matière : +5${NBSP}%`,
      `Charge fixe additionnelle mensuelle : +${eur("2 800,00")} HT par mois`,
      `Mensualité du nouvel emprunt : ${eur("450,00")} par mois`,
      `Durée de projection : 6${NBSP}mois`,
      `Jours d’ouverture par mois : 30${NBSP}jours`,
      `Solde de trésorerie actuel : ${eur("15 000,00")}`,
    ]);
    expect(report.querySelector(".company-finance-demo-banner")).toBeNull();
    expect(report.querySelector(".company-finance-simulation-notice").textContent).toBe(SIMULATION_NOTICE);
    expect(report.querySelector(".numm-tech-disclaimer").textContent).toBe(`${SIMULATION_DISCLAIMER} ${NOT_CERTIFIED_NOTICE}`);

    expect(cardValue("point_mort_journalier")).toBe(eur("1 299,81"));
    expect(cardNotes("point_mort_journalier")).toEqual([`Avant : ${eur("1 119,05")} · 30${NBSP}jours d’ouverture par mois`]);
    expect(cardValue("ca_supplementaire")).toBe(eur("4 994,17"));
    expect(cardValue("ebe_projete")).toBe(eur("-1 476,00"));
    expect(card("ebe_projete").querySelector("dd").dataset.negative).toBe("true");
    expect(cardNotes("ebe_projete")).toEqual([`Variation : ${eur("-7 476,00")} par mois`]);
    expect(cardValue("couverture")).toBe(`${MINUS}0,76${NBSP}fois`);
    expect(card("couverture").dataset.status).toBe("critical");
    expect(cardNotes("couverture")).toEqual(["Seuil critique", `Avant : 4${NBSP}fois`, THRESHOLDS.debt_service_coverage.label]);
    expect(card("tresorerie_fin").querySelector("dt").textContent).toBe("Trésorerie à la fin du mois 6");
    expect(cardValue("tresorerie_fin")).toBe(eur("-5 556,00"));
    expect(cardNotes("tresorerie_fin")).toEqual([
      `Départ : ${eur("15 000,00")} (solde bancaire déclaré pour la simulation)`,
      `Variation sur la projection : ${eur("-20 556,00")}`,
    ]);
    expect(cardValue("besoin_financement")).toBe(eur("5 556,00"));
    expect(card("besoin_financement").querySelector("dd").dataset.negative).toBe("true");
    expect(card("besoin_financement").hasAttribute("data-status")).toBe(false);
    expect(cardNotes("besoin_financement"))
      .toEqual(["Découvert maximal à couvrir pendant la projection (apport, prêt ou concours bancaire)."]);

    expect(tableRow("chiffre_affaires_ht")).toEqual(["Chiffre d’affaires HT", eur("40 000,00"), eur("34 000,00"), eur("-6 000,00")]);
    expect(tableRow("achats_matieres"))
      .toEqual([`${MINUS}Matières premières et marchandises consommées`, eur("11 200,00"), eur("9 996,00"), eur("-1 204,00")]);
    expect(tableRow("ebe")).toEqual(["=Excédent brut d’exploitation (EBE)", eur("6 000,00"), eur("-1 476,00"), eur("-7 476,00")]);
    const ebeCells = report.querySelectorAll('tr[data-metric="ebe"] td');
    expect([ebeCells[0].dataset.negative, ebeCells[1].dataset.negative]).toEqual([undefined, "true"]);
    expect(tableRow("taux_marge_sur_couts_variables")).toEqual([
      "Taux de marge sur coûts variables (au volume de référence)", `70${NBSP}%`, `68,6${NBSP}%`, `${MINUS}1,4${NBSP}pt`,
    ]);
    expect(tableRow("nouvelle_mensualite")).toEqual(["dont nouvelle mensualité", eur("0,00"), eur("450,00"), `+${eur("450,00")}`]);
    expect(tableRow("couverture_service_dette")).toEqual([
      "Couverture des annuités (EBE ÷ service de la dette)", `4${NBSP}fois`, `${MINUS}0,76${NBSP}fois`, `${MINUS}4,76${NBSP}fois`,
    ]);
    expect(tableRow("point_mort_journalier"))
      .toEqual(["Point mort de trésorerie journalier", eur("1 119,05"), eur("1 299,81"), `+${eur("180,76")}`]);
    expect(report.querySelectorAll("tr[data-metric]")).toHaveLength(18);

    expect(cashSection().querySelector(".company-finance-intro").textContent).toBe(
      `Solde de départ : ${eur("15 000,00")} (solde bancaire déclaré pour la simulation). `
      + `Flux mensuel : +${eur("4 500,00")} sans le scénario, ${eur("-3 426,00")} avec.`,
    );
    expect(rupture().dataset.state).toBe("rupture");
    expect(rupture().querySelector("strong").textContent).toBe("Rupture de trésorerie");
    expect(ruptureTexts()).toEqual([
      "Trésorerie négative au mois 5 (vers J+150) au rythme simulé.",
      `Autonomie au rythme simulé : 4,4${NBSP}mois.`,
    ]);
    expect(cashSection().querySelector("caption").textContent)
      .toBe("Trésorerie aux jalons J+30, J+60 et J+90 (fins des mois 1, 2 et 3)");
    expect(milestones()).toEqual([
      ["J+30", eur("19 500,00"), eur("11 574,00"), eur("-7 926,00")],
      ["J+60", eur("24 000,00"), eur("8 148,00"), eur("-15 852,00")],
      ["J+90", eur("28 500,00"), eur("4 722,00"), eur("-23 778,00")],
    ]);
    const months = [...cashSection().querySelectorAll(".company-finance-monthly tbody tr")];
    expect(months.map((row) => cells(row)[0])).toEqual([1, 2, 3, 4, 5, 6].map((month) => `Mois ${month} · J+${month * 30}`));
    expect(cells(months[4]).slice(1)).toEqual([eur("37 500,00"), eur("-2 130,00")]);
    expect(months[4].querySelector(".company-finance-bar").dataset.negative).toBe("true");
    expect(months[3].querySelector(".company-finance-bar").hasAttribute("data-negative")).toBe(false);
    expect(cashSection().textContent).not.toContain("Flux bancaire réel");

    expect(severities()).toEqual(["critical", "critical", "critical", "warning", "info"]);
    expect(report.querySelector(".company-finance-alert-label").textContent).toBe("Prioritaire");
    expect(report.querySelectorAll(".company-finance-method li")).toHaveLength(8);
    expect(report.querySelector(".company-finance-method").open).toBe(false);
    expect(host.textContent).not.toMatch(/NaN|undefined|null|Infinity|\[object/);
  });

  test("solde de départ inconnu : flux cumulés seulement, trésorerie et besoin non évaluables", async () => {
    serve({ stress: (params) => reply(200, responseFor("sans_solde", params)) });
    await simulate(NO_CASH_INPUT);
    expect(bodyOf(stressCalls()[0])).toEqual({
      id_entreprise: COMPANY.id, delta_ca_percent: "5", delta_cout_matiere_percent: "0",
      charge_fixe_additionnelle_mensuelle: "2800", investissement_emprunt_mensualite: "0", duree_mois: 12,
      jours_ouverture_mois: "30", solde_tresorerie_actuel: null,
    });
    expect(card("tresorerie_fin").querySelector("dt").textContent).toBe("Trésorerie à la fin du mois 12");
    expect(cardValue("tresorerie_fin")).toBe("Non projetée");
    expect(cardNotes("tresorerie_fin")).toEqual(["Solde de départ inconnu.", `Variation sur la projection : +${eur("37 200,00")}`]);
    expect(cardValue("besoin_financement")).toBe("Non évaluable");
    expect(card("besoin_financement").querySelector("dd").hasAttribute("data-negative")).toBe(false);
    expect(cardNotes("besoin_financement")).toEqual(["Renseignez le solde de trésorerie actuel pour l’évaluer."]);
    expect(cardValue("ca_supplementaire")).toBe(eur("0,00"));
    expect(cardValue("couverture")).toBe(`3,07${NBSP}fois`);
    expect(cardNotes("couverture")[0]).toBe("Repère respecté");
    expect(rupture().dataset.state).toBe("unknown");
    expect(rupture().querySelector("strong").textContent).toBe("Rupture non évaluable");
    expect(ruptureTexts()).toEqual(["Rupture non évaluable : solde de trésorerie de départ inconnu."]);
    expect(cashSection().querySelector(".company-finance-intro").textContent).toBe(
      "Solde de départ inconnu : seuls les flux cumulés sont projetés. Renseignez le solde de trésorerie actuel pour projeter les soldes. "
      + `Flux mensuel : +${eur("4 500,00")} sans le scénario, +${eur("3 100,00")} avec.`,
    );
    expect(cashSection().querySelector("caption").textContent)
      .toBe("Flux cumulé aux jalons J+30, J+60 et J+90 (fins des mois 1, 2 et 3)");
    expect(milestones()).toEqual([
      ["J+30", eur("4 500,00"), eur("3 100,00"), eur("-1 400,00")],
      ["J+60", eur("9 000,00"), eur("6 200,00"), eur("-2 800,00")],
      ["J+90", eur("13 500,00"), eur("9 300,00"), eur("-4 200,00")],
    ]);
    const monthly = cashSection().querySelector(".company-finance-monthly");
    expect([...monthly.querySelectorAll("thead th")].map((node) => node.textContent))
      .toEqual(["Fin du mois", "Flux cumulé sans le scénario", "Flux cumulé avec le scénario"]);
    expect(monthly.querySelectorAll("tbody tr")).toHaveLength(12);
    expect(simReport().querySelector('[data-lever="solde_tresorerie_actuel"]').textContent)
      .toBe("Solde de trésorerie actuel : Non déclaré");
    expect(severities()).toEqual(["warning", "info"]);
    expect(host.textContent).not.toMatch(/NaN|undefined|null|Infinity|\[object/);
  });

  test("démonstration : exemple pré-rempli, chemin dédié, bandeau fictif sur le rapport", async () => {
    serve();
    await renderSimulation({ companyId: null, demoSector: "HOSPITALITY" });
    expect(fieldValues()).toEqual(DEMO_VALUES);
    expect(global.fetch).not.toHaveBeenCalled();
    await launch();
    expect(paths()).toEqual([`${DEMO_STRESS}?${PERIOD}`]);
    expect(bodyOf(global.fetch.mock.calls[0])).toEqual({
      id_entreprise: "demo-hospitality", delta_ca_percent: "-15", delta_cout_matiere_percent: "5",
      charge_fixe_additionnelle_mensuelle: "2800", investissement_emprunt_mensualite: "450", duree_mois: 6,
      jours_ouverture_mois: "26", solde_tresorerie_actuel: null,
    });
    const report = simReport();
    const { entreprise, alerte_rupture_tresorerie: demoRupture } = simulation.cases.demo.response;
    expect(entreprise.name).toMatch(/\(fictive\)$/);
    expect(report.querySelector("#company-finance-sim-title").textContent).toBe(entreprise.name);
    expect(report.querySelector(".company-finance-demo-banner").textContent).toBe(DEMO_NOTICE);
    expect(report.querySelector(".numm-tech-disclaimer").textContent)
      .toBe(`${SIMULATION_DISCLAIMER} ${NOT_CERTIFIED_NOTICE} ${DEMO_NOTICE}`);
    expect(cardValue("point_mort_journalier")).toBe(eur("2 898,81"));
    expect(cardNotes("point_mort_journalier")).toEqual([`Avant : ${eur("2 667,21")} · 26${NBSP}jours d’ouverture par mois`]);
    expect(cardValue("couverture")).toBe(`0,11${NBSP}fois`);
    expect(card("couverture").dataset.status).toBe("critical");
    expect(cardValue("tresorerie_fin")).toBe(eur("147 336,46"));
    expect(cardNotes("tresorerie_fin")).toEqual([
      `Départ : ${eur("181 869,88")} (trésorerie reconstituée en fin de période de référence)`,
      `Variation sur la projection : ${eur("-34 533,42")}`,
    ]);
    expect(cardValue("besoin_financement")).toBe(eur("0,00"));
    expect(card("besoin_financement").querySelector("dd").hasAttribute("data-negative")).toBe(false);
    expect(cardNotes("besoin_financement")).toEqual(["Aucun découvert sur la durée projetée."]);
    expect(rupture().dataset.state).toBe("ok");
    expect(rupture().querySelector("strong").textContent).toBe("Pas de rupture");
    expect(ruptureTexts()).toEqual([demoRupture.message]);
    expect(demoRupture.message).toMatch(/^Pas de rupture sur 6.mois.; au rythme simulé, .+ 31,6.mois environ\.$/);
    expect(milestones()[0]).toEqual(["J+30", eur("188 763,85"), eur("176 114,31"), eur("-12 649,54")]);
    expect(cashSection().querySelector(".company-finance-note").textContent).toContain(
      `Flux bancaire réel moyen de la période de référence : +${eur("2 688,99")} par mois, `
      + `contre +${eur("6 893,97")} de flux de gestion`,
    );
    expect(host.textContent).not.toMatch(/NaN|undefined|null|Infinity|\[object/);
  });
});

describe("erreurs, délais et annulations", () => {
  test("saisie invalide : rien n’est envoyé, chaque champ explique son erreur ; la saisie corrigée part", async () => {
    serve();
    await renderSimulation();
    await fill({
      delta_ca_percent: "-150", delta_cout_matiere_percent: "abc", charge_fixe_additionnelle_mensuelle: "12,345",
      investissement_emprunt_mensualite: "-450", duree_mois: "0", jours_ouverture_mois: "",
      solde_tresorerie_actuel: "1 000 000 000 000 000",
    });
    await launch();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(formAlert()).toBe("Simulation non lancée : corrigez les champs signalés.");
    expect(Object.fromEntries(SIMULATION_LEVERS.map((item) => [item.name, fieldError(item.name)]))).toEqual({
      delta_ca_percent: `Valeur inférieure au minimum autorisé (${MINUS}100).`,
      delta_cout_matiere_percent: "Nombre invalide : chiffres et une seule virgule décimale (ex. 1250,50).",
      charge_fixe_additionnelle_mensuelle: "2 décimales au maximum.",
      investissement_emprunt_mensualite: "Valeur positive ou nulle attendue.",
      duree_mois: "Nombre entier de mois attendu, de 1 à 36.",
      jours_ouverture_mois: "Valeur requise.",
      solde_tresorerie_actuel: "12 chiffres au maximum avant la virgule.",
    });
    const revenue = field("delta_ca_percent");
    expect(revenue.getAttribute("aria-invalid")).toBe("true");
    expect(revenue.getAttribute("aria-describedby")).toBe(`${revenue.id}-help ${revenue.id}-error`);

    // Corriger un champ efface son erreur sans attendre le prochain envoi.
    await fill({ delta_ca_percent: "-15" });
    expect(fieldError("delta_ca_percent")).toBeNull();
    expect(revenue.hasAttribute("aria-invalid")).toBe(false);
    expect(revenue.getAttribute("aria-describedby")).toBe(`${revenue.id}-help`);
    expect(fieldError("duree_mois")).toBe("Nombre entier de mois attendu, de 1 à 36.");

    await fill(RUPTURE_INPUT);
    await launch();
    expect(formAlert()).toBeNull();
    expect(SIMULATION_LEVERS.map((item) => fieldError(item.name)).filter(Boolean)).toEqual([]);
    expect(stressCalls().map(bodyOf)).toEqual([RUPTURE_BODY]);
    expect(simReport()).not.toBeNull();
  });

  test("refus métier du serveur (422) : message relayé tel quel, saisie conservée", async () => {
    const detail = "Charge fixe additionnelle mensuelle : l’économie dépasse les charges fixes de la période de référence.";
    serve({ stress: () => reply(422, { detail }) });
    await simulate({ ...RUPTURE_INPUT, charge_fixe_additionnelle_mensuelle: "-30 000" });
    expect(bodyOf(stressCalls()[0]).charge_fixe_additionnelle_mensuelle).toBe("-30000");
    expect(loadError()).toBe(detail);
    expect(simReport()).toBeNull();
    expect(field("charge_fixe_additionnelle_mensuelle").value).toBe("-30 000");
    expect(launchButton().disabled).toBe(false);
  });

  test.each([
    ["présentée comme une démonstration", (data) => { data.demo = true; }],
    ["autre entreprise", (data) => { data.entreprise.id = "company_b"; }],
    ["autre période de référence", (data) => { data.periode_reference = { start_date: "2024-01-01", end_date: "2024-12-31" }; }],
    ["écho d’un autre scénario", (data) => { data.scenario.delta_ca_percent = "-10"; }],
    ["synthèse incohérente avec le détail", (data) => { data.ebe_projete_mensuel = "0.00"; }],
  ])("réponse refusée (%s) : aucun chiffre affiché", async (_, corrupt) => {
    serve({
      stress: (params) => {
        const data = responseFor("rupture", params);
        corrupt(data);
        return reply(200, data);
      },
    });
    await simulate();
    expect(loadError()).toBe(INVALID_PAYLOAD_MESSAGE);
    expect(simReport()).toBeNull();
  });

  test("profil financier absent : configurer la saisie ou voir la démonstration", async () => {
    serve({ stress: () => reply(404, { detail: PROFILE_MISSING }) });
    const onConfigure = jest.fn();
    const onDemo = jest.fn();
    await simulate(RUPTURE_INPUT, { onConfigure, onDemo });
    const notice = host.querySelector(".company-finance-notice");
    expect(notice.querySelector("h3").textContent).toBe("Profil financier à créer");
    expect(notice.querySelector('[role="status"]').textContent).toBe(PROFILE_MISSING);
    expect(loadError()).toBeNull();
    expect(simReport()).toBeNull();
    await click(findButton("Configurer et saisir", notice));
    await click(findButton("Voir la démonstration", notice));
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(onDemo).toHaveBeenCalledTimes(1);
    // Déjà en démonstration : pas de bouton qui y renverrait.
    await renderSimulation({ onConfigure });
    expect(findButton("Voir la démonstration")).toBeUndefined();
    expect(findButton("Configurer et saisir")).toBeDefined();
    expect(stressCalls()).toHaveLength(1);
  });

  test("délai maximal de 30 secondes : message visible, puis nouvel essai du même scénario", async () => {
    jest.useFakeTimers();
    let attempts = 0;
    serve({
      stress: (params, init) => {
        attempts += 1;
        return attempts === 1 ? pending(params, init) : reply(200, responseFor("rupture", params));
      },
    });
    await simulate();
    expect(launchButton().disabled).toBe(true);
    expect(launchButton().textContent.trim()).toBe("Calcul en cours…");
    expect(findButton("Scénario neutre").disabled).toBe(true);
    expect(host.querySelector('[aria-busy="true"] > [role="status"]').textContent)
      .toBe("Simulation en cours : calcul en mémoire, sans écriture…");
    await act(async () => jest.advanceTimersByTime(30000));
    expect(loadError()).toBe(TIMEOUT_MESSAGE);
    expect(stressCalls()[0][1].signal.aborted).toBe(true);
    expect(launchButton().disabled).toBe(false);
    await launch();
    expect(stressCalls().map(bodyOf)).toEqual([RUPTURE_BODY, RUPTURE_BODY]);
    expect(loadError()).toBeNull();
    expect(simReport()).not.toBeNull();
  });

  test("nouvelle période de référence : calcul relancé, réponse tardive de l’ancienne période ignorée", async () => {
    const calls = [];
    serve({ stress: (params, { signal }) => new Promise((resolve) => { calls.push({ params, signal, resolve }); }) });
    await simulate();
    const second = { start_date: "2025-07-01", end_date: "2025-12-31", comparison: "year_ago" };
    await renderSimulation({ query: second });
    expect(paths()).toEqual([`${STRESS}?${PERIOD}`, stressPath(second)]);
    expect(calls.map(({ signal }) => signal.aborted)).toEqual([true, false]);
    expect(bodyOf(stressCalls()[1])).toEqual(RUPTURE_BODY);
    expect(simForm().textContent).toContain("moyennes mensuelles HT du 01/07/2025 au 31/12/2025");
    const answer = ({ params, resolve }) => act(async () => {
      resolve({ ok: true, status: 200, json: async () => responseFor("rupture", params) });
    });
    await answer(calls[0]);
    expect(simReport()).toBeNull();
    expect(launchButton().textContent.trim()).toBe("Calcul en cours…");
    await answer(calls[1]);
    expect(reportHead()).toContain("Référence du 01/07/2025 au 31/12/2025");
  });

  test("leviers modifiés après un calcul : rapport conservé, invitation à relancer ; « Scénario neutre » ne lance rien", async () => {
    serve({
      stress: (params, { body }) => reply(200, responseFor(
        JSON.parse(body).solde_tresorerie_actuel === null ? "sans_solde" : "rupture", params,
      )),
    });
    await simulate();
    expect(editedNote()).toBeNull();
    await fill({ delta_ca_percent: "-20" });
    const note = "Leviers modifiés : relancez la simulation pour mettre à jour le rapport ci-dessous.";
    expect(editedNote()).toBe(note);
    expect(simReport().querySelector('[data-lever="delta_ca_percent"]').textContent)
      .toBe(`Variation du chiffre d’affaires : ${MINUS}15${NBSP}%`);
    await click(findButton("Scénario neutre"));
    expect(fieldValues()).toEqual(NEUTRAL_VALUES);
    expect(editedNote()).toBe(note);
    expect(stressCalls()).toHaveLength(1);

    await fill(NO_CASH_INPUT);
    await launch();
    expect(editedNote()).toBeNull();
    expect(simReport().querySelector('[data-lever="duree_mois"]').textContent).toBe(`Durée de projection : 12${NBSP}mois`);
    // Relancer le même scénario recalcule : aucune réponse n’est réutilisée.
    await launch();
    expect(stressCalls()).toHaveLength(3);
    expect(bodyOf(stressCalls()[2])).toEqual(bodyOf(stressCalls()[1]));
  });

  test("quitter la vue pendant le calcul annule la requête ; la réponse tardive est ignorée", async () => {
    let finish;
    serve({ stress: () => new Promise((resolve) => { finish = resolve; }) });
    await simulate();
    const { signal } = stressCalls()[0][1];
    expect(signal.aborted).toBe(false);
    await act(async () => root.render(<p>Autre vue</p>));
    expect(signal.aborted).toBe(true);
    await act(async () => finish({
      ok: true, status: 200, json: async () => responseFor("rupture", new URLSearchParams(PERIOD)),
    }));
    expect(host.textContent).toBe("Autre vue");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("export et impression", () => {
  test("export CSV : fichier nommé, BOM UTF-8, format français ; lien temporaire révoqué", async () => {
    serve();
    await simulate();
    await click(findButton("Export CSV"));
    expect(feedback()).toBe("Export indisponible dans ce navigateur.");

    jest.useFakeTimers();
    const downloads = [];
    URL.createObjectURL = jest.fn(() => "blob:simulation");
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function download() {
      downloads.push(this.download);
    });
    await click(findButton("Export CSV"));
    expect(downloads).toEqual(["sirius-simulation-company_a-2025-01-01_2025-12-31.csv"]);
    expect(feedback())
      .toBe("Export CSV généré : séparateur point-virgule et virgule décimale, ouvrable dans Excel ou LibreOffice.");
    const blob = URL.createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("text/csv;charset=utf-8");
    jest.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:simulation");
    jest.useRealTimers();
    const bytes = await readBytes(blob);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = Buffer.from(bytes.slice(3)).toString("utf8").split("\r\n");
    expect(lines[0]).toBe(`Simulation ΣIRIUS;${COMPANY.name}`);
    expect(lines).toContain("Rupture de trésorerie;Rupture de trésorerie;;Trésorerie négative au mois 5 (vers J+150) au rythme simulé.");
    expect(lines).toContain("J+30;30;4500,00;-3426,00;19500,00;11574,00");
    expect(lines.at(-2)).toMatch(/^Avertissement;/);
    expect(lines.at(-1)).toBe("");
  });

  test("impression : seul le rapport part, sans formulaire ni boutons, puis la page est restaurée", async () => {
    serve();
    await simulate();
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
        inputs: printRoot.querySelectorAll("input").length,
        closedDetails: [...printRoot.querySelectorAll("details")].filter((item) => !item.open).length,
        ids: printRoot.querySelectorAll("[id]").length,
      };
    });
    await click(findButton("Imprimer / PDF"));
    expect(window.print).toHaveBeenCalledTimes(1);
    expect(printed).toEqual({
      title: `ΣIRIUS – Simulation – ${COMPANY.name} – 2025-01-01 au 2025-12-31`,
      text: expect.stringContaining("Trésorerie projetée"),
      buttons: 0,
      inputs: 0,
      closedDetails: 0,
      ids: 0,
    });
    expect(printed.text).toContain("Hypothèses et méthode de calcul");
    expect(printed.text).toContain(SIMULATION_NOTICE);
    expect(printed.text).not.toContain("Scénario à tester");
    expect(printed.text).not.toContain("Impression indisponible");
    expect(feedback()).toBeNull();
    await act(async () => window.dispatchEvent(new Event("afterprint")));
    expect(document.getElementById("sirius-print-root")).toBeNull();
    expect(document.title).toBe(title);
  });
});

describe("intégration au tableau de bord NUMMARIUS", () => {
  test("onglet Simulation : tableau de bord annulé, aucun calcul avant le clic, période du filtre utilisée", async () => {
    serve();
    await renderDashboard();
    const query = realQuery();
    expect(paths()).toEqual([
      "/enterprise/context",
      `/finance/${COMPANY.id}/dashboard?start_date=${query.start_date}&end_date=${query.end_date}&comparison=year_ago`,
    ]);
    const { signal } = global.fetch.mock.calls[1][1];
    await click(findButton("Simulation"));
    expect(signal.aborted).toBe(true);
    expect([pressed("Tableau de bord"), pressed("Simulation")]).toEqual(["false", "true"]);
    expect(heading()).toBe(COMPANY.name);
    expect(badge()).toBe("Lecture seule");
    expect(filterNote()).toBe("Dates incluses · Période de référence de la simulation ; aucune écriture effectuée.");
    expect(stressCalls()).toEqual([]);
    expect(fieldValues()).toEqual(NEUTRAL_VALUES);
    expect(simForm().textContent).toContain(`moyennes mensuelles HT ${describePeriod(query)}`);

    await fill(RUPTURE_INPUT);
    await launch();
    expect(stressCalls().map(pathOf)).toEqual([stressPath(query)]);
    expect(bodyOf(stressCalls()[0])).toEqual(RUPTURE_BODY);
    expect(simReport().querySelector("#company-finance-sim-title").textContent).toBe(COMPANY.name);
    expect(reportHead()).toContain(`Référence ${describePeriod(query)}`);
  });

  test("scénario conservé entre les vues et relancé à l’identique ; changer la période recalcule", async () => {
    serve();
    await renderDashboard();
    await click(findButton("Simulation"));
    await fill(RUPTURE_INPUT);
    await launch();
    const query = realQuery();

    await click(findButton("Tableau de bord"));
    expect(simForm()).toBeNull();
    expect(paths().at(-1)).toMatch(new RegExp(`^/finance/${COMPANY.id}/dashboard\\?`));
    await click(findButton("Simulation"));
    expect(fieldValues()).toEqual(Object.values(RUPTURE_INPUT));
    expect(stressCalls().map(pathOf)).toEqual([stressPath(query), stressPath(query)]);
    expect(stressCalls().map(bodyOf)).toEqual([RUPTURE_BODY, RUPTURE_BODY]);
    expect(simReport()).not.toBeNull();
    expect(editedNote()).toBeNull();

    const previousYear = periodPresets(localToday()).find((item) => item.id === "previous-year");
    await click(findButton(previousYear.label));
    expect(stressCalls().map(pathOf).at(-1)).toBe(stressPath(previousYear));
    expect(stressCalls()).toHaveLength(3);
    expect(simForm().textContent).toContain(`moyennes mensuelles HT ${describePeriod(previousYear)}`);
    expect(reportHead()).toContain(`Référence ${describePeriod(previousYear)}`);

    // « Actualiser » recalcule la simulation affichée sur la même période.
    await act(async () => periodForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(stressCalls()).toHaveLength(4);
    expect(pathOf(stressCalls()[3])).toBe(stressPath(previousYear));
    expect(bodyOf(stressCalls()[3])).toEqual(RUPTURE_BODY);
  });

  test("démonstration : exemple pré-rempli, chemin fictif, scénario propre à chaque espace", async () => {
    serve();
    await renderDashboard();
    await click(findButton("Démonstration fictive"));
    await click(findButton("Simulation"));
    expect(heading()).toBe("Démonstration fictive");
    expect(badge()).toBe("Lecture seule");
    expect(fieldValues()).toEqual(DEMO_VALUES);
    expect(stressCalls()).toEqual([]);
    await launch();
    expect(stressCalls().map(pathOf)).toEqual([`${DEMO_STRESS}?${PERIOD}`]);
    expect(bodyOf(stressCalls()[0]).id_entreprise).toBe("demo-hospitality");
    expect(simReport().querySelector(".company-finance-demo-banner").textContent).toBe(DEMO_NOTICE);

    // Autre entreprise fictive : on repart de l’exemple, sans calcul automatique.
    await click(findButton(SECTORS.CONSTRUCTION));
    expect(fieldValues()).toEqual(DEMO_VALUES);
    expect(simReport()).toBeNull();
    expect(stressCalls()).toHaveLength(1);
    await click(findButton(SECTORS.HOSPITALITY));
    expect(stressCalls().map(pathOf)).toEqual([`${DEMO_STRESS}?${PERIOD}`, `${DEMO_STRESS}?${PERIOD}`]);
    expect(simReport()).not.toBeNull();

    // Les leviers fictifs ne suivent jamais vers l’entreprise réelle.
    await click(findButton("Mon entreprise"));
    expect(fieldValues()).toEqual(NEUTRAL_VALUES);
    expect(simReport()).toBeNull();
    expect(stressCalls()).toHaveLength(2);
  });

  test("profil absent : la démonstration s’ouvre sur la simulation ; « Configurer et saisir » mène à la saisie", async () => {
    serve({ stress: () => reply(404, { detail: PROFILE_MISSING }) });
    await renderDashboard();
    await click(findButton("Simulation"));
    await fill(RUPTURE_INPUT);
    await launch();
    const notice = host.querySelector(".company-finance-notice");
    expect(notice.querySelector('[role="status"]').textContent).toBe(PROFILE_MISSING);
    await click(findButton("Voir la démonstration", notice));
    expect([pressed("Mon entreprise"), pressed("Démonstration fictive"), pressed("Simulation")]).toEqual(["false", "true", "true"]);
    expect(fieldValues()).toEqual(DEMO_VALUES);
    expect(host.querySelector(".company-finance-notice")).toBeNull();

    await click(findButton("Mon entreprise"));
    expect(fieldValues()).toEqual(Object.values(RUPTURE_INPUT));
    expect(stressCalls()).toHaveLength(2);
    await click(findButton("Configurer et saisir", host.querySelector(".company-finance-notice")));
    expect(pressed("Saisie & imports")).toBe("true");
    expect(badge()).toBe("Saisie tracée");
    expect(simForm()).toBeNull();
  });
});

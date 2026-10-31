import fixtures from "./__fixtures__/financeDashboardV2.json";
import { API_BASE_URL } from "./lib/api";
import {
  DEMO_NOTICE, DEMO_REFERENCE_DATE, DEMO_WINDOW_MESSAGE, INVALID_PAYLOAD_MESSAGE, MAX_IMPORT_BYTES, NOT_CERTIFIED_NOTICE,
  SECTOR_KEYS, TIMEOUT_MESSAGE, addDays, addMonths, bankIdempotencyKey, barPermille, buildEntryPayload, buildFinanceCsv,
  canUseFinance, createEntry, defaultQuery, demoCompanyId, downloadText, entriesPath, entryColumns, fetchEnterpriseContext,
  fetchEntries, fetchFinanceDashboard, fieldHelp, fieldLabel, financeCsvFilename, financeRequest, formatChange,
  formatEntryValue, formatFinanceValue, formatVariationPct, inclusiveDays, initialEntryValues, isAdverse, maxAbsDecimal,
  monthlyLabel, normalizeDemoCatalog, parseDecimalInput, periodError, periodPresets, printFinanceReport, sigRows,
  thresholdStatus, uploadBankStatement, validFinancePeriod, validateFinanceDashboard, visibleFields, withTimeout,
  ENTRY_FIELDS, dashboardPath,
} from "./companyFinance";

const clone = (value) => JSON.parse(JSON.stringify(value));
const NNBSP = "\u202f";
const NBSP = "\u00a0";
const response = (status, body, { json = true } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: json ? async () => body : async () => { throw new SyntaxError("Unexpected token"); },
});

// Toutes les fixtures sont produites par le vrai moteur de démonstration du backend.
const FIXTURE_CASES = [
  ["dashboard", fixtures.dashboard, "year_ago"],
  ...Object.entries(fixtures.sectors).map(([sector, data]) => [`sectors.${sector}`, data, "year_ago"]),
  ["annual", fixtures.annual, "previous"],
  ["noComparisonData", fixtures.noComparisonData, "year_ago"],
  ["withoutComparison", fixtures.withoutComparison, "none"],
];
const optionsFor = (data, comparison) => ({
  companyId: demoCompanyId(data.company.sector), period: data.period, comparison, demo: true,
});

let originalFetch;
beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("affichage décimal exact", () => {
  test.each([
    ["9007199254740993.99", "money", `9${NNBSP}007${NNBSP}199${NNBSP}254${NNBSP}740${NNBSP}993,99${NBSP}€`],
    ["-12.40", "money", `−12,40${NBSP}€`],
    ["-0.00", "money", `0,00${NBSP}€`],
    ["0", "money", `0,00${NBSP}€`],
    ["40.1234", "percent", `40,1234${NBSP}%`],
    ["40.0000", "percent", `40${NBSP}%`],
    ["3.1250", "ratio", `3,125${NBSP}fois`],
    ["12.5", "days", `12,5${NBSP}jours`],
    ["1.0", "years", `1${NBSP}an`],
    ["-2.50", "points", `−2,5${NBSP}pt`],
    ["2025-03-31", "date", "31/03/2025"],
    [null, "money", "Non calculable"],
  ])("%s (%s) s’affiche sans conversion flottante", (value, kind, expected) => {
    expect(formatFinanceValue(value, kind)).toBe(expected);
  });

  test("la devise suit le profil de l’entreprise", () => {
    expect(formatFinanceValue("1200.00", "money", "USD")).toBe(`1${NNBSP}200,00${NBSP}$`);
    expect(formatFinanceValue("1200.00", "money", "CHF")).toBe(`1${NNBSP}200,00${NBSP}CHF`);
    expect(() => formatFinanceValue("10", "money", "eur")).toThrow("Devise");
  });

  test.each([12.5, undefined, "NaN", "Infinity", "", "1e10", "0.001", " 12", "12,5"])("refuse le montant invalide %p", (value) => {
    expect(() => formatFinanceValue(value)).toThrow();
  });

  test("variations signées et évolutions en pourcentage", () => {
    expect(formatChange("12.50", "money")).toBe(`+12,50${NBSP}€`);
    expect(formatChange("-3.20", "percent")).toBe(`−3,2${NBSP}pt`);
    expect(formatChange(null)).toBe("Non comparable");
    expect(formatVariationPct("5.00")).toBe(`+5${NBSP}%`);
    expect(formatVariationPct("0.00")).toBe(`0${NBSP}%`);
    expect(formatVariationPct(null)).toBe("—");
  });
});

describe("saisie des montants", () => {
  test.each([
    ["1 250,50", "1250.50", {}],
    [`1${NNBSP}250,5`, "1250.5", {}],
    ["1250.5", "1250.5", {}],
    ["+5", "5", {}],
    ["0012,30", "12.30", {}],
    ["12,340", "12.34", {}],
    ["−12,40", "-12.40", { allowNegative: true }],
    ["-0,00", "0.00", {}],
    ["5,5", "5.5", { scale: 4, max: "100" }],
  ])("%p devient la chaîne décimale %p", (text, value, options) => {
    expect(parseDecimalInput(text, options)).toEqual({ value });
  });

  test.each([
    [12, "Nombre attendu.", {}],
    ["", "Valeur requise.", {}],
    ["1e5", "Nombre invalide", {}],
    ["1,2,3", "Nombre invalide", {}],
    ["12,345", "2 décimales au maximum.", {}],
    ["-12,40", "Valeur positive ou nulle attendue.", {}],
    ["1234567890123", "12 chiffres au maximum avant la virgule.", {}],
    ["120", "Valeur supérieure au maximum autorisé (100).", { scale: 4, maxWhole: 3, max: "100" }],
  ])("%p est refusé : %s", (text, message, options) => {
    expect(parseDecimalInput(text, options).error).toContain(message);
  });
});

describe("calendrier", () => {
  test("les périodes sont des intervalles de dates réels et inclusifs", () => {
    expect(validFinancePeriod({ start_date: "2024-02-29", end_date: "2024-02-29" })).toBe(true);
    expect(inclusiveDays("2024-02-01", "2024-02-29")).toBe(29);
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
    for (const period of [
      { start_date: "2026-02-29", end_date: "2026-03-01" },
      { start_date: "2026-01-02", end_date: "2026-01-01" },
      { start_date: "2026-01-01", end_date: "9999-12-31" },
      { start_date: "", end_date: "2026-01-01" },
    ]) expect(validFinancePeriod(period)).toBe(false);
  });

  test("messages d’erreur de période, limite de 10 ans et fenêtre de démonstration", () => {
    expect(periodError({ start_date: "2026-01-31", end_date: "2026-01-01" })).toContain("période valide");
    expect(periodError({ start_date: "2016-01-01", end_date: "2025-12-31" })).toBeNull();
    expect(periodError({ start_date: "2016-01-01", end_date: "2026-01-01" })).toBe("Période limitée à 10 ans.");
    expect(periodError({ start_date: "2022-12-31", end_date: "2023-01-31" }, { demo: true })).toBe(DEMO_WINDOW_MESSAGE);
    expect(periodError({ start_date: "2022-12-31", end_date: "2023-01-31" })).toBeNull();
  });

  test("périodes par défaut : mois en cours à date, comparaison N-1", () => {
    expect(defaultQuery(false, "2026-10-31")).toEqual({ start_date: "2026-10-01", end_date: "2026-10-31", comparison: "year_ago" });
    expect(defaultQuery(true)).toEqual({ start_date: "2025-01-01", end_date: "2025-12-31", comparison: "year_ago" });
  });

  test("raccourcis de période calculés au jour près", () => {
    const byId = (reference) => Object.fromEntries(periodPresets(reference).map((item) => [item.id, item]));
    expect(byId("2026-10-31")).toMatchObject({
      month: { label: "Octobre 2026 à date", start_date: "2026-10-01", end_date: "2026-10-31" },
      "previous-month": { label: "Septembre 2026", start_date: "2026-09-01", end_date: "2026-09-30" },
      quarter: { label: "T4 2026 à date", start_date: "2026-10-01", end_date: "2026-10-31" },
      year: { label: "2026 à date", start_date: "2026-01-01", end_date: "2026-10-31" },
      "previous-year": { label: "Année 2025", start_date: "2025-01-01", end_date: "2025-12-31" },
      rolling: { label: "12 mois glissants", start_date: "2025-11-01", end_date: "2026-10-31" },
    });
    expect(byId("2024-03-31")["previous-month"]).toMatchObject({ label: "Février 2024", start_date: "2024-02-01", end_date: "2024-02-29" });
    expect(byId("2024-02-29").rolling).toMatchObject({ start_date: "2023-03-01", end_date: "2024-02-29" });
    expect(byId("2026-01-15")["previous-month"]).toMatchObject({ label: "Décembre 2025", start_date: "2025-12-01", end_date: "2025-12-31" });
    periodPresets(DEMO_REFERENCE_DATE, { demo: true }).forEach((preset) => expect(periodError(preset, { demo: true })).toBeNull());
  });

  test("libellés mensuels", () => {
    expect(monthlyLabel({ start_date: "2024-02-01", end_date: "2024-02-29" })).toBe("Février 2024");
    expect(monthlyLabel({ start_date: "2024-01-15", end_date: "2024-01-31" })).toBe("15/01/2024 → 31/01/2024");
  });
});

describe("repères bancaires", () => {
  test("seuils de vigilance et valeurs défavorables", () => {
    expect(thresholdStatus("debt_service_coverage", "0.95")).toBe("critical");
    expect(thresholdStatus("debt_service_coverage", "1.10")).toBe("watch");
    expect(thresholdStatus("debt_service_coverage", "1.20")).toBe("ok");
    expect(thresholdStatus("financial_expenses_to_ebe_pct", "35.00")).toBe("watch");
    expect(thresholdStatus("equity_ratio_pct", "19.99")).toBe("watch");
    expect(thresholdStatus("debt_service_coverage", null)).toBeNull();
    expect(thresholdStatus("revenue_ht", "10")).toBeNull();
    expect(isAdverse("closing_cash", "-0.01")).toBe(true);
    expect(isAdverse("vat_balance_estimate", "-10")).toBe(false);
  });

  test("barres proportionnelles calculées en entiers", () => {
    expect(barPermille("50", "200")).toBe(250);
    expect(barPermille("-300", "-200")).toBe(1000);
    expect(barPermille("10", "0")).toBe(0);
    expect(barPermille(null, "10")).toBe(0);
    expect(maxAbsDecimal(["-500.00", "200", null, "abc"])).toBe("-500.00");
  });

  test("la variation de stocks n’apparaît dans les SIG que si elle est non nulle", () => {
    const data = clone(fixtures.dashboard);
    const keys = () => sigRows(data).map((row) => row.key);
    data.common.stock_variation = null;
    expect(keys()).not.toContain("stock_variation");
    data.common.stock_variation = "0.00";
    expect(keys()).not.toContain("stock_variation");
    data.common.stock_variation = "-120.00";
    expect(keys()).toContain("stock_variation");
    expect(keys()[0]).toBe("revenue_ht");
    expect(keys().at(-1)).toBe("caf_after_principal");
  });
});

describe("validation du tableau de bord", () => {
  test.each(FIXTURE_CASES)("la fixture réelle %s est acceptée", (_, data, comparison) => {
    expect(validateFinanceDashboard(clone(data), optionsFor(data, comparison))).toEqual(data);
  });

  test("la démonstration couvre les quatre secteurs", () => {
    const sectors = [fixtures.dashboard, ...Object.values(fixtures.sectors)].map((data) => data.company.sector).sort();
    expect(sectors).toEqual([...SECTOR_KEYS].sort());
  });

  test.each([
    ["autre entreprise", (data) => { data.company.id = "other-company"; }],
    ["montant numérique", (data) => { data.common.revenue_ht = 146680.61; }],
    ["indicateur absent", (data) => { delete data.common.revenue_ht; }],
    ["indicateur obligatoire nul", (data) => { data.common.revenue_ht = null; }],
    ["trois décimales", (data) => { data.common.revenue_ht = "1.234"; }],
    ["notation scientifique", (data) => { data.specific.margin_pct = "1e3"; }],
    ["indicateur bancaire obligatoire nul", (data) => { data.banking.approximate_caf = null; }],
    ["date impossible", (data) => { data.banking.break_even_date = "2025-02-30"; }],
    ["secteur forgé", (data) => { data.company.sector = "toString"; }],
    ["devise invalide", (data) => { data.company.currency = ["EUR"]; }],
    ["secteur incohérent", (data) => { data.specific.sector = "RETAIL"; }],
    ["autre période", (data) => { data.period = { start_date: "2000-01-01", end_date: "2000-01-31" }; }],
    ["alertes absentes", (data) => { delete data.alerts; }],
    ["gravité inconnue", (data) => { data.alerts.push({ code: "X", severity: "fatal", message: "?" }); }],
    ["ancienne version de calcul", (data) => { data.calculation_version = "1"; }],
    ["démo présentée comme réelle", (data) => { data.demo = false; }],
    ["autre mode de comparaison", (data) => { data.comparison.mode = "previous"; }],
    ["variation dupliquée", (data) => { data.comparison.variations.push(data.comparison.variations[0]); }],
    ["mois hors période", (data) => { data.monthly[0].period = { start_date: "2025-02-01", end_date: "2025-02-28" }; }],
    ["série trop longue", (data) => { data.monthly = Array(61).fill(data.monthly[0]); }],
    ["chantier dupliqué", (data) => { data.specific.projects.push(data.specific.projects[0]); }],
    ["chantier sans référence", (data) => { data.specific.projects[0].business_reference = " "; }],
  ])("refuse une réponse corrompue : %s", (_, corrupt) => {
    const data = clone(fixtures.dashboard);
    corrupt(data);
    expect(() => validateFinanceDashboard(data, optionsFor(fixtures.dashboard, "year_ago"))).toThrow(
      expect.objectContaining({ code: "INVALID_PAYLOAD", message: INVALID_PAYLOAD_MESSAGE }),
    );
  });

  test("une comparaison reçue alors qu’aucune n’est demandée est refusée", () => {
    expect(() => validateFinanceDashboard(clone(fixtures.dashboard), optionsFor(fixtures.dashboard, "none"))).toThrow(INVALID_PAYLOAD_MESSAGE);
  });

  test("les mois d’une période annuelle sont ordonnés et contigus", () => {
    const data = clone(fixtures.annual);
    expect(data.monthly).toHaveLength(12);
    [data.monthly[0], data.monthly[1]] = [data.monthly[1], data.monthly[0]];
    expect(() => validateFinanceDashboard(data, optionsFor(fixtures.annual, "previous"))).toThrow(INVALID_PAYLOAD_MESSAGE);
  });

  test("le catalogue de démonstration ignore les entrées invalides", () => {
    const catalog = clone(fixtures.catalog);
    catalog.companies.push({ company: { id: "x", name: "X", sector: "toString" } }, null);
    const normalized = normalizeDemoCatalog(catalog);
    expect(normalized.companies.map((company) => company.id)).toEqual(SECTOR_KEYS.map(demoCompanyId));
    expect(normalized.notice).toBe(fixtures.catalog.notice);
    expect(normalizeDemoCatalog({ companies: [] }).notice).toBe(DEMO_NOTICE);
    expect(() => normalizeDemoCatalog({})).toThrow(INVALID_PAYLOAD_MESSAGE);
  });
});

describe("export CSV pour tableur", () => {
  const exportedAt = new Date("2026-01-01T00:00:00Z");

  test("format français : BOM UTF-8, point-virgule, virgule décimale, fins de ligne CRLF", () => {
    const csv = buildFinanceCsv(fixtures.dashboard, { exportedAt });
    expect(csv.startsWith("\ufeffRapport financier SIRIUS;Durand Rénovation (fictive)\r\n")).toBe(true);
    expect(csv.endsWith(`Avertissement;${NOT_CERTIFIED_NOTICE}\r\n`)).toBe(true);
    expect(csv.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const lines = csv.split("\r\n");
    expect(lines).toEqual(expect.arrayContaining([
      "Secteur;BTP & artisanat",
      "Période;du 01/03/2025 au 31/03/2025",
      "Comparaison;Même période N-1 du 01/03/2024 au 31/03/2024",
      "Devise;EUR",
      "Version de calcul;2",
      `Nature des données;${DEMO_NOTICE}`,
      "Section;Indicateur;Valeur;Unité;Période de comparaison;Variation;Variation %;Note",
      "Marge par chantier;CA HT;Déboursé sec;Marge;Taux de marge (%)",
      "CH-2025-02 Rénovation de boutique;26290,20;10000,60;16289,60;61,96",
      "Points d’attention;Code;Message",
    ]));
    expect(lines.find((line) => line.startsWith("Soldes intermédiaires de gestion;Chiffre d’affaires HT;"))).toMatch(/^[^;]+;[^;]+;146680,61;EUR;/);
    expect(lines.find((line) => line.startsWith("Trésorerie;Flux net de trésorerie;"))).toContain(";-7645,58;EUR;");
    expect(lines.find((line) => line.startsWith("Mars 2025;"))).toMatch(/^Mars 2025;01\/03\/2025;31\/03\/2025;146680,61;/);
  });

  test("valeurs non calculables expliquées, sans comparaison ou sans données", () => {
    const data = clone(fixtures.dashboard);
    data.banking.debt_service_coverage = null;
    expect(buildFinanceCsv(data, { exportedAt })).toContain("Non calculable : Aucune annuité d’emprunt sur la période.");
    expect(buildFinanceCsv(fixtures.withoutComparison, { exportedAt })).toContain("\r\nComparaison;Sans comparaison\r\n");
    expect(buildFinanceCsv(fixtures.noComparisonData, { exportedAt })).toContain("(aucune donnée)");
  });

  test("neutralise les formules de tableur et protège les séparateurs", () => {
    const data = clone(fixtures.dashboard);
    data.company.name = '=HYPERLINK("http://x";"clic")';
    data.specific.projects[0].business_reference = "@SUM(A1)";
    const csv = buildFinanceCsv(data, { exportedAt });
    expect(csv.split("\r\n")[0]).toBe('\ufeffRapport financier SIRIUS;"\'=HYPERLINK(""http://x"";""clic"")"');
    expect(csv).toContain("\r\n'@SUM(A1);");
  });

  test("nom de fichier stable et sans caractère dangereux", () => {
    expect(financeCsvFilename(fixtures.dashboard)).toBe("sirius-finance-demo-construction-2025-03-01_2025-03-31.csv");
    expect(financeCsvFilename({ company: { id: "a/b c" }, period: { start_date: "2025-01-01", end_date: "2025-01-31" } }))
      .toBe("sirius-finance-a_b_c-2025-01-01_2025-01-31.csv");
  });
});

describe("pièces saisies", () => {
  const names = (kind, sector, values) => visibleFields(kind, sector, values).map((item) => item.name);

  test("les champs de recette suivent le secteur", () => {
    const base = ["date", "amount_ht", "vat_rate", "payment_method"];
    expect(names("revenues", "HOSPITALITY")).toEqual([...base, "allocation", "business_reference"]);
    expect(names("revenues", "CONSTRUCTION")).toEqual([...base, "business_reference"]);
    expect(names("revenues", "RETAIL")).toEqual([...base, "business_reference", "ticket_count"]);
    expect(names("revenues", "SERVICES")).toEqual([...base, "business_reference", "hours", "days"]);
    const reference = ENTRY_FIELDS.revenues.find((item) => item.name === "business_reference");
    expect(fieldLabel(reference, "CONSTRUCTION")).toBe("Chantier / devis");
    expect(fieldHelp(reference, "CONSTRUCTION")).toBe("Indispensable pour la marge par chantier.");
    expect(fieldHelp(reference, "RETAIL")).toBe("");
  });

  test("valeurs initiales adaptées au secteur et à la date du jour", () => {
    expect(initialEntryValues("revenues", "HOSPITALITY", "2026-10-31")).toMatchObject({ date: "2026-10-31", vat_rate: "10", payment_method: "CARD" });
    expect(initialEntryValues("revenues", "SERVICES", "2026-10-31")).toMatchObject({ vat_rate: "20", payment_method: "TRANSFER" });
    expect(initialEntryValues("expenses", "HOSPITALITY", "2026-10-31")).toMatchObject({ vat_rate: "5,5", category: "MATIERE_PREMIERE", allocation: "FOOD" });
    expect(initialEntryValues("inventories", "RETAIL", "2026-10-31")).toEqual({ date: "2026-10-01", allocation: "MERCHANDISE", value: "" });
    expect(initialEntryValues("balance_sheets", "SERVICES", "2026-10-31").date).toBe("2025-12-31");
    expect(() => initialEntryValues("unknown", "SERVICES")).toThrow(TypeError);
  });

  test("une recette devient une charge utile décimale exacte", () => {
    const values = { ...initialEntryValues("revenues", "HOSPITALITY", "2026-10-31"), amount_ht: " 1 250,50 " };
    expect(buildEntryPayload("revenues", "HOSPITALITY", values)).toEqual({
      payload: { date: "2026-10-31", amount_ht: "1250.50", vat_rate: "10", payment_method: "CARD", allocation: "FOOD" },
      errors: {},
    });
    const retail = { ...initialEntryValues("revenues", "RETAIL", "2026-10-31"), amount_ht: "-80", ticket_count: "42" };
    expect(buildEntryPayload("revenues", "RETAIL", retail).payload).toMatchObject({ amount_ht: "-80", ticket_count: 42 });
  });

  test("erreurs de saisie signalées champ par champ", () => {
    const values = {
      ...initialEntryValues("revenues", "RETAIL", "2026-10-31"),
      date: "2026-02-30", vat_rate: "120", payment_method: "BITCOIN", ticket_count: "4,5",
    };
    expect(buildEntryPayload("revenues", "RETAIL", values).errors).toEqual({
      date: "Date invalide.",
      amount_ht: "Champ obligatoire.",
      vat_rate: "Valeur supérieure au maximum autorisé (100).",
      payment_method: "Choix invalide.",
      ticket_count: "Nombre entier positif attendu.",
    });
  });

  test("achat : TVA par taux ou par montant, déductibilité explicite", () => {
    const values = { ...initialEntryValues("expenses", "HOSPITALITY", "2026-10-31"), supplier: "Metro", amount_ht: "100" };
    expect(buildEntryPayload("expenses", "HOSPITALITY", values).payload).toEqual({
      date: "2026-10-31", supplier: "Metro", amount_ht: "100", vat_rate: "5.5", vat_deductible: true,
      category: "MATIERE_PREMIERE", allocation: "FOOD",
    });
    const byAmount = { ...values, vat_mode: "amount", amount_vat: "5,50", vat_deductible: false, category: "FRAIS_GENERAUX" };
    expect(buildEntryPayload("expenses", "HOSPITALITY", byAmount).payload).toEqual({
      date: "2026-10-31", supplier: "Metro", amount_ht: "100", amount_vat: "5.50", vat_deductible: false, category: "FRAIS_GENERAUX",
    });
  });

  test("charges récurrentes : prêt, salaires et dates d’activité contrôlés", () => {
    const loan = {
      ...initialEntryValues("overheads", "SERVICES", "2026-10-31"),
      label: "Prêt fonds de commerce", category: "LOAN", monthly_amount_ht: "1500", loan_principal: "1600", active_to: "2026-09-30",
    };
    expect(names("overheads", "SERVICES", loan)).not.toContain("vat_rate");
    expect(fieldLabel(ENTRY_FIELDS.overheads[2], "SERVICES", loan)).toBe("Mensualité d’emprunt (capital + intérêts)");
    expect(buildEntryPayload("overheads", "SERVICES", loan).errors).toEqual({
      active_to: "La fin de la charge précède son début.",
      loan_principal: "Le capital remboursé dépasse la mensualité.",
    });
    const payroll = { ...loan, category: "PAYROLL", monthly_amount_ht: "8000", employer_charges: "3400", loan_principal: "", active_to: "" };
    expect(buildEntryPayload("overheads", "SERVICES", payroll)).toEqual({
      payload: { label: "Prêt fonds de commerce", category: "PAYROLL", monthly_amount_ht: "8000", employer_charges: "3400", active_from: "2026-10-01" },
      errors: {},
    });
  });

  test("bilan : le total doit couvrir l’actif et le passif saisis", () => {
    const sheet = {
      ...initialEntryValues("balance_sheets", "RETAIL", "2026-10-31"),
      equity: "-5000", financial_debt: "50000", inventory: "20000", trade_receivables: "30000", cash: "10000", total_assets: "50000",
    };
    expect(buildEntryPayload("balance_sheets", "RETAIL", sheet).errors.total_assets).toContain("stocks, créances clients et disponibilités");
    expect(buildEntryPayload("balance_sheets", "RETAIL", { ...sheet, equity: "100000", total_assets: "120000" }).errors.total_assets)
      .toContain("capitaux propres et dettes");
    expect(buildEntryPayload("balance_sheets", "RETAIL", { ...sheet, total_assets: "200000" }).errors).toEqual({});
  });

  test("colonnes et valeurs affichées dans les listes", () => {
    expect(entryColumns("revenues", "HOSPITALITY").map((item) => item.key))
      .toEqual(["date", "amount_ht", "amount_ttc", "vat_rate", "payment_method", "allocation", "business_reference"]);
    expect(entryColumns("expenses", "SERVICES").map((item) => item.key)).not.toContain("allocation");
    expect(entryColumns("unknown", "SERVICES")).toEqual([]);
    expect(formatEntryValue({ kind: "money" }, "1250.5")).toBe(`1${NNBSP}250,50${NBSP}€`);
    expect(formatEntryValue({ kind: "money" }, "1250.5000", "GBP")).toBe(`1${NNBSP}250,50${NBSP}£`);
    expect(formatEntryValue({ kind: "percent" }, "20.0000")).toBe(`20${NBSP}%`);
    expect(formatEntryValue({ kind: "quantity" }, "7.5000")).toBe("7,5");
    expect(formatEntryValue({ kind: "integer" }, 42)).toBe("42");
    expect(formatEntryValue({ kind: "enum", options: { CARD: "Carte bancaire" } }, "CARD")).toBe("Carte bancaire");
    expect(formatEntryValue({ kind: "enum", options: {} }, "X")).toBe("X");
    expect(formatEntryValue({ kind: "boolean" }, false)).toBe("Non");
    expect(formatEntryValue({ kind: "date" }, "2026-10-31")).toBe("31/10/2026");
    expect(formatEntryValue({ kind: "money" }, null)).toBe("—");
    expect(formatEntryValue({ kind: "money" }, "abc")).toBe("abc");
  });
});

describe("requêtes réseau", () => {
  const PROFILE_DETAIL = "Profil financier d’entreprise introuvable : créez-le dans « Saisie & imports ».";

  test.each([
    ["serveur injoignable", () => Promise.reject(new TypeError("Failed to fetch")), { code: "NETWORK" }],
    ["session expirée", () => Promise.resolve(response(401, { detail: "x" })), { code: "UNAUTHENTICATED", status: 401 }],
    ["profil manquant", () => Promise.resolve(response(404, { detail: PROFILE_DETAIL })), { code: "PROFILE_MISSING", message: PROFILE_DETAIL }],
    ["entreprise inaccessible", () => Promise.resolve(response(404, { detail: "Entreprise inaccessible." })),
      { code: "HTTP_404", message: "Entreprise inaccessible." }],
    ["validation", () => Promise.resolve(response(422, { detail: [{ msg: "x" }] })),
      { code: "HTTP_422", message: "Données refusées : vérifiez les champs saisis." }],
    ["panne", () => Promise.resolve(response(503, null, { json: false })),
      { code: "SERVER", message: "Service financier indisponible (HTTP 503). Réessayez sans modifier vos données." }],
    ["erreur interne", () => Promise.resolve(response(500, { detail: "Erreur interne." })),
      { code: "SERVER", message: "Erreur interne (HTTP 500). Réessayez sans modifier vos données." }],
    ["statut inconnu", () => Promise.resolve(response(418, {})), { code: "HTTP_418", message: "Requête refusée (HTTP 418)." }],
    ["route absente (message anglais générique)", () => Promise.resolve(response(404, { detail: "Not Found" })),
      { code: "HTTP_404", message: "Ressource financière introuvable." }],
    ["accès refusé (message anglais générique)", () => Promise.resolve(response(403, { detail: "Forbidden" })),
      { code: "HTTP_403", message: "Accès refusé à cette ressource financière." }],
    ["passerelle en panne (message anglais générique)", () => Promise.resolve(response(502, { detail: "Bad Gateway" })),
      { code: "SERVER", message: "Service financier indisponible (HTTP 502). Réessayez sans modifier vos données." }],
    ["JSON illisible", () => Promise.resolve(response(200, null, { json: false })), { code: "INVALID_JSON" }],
  ])("%s produit une erreur explicite", async (_, reply, expected) => {
    global.fetch = jest.fn(reply);
    await expect(financeRequest("/finance/x")).rejects.toMatchObject({ name: "FinanceError", ...expected });
    expect(global.fetch).toHaveBeenCalledWith(`${API_BASE_URL}/finance/x`, expect.objectContaining({ credentials: "include" }));
  });

  test("204 renvoie null et une annulation reste une annulation", async () => {
    global.fetch = jest.fn(() => Promise.resolve(response(204, null)));
    await expect(financeRequest("/x", { method: "DELETE" })).resolves.toBeNull();
    global.fetch = jest.fn(() => Promise.reject(new DOMException("Aborted", "AbortError")));
    await expect(financeRequest("/x")).rejects.toMatchObject({ name: "AbortError" });
  });

  test("chemins encodés et paramètres de période", () => {
    expect(dashboardPath("a b/c", { start_date: "2025-03-01", end_date: "2025-03-31", comparison: "none" }))
      .toBe("/finance/a%20b%2Fc/dashboard?start_date=2025-03-01&end_date=2025-03-31&comparison=none");
    expect(entriesPath("company_a", "revenues", { start_date: "2025-03-01", end_date: "2025-03-31" }))
      .toBe("/finance/company_a/entries/revenues?start_date=2025-03-01&end_date=2025-03-31&limit=500");
    expect(entriesPath("company_a", "inventories", {})).toBe("/finance/company_a/entries/inventories?limit=500");
  });

  test("contexte entreprise et rôles autorisés", async () => {
    global.fetch = jest.fn(() => Promise.resolve(response(200, {
      company: { id: "c1", name: "Nom" }, membership: { company_id: "c1", role: "admin" },
    })));
    await expect(fetchEnterpriseContext()).resolves.toEqual({ companyId: "c1", companyName: "Nom", role: "admin" });
    global.fetch = jest.fn(() => Promise.resolve(response(200, { company: null, membership: null })));
    await expect(fetchEnterpriseContext()).resolves.toEqual({ companyId: null, companyName: "", role: null });
    expect([canUseFinance("admin"), canUseFinance("manager"), canUseFinance("viewer"), canUseFinance(null)]).toEqual([true, true, false, false]);
  });

  test("des données de démonstration ne peuvent jamais être affichées comme réelles", async () => {
    const query = { ...fixtures.dashboard.period, comparison: "year_ago" };
    global.fetch = jest.fn(() => Promise.resolve(response(200, clone(fixtures.dashboard))));
    await expect(fetchFinanceDashboard({ companyId: "demo-construction", query })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    expect(global.fetch.mock.calls[0][0])
      .toBe(`${API_BASE_URL}/finance/demo-construction/dashboard?start_date=2025-03-01&end_date=2025-03-31&comparison=year_ago`);
    await expect(fetchFinanceDashboard({ demoSector: "CONSTRUCTION", query })).resolves.toMatchObject({ demo: true });
    expect(global.fetch.mock.calls[1][0]).toContain("/finance/demo/CONSTRUCTION/dashboard?start_date=2025-03-01");
  });

  test("listes de pièces contrôlées et création sans paramètre de liste", async () => {
    global.fetch = jest.fn(() => Promise.resolve(response(200, { kind: "expenses", entries: [], truncated: false })));
    await expect(fetchEntries({ companyId: "company_a", kind: "revenues" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    global.fetch = jest.fn(() => Promise.resolve(response(200, {
      kind: "revenues", entries: [{ id: 1, values: {} }, { id: 2 }, null], truncated: true,
    })));
    await expect(fetchEntries({ companyId: "company_a", kind: "revenues" })).resolves.toEqual({ entries: [{ id: 1, values: {} }], truncated: true });
    global.fetch = jest.fn(() => Promise.resolve(response(201, { id: 3 })));
    await createEntry("company_a", "revenues", { amount_ht: "1.00" });
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/finance/company_a/entries/revenues`);
    expect(options).toMatchObject({ method: "POST", body: '{"amount_ht":"1.00"}', headers: { "Content-Type": "application/json" } });
  });
});

describe("import de relevé bancaire", () => {
  test.each([
    ["mauvais format", new File(["x"], "releve.pdf"), "FILE_TYPE"],
    ["fichier vide", new File([], "releve.csv"), "FILE_EMPTY"],
    ["fichier trop lourd", { name: "releve.csv", size: MAX_IMPORT_BYTES + 1 }, "FILE_TOO_LARGE"],
  ])("%s refusé avant tout envoi", async (_, file, code) => {
    global.fetch = jest.fn();
    await expect(uploadBankStatement("company_a", file)).rejects.toMatchObject({ code });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("envoi du fichier brut avec type et clé d’idempotence", async () => {
    global.fetch = jest.fn(() => Promise.resolve(response(200, { record_count: 1 })));
    const file = new File(["Date;Libellé;Débit;Crédit\r\n"], "Relevé mars.csv", { type: "text/csv", lastModified: 1700000000000 });
    await uploadBankStatement("company_a", file);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe(`${API_BASE_URL}/finance/company_a/ingestions/bank_statement_csv`);
    expect(options.method).toBe("POST");
    expect(options.body).toBe(file);
    expect(options.headers).toEqual({ "Content-Type": "text/csv", "Idempotency-Key": `bank-${file.size}-1700000000000-Relev__mars.csv` });
    await uploadBankStatement("company_a", new File(["<OFX>"], "export.QFX"));
    expect(global.fetch.mock.calls[1][0]).toContain("/ingestions/bank_statement_ofx");
    expect(global.fetch.mock.calls[1][1].headers["Content-Type"]).toBe("application/x-ofx");
    expect(bankIdempotencyKey({ name: "x".repeat(300), size: 1, lastModified: 2 })).toHaveLength(128);
  });
});

describe("délais et annulation", () => {
  test("le délai maximal interrompt la requête avec un message explicite", async () => {
    jest.useFakeTimers();
    let inner;
    const pending = withTimeout((signal) => { inner = signal; return new Promise(() => {}); }, { timeoutMs: 1000 });
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", message: TIMEOUT_MESSAGE });
    expect(inner.aborted).toBe(true);
  });

  test("une annulation externe interrompt la requête", async () => {
    const controller = new AbortController();
    let inner;
    const pending = withTimeout((signal) => { inner = signal; return new Promise(() => {}); }, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(inner.aborted).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await expect(withTimeout(() => "ok", { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("téléchargement et impression", () => {
  test("téléchargement indisponible sans URL.createObjectURL", () => {
    expect(URL.createObjectURL).toBeUndefined();
    expect(downloadText("a.csv", "x")).toBe(false);
  });

  test("téléchargement par lien temporaire puis libération de l’URL", () => {
    jest.useFakeTimers();
    const clicked = [];
    URL.createObjectURL = jest.fn(() => "blob:sirius");
    URL.revokeObjectURL = jest.fn();
    jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click() {
      clicked.push({ download: this.download, href: this.href, attached: document.body.contains(this) });
    });
    try {
      expect(downloadText("rapport.csv", "\ufeffa;b\r\n")).toBe(true);
      expect(clicked).toEqual([{ download: "rapport.csv", href: "blob:sirius", attached: true }]);
      expect(URL.createObjectURL.mock.calls[0][0].type).toBe("text/csv;charset=utf-8");
      expect(document.querySelector("a[download]")).toBeNull();
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1000);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:sirius");
    } finally {
      delete URL.createObjectURL;
      delete URL.revokeObjectURL;
    }
  });

  describe("impression", () => {
    const originalPrint = window.print;
    let node;
    beforeEach(() => {
      node = document.createElement("article");
      node.id = "report";
      node.innerHTML = '<h3 id="title">Rapport</h3><div data-print-hide="true"><button>Export</button></div>'
        + "<details><summary>Méthode</summary><p>Définitions</p></details>";
      document.body.appendChild(node);
      document.title = "SIRIUS";
    });
    afterEach(() => {
      window.print = originalPrint;
      node.remove();
      document.getElementById("sirius-print-root")?.remove();
      document.documentElement.classList.remove("sirius-printing");
    });

    test("indisponible sans window.print", () => {
      window.print = undefined;
      expect(printFinanceReport(node)).toBe(false);
      expect(document.getElementById("sirius-print-root")).toBeNull();
    });

    test("imprime un clone nettoyé puis restaure la page", () => {
      window.print = jest.fn(() => {
        const root = document.getElementById("sirius-print-root");
        expect(root.querySelector("[data-print-hide]")).toBeNull();
        expect(root.querySelector("[id]")).toBeNull();
        expect(root.querySelector("details").hasAttribute("open")).toBe(true);
        expect(document.documentElement.classList.contains("sirius-printing")).toBe(true);
        expect(document.title).toBe("ΣIRIUS – Rapport");
      });
      expect(printFinanceReport(node, { title: "ΣIRIUS – Rapport" })).toBe(true);
      expect(window.print).toHaveBeenCalledTimes(1);
      expect(node.querySelector("[data-print-hide]")).not.toBeNull();
      expect(document.getElementById("title")).not.toBeNull();
      window.dispatchEvent(new Event("afterprint"));
      expect(document.getElementById("sirius-print-root")).toBeNull();
      expect(document.documentElement.classList.contains("sirius-printing")).toBe(false);
      expect(document.title).toBe("SIRIUS");
    });

    test("nettoyage de secours après 60 secondes et en cas d’échec", () => {
      jest.useFakeTimers();
      window.print = jest.fn();
      printFinanceReport(node);
      printFinanceReport(node);
      expect(document.querySelectorAll("#sirius-print-root")).toHaveLength(1);
      jest.advanceTimersByTime(60000);
      expect(document.getElementById("sirius-print-root")).toBeNull();
      window.print = jest.fn(() => { throw new Error("bloqué"); });
      expect(printFinanceReport(node)).toBe(false);
      expect(document.getElementById("sirius-print-root")).toBeNull();
      expect(document.documentElement.classList.contains("sirius-printing")).toBe(false);
    });
  });
});

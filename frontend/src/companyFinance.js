import { API_BASE_URL } from "./lib/api";

// Montants : chaînes décimales exactes de bout en bout ; aucun Number pour les valeurs monétaires.
export const CALCULATION_VERSION = "2";
export const REQUEST_TIMEOUT_MS = 30000;
export const MAX_PERIOD_DAYS = 3653;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRY_LIST = 500;
export const MAX_MONTHLY_POINTS = 60;
export const DEMO_WINDOW = Object.freeze({ start_date: "2023-01-01", end_date: "2025-12-31" });
export const DEMO_REFERENCE_DATE = "2025-12-31";
export const PROFILE_MISSING_PREFIX = "Profil financier";
export const TIMEOUT_MESSAGE = "Le chargement a dépassé 30 secondes. Réessayez.";
export const MUTATION_TIMEOUT_MESSAGE =
  "Délai de 30 secondes dépassé : vérifiez la liste avant de renvoyer, l’opération a pu aboutir.";
export const DEMO_WINDOW_MESSAGE =
  "La démonstration couvre les exercices 2023 à 2025 (du 01/01/2023 au 31/12/2025).";
export const INVALID_PAYLOAD_MESSAGE =
  "Réponse financière incomplète ou incohérente : tableau non affiché. Réessayez ou contactez le support.";
export const NOT_CERTIFIED_NOTICE =
  "Indicateurs de gestion calculés à partir des pièces saisies ou importées par l’entreprise : ils ne remplacent ni des comptes annuels certifiés ni une liasse fiscale.";
export const DEMO_NOTICE = "DONNÉES FICTIVES DE DÉMONSTRATION — aucune entreprise réelle n’est représentée.";

export class FinanceError extends Error {
  constructor(message, { status = 0, code = "ERROR" } = {}) {
    super(message);
    this.name = "FinanceError";
    this.status = status;
    this.code = code;
  }
}

const hasOwn = (object, key) =>
  object !== null && typeof object === "object" && Object.prototype.hasOwnProperty.call(object, key);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const SECTORS = Object.freeze({
  HOSPITALITY: "Restauration & alimentaire",
  CONSTRUCTION: "BTP & artisanat",
  RETAIL: "Commerce & retail",
  SERVICES: "Services & prestations",
});
export const SECTOR_KEYS = Object.freeze(Object.keys(SECTORS));
export const isSector = (value) => typeof value === "string" && hasOwn(SECTORS, value);
export const demoCompanyId = (sector) => `demo-${String(sector).toLowerCase()}`;

export const COMPARISONS = Object.freeze({
  year_ago: "Même période N-1",
  previous: "Période précédente",
  none: "Sans comparaison",
});
export const DEFAULT_COMPARISON = "year_ago";
export const isComparison = (value) => typeof value === "string" && hasOwn(COMPARISONS, value);

const metric = (label, kind, formula) => Object.freeze({ label, kind, formula });

export const METRICS = Object.freeze({
  revenue_ht: metric("Chiffre d’affaires HT", "money", "Somme des recettes HT de la période, avoirs déduits."),
  revenue_ttc: metric("Chiffre d’affaires TTC", "money", "Somme des recettes TTC de la période."),
  variable_costs: metric(
    "Coûts variables",
    "money",
    "Matières, marchandises, sous-traitance et fournitures (TTC − TVA déductible) + variation de stocks.",
  ),
  stock_variation: metric(
    "Variation de stocks",
    "money",
    "Stock initial − stock final des familles inventoriées le premier jour et le lendemain du dernier jour.",
  ),
  fixed_costs: metric(
    "Charges fixes d’exploitation",
    "money",
    "Charges récurrentes d’exploitation proratisées au jour (hors intérêts et capital, TVA non récupérable incluse) + frais généraux.",
  ),
  recurring_commitments: metric(
    "Engagements récurrents décaissés",
    "money",
    "Charges récurrentes HT + charges patronales + TVA, proratisées au jour (mensualités d’emprunt comprises).",
  ),
  financial_expenses: metric("Intérêts d’emprunt", "money", "Mensualités d’emprunt − capital remboursé, proratisées."),
  operating_expenses: metric(
    "Charges d’exploitation",
    "money",
    "Coûts variables + charges fixes d’exploitation ; les achats d’équipement (investissements) sont exclus.",
  ),
  contribution_margin_pct: metric("Taux de marge sur coûts variables", "percent", "(CA HT − coûts variables) / CA HT."),
  break_even_revenue_ht: metric(
    "Seuil de rentabilité (CA HT)",
    "money",
    "Charges fixes × CA HT / (CA HT − coûts variables) : CA HT qui couvre exactement les charges de la période.",
  ),
  approximate_ebe: metric(
    "EBE approché",
    "money",
    "CA HT − charges d’exploitation (hors intérêts, capital remboursé, investissements, impôts et éléments exceptionnels).",
  ),
  vat_collected: metric("TVA collectée", "money", "Recettes TTC − recettes HT."),
  vat_deductible: metric("TVA déductible", "money", "TVA déductible des achats + TVA récupérable des charges récurrentes."),
  vat_balance_estimate: metric(
    "Solde de TVA théorique",
    "money",
    "TVA collectée − TVA déductible ; positif : à reverser, négatif : crédit de TVA. Ne remplace pas la déclaration.",
  ),
  cash_inflows: metric("Encaissements bancaires", "money", "Mouvements de trésorerie positifs datés dans la période."),
  cash_outflows: metric("Décaissements bancaires", "money", "Mouvements de trésorerie négatifs datés dans la période, en valeur absolue."),
  cash_net_flow: metric("Flux net de trésorerie", "money", "Encaissements − décaissements de la période."),
  opening_cash: metric(
    "Trésorerie d’ouverture",
    "money",
    "Dernier solde connu au plus tard au début de période + mouvements entre ce solde et le début de période.",
  ),
  closing_cash: metric("Trésorerie de clôture", "money", "Trésorerie d’ouverture + flux net de la période."),
  external_charges: metric(
    "Consommations en provenance de tiers",
    "money",
    "Charges d’exploitation − frais de personnel (achats consommés, sous-traitance, loyers, assurances, frais généraux).",
  ),
  external_charges_pct: metric("Consommations de tiers / CA", "percent", "Consommations en provenance de tiers / CA HT."),
  value_added: metric("Valeur ajoutée", "money", "CA HT − consommations en provenance de tiers."),
  value_added_pct: metric("Taux de valeur ajoutée", "percent", "Valeur ajoutée / CA HT."),
  payroll_costs: metric("Frais de personnel", "money", "Salaires bruts + charges patronales, proratisés au jour."),
  payroll_costs_pct: metric("Frais de personnel / CA", "percent", "Frais de personnel / CA HT."),
  payroll_to_value_added_pct: metric("Frais de personnel / valeur ajoutée", "percent", "Frais de personnel / valeur ajoutée."),
  ebe_margin_pct: metric("Taux de marge d’EBE", "percent", "EBE approché / CA HT."),
  financial_expenses_to_revenue_pct: metric("Intérêts / CA", "percent", "Intérêts d’emprunt / CA HT."),
  approximate_caf: metric(
    "CAF approchée",
    "money",
    "EBE approché − intérêts d’emprunt (avant impôt sur les bénéfices et éléments exceptionnels).",
  ),
  caf_margin_pct: metric("CAF / CA", "percent", "CAF approchée / CA HT."),
  loan_principal_repaid: metric("Capital remboursé", "money", "Part capital des mensualités d’emprunt, proratisée au jour."),
  debt_service: metric("Annuités d’emprunt", "money", "Capital remboursé + intérêts d’emprunt de la période."),
  debt_service_coverage: metric(
    "Couverture des annuités (EBE / annuités)",
    "ratio",
    "EBE approché / (capital remboursé + intérêts). Repère bancaire usuel : au moins 1,2 fois.",
  ),
  caf_after_principal: metric(
    "Autofinancement après annuités (CAF − capital)",
    "money",
    "CAF approchée − capital remboursé : ce qui reste pour investir ou renforcer la trésorerie.",
  ),
  financial_expenses_to_ebe_pct: metric("Intérêts / EBE", "percent", "Intérêts d’emprunt / EBE approché. Repère : au plus 30 %."),
  safety_margin: metric("Marge de sécurité", "money", "CA HT − seuil de rentabilité."),
  safety_margin_pct: metric("Indice de sécurité", "percent", "Marge de sécurité / CA HT."),
  break_even_date: metric(
    "Point mort (date)",
    "date",
    "Premier jour où le CA HT cumulé de la période atteint le seuil de rentabilité de la période.",
  ),
  cash_days: metric(
    "Trésorerie en jours de décaissements",
    "days",
    "Trésorerie de clôture × jours de la période / décaissements. Repère : au moins 30 jours.",
  ),
  balance_sheet_date: metric("Date du bilan utilisé", "date", "Dernier bilan arrêté au plus tard à la fin de période."),
  working_capital_requirement: metric(
    "Besoin en fonds de roulement (BFR)",
    "money",
    "Stocks + créances clients − dettes fournisseurs − dettes fiscales et sociales (bilan utilisé).",
  ),
  working_capital_days: metric("BFR en jours de CA", "days", "BFR × jours de la période / CA HT."),
  customer_days: metric("Délai clients", "days", "Créances clients × jours de la période / CA TTC."),
  supplier_days: metric(
    "Délai fournisseurs",
    "days",
    "Dettes fournisseurs × jours / (achats TTC hors équipement + loyers, assurances et autres charges externes récurrentes).",
  ),
  inventory_days: metric(
    "Rotation des stocks en jours",
    "days",
    "Stocks du bilan × jours de la période / (achats de matières et marchandises + variation de stocks).",
  ),
  financial_debt: metric("Dettes financières", "money", "Emprunts et dettes financières du bilan utilisé."),
  net_debt: metric("Endettement net", "money", "Dettes financières − disponibilités du bilan utilisé."),
  equity: metric("Capitaux propres", "money", "Capitaux propres du bilan utilisé."),
  gearing: metric(
    "Gearing (endettement net / capitaux propres)",
    "ratio",
    "Endettement net / capitaux propres. Repère : au plus 1.",
  ),
  equity_ratio_pct: metric(
    "Autonomie financière (capitaux propres / total bilan)",
    "percent",
    "Capitaux propres / total du bilan. Repère : au moins 20 %.",
  ),
  debt_repayment_years: metric(
    "Capacité de remboursement (dettes financières / CAF annualisée)",
    "years",
    "Dettes financières / (CAF approchée × 365 / jours de la période). Repère : au plus 4 ans.",
  ),
  food_consumed_cost: metric("Coût des aliments consommés", "money", "Stock initial + achats d’aliments − stock final."),
  beverage_consumed_cost: metric("Coût des boissons consommées", "money", "Stock initial + achats de boissons − stock final."),
  food_cost_pct: metric("Food Cost", "percent", "Coût des aliments consommés / CA aliments HT."),
  beverage_cost_pct: metric("Beverage Cost", "percent", "Coût des boissons consommées / CA boissons HT."),
  prime_cost_pct: metric(
    "Prime Cost",
    "percent",
    "(Aliments consommés + boissons consommées + frais de personnel) / CA HT total.",
  ),
  dry_cost: metric("Déboursé sec", "money", "Matériaux et marchandises + sous-traitance (TTC − TVA déductible)."),
  margin: metric("Marge sur déboursé sec", "money", "CA HT − déboursé sec."),
  margin_pct: metric("Taux de marge sur déboursé sec", "percent", "Marge sur déboursé sec / CA HT."),
  unallocated_revenue_ht: metric("CA sans référence chantier", "money", "Recettes HT sans référence devis ou chantier."),
  unallocated_dry_cost: metric(
    "Déboursé sec sans référence chantier",
    "money",
    "Achats de matériaux et sous-traitance sans référence devis ou chantier.",
  ),
  goods_consumed_cost: metric(
    "Coût des marchandises consommées",
    "money",
    "Stock initial + achats de marchandises − stock final.",
  ),
  commercial_margin: metric("Marge commerciale", "money", "CA HT − coût des marchandises consommées."),
  commercial_margin_pct: metric("Taux de marge commerciale", "percent", "Marge commerciale / CA HT."),
  estimated_stock_turnover: metric(
    "Rotation estimée des stocks",
    "ratio",
    "Coût des marchandises consommées / stock moyen ((stock initial + stock final) / 2).",
  ),
  average_basket_ht: metric("Panier moyen HT", "money", "CA HT / nombre de tickets."),
  average_hourly_rate_ht: metric("Taux horaire moyen réel", "money", "CA HT / heures réalisées."),
  average_daily_rate_ht: metric("Taux journalier moyen réel", "money", "CA HT / jours réalisés."),
  structure_cost_ratio_pct: metric(
    "Charges de structure / CA",
    "percent",
    "(Charges récurrentes d’exploitation, salaires inclus, + frais généraux) / CA HT.",
  ),
});

export const COMMON_KEYS = Object.freeze([
  "revenue_ht", "revenue_ttc", "variable_costs", "stock_variation", "fixed_costs", "recurring_commitments",
  "financial_expenses", "operating_expenses", "contribution_margin_pct", "break_even_revenue_ht", "approximate_ebe",
  "vat_collected", "vat_deductible", "vat_balance_estimate", "cash_inflows", "cash_outflows", "cash_net_flow",
  "opening_cash", "closing_cash",
]);
const COMMON_NULLABLE = new Set([
  "stock_variation", "contribution_margin_pct", "break_even_revenue_ht", "opening_cash", "closing_cash",
]);
export const BANKING_KEYS = Object.freeze([
  "external_charges", "external_charges_pct", "value_added", "value_added_pct", "payroll_costs", "payroll_costs_pct",
  "payroll_to_value_added_pct", "ebe_margin_pct", "financial_expenses_to_revenue_pct", "approximate_caf",
  "caf_margin_pct", "loan_principal_repaid", "debt_service", "debt_service_coverage", "caf_after_principal",
  "financial_expenses_to_ebe_pct", "safety_margin", "safety_margin_pct", "break_even_date", "cash_days",
  "balance_sheet_date", "working_capital_requirement", "working_capital_days", "customer_days", "supplier_days",
  "inventory_days", "financial_debt", "net_debt", "equity", "gearing", "equity_ratio_pct", "debt_repayment_years",
]);
const BANKING_REQUIRED = new Set([
  "external_charges", "value_added", "payroll_costs", "approximate_caf", "loan_principal_repaid", "debt_service",
  "caf_after_principal",
]);
export const SECTOR_METRICS = Object.freeze({
  HOSPITALITY: Object.freeze([
    "food_consumed_cost", "beverage_consumed_cost", "food_cost_pct", "beverage_cost_pct", "prime_cost_pct",
  ]),
  CONSTRUCTION: Object.freeze(["dry_cost", "margin", "margin_pct", "unallocated_revenue_ht", "unallocated_dry_cost"]),
  RETAIL: Object.freeze([
    "goods_consumed_cost", "commercial_margin", "commercial_margin_pct", "estimated_stock_turnover", "average_basket_ht",
  ]),
  SERVICES: Object.freeze(["average_hourly_rate_ht", "average_daily_rate_ht", "structure_cost_ratio_pct"]),
});
const SECTOR_REQUIRED = new Set(["dry_cost", "margin", "unallocated_revenue_ht", "unallocated_dry_cost"]);
export const RATE_KEYS = new Set([
  "debt_service_coverage", "gearing", "estimated_stock_turnover", "cash_days", "working_capital_days",
  "customer_days", "supplier_days", "inventory_days", "debt_repayment_years",
]);
export const metricLabel = (key) => METRICS[key]?.label ?? key;
export const metricKind = (key) => METRICS[key]?.kind ?? "number";

export const SUMMARY_METRICS = Object.freeze([
  ["revenue_ht", "revenue_ttc"],
  ["approximate_ebe", "ebe_margin_pct"],
  ["approximate_caf", "caf_margin_pct"],
  ["debt_service_coverage", "debt_service"],
  ["break_even_revenue_ht", "safety_margin_pct"],
  ["closing_cash", "cash_days"],
]);

// Soldes intermédiaires de gestion simplifiés, dans l’ordre de lecture d’un banquier.
export const SIG_ROWS = Object.freeze([
  { key: "revenue_ht", sign: "", share: null, total: true },
  { key: "external_charges", sign: "−", share: "external_charges_pct" },
  { key: "stock_variation", sign: "", share: null, detail: true, label: "dont variation de stocks" },
  { key: "value_added", sign: "=", share: "value_added_pct", total: true },
  { key: "payroll_costs", sign: "−", share: "payroll_costs_pct" },
  { key: "approximate_ebe", sign: "=", share: "ebe_margin_pct", total: true },
  { key: "financial_expenses", sign: "−", share: "financial_expenses_to_revenue_pct" },
  { key: "approximate_caf", sign: "=", share: "caf_margin_pct", total: true },
  { key: "loan_principal_repaid", sign: "−", share: null },
  { key: "caf_after_principal", sign: "=", share: null, total: true },
]);

export const DASHBOARD_GROUPS = Object.freeze([
  {
    id: "debt",
    title: "Endettement et capacité de remboursement",
    intro: "Capacité de l’exploitation à honorer les échéances d’emprunt de la période.",
    keys: [
      "debt_service", "debt_service_coverage", "financial_expenses_to_ebe_pct", "caf_after_principal",
      "debt_repayment_years", "financial_debt", "net_debt", "gearing",
    ],
  },
  {
    id: "breakeven",
    title: "Point mort et marge de sécurité",
    intro: "Niveau d’activité qui couvre l’ensemble des charges d’exploitation de la période.",
    keys: [
      "variable_costs", "contribution_margin_pct", "fixed_costs", "break_even_revenue_ht", "safety_margin",
      "safety_margin_pct", "break_even_date",
    ],
  },
  {
    id: "cash",
    title: "Trésorerie",
    intro: "Reconstituée à partir du dernier solde bancaire saisi et des mouvements importés ou saisis.",
    keys: ["opening_cash", "cash_inflows", "cash_outflows", "cash_net_flow", "closing_cash", "cash_days"],
  },
  {
    id: "structure",
    title: "Bilan, BFR et délais de paiement",
    intro: "Lecture du dernier bilan arrêté au plus tard à la fin de période, rapportée à l’activité de la période.",
    keys: [
      "balance_sheet_date", "equity", "equity_ratio_pct", "working_capital_requirement", "working_capital_days",
      "customer_days", "supplier_days", "inventory_days",
    ],
  },
  {
    id: "vat",
    title: "TVA et engagements récurrents",
    intro: "Estimations de gestion : elles ne remplacent pas les déclarations de TVA.",
    keys: [
      "vat_collected", "vat_deductible", "vat_balance_estimate", "revenue_ttc", "recurring_commitments",
      "operating_expenses",
    ],
  },
]);

export const THRESHOLDS = Object.freeze({
  debt_service_coverage: Object.freeze({ min: "1.2", critical: "1", label: "Repère : au moins 1,2 fois ; sous 1, l’EBE ne couvre pas les annuités." }),
  financial_expenses_to_ebe_pct: Object.freeze({ max: "30", label: "Repère : au plus 30 % de l’EBE." }),
  debt_repayment_years: Object.freeze({ max: "4", label: "Repère : au plus 4 ans de CAF." }),
  gearing: Object.freeze({ max: "1", label: "Repère : endettement net au plus égal aux capitaux propres." }),
  equity_ratio_pct: Object.freeze({ min: "20", label: "Repère : au moins 20 % du total du bilan." }),
  cash_days: Object.freeze({ min: "30", label: "Repère : au moins 30 jours de décaissements." }),
});

// Un montant négatif sur ces indicateurs signale une difficulté (affichage en rouge).
const NEGATIVE_IS_ADVERSE = new Set([
  "revenue_ht", "value_added", "value_added_pct", "approximate_ebe", "ebe_margin_pct", "approximate_caf",
  "caf_margin_pct", "caf_after_principal", "contribution_margin_pct", "safety_margin", "safety_margin_pct",
  "opening_cash", "closing_cash", "cash_net_flow", "equity", "margin", "margin_pct", "commercial_margin",
  "commercial_margin_pct",
]);

export function thresholdStatus(key, value) {
  const threshold = THRESHOLDS[key];
  if (!threshold || typeof value !== "string" || !isDecimalString(value)) return null;
  if (threshold.critical !== undefined && compareDecimal(value, threshold.critical) < 0) return "critical";
  if (threshold.min !== undefined && compareDecimal(value, threshold.min) < 0) return "watch";
  if (threshold.max !== undefined && compareDecimal(value, threshold.max) > 0) return "watch";
  return "ok";
}

export const isAdverse = (key, value) =>
  NEGATIVE_IS_ADVERSE.has(key) && typeof value === "string" && isDecimalString(value) && compareDecimal(value, "0") < 0;

export function metricValue(data, key) {
  for (const section of ["common", "banking", "specific"]) {
    if (hasOwn(data?.[section], key)) return data[section][key];
  }
  return undefined;
}

export function sigRows(data) {
  return SIG_ROWS.filter((row) => {
    if (!row.detail) return true;
    const value = metricValue(data, row.key);
    return typeof value === "string" && compareDecimal(value, "0") !== 0;
  });
}

const BALANCE_SHEET_KEYS = new Set([
  "balance_sheet_date", "working_capital_requirement", "working_capital_days", "customer_days", "supplier_days",
  "inventory_days", "financial_debt", "net_debt", "equity", "gearing", "equity_ratio_pct", "debt_repayment_years",
]);
const REVENUE_SHARE_KEYS = new Set([
  "external_charges_pct", "value_added_pct", "payroll_costs_pct", "ebe_margin_pct", "financial_expenses_to_revenue_pct",
  "caf_margin_pct", "contribution_margin_pct", "working_capital_days", "margin_pct", "structure_cost_ratio_pct",
]);
const MISSING_OPENING_CASH = "Saisissez un solde bancaire daté au plus tard au premier jour de la période.";
const NO_BREAK_EVEN = "CA ou marge sur coûts variables nuls ou négatifs : seuil de rentabilité non calculable.";

export function nullReason(key, data) {
  const common = data?.common ?? {};
  const banking = data?.banking ?? {};
  if (BALANCE_SHEET_KEYS.has(key) && banking.balance_sheet_date == null) {
    return "Saisissez un bilan arrêté au plus tard à la fin de période.";
  }
  if (REVENUE_SHARE_KEYS.has(key)) return "CA HT nul ou négatif sur la période.";
  switch (key) {
    case "opening_cash":
    case "closing_cash":
      return MISSING_OPENING_CASH;
    case "cash_days":
      if (common.closing_cash == null) return MISSING_OPENING_CASH;
      if (compareDecimal(common.closing_cash, "0") < 0) return "Trésorerie de clôture négative.";
      return "Aucun décaissement bancaire sur la période.";
    case "stock_variation":
      return "Inventaires requis au premier jour de la période et au lendemain du dernier jour.";
    case "break_even_revenue_ht":
    case "safety_margin":
    case "safety_margin_pct":
      return NO_BREAK_EVEN;
    case "break_even_date":
      return common.break_even_revenue_ht == null ? NO_BREAK_EVEN : "Seuil de rentabilité non atteint sur la période.";
    case "payroll_to_value_added_pct":
      return "Valeur ajoutée nulle ou négative.";
    case "debt_service_coverage":
      return "Aucune annuité d’emprunt sur la période.";
    case "financial_expenses_to_ebe_pct":
      return "EBE nul ou négatif : ratio non significatif.";
    case "debt_repayment_years":
      return "CAF nulle ou négative : capacité de remboursement non démontrée.";
    case "gearing":
      return "Capitaux propres nuls ou négatifs : ratio non significatif.";
    case "equity_ratio_pct":
      return "Total du bilan non saisi.";
    case "customer_days":
      return "CA TTC nul ou négatif sur la période.";
    case "supplier_days":
      return "Aucun achat ni charge externe sur la période.";
    case "inventory_days":
      return "Aucune consommation de matières ou de marchandises sur la période.";
    case "food_consumed_cost":
    case "beverage_consumed_cost":
    case "goods_consumed_cost":
    case "commercial_margin":
    case "commercial_margin_pct":
    case "estimated_stock_turnover":
      return "Inventaires de début et de fin et ventilation des achats requis (voir les alertes).";
    case "food_cost_pct":
    case "beverage_cost_pct":
    case "prime_cost_pct":
      return "Inventaires et ventilation aliments / boissons des recettes et des achats requis (voir les alertes).";
    case "average_basket_ht":
      return "Nombre de tickets manquant sur au moins une recette.";
    case "average_hourly_rate_ht":
      return "Heures réalisées manquantes ou nulles.";
    case "average_daily_rate_ht":
      return "Jours réalisés manquants ou nuls.";
    default:
      return "Données insuffisantes · voir les alertes.";
  }
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
const MONEY_RE = /^-?\d+(\.\d{1,2})?$/;
const QUANTITY_RE = /^-?\d+(\.\d{1,4})?$/;
const KINDS = new Set(["money", "percent", "points", "ratio", "days", "years", "date", "number"]);
const NNBSP = "\u202f";
const NBSP = "\u00a0";
const MINUS = "\u2212";
const CURRENCY_SYMBOLS = Object.freeze({ EUR: "€", USD: "$", GBP: "£" });
const ZERO = BigInt(0);

export const isDecimalString = (value, kind = "number") =>
  typeof value === "string" && (kind === "money" ? MONEY_RE : QUANTITY_RE).test(value);

export function decimalToScaled(value, scale = 4) {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
    throw new TypeError(`Valeur décimale attendue : ${String(value)}`);
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const scaled = BigInt(`${whole}${fraction.padEnd(scale, "0").slice(0, scale)}`);
  return negative ? -scaled : scaled;
}

export function compareDecimal(left, right) {
  const a = decimalToScaled(left);
  const b = decimalToScaled(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export const decimalSign = (value) => compareDecimal(value, "0");

export function maxAbsDecimal(values) {
  let best = null;
  let bestScaled = ZERO;
  for (const value of values) {
    if (typeof value !== "string" || !DECIMAL_RE.test(value)) continue;
    const scaled = decimalToScaled(value);
    const magnitude = scaled < ZERO ? -scaled : scaled;
    if (best === null || magnitude > bestScaled) {
      best = value;
      bestScaled = magnitude;
    }
  }
  return best;
}

// Longueur d’une barre en pour mille de la plus grande valeur absolue (calcul BigInt, Number seulement pour le CSS).
export function barPermille(value, max) {
  if (typeof value !== "string" || typeof max !== "string") return 0;
  const scaledMax = decimalToScaled(max);
  const top = scaledMax < ZERO ? -scaledMax : scaledMax;
  if (top === ZERO) return 0;
  const scaled = decimalToScaled(value);
  const magnitude = scaled < ZERO ? -scaled : scaled;
  const permille = (magnitude * BigInt(1000)) / top;
  return Number(permille > BigInt(1000) ? BigInt(1000) : permille);
}

const groupThousands = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP);

function unitSuffix(kind, whole, currency) {
  const singular = whole === "0" || whole === "1";
  switch (kind) {
    case "money":
      return `${NBSP}${CURRENCY_SYMBOLS[currency] ?? currency}`;
    case "percent":
      return `${NBSP}%`;
    case "points":
      return `${NBSP}pt`;
    case "ratio":
      return `${NBSP}fois`;
    case "days":
      return `${NBSP}${singular ? "jour" : "jours"}`;
    case "years":
      return `${NBSP}${singular ? "an" : "ans"}`;
    default:
      return "";
  }
}

export function formatFinanceValue(value, kind = "money", currency = "EUR") {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TypeError("Devise ISO à trois lettres attendue.");
  if (!KINDS.has(kind)) throw new TypeError(`Type d’indicateur inconnu : ${String(kind)}`);
  if (value === null) return "Non calculable";
  if (kind === "date") {
    if (!isDate(value)) throw new TypeError(`Date ISO attendue : ${String(value)}`);
    return formatDate(value);
  }
  if (!isDecimalString(value, kind)) throw new TypeError(`Valeur décimale attendue : ${String(value)}`);
  const negative = value.startsWith("-");
  const [rawWhole, rawFraction = ""] = (negative ? value.slice(1) : value).split(".");
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = kind === "money" ? rawFraction.padEnd(2, "0") : rawFraction.replace(/0+$/, "");
  const zero = !/[1-9]/.test(`${whole}${fraction}`);
  const sign = negative && !zero ? MINUS : "";
  return `${sign}${groupThousands(whole)}${fraction ? `,${fraction}` : ""}${unitSuffix(kind, whole, currency)}`;
}

export const formatMetric = (key, value, currency = "EUR") => formatFinanceValue(value, metricKind(key), currency);

export function formatChange(value, kind = "money", currency = "EUR") {
  if (value === null || value === undefined) return "Non comparable";
  const text = formatFinanceValue(value, kind === "percent" ? "points" : kind, currency);
  return decimalSign(value) > 0 ? `+${text}` : text;
}

export function formatVariationPct(value) {
  if (value === null || value === undefined) return "—";
  const text = formatFinanceValue(value, "percent");
  return decimalSign(value) > 0 ? `+${text}` : text;
}

export function parseDecimalInput(text, { scale = 2, allowNegative = false, maxWhole = 12, max = null } = {}) {
  if (typeof text !== "string") return { error: "Nombre attendu." };
  let cleaned = text.replace(/[\s\u00a0\u202f\u2009]/g, "").replace(/\u2212/g, "-");
  if (!cleaned) return { error: "Valeur requise." };
  let negative = false;
  if (cleaned.startsWith("-")) {
    negative = true;
    cleaned = cleaned.slice(1);
  } else if (cleaned.startsWith("+")) {
    cleaned = cleaned.slice(1);
  }
  if (!/^\d+([.,]\d+)?$/.test(cleaned)) {
    return { error: "Nombre invalide : chiffres et une seule virgule décimale (ex. 1250,50)." };
  }
  const [rawWhole, rawFraction = ""] = cleaned.split(/[.,]/);
  if (rawFraction.length > scale && /[1-9]/.test(rawFraction.slice(scale))) {
    return { error: `${scale} décimale${scale > 1 ? "s" : ""} au maximum.` };
  }
  const whole = rawWhole.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.slice(0, scale);
  if (whole.length > maxWhole) return { error: `${maxWhole} chiffres au maximum avant la virgule.` };
  const unsigned = `${whole}${fraction ? `.${fraction}` : ""}`;
  const zero = !/[1-9]/.test(unsigned);
  if (negative && !zero && !allowNegative) return { error: "Valeur positive ou nulle attendue." };
  const value = negative && !zero ? `-${unsigned}` : unsigned;
  if (max !== null && compareDecimal(value, max) > 0) {
    return { error: `Valeur supérieure au maximum autorisé (${formatFinanceValue(max, "number")}).` };
  }
  return { value };
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FR_MONTHS = Object.freeze([
  "janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]);
const pad2 = (value) => String(value).padStart(2, "0");
const isoFromParts = (year, month, day) => `${String(year).padStart(4, "0")}-${pad2(month)}-${pad2(day)}`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export function parseIsoDate(value) {
  if (typeof value !== "string") return null;
  const match = ISO_DATE_RE.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 1) return null;
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

export const isDate = (value) => parseIsoDate(value) !== null;

const toIsoDate = (date) => isoFromParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());

export function addDays(value, days) {
  const date = parseIsoDate(value);
  if (!date) throw new TypeError(`Date ISO attendue : ${String(value)}`);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function lastDayOfMonth(year, month) {
  const date = new Date(Date.UTC(2000, 0, 1));
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

export function addMonths(value, months) {
  const [year, month, day] = value.split("-").map(Number);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return isoFromParts(targetYear, targetMonth, Math.min(day, lastDayOfMonth(targetYear, targetMonth)));
}

export const inclusiveDays = (start, end) => Math.round((parseIsoDate(end) - parseIsoDate(start)) / 86400000) + 1;

export function validFinancePeriod(period) {
  const { start_date: start, end_date: end } = period ?? {};
  if (!isDate(start) || !isDate(end) || end < start || end >= "9999-12-31") return false;
  return inclusiveDays(start, end) <= MAX_PERIOD_DAYS;
}

export function periodError(period, { demo = false } = {}) {
  const { start_date: start, end_date: end } = period ?? {};
  if (!isDate(start) || !isDate(end) || end < start || end >= "9999-12-31") {
    return "Saisissez une période valide : une date de début puis une date de fin postérieure ou égale.";
  }
  if (inclusiveDays(start, end) > MAX_PERIOD_DAYS) return "Période limitée à 10 ans.";
  if (demo && (start < DEMO_WINDOW.start_date || end > DEMO_WINDOW.end_date)) return DEMO_WINDOW_MESSAGE;
  return null;
}

export function localToday(now = new Date()) {
  return isoFromParts(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function defaultQuery(demo = false, today = localToday()) {
  if (demo) return { start_date: "2025-01-01", end_date: "2025-12-31", comparison: DEFAULT_COMPARISON };
  return { start_date: `${today.slice(0, 8)}01`, end_date: today, comparison: DEFAULT_COMPARISON };
}

const DEMO_PRESETS = Object.freeze([
  { id: "demo-december", label: "Décembre 2025", start_date: "2025-12-01", end_date: "2025-12-31" },
  { id: "demo-november", label: "Novembre 2025", start_date: "2025-11-01", end_date: "2025-11-30" },
  { id: "demo-q4", label: "T4 2025", start_date: "2025-10-01", end_date: "2025-12-31" },
  { id: "demo-2025", label: "Année 2025", start_date: "2025-01-01", end_date: "2025-12-31" },
  { id: "demo-2024", label: "Année 2024", start_date: "2024-01-01", end_date: "2024-12-31" },
  { id: "demo-all", label: "2023 → 2025", start_date: DEMO_WINDOW.start_date, end_date: DEMO_WINDOW.end_date },
]);

export function periodPresets(reference = localToday(), { demo = false } = {}) {
  if (demo) return DEMO_PRESETS;
  const [year, month] = reference.split("-").map(Number);
  const monthStart = isoFromParts(year, month, 1);
  const previousStart = addMonths(monthStart, -1);
  const [previousYear, previousMonth] = previousStart.split("-").map(Number);
  const quarter = Math.floor((month - 1) / 3);
  return [
    { id: "month", label: `${capitalize(FR_MONTHS[month - 1])} ${year} à date`, start_date: monthStart, end_date: reference },
    {
      id: "previous-month",
      label: `${capitalize(FR_MONTHS[previousMonth - 1])} ${previousYear}`,
      start_date: previousStart,
      end_date: addDays(monthStart, -1),
    },
    { id: "quarter", label: `T${quarter + 1} ${year} à date`, start_date: isoFromParts(year, quarter * 3 + 1, 1), end_date: reference },
    { id: "year", label: `${year} à date`, start_date: isoFromParts(year, 1, 1), end_date: reference },
    {
      id: "previous-year",
      label: `Année ${year - 1}`,
      start_date: isoFromParts(year - 1, 1, 1),
      end_date: isoFromParts(year - 1, 12, 31),
    },
    { id: "rolling", label: "12 mois glissants", start_date: addDays(addMonths(reference, -12), 1), end_date: reference },
  ];
}

export function formatDate(value) {
  if (!isDate(value)) return typeof value === "string" ? value : "—";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

export function formatTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return "—";
  let text = value.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) text = `${text}Z`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

export const describePeriod = (period) => `du ${formatDate(period?.start_date)} au ${formatDate(period?.end_date)}`;

export function monthlyLabel(period) {
  const { start_date: start, end_date: end } = period ?? {};
  if (isDate(start) && isDate(end)) {
    const [year, month, day] = start.split("-").map(Number);
    if (day === 1 && end === isoFromParts(year, month, lastDayOfMonth(year, month))) {
      return `${capitalize(FR_MONTHS[month - 1])} ${year}`;
    }
  }
  return `${formatDate(start)} → ${formatDate(end)}`;
}

export const SEVERITIES = Object.freeze({ critical: "Prioritaire", warning: "À surveiller", info: "Information" });
const SEVERITY_ORDER = Object.freeze({ critical: 0, warning: 1, info: 2 });

export const sortAlerts = (alerts) =>
  [...(alerts ?? [])].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);

function invalidPayload(detail) {
  const error = new FinanceError(INVALID_PAYLOAD_MESSAGE, { code: "INVALID_PAYLOAD" });
  error.detail = detail;
  return error;
}

const isPeriodObject = (value) =>
  isPlainObject(value) && isDate(value.start_date) && isDate(value.end_date) && value.end_date >= value.start_date;

function checkMetric(section, key, nullable, where) {
  if (!hasOwn(section, key)) throw invalidPayload(`${where}.${key} absent`);
  const value = section[key];
  if (value === null) {
    if (!nullable) throw invalidPayload(`${where}.${key} nul`);
    return;
  }
  const kind = metricKind(key);
  if (!(kind === "date" ? isDate(value) : isDecimalString(value, kind))) throw invalidPayload(`${where}.${key} invalide`);
}

const checkNullableDecimal = (value, kind, detail) => {
  if (value !== null && !isDecimalString(value, kind)) throw invalidPayload(detail);
};

function validateProjects(projects) {
  if (!Array.isArray(projects)) throw invalidPayload("chantiers absents");
  const seen = new Set();
  projects.forEach((project) => {
    const reference = project?.business_reference;
    if (!isPlainObject(project) || typeof reference !== "string" || !reference.trim() || seen.has(reference)) {
      throw invalidPayload("référence de chantier vide ou dupliquée");
    }
    seen.add(reference);
    ["revenue_ht", "dry_cost", "margin"].forEach((key) => {
      if (!isDecimalString(project[key], "money")) throw invalidPayload(`chantier.${key}`);
    });
    checkNullableDecimal(project.margin_pct, "percent", "chantier.margin_pct");
  });
}

function validateComparison(value, mode) {
  if (value === null || value === undefined) return;
  if (mode === "none") throw invalidPayload("comparaison inattendue");
  if (!isPlainObject(value) || value.mode !== mode || !isPeriodObject(value.period) || typeof value.has_data !== "boolean"
    || !Array.isArray(value.variations)) {
    throw invalidPayload("comparaison");
  }
  const seen = new Set();
  value.variations.forEach((item) => {
    if (!isPlainObject(item) || typeof item.key !== "string" || seen.has(item.key)) throw invalidPayload("variation");
    seen.add(item.key);
    const kind = metricKind(item.key) === "money" ? "money" : "number";
    ["current", "previous", "change"].forEach((field) => checkNullableDecimal(item[field], kind, `variation.${item.key}`));
    checkNullableDecimal(item.change_pct, "percent", `variation.${item.key}.change_pct`);
  });
}

function validateMonthly(points, period) {
  if (!Array.isArray(points) || points.length > MAX_MONTHLY_POINTS) throw invalidPayload("série mensuelle");
  let previousEnd = null;
  points.forEach((point) => {
    if (!isPlainObject(point) || !isPeriodObject(point.period)) throw invalidPayload("point mensuel");
    const { start_date: start, end_date: end } = point.period;
    if (start < period.start_date || end > period.end_date || (previousEnd !== null && start <= previousEnd)) {
      throw invalidPayload("point mensuel hors période ou désordonné");
    }
    previousEnd = end;
    ["revenue_ht", "approximate_ebe", "approximate_caf", "cash_net_flow"].forEach((key) => {
      if (!isDecimalString(point[key], "money")) throw invalidPayload(`mensuel.${key}`);
    });
    checkNullableDecimal(point.stock_variation ?? null, "money", "mensuel.stock_variation");
    checkNullableDecimal(point.closing_cash, "money", "mensuel.closing_cash");
    checkNullableDecimal(point.ebe_margin_pct, "percent", "mensuel.ebe_margin_pct");
  });
}

export function validateFinanceDashboard(data, { companyId, period, comparison = DEFAULT_COMPARISON, demo = false } = {}) {
  if (!isPlainObject(data)) throw invalidPayload("charge utile");
  if (data.calculation_version !== CALCULATION_VERSION) throw invalidPayload("version de calcul");
  if (data.demo !== demo) throw invalidPayload("nature démonstration / réel");
  const { company } = data;
  if (!isPlainObject(company) || company.id !== companyId || typeof company.name !== "string" || !company.name.trim()
    || !isSector(company.sector) || typeof company.currency !== "string" || !/^[A-Z]{3}$/.test(company.currency)) {
    throw invalidPayload("entreprise");
  }
  if (!isPeriodObject(data.period)
    || (period && (data.period.start_date !== period.start_date || data.period.end_date !== period.end_date))) {
    throw invalidPayload("période");
  }
  if (!isPlainObject(data.common) || !isPlainObject(data.banking)) throw invalidPayload("sections d’indicateurs");
  COMMON_KEYS.forEach((key) => checkMetric(data.common, key, COMMON_NULLABLE.has(key), "common"));
  BANKING_KEYS.forEach((key) => checkMetric(data.banking, key, !BANKING_REQUIRED.has(key), "banking"));
  const { specific } = data;
  if (!isPlainObject(specific) || specific.sector !== company.sector) throw invalidPayload("indicateurs métier");
  SECTOR_METRICS[company.sector].forEach((key) => checkMetric(specific, key, !SECTOR_REQUIRED.has(key), "specific"));
  if (company.sector === "CONSTRUCTION") validateProjects(specific.projects);
  validateComparison(data.comparison, comparison);
  validateMonthly(data.monthly, data.period);
  if (!Array.isArray(data.alerts) || data.alerts.some((alert) => !isPlainObject(alert) || typeof alert.code !== "string"
    || !hasOwn(SEVERITIES, alert.severity) || typeof alert.message !== "string")) {
    throw invalidPayload("alertes");
  }
  return data;
}

export function normalizeDemoCatalog(data) {
  if (!isPlainObject(data) || !Array.isArray(data.companies)) throw invalidPayload("catalogue de démonstration");
  const companies = data.companies
    .filter((item) => isPlainObject(item?.company) && isSector(item.company.sector) && typeof item.company.name === "string")
    .map((item) => ({
      id: item.company.id,
      name: item.company.name,
      sector: item.company.sector,
      currency: item.company.currency,
      description: typeof item.description === "string" ? item.description : "",
    }));
  return { notice: typeof data.notice === "string" ? data.notice : DEMO_NOTICE, companies };
}

const STATUS_MESSAGES = Object.freeze({
  400: "Requête refusée par le serveur.",
  401: "Session expirée : reconnectez-vous pour accéder à la finance d’entreprise.",
  403: "Accès refusé à cette ressource financière.",
  404: "Ressource financière introuvable.",
  409: "Conflit : les données ont changé entre-temps. Rechargez la liste.",
  413: "Fichier trop volumineux : 5 Mio au maximum.",
  415: "Format de fichier non accepté.",
  422: "Données refusées : vérifiez les champs saisis.",
  429: "Trop de requêtes : patientez quelques secondes avant de réessayer.",
});

// Messages par défaut de FastAPI ou d’un proxy, en anglais : remplacés par le message français du statut.
const GENERIC_DETAILS = new Set([
  "bad request", "not authenticated", "unauthorized", "forbidden", "not found", "method not allowed", "conflict",
  "request entity too large", "unsupported media type", "too many requests", "internal server error", "bad gateway",
  "service unavailable", "gateway timeout",
]);

const abortError = () => {
  const error = new Error("Opération annulée.");
  error.name = "AbortError";
  return error;
};

export async function financeRequest(path, { method = "GET", body, headers, signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { method, credentials: "include", headers, body, signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new FinanceError("Serveur SIRIUS injoignable : vérifiez la connexion puis réessayez.", { code: "NETWORK" });
  }
  if (response.status === 204) return null;
  let payload = null;
  let parsed = false;
  try {
    payload = await response.json();
    parsed = true;
  } catch (error) {
    if (error?.name === "AbortError") throw error;
  }
  const { status } = response;
  if (!response.ok) {
    const raw = typeof payload?.detail === "string" ? payload.detail.trim() : "";
    const detail = raw && !GENERIC_DETAILS.has(raw.toLowerCase()) ? raw : null;
    if (status === 401) throw new FinanceError(STATUS_MESSAGES[401], { status, code: "UNAUTHENTICATED" });
    if (status === 404 && detail?.startsWith(PROFILE_MISSING_PREFIX)) {
      throw new FinanceError(detail, { status, code: "PROFILE_MISSING" });
    }
    if (status >= 500) {
      const base = (detail ?? "Service financier indisponible").replace(/[.\s]+$/u, "");
      throw new FinanceError(`${base} (HTTP ${status}). Réessayez sans modifier vos données.`, { status, code: "SERVER" });
    }
    throw new FinanceError(detail ?? STATUS_MESSAGES[status] ?? `Requête refusée (HTTP ${status}).`, {
      status,
      code: `HTTP_${status}`,
    });
  }
  if (!parsed) throw new FinanceError("Réponse illisible du serveur financier : réessayez.", { status, code: "INVALID_JSON" });
  return payload;
}

// Course entre l’opération, le délai maximal et l’annulation externe (démontage, nouvelle requête).
export function withTimeout(run, { timeoutMs = REQUEST_TIMEOUT_MS, message = TIMEOUT_MESSAGE, signal: outer } = {}) {
  const controller = new AbortController();
  let timer;
  let relay;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FinanceError(message, { code: "TIMEOUT" }));
    }, timeoutMs);
  });
  const cancelled = new Promise((_, reject) => {
    relay = () => {
      controller.abort();
      reject(abortError());
    };
    if (outer?.aborted) relay();
    else outer?.addEventListener("abort", relay, { once: true });
  });
  const work = Promise.resolve().then(() => run(controller.signal));
  return Promise.race([work, timeout, cancelled]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", relay);
  });
}

const enc = encodeURIComponent;

function searchString(params) {
  const search = new URLSearchParams();
  params.forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.append(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : "";
}

const periodParams = ({ start_date: start, end_date: end, comparison } = {}) => [
  ["start_date", start], ["end_date", end], ["comparison", comparison],
];

export const contextPath = () => "/enterprise/context";
export const demoCatalogPath = () => "/finance/demo/companies";
export const dashboardPath = (companyId, query) => `/finance/${enc(companyId)}/dashboard${searchString(periodParams(query))}`;
export const demoDashboardPath = (sector, query) => `/finance/demo/${enc(sector)}/dashboard${searchString(periodParams(query))}`;
export const profilePath = (companyId) => `/finance/${enc(companyId)}/profile`;
export const entriesPath = (companyId, kind, { start_date: start, end_date: end, limit = MAX_ENTRY_LIST } = {}) =>
  `/finance/${enc(companyId)}/entries/${enc(kind)}${searchString([["start_date", start], ["end_date", end], ["limit", limit]])}`;
export const demoEntriesPath = (sector, kind, { start_date: start, end_date: end, limit = MAX_ENTRY_LIST } = {}) =>
  `/finance/demo/${enc(sector)}/entries/${enc(kind)}${searchString([["start_date", start], ["end_date", end], ["limit", limit]])}`;
export const entryPath = (companyId, kind, entryId) => `/finance/${enc(companyId)}/entries/${enc(kind)}/${enc(String(entryId))}`;
export const ingestionPath = (companyId, source) => `/finance/${enc(companyId)}/ingestions/${enc(source)}`;
export const ingestionsPath = (companyId, limit = 50) => `/finance/${enc(companyId)}/ingestions?limit=${limit}`;
export const ingestionBatchPath = (companyId, batchId) => `/finance/${enc(companyId)}/ingestions/${enc(batchId)}`;
export const auditPath = (companyId) => `/finance/${enc(companyId)}/audit`;

const jsonRequest = (path, method, payload, signal) =>
  financeRequest(path, {
    method,
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    signal,
  });

export async function fetchEnterpriseContext(signal) {
  const data = await financeRequest(contextPath(), { signal });
  const companyId = data?.company?.id ?? data?.membership?.company_id ?? null;
  return {
    companyId: typeof companyId === "string" && companyId ? companyId : null,
    companyName: typeof data?.company?.name === "string" ? data.company.name : "",
    role: typeof data?.membership?.role === "string" ? data.membership.role : null,
  };
}

export const canUseFinance = (role) => role === "admin" || role === "manager";

export async function fetchDemoCatalog(signal) {
  return normalizeDemoCatalog(await financeRequest(demoCatalogPath(), { signal }));
}

export async function fetchFinanceDashboard({ companyId, demoSector = null, query, signal }) {
  const demo = Boolean(demoSector);
  const path = demo ? demoDashboardPath(demoSector, query) : dashboardPath(companyId, query);
  const data = await financeRequest(path, { signal });
  return validateFinanceDashboard(data, {
    companyId: demo ? demoCompanyId(demoSector) : companyId,
    period: { start_date: query.start_date, end_date: query.end_date },
    comparison: query.comparison,
    demo,
  });
}

export async function fetchProfile(companyId, signal) {
  const data = await financeRequest(profilePath(companyId), { signal });
  const profile = data?.profile ?? null;
  if (profile !== null && (!isPlainObject(profile) || !isSector(profile.sector))) throw invalidPayload("profil");
  return profile;
}

export const saveProfile = (companyId, profile, signal) => jsonRequest(profilePath(companyId), "PUT", profile, signal);

export async function fetchEntries({ companyId, demoSector = null, kind, query = {}, signal }) {
  const path = demoSector ? demoEntriesPath(demoSector, kind, query) : entriesPath(companyId, kind, query);
  const data = await financeRequest(path, { signal });
  if (!isPlainObject(data) || data.kind !== kind || !Array.isArray(data.entries)) throw invalidPayload("liste de pièces");
  return { entries: data.entries.filter((entry) => isPlainObject(entry) && isPlainObject(entry.values)), truncated: data.truncated === true };
}

export const createEntry = (companyId, kind, payload, signal) => jsonRequest(entriesPath(companyId, kind, { limit: null }), "POST", payload, signal);
export const deleteEntry = (companyId, kind, entryId, signal) =>
  financeRequest(entryPath(companyId, kind, entryId), { method: "DELETE", signal });

export function bankStatementSource(file) {
  const name = String(file?.name ?? "").toLowerCase();
  if (name.endsWith(".csv")) return { source: "bank_statement_csv", contentType: "text/csv" };
  if (name.endsWith(".ofx") || name.endsWith(".qfx")) return { source: "bank_statement_ofx", contentType: "application/x-ofx" };
  return null;
}

export function bankIdempotencyKey(file) {
  const name = String(file?.name ?? "releve").replace(/[^A-Za-z0-9._-]/g, "_");
  return `bank-${Number(file?.size) || 0}-${Number(file?.lastModified) || 0}-${name}`.slice(0, 128);
}

export function uploadBankStatement(companyId, file, signal) {
  const format = bankStatementSource(file);
  if (!format) {
    return Promise.reject(new FinanceError("Choisissez un relevé .csv, .ofx ou .qfx exporté depuis la banque.", { code: "FILE_TYPE" }));
  }
  if (!file.size) return Promise.reject(new FinanceError("Le fichier est vide.", { code: "FILE_EMPTY" }));
  if (file.size > MAX_IMPORT_BYTES) {
    return Promise.reject(new FinanceError("Fichier trop volumineux : 5 Mio au maximum.", { code: "FILE_TOO_LARGE" }));
  }
  return financeRequest(ingestionPath(companyId, format.source), {
    method: "POST",
    body: file,
    headers: { "Content-Type": format.contentType, "Idempotency-Key": bankIdempotencyKey(file) },
    signal,
  });
}

export async function fetchIngestions(companyId, signal) {
  const data = await financeRequest(ingestionsPath(companyId), { signal });
  if (!isPlainObject(data) || !Array.isArray(data.batches)) throw invalidPayload("journal des imports");
  return { batches: data.batches.filter(isPlainObject), truncated: data.truncated === true };
}

export const revertIngestion = (companyId, batchId, signal) =>
  financeRequest(ingestionBatchPath(companyId, batchId), { method: "DELETE", signal });

export async function fetchAudit(companyId, signal) {
  const data = await financeRequest(auditPath(companyId), { signal });
  if (!isPlainObject(data) || !Array.isArray(data.events)) throw invalidPayload("journal d’audit");
  return data.events.filter(isPlainObject);
}

export const ENTRY_KIND_LABELS = Object.freeze({
  revenues: "Recettes",
  expenses: "Achats",
  overheads: "Charges récurrentes",
  inventories: "Inventaires",
  cash_balances: "Soldes de trésorerie",
  cash_movements: "Mouvements de trésorerie",
  balance_sheets: "Bilans",
});
export const ENTRY_KINDS = Object.freeze(Object.keys(ENTRY_KIND_LABELS));
export const ENTRY_KIND_HELP = Object.freeze({
  revenues: "Une ligne par Z de caisse, facture ou encaissement de CA. Montant HT négatif pour un avoir ; le TTC est calculé par SIRIUS.",
  expenses: "Factures fournisseurs. Coût retenu : TTC − TVA déductible. Les équipements sont exclus de l’EBE (investissement).",
  overheads: "Charges fixes mensuelles, proratisées au jour : loyer, salaires et charges, échéances d’emprunt, assurances.",
  inventories: "Valeur du stock au premier jour de la période analysée et au lendemain de son dernier jour.",
  cash_balances: "Solde bancaire au début de la journée indiquée : point de départ du calcul de trésorerie.",
  cash_movements: "Encaissements (positifs) et décaissements (négatifs). L’import d’un relevé bancaire les renseigne automatiquement.",
  balance_sheets: "Postes du dernier bilan : capitaux propres, dettes, stocks, créances et disponibilités.",
});

export const PAYMENT_METHODS = Object.freeze({
  CASH: "Espèces", CARD: "Carte bancaire", TRANSFER: "Virement", CHEQUE: "Chèque", OTHER: "Autre",
});
export const ALLOCATIONS = Object.freeze({
  FOOD: "Aliments", BEVERAGE: "Boissons", MERCHANDISE: "Marchandises", OTHER: "Non ventilé",
});
export const EXPENSE_CATEGORIES = Object.freeze({
  MATIERE_PREMIERE: "Matières premières / marchandises",
  SOUS_TRAITANCE: "Sous-traitance",
  FOURNITURES: "Fournitures et petits consommables",
  FRAIS_GENERAUX: "Frais généraux",
  EQUIPEMENT: "Équipement (investissement)",
});
export const OVERHEAD_CATEGORIES = Object.freeze({
  RENT: "Loyer", PAYROLL: "Salaires et charges", LOAN: "Emprunt", INSURANCE: "Assurance", OTHER: "Autre charge fixe",
});
export const INGESTION_SOURCES = Object.freeze({
  pos_webhook: "Caisse (POS)",
  bank_statement_csv: "Relevé bancaire CSV",
  bank_statement_ofx: "Relevé bancaire OFX",
  invoice_ocr: "Facture (OCR)",
});
export const ORIGINS = Object.freeze({ manual: "Saisie manuelle", demo: "Démonstration fictive", ...INGESTION_SOURCES });
export const AUDIT_ACTIONS = Object.freeze({
  create: "Saisie", delete: "Suppression", import: "Import", revert: "Annulation d’import", profile: "Profil",
});

const REVENUE_REFERENCE_LABELS = Object.freeze({
  HOSPITALITY: "Z de caisse / ticket",
  CONSTRUCTION: "Chantier / devis",
  RETAIL: "Z de caisse / ticket",
  SERVICES: "Facture / mission",
});
const OVERHEAD_AMOUNT_LABELS = Object.freeze({
  RENT: "Loyer mensuel HT",
  PAYROLL: "Salaires bruts mensuels",
  LOAN: "Mensualité d’emprunt (capital + intérêts)",
  INSURANCE: "Prime mensuelle HT",
  OTHER: "Montant mensuel HT",
});
const NO_VAT_OVERHEADS = new Set(["PAYROLL", "LOAN"]);
const optionsOf = (labels, keys = Object.keys(labels)) => keys.map((key) => [key, labels[key]]);
const stockFamilies = (sector) =>
  optionsOf(ALLOCATIONS, sector === "HOSPITALITY" ? ["FOOD", "BEVERAGE"] : ["MERCHANDISE"]);
const field = (name, label, type, extra = {}) => Object.freeze({ name, label, type, ...extra });
const dateField = (label = "Date", extra = {}) => field("date", label, "date", { required: true, ...extra });

export const ENTRY_FIELDS = Object.freeze({
  revenues: [
    dateField(),
    field("amount_ht", "Montant HT", "money", { required: true, signed: true, help: "Négatif pour un avoir." }),
    field("vat_rate", "Taux de TVA (%)", "percent", { required: true }),
    field("payment_method", "Moyen de paiement", "select", { required: true, options: () => optionsOf(PAYMENT_METHODS) }),
    field("allocation", "Famille de vente", "select", {
      required: true,
      show: (sector) => sector === "HOSPITALITY",
      options: () => optionsOf(ALLOCATIONS, ["FOOD", "BEVERAGE", "OTHER"]),
      help: "Une recette par famille : le Food Cost et le Beverage Cost exigent la ventilation aliments / boissons.",
    }),
    field("business_reference", (sector) => REVENUE_REFERENCE_LABELS[sector] ?? "Référence", "text", {
      maxLength: 160,
      help: (sector) => (sector === "CONSTRUCTION" ? "Indispensable pour la marge par chantier." : ""),
    }),
    field("ticket_count", "Nombre de tickets", "integer", {
      show: (sector) => sector === "RETAIL",
      help: "Nécessaire au panier moyen.",
    }),
    field("hours", "Heures réalisées", "quantity", { show: (sector) => sector === "SERVICES", help: "Nécessaire au taux horaire réel." }),
    field("days", "Jours réalisés", "quantity", { show: (sector) => sector === "SERVICES", help: "Nécessaire au taux journalier réel." }),
  ],
  expenses: [
    dateField(),
    field("supplier", "Fournisseur", "text", { required: true, maxLength: 160 }),
    field("amount_ht", "Montant HT", "money", { required: true, signed: true, help: "Négatif pour un avoir fournisseur." }),
    field("vat_mode", "TVA renseignée par", "select", {
      required: true,
      local: true,
      options: () => [["rate", "Taux"], ["amount", "Montant"]],
    }),
    field("vat_rate", "Taux de TVA (%)", "percent", { required: true, show: (_, values) => values.vat_mode !== "amount" }),
    field("amount_vat", "Montant de TVA", "money", { required: true, signed: true, show: (_, values) => values.vat_mode === "amount" }),
    field("vat_deductible", "TVA déductible", "boolean"),
    field("category", "Catégorie", "select", { required: true, options: () => optionsOf(EXPENSE_CATEGORIES) }),
    field("allocation", "Famille de stock", "select", {
      required: true,
      show: (sector, values) => values.category === "MATIERE_PREMIERE" && (sector === "HOSPITALITY" || sector === "RETAIL"),
      options: stockFamilies,
    }),
    field("business_reference", (sector) => (sector === "CONSTRUCTION" ? "Chantier / devis" : "Référence de la facture"), "text", {
      maxLength: 160,
      help: (sector) => (sector === "CONSTRUCTION" ? "Rattache le déboursé sec au chantier." : ""),
    }),
  ],
  overheads: [
    field("label", "Libellé", "text", { required: true, maxLength: 160 }),
    field("category", "Nature", "select", { required: true, options: () => optionsOf(OVERHEAD_CATEGORIES) }),
    field("monthly_amount_ht", (_, values) => OVERHEAD_AMOUNT_LABELS[values.category] ?? "Montant mensuel HT", "money", { required: true }),
    field("employer_charges", "Charges patronales mensuelles", "money", { show: (_, values) => values.category === "PAYROLL" }),
    field("loan_principal", "Dont capital remboursé par mois", "money", {
      required: true,
      show: (_, values) => values.category === "LOAN",
      help: "Le reste de la mensualité est compté en intérêts.",
    }),
    field("vat_rate", "Taux de TVA (%)", "percent", { show: (_, values) => !NO_VAT_OVERHEADS.has(values.category) }),
    field("vat_recoverable", "TVA récupérable", "boolean", { show: (_, values) => !NO_VAT_OVERHEADS.has(values.category) }),
    field("active_from", "Active depuis le", "date", { required: true }),
    field("active_to", "Jusqu’au (facultatif)", "date"),
  ],
  inventories: [
    dateField("Date d’inventaire", { help: "Premier jour de la période et lendemain de son dernier jour (ex. 01/03 et 01/04 pour mars)." }),
    field("allocation", "Famille de stock", "select", { required: true, options: stockFamilies }),
    field("value", "Valeur du stock HT", "money", { required: true }),
  ],
  cash_balances: [
    dateField("Date du solde", { help: "Solde au début de la journée, avant les mouvements de cette date." }),
    field("amount", "Solde bancaire", "money", { required: true, signed: true }),
  ],
  cash_movements: [
    dateField(),
    field("amount", "Montant", "money", { required: true, signed: true, help: "Positif : encaissement ; négatif : décaissement." }),
    field("label", "Libellé", "text", { required: true, maxLength: 160 }),
    field("business_reference", "Référence", "text", { maxLength: 160 }),
  ],
  balance_sheets: [
    dateField("Date de clôture"),
    field("equity", "Capitaux propres", "money", { required: true, signed: true }),
    field("financial_debt", "Dettes financières (emprunts)", "money", { required: true }),
    field("inventory", "Stocks", "money"),
    field("trade_receivables", "Créances clients", "money"),
    field("trade_payables", "Dettes fournisseurs", "money"),
    field("tax_social_payables", "Dettes fiscales et sociales", "money"),
    field("cash", "Disponibilités", "money"),
    field("total_assets", "Total du bilan", "money", { help: "Nécessaire à l’autonomie financière." }),
  ],
});

export function initialEntryValues(kind, sector, today = localToday()) {
  const monthStart = `${today.slice(0, 8)}01`;
  const hospitality = sector === "HOSPITALITY";
  switch (kind) {
    case "revenues":
      return {
        date: today, amount_ht: "", vat_rate: hospitality ? "10" : "20",
        payment_method: hospitality || sector === "RETAIL" ? "CARD" : "TRANSFER",
        allocation: "FOOD", business_reference: "", ticket_count: "", hours: "", days: "",
      };
    case "expenses":
      return {
        date: today, supplier: "", amount_ht: "", vat_mode: "rate", vat_rate: hospitality ? "5,5" : "20", amount_vat: "",
        vat_deductible: true, category: sector === "SERVICES" ? "FRAIS_GENERAUX" : "MATIERE_PREMIERE",
        allocation: hospitality ? "FOOD" : "MERCHANDISE", business_reference: "",
      };
    case "overheads":
      return {
        label: "", category: "RENT", monthly_amount_ht: "", employer_charges: "", loan_principal: "", vat_rate: "0",
        vat_recoverable: false, active_from: monthStart, active_to: "",
      };
    case "inventories":
      return { date: monthStart, allocation: hospitality ? "FOOD" : "MERCHANDISE", value: "" };
    case "cash_balances":
      return { date: monthStart, amount: "" };
    case "cash_movements":
      return { date: today, amount: "", label: "", business_reference: "" };
    case "balance_sheets":
      return {
        date: `${String(Number(today.slice(0, 4)) - 1).padStart(4, "0")}-12-31`, equity: "", financial_debt: "", inventory: "",
        trade_receivables: "", trade_payables: "", tax_social_payables: "", cash: "", total_assets: "",
      };
    default:
      throw new TypeError(`Type de pièce inconnu : ${String(kind)}`);
  }
}

const resolve = (value, sector, values) => (typeof value === "function" ? value(sector, values) : value);
export const fieldLabel = (item, sector, values = {}) => resolve(item.label, sector, values);
export const fieldHelp = (item, sector, values = {}) => resolve(item.help, sector, values) || "";
export const fieldOptions = (item, sector, values = {}) => (item.options ? item.options(sector, values) : []);
export const visibleFields = (kind, sector, values = {}) =>
  (ENTRY_FIELDS[kind] ?? []).filter((item) => !item.show || item.show(sector, values));

const DECIMAL_FIELD_RULES = Object.freeze({
  money: { scale: 2, maxWhole: 12 },
  quantity: { scale: 4, maxWhole: 9 },
  percent: { scale: 4, maxWhole: 3, max: "100" },
});

function parseField(item, text, sector, values) {
  switch (item.type) {
    case "date":
      return isDate(text) ? { value: text } : { error: "Date invalide." };
    case "money":
    case "quantity":
    case "percent":
      return parseDecimalInput(text, { ...DECIMAL_FIELD_RULES[item.type], allowNegative: Boolean(item.signed) });
    case "integer":
      return /^\d{1,9}$/.test(text) ? { value: Number(text) } : { error: "Nombre entier positif attendu." };
    case "select":
      return fieldOptions(item, sector, values).some(([key]) => key === text) ? { value: text } : { error: "Choix invalide." };
    default:
      return text.length > (item.maxLength ?? 160) ? { error: `${item.maxLength ?? 160} caractères au maximum.` } : { value: text };
  }
}

const sumScaled = (values) => values.reduce((total, value) => total + (value ? decimalToScaled(value) : ZERO), ZERO);

export function buildEntryPayload(kind, sector, values) {
  const payload = {};
  const errors = {};
  visibleFields(kind, sector, values).forEach((item) => {
    if (item.local) return;
    const raw = values[item.name];
    if (item.type === "boolean") {
      payload[item.name] = raw === true;
      return;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) {
      if (item.required) errors[item.name] = "Champ obligatoire.";
      return;
    }
    const result = parseField(item, text, sector, values);
    if (result.error) errors[item.name] = result.error;
    else payload[item.name] = result.value;
  });
  if (kind === "overheads") {
    if (payload.active_to && payload.active_from && payload.active_to < payload.active_from) {
      errors.active_to = "La fin de la charge précède son début.";
    }
    if (payload.loan_principal && payload.monthly_amount_ht && compareDecimal(payload.loan_principal, payload.monthly_amount_ht) > 0) {
      errors.loan_principal = "Le capital remboursé dépasse la mensualité.";
    }
  }
  if (kind === "balance_sheets" && payload.total_assets) {
    const total = decimalToScaled(payload.total_assets);
    if (sumScaled([payload.inventory, payload.trade_receivables, payload.cash]) > total) {
      errors.total_assets = "Le total du bilan doit couvrir stocks, créances clients et disponibilités.";
    } else if (sumScaled([payload.equity, payload.financial_debt, payload.trade_payables, payload.tax_social_payables]) > total) {
      errors.total_assets = "Le total du bilan doit couvrir capitaux propres et dettes saisies.";
    }
  }
  return { payload, errors };
}

const column = (key, label, kind, options) => Object.freeze({ key, label, kind, options });

export function entryColumns(kind, sector) {
  const hospitality = sector === "HOSPITALITY";
  const stockSector = hospitality || sector === "RETAIL";
  const columns = {
    revenues: [
      column("date", "Date", "date"),
      column("amount_ht", "HT", "money"),
      column("amount_ttc", "TTC", "money"),
      column("vat_rate", "TVA", "percent"),
      column("payment_method", "Paiement", "enum", PAYMENT_METHODS),
      hospitality && column("allocation", "Famille", "enum", ALLOCATIONS),
      column("business_reference", REVENUE_REFERENCE_LABELS[sector] ?? "Référence", "text"),
      sector === "RETAIL" && column("ticket_count", "Tickets", "integer"),
      sector === "SERVICES" && column("hours", "Heures", "quantity"),
      sector === "SERVICES" && column("days", "Jours", "quantity"),
    ],
    expenses: [
      column("date", "Date", "date"),
      column("supplier", "Fournisseur", "text"),
      column("category", "Catégorie", "enum", EXPENSE_CATEGORIES),
      column("amount_ht", "HT", "money"),
      column("amount_vat", "TVA", "money"),
      column("amount_ttc", "TTC", "money"),
      column("deductible_vat", "TVA déductible", "money"),
      stockSector && column("allocation", "Famille", "enum", ALLOCATIONS),
      column("business_reference", sector === "CONSTRUCTION" ? "Chantier / devis" : "Référence", "text"),
    ],
    overheads: [
      column("label", "Libellé", "text"),
      column("category", "Nature", "enum", OVERHEAD_CATEGORIES),
      column("monthly_amount_ht", "Mensuel HT", "money"),
      column("employer_charges", "Charges patronales", "money"),
      column("loan_principal", "Dont capital", "money"),
      column("vat_rate", "TVA", "percent"),
      column("vat_recoverable", "TVA récupérable", "boolean"),
      column("active_from", "Début", "date"),
      column("active_to", "Fin", "date"),
    ],
    inventories: [column("date", "Date", "date"), column("allocation", "Famille", "enum", ALLOCATIONS), column("value", "Valeur HT", "money")],
    cash_balances: [column("date", "Date", "date"), column("amount", "Solde", "money")],
    cash_movements: [
      column("date", "Date", "date"),
      column("amount", "Montant", "money"),
      column("label", "Libellé", "text"),
      column("business_reference", "Référence", "text"),
    ],
    balance_sheets: [
      column("date", "Clôture", "date"),
      column("equity", "Capitaux propres", "money"),
      column("financial_debt", "Dettes financières", "money"),
      column("inventory", "Stocks", "money"),
      column("trade_receivables", "Créances clients", "money"),
      column("trade_payables", "Dettes fournisseurs", "money"),
      column("tax_social_payables", "Dettes fiscales et sociales", "money"),
      column("cash", "Disponibilités", "money"),
      column("total_assets", "Total du bilan", "money"),
    ],
  };
  return (columns[kind] ?? []).filter(Boolean);
}

function trimDecimal(value, scale) {
  if (typeof value !== "string" || !DECIMAL_RE.test(value) || !value.includes(".")) return value;
  const [whole, fraction] = value.split(".");
  let trimmed = fraction;
  while (trimmed.length > scale && trimmed.endsWith("0")) trimmed = trimmed.slice(0, -1);
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export function formatEntryValue(item, value, currency = "EUR") {
  if (value === null || value === undefined || value === "") return "—";
  try {
    switch (item.kind) {
      case "date":
        return formatDate(value);
      case "money":
        return formatFinanceValue(trimDecimal(String(value), 2), "money", currency);
      case "percent":
        return formatFinanceValue(trimDecimal(String(value), 4), "percent");
      case "quantity":
      case "integer":
        return formatFinanceValue(trimDecimal(String(value), 4), "number");
      case "boolean":
        if (value === true) return "Oui";
        return value === false ? "Non" : String(value);
      case "enum":
        return item.options?.[value] ?? String(value);
      default:
        return String(value);
    }
  } catch {
    return String(value);
  }
}

const CSV_UNITS = Object.freeze({ percent: "%", points: "pt", ratio: "fois", days: "jours", years: "ans", date: "", number: "" });
const csvUnit = (kind, currency) => (kind === "money" ? currency : CSV_UNITS[kind] ?? "");

function csvText(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvValue(value, kind) {
  if (value === null || value === undefined) return "";
  if (kind === "date") return formatDate(value);
  return String(value).replace(".", ",");
}

const csvRow = (cells) => cells.join(";");

export function financeCsvFilename(data) {
  const id = String(data?.company?.id ?? "entreprise").replace(/[^A-Za-z0-9_-]/g, "_");
  return `sirius-finance-${id}-${data?.period?.start_date}_${data?.period?.end_date}.csv`;
}

export function comparisonIndex(data) {
  const comparison = data?.comparison;
  if (!comparison?.has_data) return new Map();
  return new Map(comparison.variations.map((item) => [item.key, item]));
}

export function buildFinanceCsv(data, { exportedAt = new Date() } = {}) {
  const { company, period } = data;
  const currency = company.currency;
  const variations = comparisonIndex(data);
  const comparisonText = data.comparison
    ? `${COMPARISONS[data.comparison.mode]} ${describePeriod(data.comparison.period)}${data.comparison.has_data ? "" : " (aucune donnée)"}`
    : COMPARISONS.none;
  const lines = [
    csvRow(["Rapport financier SIRIUS", csvText(company.name)]),
    csvRow(["Secteur", csvText(SECTORS[company.sector])]),
    csvRow(["Période", csvText(describePeriod(period))]),
    csvRow(["Comparaison", csvText(comparisonText)]),
    csvRow(["Devise", csvText(currency)]),
    csvRow(["Version de calcul", csvText(data.calculation_version)]),
    csvRow(["Nature des données", csvText(data.demo ? DEMO_NOTICE : "Données saisies par l’entreprise, non certifiées")]),
    csvRow(["Exporté le", csvText(formatTimestamp(exportedAt.toISOString()))]),
    "",
    csvRow(["Section", "Indicateur", "Valeur", "Unité", "Période de comparaison", "Variation", "Variation %", "Note"]),
  ];
  const metricRow = (section, key, label = metricLabel(key)) => {
    const kind = metricKind(key);
    const value = metricValue(data, key) ?? null;
    const variation = variations.get(key);
    const notes = [];
    if (value === null) notes.push(`Non calculable : ${nullReason(key, data)}`);
    if (THRESHOLDS[key]) notes.push(THRESHOLDS[key].label);
    lines.push(csvRow([
      csvText(section),
      csvText(label),
      csvValue(value, kind),
      csvText(csvUnit(kind, currency)),
      csvValue(variation?.previous ?? null, kind),
      csvValue(variation?.change ?? null, kind),
      csvValue(variation?.change_pct ?? null, "percent"),
      csvText(notes.join(" · ")),
    ]));
  };
  const sigSection = "Soldes intermédiaires de gestion";
  sigRows(data).forEach((row) => metricRow(sigSection, row.key, row.label ?? metricLabel(row.key)));
  metricRow(sigSection, "payroll_to_value_added_pct");
  DASHBOARD_GROUPS.forEach((group) => group.keys.forEach((key) => metricRow(group.title, key)));
  const sectorSection = `Indicateurs métier — ${SECTORS[company.sector]}`;
  SECTOR_METRICS[company.sector].forEach((key) => metricRow(sectorSection, key));
  const projects = data.specific.projects ?? [];
  if (projects.length) {
    lines.push("", csvRow(["Marge par chantier", "CA HT", "Déboursé sec", "Marge", "Taux de marge (%)"]));
    projects.forEach((project) => lines.push(csvRow([
      csvText(project.business_reference),
      csvValue(project.revenue_ht, "money"),
      csvValue(project.dry_cost, "money"),
      csvValue(project.margin, "money"),
      csvValue(project.margin_pct, "percent"),
    ])));
  }
  if (data.monthly.length) {
    lines.push("", csvRow([
      "Évolution mensuelle", "Début", "Fin", "CA HT", "Variation de stocks", "EBE approché", "Taux d’EBE (%)",
      "CAF approchée", "Flux net de trésorerie", "Trésorerie de clôture",
    ]));
    data.monthly.forEach((point) => lines.push(csvRow([
      csvText(monthlyLabel(point.period)),
      formatDate(point.period.start_date),
      formatDate(point.period.end_date),
      csvValue(point.revenue_ht, "money"),
      csvValue(point.stock_variation ?? null, "money"),
      csvValue(point.approximate_ebe, "money"),
      csvValue(point.ebe_margin_pct, "percent"),
      csvValue(point.approximate_caf, "money"),
      csvValue(point.cash_net_flow, "money"),
      csvValue(point.closing_cash, "money"),
    ])));
  }
  lines.push("", csvRow(["Points d’attention", "Code", "Message"]));
  sortAlerts(data.alerts).forEach((alert) => lines.push(csvRow([
    csvText(SEVERITIES[alert.severity]),
    csvText(alert.code),
    csvText(alert.message),
  ])));
  lines.push("", csvRow(["Avertissement", csvText(NOT_CERTIFIED_NOTICE)]));
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

export const BANK_CSV_TEMPLATE = "\ufeffDate;Libellé;Débit;Crédit;Référence\r\n";

export function downloadText(filename, text, type = "text/csv;charset=utf-8") {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// Impression : clone du rapport hors de l’arbre React, seul élément visible pendant l’impression.
export function printFinanceReport(node, { title } = {}) {
  if (!node || typeof window.print !== "function") return false;
  document.getElementById("sirius-print-root")?.remove();
  const root = document.createElement("div");
  root.id = "sirius-print-root";
  const clone = node.cloneNode(true);
  clone.removeAttribute("id");
  clone.querySelectorAll("[data-print-hide]").forEach((element) => element.remove());
  clone.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  clone.querySelectorAll("details").forEach((element) => element.setAttribute("open", ""));
  root.appendChild(clone);
  document.body.appendChild(root);
  const html = document.documentElement;
  const previousTitle = document.title;
  let fallback = null;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    window.removeEventListener("afterprint", cleanup);
    html.classList.remove("sirius-printing");
    document.title = previousTitle;
    root.remove();
  };
  html.classList.add("sirius-printing");
  if (title) document.title = title;
  window.addEventListener("afterprint", cleanup);
  fallback = setTimeout(cleanup, 60000);
  try {
    window.print();
  } catch {
    cleanup();
    return false;
  }
  return true;
}

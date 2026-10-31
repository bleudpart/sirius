import { useMemo, useRef, useState } from "react";
import { FileSpreadsheet, Printer } from "lucide-react";
import {
  COMPARISONS, DASHBOARD_GROUPS, DEMO_NOTICE, METRICS, NOT_CERTIFIED_NOTICE, SECTORS, SECTOR_METRICS, SEVERITIES,
  SIG_ROWS, STATUS_LABELS, SUMMARY_METRICS, THRESHOLDS, barPermille, buildFinanceCsv, comparisonIndex, decimalSign,
  describePeriod, downloadText, financeCsvFilename, formatChange, formatFinanceValue, formatMetric, formatTimestamp,
  formatVariationPct, inclusiveDays, isAdverse, maxAbsDecimal, metricKind, metricLabel, metricValue, monthlyLabel,
  nullReason, printFinanceReport, sigRows, sortAlerts, thresholdStatus,
} from "./companyFinance";

const CHANGE_PREFIX = Object.freeze({ year_ago: "vs N-1", previous: "vs période précédente" });
const COMPARED_COLUMN = Object.freeze({ year_ago: "N-1", previous: "Période précédente" });

const valueOf = (data, key) => metricValue(data, key) ?? null;
const negativeFlag = (key, value) => (isAdverse(key, value) ? "true" : undefined);

function changeText(variation, key, currency, mode) {
  const pct = variation.change_pct != null ? ` (${formatVariationPct(variation.change_pct)})` : "";
  return `${CHANGE_PREFIX[mode]} : ${formatChange(variation.change, metricKind(key), currency)}${pct}`;
}

function MetricCard({ data, metric, sub, variations, currency }) {
  const value = valueOf(data, metric);
  const status = thresholdStatus(metric, value);
  const variation = variations.get(metric);
  return <div className="numm-tech-card company-finance-metric" data-metric={metric} data-status={status ?? undefined}>
    <dt>{metricLabel(metric)}</dt>
    <dd data-negative={negativeFlag(metric, value)}>{formatMetric(metric, value, currency)}</dd>
    {status && <small className="company-finance-status">{STATUS_LABELS[status]}</small>}
    {sub && <small>{metricLabel(sub)} : {formatMetric(sub, valueOf(data, sub), currency)}</small>}
    {variation && <small className="company-finance-change">{changeText(variation, metric, currency, data.comparison.mode)}</small>}
    {value === null && <small>{nullReason(metric, data)}</small>}
    {THRESHOLDS[metric] && <small>{THRESHOLDS[metric].label}</small>}
  </div>;
}

function MetricGrid({ data, keys, variations, currency, label }) {
  return <dl className="numm-tech-metrics company-finance-metrics" aria-label={label}>
    {keys.map((entry) => {
      const [metric, sub] = Array.isArray(entry) ? entry : [entry, null];
      return <MetricCard key={metric} data={data} metric={metric} sub={sub} variations={variations} currency={currency} />;
    })}
  </dl>;
}

const shareText = (data, key, currency) => {
  const value = valueOf(data, key);
  return value === null ? "—" : formatMetric(key, value, currency);
};

function SigTable({ data, variations, currency }) {
  const compared = variations.size > 0;
  return <div className="numm-tech-table-wrap" role="region" aria-label="Soldes intermédiaires de gestion" tabIndex={0}>
    <table className="numm-tech-table company-finance-sig">
      <caption>Soldes intermédiaires de gestion simplifiés, {describePeriod(data.period)}</caption>
      <thead><tr>
        <th scope="col">Solde</th><th scope="col">Montant</th><th scope="col">% du CA HT</th>
        {compared && <>
          <th scope="col">{COMPARED_COLUMN[data.comparison.mode]}</th><th scope="col">Variation</th><th scope="col">Var. %</th>
        </>}
      </tr></thead>
      <tbody>{sigRows(data).map((row) => {
        const value = valueOf(data, row.key);
        const variation = variations.get(row.key);
        const kind = metricKind(row.key);
        return <tr key={row.key} data-metric={row.key} data-total={row.total ? "true" : undefined} data-detail={row.detail ? "true" : undefined}>
          <th scope="row"><span className="company-finance-sign" aria-hidden="true">{row.sign}</span>{row.label ?? metricLabel(row.key)}</th>
          <td data-negative={negativeFlag(row.key, value)}>{formatMetric(row.key, value, currency)}</td>
          <td>{row.share ? shareText(data, row.share, currency) : ""}</td>
          {compared && <>
            <td>{variation ? formatFinanceValue(variation.previous, kind, currency) : "—"}</td>
            <td>{variation ? formatChange(variation.change, kind, currency) : "—"}</td>
            <td>{variation ? formatVariationPct(variation.change_pct) : "—"}</td>
          </>}
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function ProjectsTable({ projects, currency }) {
  return <div className="numm-tech-table-wrap" role="region" aria-label="Marges par chantier" tabIndex={0}>
    <table className="numm-tech-table">
      <caption>Marge directe par devis ou chantier, sur la période uniquement</caption>
      <thead><tr>{["Chantier / devis", "CA HT", "Déboursé sec", "Marge", "Taux de marge"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>
        {projects.map((project) => <tr key={project.business_reference}>
          <th scope="row">{project.business_reference}</th>
          <td>{formatFinanceValue(project.revenue_ht, "money", currency)}</td>
          <td>{formatFinanceValue(project.dry_cost, "money", currency)}</td>
          <td data-negative={negativeFlag("margin", project.margin)}>{formatFinanceValue(project.margin, "money", currency)}</td>
          <td data-negative={negativeFlag("margin_pct", project.margin_pct)}>{formatFinanceValue(project.margin_pct, "percent", currency)}</td>
        </tr>)}
        {projects.length === 0 && <tr><td colSpan={5}>Aucune pièce rattachée à un chantier sur cette période.</td></tr>}
      </tbody>
    </table>
  </div>;
}

export function BarCell({ value, max, currency }) {
  if (value === null) return <td>Non calculable</td>;
  const negative = decimalSign(value) < 0;
  return <td className="company-finance-bar-cell">
    <span className="company-finance-bar" style={{ "--bar-size": `${barPermille(value, max) / 10}%` }}
      data-negative={negative ? "true" : undefined} aria-hidden="true" />
    <span data-negative={negative ? "true" : undefined}>{formatFinanceValue(value, "money", currency)}</span>
  </td>;
}

function MonthlyTable({ data, currency }) {
  const points = data.monthly;
  const max = (key) => maxAbsDecimal(points.map((point) => point[key]));
  const scales = { revenue_ht: max("revenue_ht"), approximate_ebe: max("approximate_ebe"), cash_net_flow: max("cash_net_flow") };
  const withStock = points.some((point) => point.stock_variation != null && decimalSign(point.stock_variation) !== 0);
  return <div className="numm-tech-table-wrap" role="region" aria-label="Évolution mensuelle" tabIndex={0}>
    <table className="numm-tech-table company-finance-monthly">
      <caption>Évolution mois par mois · barres proportionnelles au plus grand montant de chaque colonne</caption>
      <thead><tr>
        <th scope="col">Mois</th><th scope="col">CA HT</th>{withStock && <th scope="col">Variation de stocks</th>}
        <th scope="col">EBE approché</th><th scope="col">Taux d’EBE</th><th scope="col">CAF approchée</th>
        <th scope="col">Flux de trésorerie</th><th scope="col">Trésorerie fin de mois</th>
      </tr></thead>
      <tbody>{points.map((point) => <tr key={point.period.start_date}>
        <th scope="row">{monthlyLabel(point.period)}</th>
        <BarCell value={point.revenue_ht} max={scales.revenue_ht} currency={currency} />
        {withStock && <td>{formatFinanceValue(point.stock_variation ?? null, "money", currency)}</td>}
        <BarCell value={point.approximate_ebe} max={scales.approximate_ebe} currency={currency} />
        <td data-negative={negativeFlag("ebe_margin_pct", point.ebe_margin_pct)}>{formatFinanceValue(point.ebe_margin_pct, "percent", currency)}</td>
        <td data-negative={negativeFlag("approximate_caf", point.approximate_caf)}>{formatFinanceValue(point.approximate_caf, "money", currency)}</td>
        <BarCell value={point.cash_net_flow} max={scales.cash_net_flow} currency={currency} />
        <td data-negative={negativeFlag("closing_cash", point.closing_cash)}>{formatFinanceValue(point.closing_cash, "money", currency)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function displayedKeys(data) {
  const keys = new Set();
  SUMMARY_METRICS.flat().forEach((key) => keys.add(key));
  SIG_ROWS.forEach((row) => { keys.add(row.key); if (row.share) keys.add(row.share); });
  keys.add("payroll_to_value_added_pct");
  DASHBOARD_GROUPS.forEach((group) => group.keys.forEach((key) => keys.add(key)));
  SECTOR_METRICS[data.company.sector].forEach((key) => keys.add(key));
  return [...keys].filter((key) => METRICS[key]);
}

function ComparisonDetails({ data, keys, currency }) {
  const { comparison } = data;
  const variations = comparisonIndex(data);
  return <details className="numm-tech-card company-finance-comparison">
    <summary>Comparaison détaillée · {COMPARISONS[comparison.mode]}, {describePeriod(comparison.period)}</summary>
    {comparison.has_data ? <div className="numm-tech-table-wrap" role="region" aria-label="Comparaison détaillée" tabIndex={0}>
      <table className="numm-tech-table">
        <caption>Les taux et ratios varient en points ou en valeur absolue ; la variation en % ne concerne que les montants.</caption>
        <thead><tr>{["Indicateur", "Période analysée", "Période de comparaison", "Variation", "Var. %"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{keys.filter((key) => variations.has(key)).map((key) => {
          const item = variations.get(key);
          return <tr key={key} data-metric={key}>
            <th scope="row">{metricLabel(key)}</th>
            <td>{formatMetric(key, item.current, currency)}</td>
            <td>{formatMetric(key, item.previous, currency)}</td>
            <td>{formatChange(item.change, metricKind(key), currency)}</td>
            <td>{formatVariationPct(item.change_pct)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <p>Aucune pièce sur la période de comparaison : variations non calculées.</p>}
  </details>;
}

export default function CompanyFinanceReport({ data }) {
  const ref = useRef(null);
  const [feedback, setFeedback] = useState("");
  const variations = useMemo(() => comparisonIndex(data), [data]);
  const computedAt = useMemo(() => new Date().toISOString(), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = useMemo(() => displayedKeys(data), [data]);
  const { company, period, comparison } = data;
  const currency = company.currency;
  const alerts = sortAlerts(data.alerts);

  const exportCsv = () => {
    const done = downloadText(financeCsvFilename(data), buildFinanceCsv(data));
    setFeedback(done
      ? "Export CSV généré : séparateur point-virgule et virgule décimale, ouvrable dans Excel ou LibreOffice."
      : "Export indisponible dans ce navigateur.");
  };
  const print = () => {
    const done = printFinanceReport(ref.current, {
      title: `ΣIRIUS – ${company.name} – ${period.start_date} au ${period.end_date}`,
    });
    setFeedback(done ? "" : "Impression indisponible dans cet environnement.");
  };

  return <article className="company-finance-report" ref={ref} aria-labelledby="company-finance-report-title" data-testid="company-finance-report">
    <header className="company-finance-report-head">
      <div>
        <p className="company-finance-kicker">ΣIRIUS · DOSSIER DE GESTION</p>
        <h3 id="company-finance-report-title">{company.name}</h3>
        <p>{SECTORS[company.sector]} · Période {describePeriod(period)} ({inclusiveDays(period.start_date, period.end_date)} jours) · {currency}</p>
        <p>{comparison
          ? `Comparaison : ${COMPARISONS[comparison.mode]}, ${describePeriod(comparison.period)}${comparison.has_data ? "" : " — aucune donnée sur cette période"}`
          : "Sans comparaison"} · Calculé le {formatTimestamp(computedAt)} · méthode v{data.calculation_version}</p>
      </div>
      <div className="company-finance-actions" role="group" aria-label="Exporter le rapport" data-print-hide="true">
        <button type="button" onClick={exportCsv}><FileSpreadsheet size={16} aria-hidden="true" /> Export CSV</button>
        <button type="button" onClick={print}><Printer size={16} aria-hidden="true" /> Imprimer / PDF</button>
      </div>
    </header>
    {data.demo && <p className="company-finance-demo-banner" role="note"><strong>{DEMO_NOTICE}</strong></p>}
    {feedback && <p className="company-finance-feedback" role="status" data-print-hide="true">{feedback}</p>}

    <section aria-labelledby="company-finance-summary">
      <h4 id="company-finance-summary">Synthèse</h4>
      <MetricGrid data={data} keys={SUMMARY_METRICS} variations={variations} currency={currency} label="Indicateurs clés" />
    </section>

    <section aria-labelledby="company-finance-sig-title">
      <h4 id="company-finance-sig-title">Formation du résultat</h4>
      <SigTable data={data} variations={variations} currency={currency} />
      <p className="company-finance-note">{metricLabel("payroll_to_value_added_pct")} : {shareText(data, "payroll_to_value_added_pct", currency)}</p>
    </section>

    {DASHBOARD_GROUPS.map((group) => <section key={group.id} aria-labelledby={`company-finance-group-${group.id}`}>
      <h4 id={`company-finance-group-${group.id}`}>{group.title}</h4>
      <p className="company-finance-intro">{group.intro}</p>
      <MetricGrid data={data} keys={group.keys} variations={variations} currency={currency} label={group.title} />
    </section>)}

    <section aria-labelledby="company-finance-sector">
      <h4 id="company-finance-sector">Indicateurs métier · {SECTORS[company.sector]}</h4>
      <MetricGrid data={data} keys={SECTOR_METRICS[company.sector]} variations={variations} currency={currency} label="Indicateurs métier" />
      {company.sector === "CONSTRUCTION" && <ProjectsTable projects={data.specific.projects} currency={currency} />}
    </section>

    {data.monthly.length > 0 && <section aria-labelledby="company-finance-monthly-title">
      <h4 id="company-finance-monthly-title">Évolution mensuelle</h4>
      <MonthlyTable data={data} currency={currency} />
    </section>}

    {comparison && <ComparisonDetails data={data} keys={keys} currency={currency} />}

    <section className="numm-tech-card" aria-labelledby="company-finance-alerts">
      <h4 id="company-finance-alerts">Points d’attention</h4>
      {alerts.length ? <ul className="company-finance-alerts">
        {alerts.map((alert, index) => <li key={`${alert.code}-${index}`} data-severity={alert.severity}>
          <span className="company-finance-alert-label">{SEVERITIES[alert.severity]}</span><p>{alert.message}</p>
        </li>)}
      </ul> : <p>Aucun point d’attention sur la période.</p>}
    </section>

    <details className="numm-tech-card company-finance-method">
      <summary>Méthode et définitions des indicateurs</summary>
      <p>Calculs déterministes en décimal exact, sans arrondi flottant : montants au centime, taux et ratios à 0,01, durées à 0,1.
        Les charges récurrentes mensuelles sont proratisées au jour. La trésorerie part du dernier solde bancaire saisi et
        n’intègre que des mouvements réels, jamais des factures supposées payées.</p>
      <dl className="company-finance-definitions">{keys.map((key) => <div key={key}>
        <dt>{metricLabel(key)}</dt><dd>{METRICS[key].formula}</dd>
      </div>)}</dl>
    </details>

    <p className="numm-tech-disclaimer">{NOT_CERTIFIED_NOTICE}{data.demo ? ` ${DEMO_NOTICE}` : ""}</p>
  </article>;
}

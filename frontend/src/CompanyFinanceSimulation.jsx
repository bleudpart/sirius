import { useMemo, useRef, useState } from "react";
import { Calculator, FileSpreadsheet, FlaskConical, PencilLine, Printer, Undo2 } from "lucide-react";
import {
  DEMO_NOTICE, NEUTRAL_SIMULATION, NOT_CERTIFIED_NOTICE, RUPTURE_STATES, SECTORS, SEVERITIES, SIMULATION_DISCLAIMER,
  SIMULATION_LEVERS, SIMULATION_NOTICE, SIMULATION_ROWS, START_SOURCES, STATUS_LABELS, THRESHOLDS, buildSimulationCsv,
  buildSimulationPayload, decimalDifference, decimalSign, describePeriod, downloadText, formatChange, formatFinanceValue,
  formatLever, formatTimestamp, initialSimulationValues, maxAbsDecimal, printFinanceReport, ruptureState, runStressTest,
  simulationCsvFilename, simulationValueText, sortAlerts, thresholdStatus,
} from "./companyFinance";
import useFinanceLoader from "./useFinanceLoader";
import { BarCell } from "./CompanyFinanceReport";

const negative = (value) => (typeof value === "string" && decimalSign(value) < 0 ? "true" : undefined);
const adverse = (row, value) => (row.adverse ? negative(value) : undefined);

function LeverField({ item, value, error, onChange }) {
  const id = `company-finance-sim-${item.name}`;
  const describedBy = [`${id}-help`, error && `${id}-error`].filter(Boolean).join(" ");
  let inputMode = "decimal";
  if (item.type === "months") inputMode = "numeric";
  else if (item.signed) inputMode = undefined; // clavier complet : le signe moins reste accessible sur mobile
  return <div className="company-finance-field">
    <label htmlFor={id}>{item.label}{item.suffix ? ` ${item.suffix}` : ""}</label>
    <input id={id} name={item.name} type="text" autoComplete="off" required={!item.optional} inputMode={inputMode}
      placeholder={item.placeholder} value={value ?? ""} aria-invalid={error ? "true" : undefined} aria-describedby={describedBy}
      onChange={(event) => onChange(item.name, event.target.value)} />
    <small id={`${id}-help`}>{item.help}</small>
    {error && <small id={`${id}-error`} className="company-finance-field-error">{error}</small>}
  </div>;
}

function SimCard({ metric, label, value, flag, status = null, notes = [] }) {
  return <div className="numm-tech-card company-finance-metric" data-metric={metric} data-status={status ?? undefined}>
    <dt>{label}</dt>
    <dd data-negative={flag}>{value}</dd>
    {status && <small className="company-finance-status">{STATUS_LABELS[status]}</small>}
    {notes.filter(Boolean).map((note) => <small key={note}>{note}</small>)}
  </div>;
}

function ScenarioTable({ data, group, label, caption, currency }) {
  return <div className="numm-tech-table-wrap" role="region" aria-label={label} tabIndex={0}>
    <table className="numm-tech-table company-finance-sig">
      <caption>{caption}</caption>
      <thead><tr>
        <th scope="col">Indicateur</th><th scope="col">Avant</th><th scope="col">Après</th><th scope="col">Écart</th>
      </tr></thead>
      <tbody>{SIMULATION_ROWS.filter((row) => row.group === group).map((row) => {
        const before = data.avant[row.key];
        const after = data.apres[row.key];
        const change = decimalDifference(after, before);
        return <tr key={row.key} data-metric={row.key} data-total={row.total ? "true" : undefined}
          data-detail={row.detail ? "true" : undefined}>
          <th scope="row"><span className="company-finance-sign" aria-hidden="true">{row.sign}</span>{row.label}</th>
          <td data-negative={adverse(row, before)}>{simulationValueText(row, before, currency)}</td>
          <td data-negative={adverse(row, after)}>{simulationValueText(row, after, currency)}</td>
          <td>{change === null ? "—" : formatChange(change, row.kind, currency)}</td>
        </tr>;
      })}</tbody>
    </table>
  </div>;
}

function RuptureBox({ alert }) {
  const state = ruptureState(alert);
  return <div className="company-finance-rupture" data-state={state} data-testid="company-finance-rupture">
    <strong>{RUPTURE_STATES[state]}</strong>
    <p>{alert.message}</p>
    {alert.rupture === true && alert.mois_estime > 0 && <p>
      Autonomie au rythme simulé : {formatFinanceValue(alert.autonomie_mois, "number")}{"\u00a0"}mois.
    </p>}
  </div>;
}

function CashSection({ data, currency }) {
  const known = data.solde_depart !== null;
  const months = data.scenario.duree_mois;
  const money = (value) => formatFinanceValue(value, "money", currency);
  const [without, withScenario] = known
    ? ["solde_sans_projet", "solde_avec_projet"]
    : ["flux_cumule_sans_projet", "flux_cumule_avec_projet"];
  const subject = known ? "Trésorerie" : "Flux cumulé";
  const max = maxAbsDecimal(data.projection.map((point) => point[withScenario]));
  const flows = `Flux mensuel : ${formatChange(data.avant.flux_tresorerie, "money", currency)} sans le scénario, `
    + `${formatChange(data.apres.flux_tresorerie, "money", currency)} avec.`;
  return <section aria-labelledby="company-finance-sim-cash">
    <h4 id="company-finance-sim-cash">Trésorerie projetée</h4>
    <p className="company-finance-intro">{known
      ? `Solde de départ : ${money(data.solde_depart)} (${START_SOURCES[data.source_solde_depart]}).`
      : "Solde de départ inconnu : seuls les flux cumulés sont projetés. Renseignez le solde de trésorerie actuel pour projeter les soldes."}
    {" "}{flows}</p>
    <RuptureBox alert={data.alerte_rupture_tresorerie} />

    <div className="numm-tech-table-wrap" role="region" aria-label="Jalons de trésorerie" tabIndex={0}>
      <table className="numm-tech-table">
        <caption>{subject} aux jalons J+30, J+60 et J+90 (fins des mois 1, 2 et 3)</caption>
        <thead><tr>
          <th scope="col">Jalon</th><th scope="col">Sans le scénario</th><th scope="col">Avec le scénario</th><th scope="col">Écart</th>
        </tr></thead>
        <tbody>{data.jalons_tresorerie.map((point) => <tr key={point.mois} data-milestone={point.jour}>
          <th scope="row">J+{point.jour}{point.mois > months ? " (au-delà de la durée choisie)" : ""}</th>
          <td data-negative={negative(point[without])}>{money(point[without])}</td>
          <td data-negative={negative(point[withScenario])}>{money(point[withScenario])}</td>
          <td>{formatChange(decimalDifference(point[withScenario], point[without]), "money", currency)}</td>
        </tr>)}</tbody>
      </table>
    </div>

    <div className="numm-tech-table-wrap" role="region" aria-label="Projection mois par mois" tabIndex={0}>
      <table className="numm-tech-table company-finance-monthly">
        <caption>Projection sur {months} mois, fin de mois · barres proportionnelles au plus grand montant avec le scénario</caption>
        <thead><tr>
          <th scope="col">Fin du mois</th><th scope="col">{subject} sans le scénario</th><th scope="col">{subject} avec le scénario</th>
        </tr></thead>
        <tbody>{data.projection.map((point) => <tr key={point.mois}>
          <th scope="row">Mois {point.mois} · J+{point.jour}</th>
          <td data-negative={negative(point[without])}>{money(point[without])}</td>
          <BarCell value={point[withScenario]} max={max} currency={currency} />
        </tr>)}</tbody>
      </table>
    </div>
    {data.flux_bancaire_reel_mensuel !== null && <p className="company-finance-note">
      Flux bancaire réel moyen de la période de référence : {formatChange(data.flux_bancaire_reel_mensuel, "money", currency)} par
      mois, contre {formatChange(data.avant.flux_tresorerie, "money", currency)} de flux de gestion (EBE − annuités) :
      l’écart reflète notamment la TVA, les délais de paiement et les mouvements non saisis.
    </p>}
  </section>;
}

function SummaryCards({ data, currency }) {
  const { scenario, avant: before, apres: after } = data;
  const known = data.solde_depart !== null;
  const money = (value) => formatFinanceValue(value, "money", currency);
  const coverage = (value) => (value === null ? "Sans annuité" : formatFinanceValue(value, "ratio"));
  const days = formatFinanceValue(scenario.jours_ouverture_mois, "number");
  const noBreakEven = "Non calculable : marge sur coûts variables nulle ou négative (voir les points d’attention).";
  const need = known && decimalSign(data.besoin_financement_max) > 0;
  let needNote = "Renseignez le solde de trésorerie actuel pour l’évaluer.";
  if (need) needNote = "Découvert maximal à couvrir pendant la projection (apport, prêt ou concours bancaire).";
  else if (known) needNote = "Aucun découvert sur la durée projetée.";
  return <dl className="numm-tech-metrics company-finance-metrics" aria-label="Indicateurs clés du scénario">
    <SimCard metric="point_mort_journalier" label="Point mort de trésorerie journalier"
      value={money(data.point_mort_journalier_apres)} notes={[
        `Avant : ${money(data.point_mort_journalier_avant)} · ${days}\u00a0jours d’ouverture par mois`,
        data.point_mort_journalier_apres === null && noBreakEven,
      ]} />
    <SimCard metric="ca_supplementaire" label="CA supplémentaire requis pour l’équilibre"
      value={money(data.ca_supplementaire_requis_pour_equilibre)}
      notes={["CA HT à trouver chaque mois pour couvrir charges fixes et annuités d’emprunt."]} />
    <SimCard metric="ebe_projete" label="EBE projeté mensuel" value={money(data.ebe_projete_mensuel)}
      flag={negative(data.ebe_projete_mensuel)}
      notes={[`Variation : ${formatChange(data.variation_ebe_mensuelle, "money", currency)} par mois`]} />
    <SimCard metric="couverture" label="Couverture des annuités" value={coverage(after.couverture_service_dette)}
      flag={negative(after.couverture_service_dette)}
      status={thresholdStatus("debt_service_coverage", after.couverture_service_dette)}
      notes={[`Avant : ${coverage(before.couverture_service_dette)}`, THRESHOLDS.debt_service_coverage.label]} />
    <SimCard metric="tresorerie_fin" label={`Trésorerie à la fin du mois ${scenario.duree_mois}`}
      value={known ? money(data.tresorerie_residuelle_fin_periode) : "Non projetée"}
      flag={negative(data.tresorerie_residuelle_fin_periode)} notes={[
        known ? `Départ : ${money(data.solde_depart)} (${START_SOURCES[data.source_solde_depart]})` : "Solde de départ inconnu.",
        `Variation sur la projection : ${formatChange(data.variation_tresorerie_periode, "money", currency)}`,
      ]} />
    <SimCard metric="besoin_financement" label="Besoin de financement maximal"
      value={known ? money(data.besoin_financement_max) : "Non évaluable"} flag={need ? "true" : undefined}
      notes={[needNote]} />
  </dl>;
}

function SimulationReport({ data }) {
  const ref = useRef(null);
  const [feedback, setFeedback] = useState("");
  const computedAt = useMemo(() => new Date().toISOString(), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const { entreprise: company, periode_reference: period, scenario } = data;
  const currency = company.currency;
  const alerts = sortAlerts(data.alertes);

  const exportCsv = () => {
    const done = downloadText(simulationCsvFilename(data), buildSimulationCsv(data));
    setFeedback(done
      ? "Export CSV généré : séparateur point-virgule et virgule décimale, ouvrable dans Excel ou LibreOffice."
      : "Export indisponible dans ce navigateur.");
  };
  const print = () => {
    const done = printFinanceReport(ref.current, {
      title: `ΣIRIUS – Simulation – ${company.name} – ${period.start_date} au ${period.end_date}`,
    });
    setFeedback(done ? "" : "Impression indisponible dans cet environnement.");
  };

  return <article className="company-finance-report company-finance-simulation-report" ref={ref}
    aria-labelledby="company-finance-sim-title" data-testid="company-finance-simulation-report">
    <header className="company-finance-report-head">
      <div>
        <p className="company-finance-kicker">ΣIRIUS · STRESS TEST</p>
        <h3 id="company-finance-sim-title">{company.name}</h3>
        <p>{SECTORS[company.sector]} · Référence {describePeriod(period)} ({formatFinanceValue(data.mois_reference, "number")}{"\u00a0"}mois) · {currency}</p>
        <p>Projection sur {scenario.duree_mois}{"\u00a0"}mois · Calculé le {formatTimestamp(computedAt)} · méthode v{data.version_calcul}</p>
        <ul className="company-finance-scenario" aria-label="Leviers du scénario">
          {SIMULATION_LEVERS.map((item) => <li key={item.name} data-lever={item.name}>
            {item.label} : <strong>{formatLever(item.name, scenario[item.name], currency)}</strong>
          </li>)}
        </ul>
      </div>
      <div className="company-finance-actions" role="group" aria-label="Exporter la simulation" data-print-hide="true">
        <button type="button" onClick={exportCsv}><FileSpreadsheet size={16} aria-hidden="true" /> Export CSV</button>
        <button type="button" onClick={print}><Printer size={16} aria-hidden="true" /> Imprimer / PDF</button>
      </div>
    </header>
    {data.demo && <p className="company-finance-demo-banner" role="note"><strong>{DEMO_NOTICE}</strong></p>}
    <p className="company-finance-simulation-notice" role="note">{SIMULATION_NOTICE}</p>
    {feedback && <p className="company-finance-feedback" role="status" data-print-hide="true">{feedback}</p>}

    <section aria-labelledby="company-finance-sim-summary">
      <h4 id="company-finance-sim-summary">Synthèse du scénario</h4>
      <SummaryCards data={data} currency={currency} />
    </section>

    <section aria-labelledby="company-finance-sim-result">
      <h4 id="company-finance-sim-result">Formation du résultat mensuel</h4>
      <ScenarioTable data={data} group="resultat" label="Résultat mensuel avant et après le scénario" currency={currency}
        caption="Moyennes mensuelles HT : avant (période de référence) et après application du scénario" />
    </section>

    <section aria-labelledby="company-finance-sim-thresholds">
      <h4 id="company-finance-sim-thresholds">Seuil de rentabilité et point mort</h4>
      <ScenarioTable data={data} group="seuils" label="Seuils avant et après le scénario" currency={currency}
        caption={`CA HT à réaliser pour couvrir les charges fixes, puis les annuités d’emprunt en plus · journalier sur ${formatFinanceValue(scenario.jours_ouverture_mois, "number")} jours d’ouverture`} />
    </section>

    <CashSection data={data} currency={currency} />

    <section className="numm-tech-card" aria-labelledby="company-finance-sim-alerts">
      <h4 id="company-finance-sim-alerts">Points d’attention</h4>
      {alerts.length ? <ul className="company-finance-alerts">
        {alerts.map((alert, index) => <li key={`${alert.code}-${index}`} data-severity={alert.severity}>
          <span className="company-finance-alert-label">{SEVERITIES[alert.severity]}</span><p>{alert.message}</p>
        </li>)}
      </ul> : <p>Aucun point d’attention pour ce scénario.</p>}
    </section>

    <details className="numm-tech-card company-finance-method">
      <summary>Hypothèses et méthode de calcul</summary>
      <ul className="company-finance-notes">{data.hypotheses.map((item) => <li key={item}>{item}</li>)}</ul>
      <p>Calculs déterministes en décimal exact, sans arrondi flottant : montants au centime, taux et couverture à 0,01,
        autonomie à 0,1 mois. Le scénario n’est pas enregistré : relancez-le pour le retrouver.</p>
    </details>

    <p className="numm-tech-disclaimer">{SIMULATION_DISCLAIMER} {NOT_CERTIFIED_NOTICE}{data.demo ? ` ${DEMO_NOTICE}` : ""}</p>
  </article>;
}

// saved / onSaved : dernier scénario lancé, conservé par le tableau de bord quand on change de vue.
export default function CompanyFinanceSimulation({
  companyId, demoSector = null, query, reloadKey = 0, saved = null, onSaved, onConfigure, onDemo,
}) {
  const demo = Boolean(demoSector);
  const [values, setValues] = useState(() => (saved ? { ...saved.values } : initialSimulationValues(demo)));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [request, setRequest] = useState(() => saved?.request ?? null);
  const [edited, setEdited] = useState(false);
  const result = useFinanceLoader(
    request ? (signal) => runStressTest({ companyId, demoSector, query, levers: request.levers, signal }) : null,
    [request, query.start_date, query.end_date, reloadKey],
  );
  const busy = result.phase === "loading";
  const data = result.phase === "ready" ? result.data : null;

  const update = (name, value) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
    if (request) setEdited(true);
  };
  const reset = () => {
    setValues({ ...NEUTRAL_SIMULATION });
    setErrors({});
    setFormError("");
    if (request) setEdited(true);
  };
  const submit = (event) => {
    event.preventDefault();
    const { payload, errors: found } = buildSimulationPayload(values);
    setErrors(found);
    if (Object.keys(found).length) {
      setFormError("Simulation non lancée : corrigez les champs signalés.");
      return;
    }
    setFormError("");
    setEdited(false);
    const next = { levers: payload };
    setRequest(next);
    onSaved?.({ values: { ...values }, request: next });
  };

  return <div className="company-finance-simulation" data-testid="company-finance-simulation">
    <form className="numm-tech-card company-finance-form company-finance-simulation-form" onSubmit={submit} noValidate
      aria-labelledby="company-finance-sim-form-title">
      <h3 id="company-finance-sim-form-title">Scénario à tester</h3>
      <p>Situation de référence : moyennes mensuelles HT {describePeriod(query)}, calculées comme le tableau de bord.
        Calcul en mémoire : aucune pièce, aucun solde ni aucun journal d’audit n’est modifié.</p>
      <div className="company-finance-fields">
        {SIMULATION_LEVERS.map((item) => <LeverField key={item.name} item={item} value={values[item.name]}
          error={errors[item.name]} onChange={update} />)}
      </div>
      <div className="company-finance-actions">
        <button type="submit" disabled={busy}><Calculator size={16} aria-hidden="true" />
          {busy ? "Calcul en cours…" : "Lancer la simulation"}</button>
        <button type="button" onClick={reset} disabled={busy}><Undo2 size={16} aria-hidden="true" /> Scénario neutre</button>
        <small>{"Pourcentages signés (−15 pour une baisse de 15\u00a0%) · montants avec virgule décimale (ex. 2\u202f800,00)"}</small>
      </div>
      {formError && <p className="company-finance-field-error" role="alert">{formError}</p>}
      {edited && data && <p className="company-finance-note" role="status">
        Leviers modifiés : relancez la simulation pour mettre à jour le rapport ci-dessous.</p>}
    </form>

    <div aria-busy={busy}>
      {busy && <p role="status">Simulation en cours : calcul en mémoire, sans écriture…</p>}
      {result.phase === "error" && result.error?.code === "PROFILE_MISSING" && <div className="numm-tech-card numm-tech-summary company-finance-notice">
        <h3>Profil financier à créer</h3>
        <p role="status">{result.error.message}</p>
        <p>La simulation part de vos pièces réelles : configurez le profil, puis saisissez ou importez vos pièces.</p>
        {(onConfigure || onDemo) && <div className="company-finance-actions">
          {onConfigure && <button type="button" onClick={onConfigure}><PencilLine size={16} aria-hidden="true" /> Configurer et saisir</button>}
          {onDemo && <button type="button" onClick={onDemo}><FlaskConical size={16} aria-hidden="true" /> Voir la démonstration</button>}
        </div>}
      </div>}
      {result.phase === "error" && result.error?.code !== "PROFILE_MISSING" && <div className="company-finance-error">
        <p role="alert">{result.error?.message || "Simulation impossible : réessayez."}</p>
      </div>}
      {data && <SimulationReport data={data} />}
    </div>
  </div>;
}

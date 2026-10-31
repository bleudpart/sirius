import { useMemo, useState } from "react";
import { Building2, FlaskConical, LayoutDashboard, PencilLine, RefreshCw, ShieldCheck } from "lucide-react";
import {
  COMPARISONS, DEMO_NOTICE, DEMO_REFERENCE_DATE, DEMO_WINDOW, SECTORS, SECTOR_KEYS, canUseFinance, defaultQuery,
  fetchDemoCatalog, fetchEnterpriseContext, fetchFinanceDashboard, localToday, periodError, periodPresets,
} from "./companyFinance";
import useFinanceLoader from "./useFinanceLoader";
import CompanyFinanceReport from "./CompanyFinanceReport";
import CompanyFinanceEntry from "./CompanyFinanceEntry";
import "./NummariusAnalytics.css";
import "./CompanyFinanceDashboard.css";

const NO_COMPANY = "Aucune entreprise rattachée à ce compte. Créez ou rejoignez votre entreprise depuis Gestion entreprise.";
const RESTRICTED = "Ce tableau est réservé aux administrateurs et gestionnaires de votre entreprise.";

function AccessNotice({ title, message, alert = false, onDemo }) {
  return <div className="numm-tech-card numm-tech-summary company-finance-notice">
    <Building2 size={26} aria-hidden="true" />
    <h3>{title}</h3>
    <p role={alert ? "alert" : "status"}>{message}</p>
    <p>Aucun chiffre fictif n’est mêlé à vos données : la démonstration reste un espace séparé.</p>
    <button type="button" onClick={onDemo}><FlaskConical size={16} aria-hidden="true" /> Explorer la démonstration fictive</button>
  </div>;
}

export default function CompanyFinanceDashboard() {
  const [today] = useState(localToday);
  const [mode, setMode] = useState("real");
  const [view, setView] = useState("dashboard");
  const [demoSector, setDemoSector] = useState("HOSPITALITY");
  const [query, setQuery] = useState(() => defaultQuery(false, today));
  const [draft, setDraft] = useState(query);
  const [formError, setFormError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const demo = mode === "demo";

  const context = useFinanceLoader((signal) => fetchEnterpriseContext(signal), []);
  const catalog = useFinanceLoader(demo ? (signal) => fetchDemoCatalog(signal) : null, [demo]);
  const companyId = context.data?.companyId ?? null;
  const allowed = context.phase === "ready" && Boolean(companyId) && canUseFinance(context.data.role);
  const scope = demo ? demoSector : companyId;
  const dashboard = useFinanceLoader(
    view === "dashboard" && (demo || allowed)
      ? (signal) => fetchFinanceDashboard({ companyId, demoSector: demo ? demoSector : null, query, signal })
      : null,
    [view, demo, allowed, scope, query.start_date, query.end_date, query.comparison, reloadKey],
  );
  const presets = useMemo(() => periodPresets(demo ? DEMO_REFERENCE_DATE : today, { demo }), [demo, today]);

  const switchMode = (next) => {
    if (next === mode) return;
    const nextQuery = defaultQuery(next === "demo", today);
    setMode(next);
    setQuery(nextQuery);
    setDraft(nextQuery);
    setFormError("");
  };
  const applyPeriod = (period) => {
    const next = { ...query, start_date: period.start_date, end_date: period.end_date };
    setDraft(next);
    setQuery(next);
    setFormError("");
  };
  const changeComparison = (event) => {
    const comparison = event.target.value;
    setDraft((current) => ({ ...current, comparison }));
    setQuery((current) => ({ ...current, comparison }));
  };
  const submit = (event) => {
    event.preventDefault();
    const error = periodError(draft, { demo });
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    setQuery({ ...draft });
    setReloadKey((key) => key + 1);
  };

  const busy = dashboard.phase === "loading";
  const data = dashboard.data;
  const dirty = draft.start_date !== query.start_date || draft.end_date !== query.end_date;
  const description = demo ? catalog.data?.companies.find((company) => company.sector === demoSector)?.description : "";
  const readOnly = view === "dashboard" || demo;
  const openDemo = () => switchMode("demo");

  let gate = null;
  if (!demo) {
    if (context.phase === "loading" || context.phase === "idle") {
      gate = <p role="status">Vérification de votre accès entreprise…</p>;
    } else if (context.phase === "error") {
      gate = <AccessNotice title="Accès entreprise" message={context.error?.message} alert onDemo={openDemo} />;
    } else if (!companyId) {
      gate = <AccessNotice title="Rattachement nécessaire" message={NO_COMPANY} onDemo={openDemo} />;
    } else if (!allowed) {
      gate = <AccessNotice title="Accès entreprise" message={RESTRICTED} onDemo={openDemo} />;
    }
  }

  return <section className="numm-tech company-finance" aria-labelledby="company-finance-heading" data-testid="company-finance-dashboard">
    <div className="numm-tech-hero">
      <div>
        <p className="company-finance-kicker">ΣIRIUS · PILOTAGE ENTREPRISE</p>
        <h2 id="company-finance-heading">{data ? data.company.name : demo ? "Démonstration fictive" : context.data?.companyName || "Finance d’entreprise"}</h2>
        <p>{data ? SECTORS[data.company.sector] : "Un socle commun, des indicateurs adaptés à votre activité."}</p>
      </div>
      <span className="company-finance-badge"><ShieldCheck size={18} aria-hidden="true" /> {readOnly ? "Lecture seule" : "Saisie tracée"}</span>
    </div>

    <div className="numm-tech-toolbar company-finance-toolbar">
      <div role="group" aria-label="Données affichées">
        <button type="button" aria-pressed={!demo} onClick={() => switchMode("real")}><Building2 size={16} aria-hidden="true" /> Mon entreprise</button>
        <button type="button" aria-pressed={demo} onClick={openDemo}><FlaskConical size={16} aria-hidden="true" /> Démonstration fictive</button>
      </div>
      <div role="group" aria-label="Affichage">
        <button type="button" aria-pressed={view === "dashboard"} onClick={() => setView("dashboard")}><LayoutDashboard size={16} aria-hidden="true" /> Tableau de bord</button>
        <button type="button" aria-pressed={view === "entries"} onClick={() => setView("entries")}><PencilLine size={16} aria-hidden="true" /> Saisie & imports</button>
      </div>
    </div>

    {demo && <div className="numm-tech-card company-finance-demo-panel">
      <p className="company-finance-demo-banner" role="note"><strong>{catalog.data?.notice || DEMO_NOTICE}</strong></p>
      <div className="company-finance-sectors" role="group" aria-label="Entreprise fictive">
        {SECTOR_KEYS.map((sector) => <button type="button" key={sector} aria-pressed={demoSector === sector}
          onClick={() => setDemoSector(sector)}>{SECTORS[sector]}</button>)}
      </div>
      {description && <p className="company-finance-filter-note">{description}</p>}
    </div>}

    <form className="numm-tech-card company-finance-filters" onSubmit={submit} aria-label="Période analysée" noValidate>
      <label htmlFor="company-finance-start">Du
        <input id="company-finance-start" type="date" required value={draft.start_date}
          min={demo ? DEMO_WINDOW.start_date : undefined} max={demo ? DEMO_WINDOW.end_date : "9999-12-30"}
          onChange={(event) => setDraft((current) => ({ ...current, start_date: event.target.value }))} />
      </label>
      <label htmlFor="company-finance-end">Au
        <input id="company-finance-end" type="date" required value={draft.end_date} min={draft.start_date || undefined}
          max={demo ? DEMO_WINDOW.end_date : "9999-12-30"}
          onChange={(event) => setDraft((current) => ({ ...current, end_date: event.target.value }))} />
      </label>
      <label htmlFor="company-finance-comparison">Comparer avec
        <select id="company-finance-comparison" value={draft.comparison} onChange={changeComparison}>
          {Object.entries(COMPARISONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <button type="submit" disabled={busy}><RefreshCw size={16} aria-hidden="true" />
        {busy ? "Chargement…" : dirty ? "Appliquer la période" : "Actualiser"}</button>
      <div className="company-finance-presets" role="group" aria-label="Périodes rapides">
        {presets.map((preset) => <button type="button" key={preset.id}
          aria-pressed={query.start_date === preset.start_date && query.end_date === preset.end_date}
          onClick={() => applyPeriod(preset)}>{preset.label}</button>)}
      </div>
      <p className="company-finance-filter-note">Dates incluses · {dirty
        ? "Filtres modifiés, à appliquer."
        : view === "dashboard" ? "Aucune écriture comptable effectuée." : "Les listes de pièces suivent cette période."}</p>
      {formError && <p role="alert">{formError}</p>}
    </form>

    <div aria-busy={busy}>
      {gate}
      {!gate && view === "dashboard" && <>
        {busy && <p role="status">Calcul sécurisé du tableau de bord…</p>}
        {dashboard.phase === "error" && dashboard.error?.code === "PROFILE_MISSING" && <div className="numm-tech-card numm-tech-summary company-finance-notice">
          <h3>Profil financier à créer</h3>
          <p role="status">{dashboard.error.message}</p>
          <p>Indiquez le secteur et la devise de l’entreprise, puis saisissez ou importez vos pièces : aucun chiffre n’est inventé.</p>
          <div className="company-finance-actions">
            <button type="button" onClick={() => setView("entries")}><PencilLine size={16} aria-hidden="true" /> Configurer et saisir</button>
            <button type="button" onClick={openDemo}><FlaskConical size={16} aria-hidden="true" /> Voir la démonstration</button>
          </div>
        </div>}
        {dashboard.phase === "error" && dashboard.error?.code !== "PROFILE_MISSING" && <div className="company-finance-error">
          <p role="alert">{dashboard.error?.message || "Impossible de charger le tableau de bord."}</p>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)}><RefreshCw size={16} aria-hidden="true" /> Réessayer</button>
        </div>}
        {data && <CompanyFinanceReport data={data} />}
      </>}
      {!gate && view === "entries" && <CompanyFinanceEntry key={`${mode}-${scope}`} companyId={companyId}
        companyName={context.data?.companyName ?? ""} demoSector={demo ? demoSector : null} query={query} reloadKey={reloadKey} />}
    </div>
  </section>;
}

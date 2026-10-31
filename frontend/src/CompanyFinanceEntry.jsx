import { useEffect, useRef, useState } from "react";
import { FileDown, Save, Trash2, Undo2, Upload } from "lucide-react";
import {
  AUDIT_ACTIONS, BANK_CSV_TEMPLATE, ENTRY_KINDS, ENTRY_KIND_HELP, ENTRY_KIND_LABELS, INGESTION_SOURCES, MAX_ENTRY_LIST,
  MUTATION_TIMEOUT_MESSAGE, ORIGINS, SECTORS, SECTOR_KEYS, buildEntryPayload, createEntry, deleteEntry, describePeriod,
  downloadText, entryColumns, fetchAudit, fetchEntries, fetchIngestions, fetchProfile, fieldHelp, fieldLabel, fieldOptions,
  formatEntryValue, formatTimestamp, initialEntryValues, isSector, revertIngestion, saveProfile, uploadBankStatement,
  visibleFields, withTimeout,
} from "./companyFinance";
import useFinanceLoader from "./useFinanceLoader";

const CURRENCIES = Object.freeze([
  ["EUR", "Euro (EUR)"], ["CHF", "Franc suisse (CHF)"], ["GBP", "Livre sterling (GBP)"], ["USD", "Dollar américain (USD)"],
]);
// Pièces ponctuelles (stock, solde, bilan) : listées toutes dates, car elles servent d’ancrage hors de la période.
const POINT_IN_TIME = new Set(["inventories", "cash_balances", "balance_sheets"]);
const IDLE_STATUS = Object.freeze({ pending: false, error: "", message: "" });
const plural = (count, singular, pluralForm) => `${count} ${count > 1 ? pluralForm : singular}`;

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

// Mutation unique : bouton désactivé pendant l’envoi, délai maximal de 30 s, état ignoré après démontage.
function useMutation() {
  const mounted = useMounted();
  const [status, setStatus] = useState(IDLE_STATUS);
  const run = async (task, success) => {
    setStatus({ pending: true, error: "", message: "" });
    try {
      const result = await withTimeout(task, { message: MUTATION_TIMEOUT_MESSAGE });
      if (!mounted.current) return undefined;
      setStatus({ pending: false, error: "", message: typeof success === "function" ? success(result) : success });
      return { result };
    } catch (error) {
      if (mounted.current) setStatus({ pending: false, error: error?.message || "Opération impossible.", message: "" });
      return undefined;
    }
  };
  const fail = (error) => setStatus({ pending: false, error, message: "" });
  return { status, run, fail, reset: () => setStatus(IDLE_STATUS) };
}

function Feedback({ status }) {
  return <>
    {status.message && <p className="company-finance-feedback" role="status">{status.message}</p>}
    {status.error && <p role="alert">{status.error}</p>}
  </>;
}

function ProfileCard({ companyId, profile, defaultName, onSaved }) {
  const [editing, setEditing] = useState(!profile);
  const fromProfile = () => ({
    name: profile?.name ?? defaultName ?? "", sector: profile?.sector ?? "HOSPITALITY", currency: profile?.currency ?? "EUR",
  });
  const [values, setValues] = useState(fromProfile);
  const mutation = useMutation();
  const update = (name) => (event) => setValues((current) => ({ ...current, [name]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    const name = values.name.trim();
    if (!name || name.length > 160) {
      mutation.fail("Indiquez le nom de l’entreprise (160 caractères au maximum).");
      return;
    }
    const outcome = await mutation.run(
      (signal) => saveProfile(companyId, { name, sector: values.sector, currency: values.currency }, signal),
      "Profil enregistré.",
    );
    if (!outcome) return;
    if (!isSector(outcome.result?.sector)) {
      mutation.fail("Réponse du serveur incomplète : rechargez la page pour vérifier le profil.");
      return;
    }
    setEditing(false);
    onSaved(outcome.result);
  };

  return <section className="numm-tech-card company-finance-profile" aria-labelledby="company-finance-profile-title">
    <h3 id="company-finance-profile-title">{profile ? "Profil financier" : "Créer le profil financier"}</h3>
    {!profile && <p>Le secteur choisit les indicateurs métier (Food Cost, déboursé sec, marge commerciale, taux horaire) ;
      la devise est verrouillée dès la première pièce enregistrée.</p>}
    {profile && !editing && <>
      <dl className="company-finance-facts">
        <div><dt>Entreprise</dt><dd>{profile.name}</dd></div>
        <div><dt>Secteur</dt><dd>{SECTORS[profile.sector]}</dd></div>
        <div><dt>Devise</dt><dd>{profile.currency}</dd></div>
      </dl>
      <button type="button" onClick={() => { mutation.reset(); setValues(fromProfile()); setEditing(true); }}>Modifier le profil</button>
    </>}
    {editing && <form className="company-finance-form" onSubmit={submit} noValidate>
      <div className="company-finance-field">
        <label htmlFor="company-finance-profile-name">Nom de l’entreprise</label>
        <input id="company-finance-profile-name" type="text" required maxLength={160} autoComplete="organization"
          value={values.name} onChange={update("name")} />
      </div>
      <div className="company-finance-field">
        <label htmlFor="company-finance-profile-sector">Secteur d’activité</label>
        <select id="company-finance-profile-sector" value={values.sector} onChange={update("sector")}>
          {SECTOR_KEYS.map((sector) => <option key={sector} value={sector}>{SECTORS[sector]}</option>)}
        </select>
        {profile && <small>Changer de secteur modifie les indicateurs métier ; les pièces déjà saisies sont conservées.</small>}
      </div>
      <div className="company-finance-field">
        <label htmlFor="company-finance-profile-currency">Devise de tenue</label>
        <select id="company-finance-profile-currency" value={values.currency} onChange={update("currency")}>
          {CURRENCIES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          {!CURRENCIES.some(([code]) => code === values.currency) && <option value={values.currency}>{values.currency}</option>}
        </select>
      </div>
      <div className="company-finance-actions">
        <button type="submit" disabled={mutation.status.pending}><Save size={16} aria-hidden="true" />
          {mutation.status.pending ? "Enregistrement…" : "Enregistrer le profil"}</button>
        {profile && <button type="button" onClick={() => { mutation.reset(); setEditing(false); }}>Annuler</button>}
      </div>
    </form>}
    <Feedback status={mutation.status} />
  </section>;
}

function importSummary(result) {
  if (result?.replayed) return "Ce relevé avait déjà été importé avec la même clé : aucune écriture dupliquée.";
  const records = Number(result?.record_count) || 0;
  const duplicates = Number(result?.duplicate_count) || 0;
  const imported = `${plural(records, "écriture importée", "écritures importées")}`;
  return duplicates ? `${imported}, ${plural(duplicates, "doublon ignoré", "doublons ignorés")}.` : `${imported}.`;
}

const textList = (items) => (Array.isArray(items) ? items.filter((item) => typeof item === "string" && item.trim()) : []);

function ImportResult({ result }) {
  const notes = textList(result.notes);
  const warnings = textList(result.warnings);
  return <div className="company-finance-import-result" role="status">
    <p><strong>{importSummary(result)}</strong></p>
    {result.review_required && <p>Contrôle recommandé : vérifiez les avertissements ci-dessous avant de présenter les chiffres.</p>}
    {warnings.length > 0 && <ul className="company-finance-warnings">{warnings.map((item) => <li key={item}>{item}</li>)}</ul>}
    {notes.length > 0 && <ul className="company-finance-notes">{notes.map((item) => <li key={item}>{item}</li>)}</ul>}
  </div>;
}

function IngestionJournal({ companyId, refreshKey, onChanged }) {
  const journal = useFinanceLoader((signal) => fetchIngestions(companyId, signal), [companyId, refreshKey]);
  const [confirming, setConfirming] = useState(null);
  const mutation = useMutation();
  const revert = async (batch) => {
    const outcome = await mutation.run(
      (signal) => revertIngestion(companyId, batch.batch_id, signal),
      "Import annulé : ses écritures restantes ont été retirées.",
    );
    if (!outcome) return;
    setConfirming(null);
    onChanged();
  };
  const batches = journal.data?.batches ?? [];

  return <div className="company-finance-journal">
    <h4>Journal des imports</h4>
    {journal.phase === "loading" && <p role="status">Chargement du journal des imports…</p>}
    {journal.phase === "error" && <p role="alert">{journal.error?.message}</p>}
    {journal.phase === "ready" && (batches.length === 0
      ? <p>Aucun import pour l’instant.</p>
      : <div className="numm-tech-table-wrap" role="region" aria-label="Journal des imports" tabIndex={0}>
        <table className="numm-tech-table company-finance-entry-table">
          <caption>Imports les plus récents{journal.data.truncated ? " (liste limitée aux 50 derniers)" : ""}</caption>
          <thead><tr>{["Date", "Source", "Écritures", "Doublons ignorés", "Encore présentes", "Remarques", "Action"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{batches.map((batch) => {
            const remarks = [...textList(batch.warnings), ...textList(batch.notes)];
            const remaining = Number(batch.remaining_count) || 0;
            return <tr key={batch.batch_id}>
              <td>{formatTimestamp(batch.created_at)}</td>
              <td>{INGESTION_SOURCES[batch.source] ?? batch.source}</td>
              <td>{batch.record_count}</td>
              <td>{batch.duplicate_count}</td>
              <td>{batch.remaining_count}</td>
              <td>{remarks.length ? <details><summary>{plural(remarks.length, "remarque", "remarques")}</summary>
                <ul>{remarks.map((item) => <li key={item}>{item}</li>)}</ul></details> : "—"}</td>
              <td>{confirming === batch.batch_id ? <span className="company-finance-confirm">
                <button type="button" disabled={mutation.status.pending} onClick={() => revert(batch)}>
                  Confirmer : retirer {plural(remaining, "écriture", "écritures")}</button>
                <button type="button" onClick={() => setConfirming(null)}>Garder</button>
              </span> : <button type="button" onClick={() => { mutation.reset(); setConfirming(batch.batch_id); }}>
                <Undo2 size={15} aria-hidden="true" /> Annuler l’import</button>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>)}
    <Feedback status={mutation.status} />
  </div>;
}

function BankImport({ companyId, refreshKey, onChanged }) {
  const input = useRef(null);
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const mutation = useMutation();
  const submit = async (event) => {
    event.preventDefault();
    setResult(null);
    if (!file) {
      mutation.fail("Choisissez un relevé bancaire (.csv, .ofx ou .qfx).");
      return;
    }
    const outcome = await mutation.run((signal) => uploadBankStatement(companyId, file, signal), "");
    if (!outcome) return;
    setResult(outcome.result ?? {});
    setFile(null);
    if (input.current) input.current.value = "";
    onChanged();
  };
  const template = () => {
    if (downloadText("modele-releve-bancaire-sirius.csv", BANK_CSV_TEMPLATE)) mutation.reset();
    else mutation.fail("Téléchargement indisponible dans ce navigateur.");
  };

  return <section className="numm-tech-card company-finance-import" aria-labelledby="company-finance-import-title">
    <h3 id="company-finance-import-title">Importer un relevé bancaire</h3>
    <p>Export CSV de votre banque (colonnes Date, Libellé, Débit / Crédit ou Montant) ou fichier OFX / QFX, 5 Mio au maximum.
      Les opérations déjà importées sont reconnues et ignorées ; chaque import peut être annulé.</p>
    <form className="company-finance-form company-finance-import-form" onSubmit={submit} noValidate>
      <div className="company-finance-field">
        <label htmlFor="company-finance-bank-file">Relevé bancaire</label>
        <input id="company-finance-bank-file" ref={input} type="file" accept=".csv,.ofx,.qfx,text/csv,application/x-ofx"
          onChange={(event) => { mutation.reset(); setResult(null); setFile(event.target.files?.[0] ?? null); }} />
        {file && <small>{file.name} · {Math.max(1, Math.ceil(file.size / 1024))} Kio</small>}
      </div>
      <div className="company-finance-actions">
        <button type="submit" disabled={mutation.status.pending}><Upload size={16} aria-hidden="true" />
          {mutation.status.pending ? "Import en cours…" : "Importer le relevé"}</button>
        <button type="button" onClick={template}><FileDown size={16} aria-hidden="true" /> Modèle CSV vierge</button>
      </div>
    </form>
    {result && <ImportResult result={result} />}
    <Feedback status={mutation.status} />
    <IngestionJournal companyId={companyId} refreshKey={refreshKey} onChanged={onChanged} />
  </section>;
}

const PLACEHOLDERS = Object.freeze({ money: "0,00", percent: "20", quantity: "0", integer: "0" });

function EntryField({ item, kind, sector, values, error, onChange }) {
  const id = `company-finance-${kind}-${item.name}`;
  const label = fieldLabel(item, sector, values);
  const help = fieldHelp(item, sector, values);
  const describedBy = [help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const common = { id, name: item.name, "aria-invalid": error ? "true" : undefined, "aria-describedby": describedBy };
  const notes = <>
    {help && <small id={`${id}-help`}>{help}</small>}
    {error && <small id={`${id}-error`} className="company-finance-field-error">{error}</small>}
  </>;
  if (item.type === "boolean") {
    return <div className="company-finance-field company-finance-check">
      <label htmlFor={id}><input type="checkbox" {...common} checked={values[item.name] === true}
        onChange={(event) => onChange(item.name, event.target.checked)} /> {label}</label>
      {notes}
    </div>;
  }
  const control = item.type === "select"
    ? <select {...common} value={values[item.name] ?? ""} onChange={(event) => onChange(item.name, event.target.value)}>
      {fieldOptions(item, sector, values).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
    </select>
    : <input {...common} type={item.type === "date" ? "date" : "text"} required={item.required} autoComplete="off"
      inputMode={item.type === "integer" ? "numeric" : PLACEHOLDERS[item.type] && !item.signed ? "decimal" : undefined}
      placeholder={PLACEHOLDERS[item.type]} maxLength={item.type === "text" ? item.maxLength ?? 160 : undefined}
      value={values[item.name] ?? ""} onChange={(event) => onChange(item.name, event.target.value)} />;
  return <div className="company-finance-field">
    <label htmlFor={id}>{label}{item.required && <span aria-hidden="true"> *</span>}</label>
    {control}
    {notes}
  </div>;
}

function EntryForm({ companyId, kind, sector, onCreated }) {
  const [values, setValues] = useState(() => initialEntryValues(kind, sector));
  const [errors, setErrors] = useState({});
  const mutation = useMutation();
  const update = (name, value) => {
    setValues((current) => ({ ...current, [name]: value }));
    setErrors((current) => (current[name] ? { ...current, [name]: undefined } : current));
  };
  const submit = async (event) => {
    event.preventDefault();
    const { payload, errors: found } = buildEntryPayload(kind, sector, values);
    setErrors(found);
    if (Object.keys(found).length) {
      mutation.fail("Pièce non enregistrée : corrigez les champs signalés.");
      return;
    }
    const outcome = await mutation.run(
      (signal) => createEntry(companyId, kind, payload, signal),
      "Pièce enregistrée et tracée : le tableau de bord en tiendra compte au prochain calcul.",
    );
    if (!outcome) return;
    setValues((current) => {
      const next = initialEntryValues(kind, sector);
      if ("date" in next && current.date) next.date = current.date;
      return next;
    });
    onCreated();
  };

  return <form className="company-finance-form company-finance-entry-form" onSubmit={submit} noValidate
    aria-label={`Nouvelle pièce : ${ENTRY_KIND_LABELS[kind]}`}>
    <div className="company-finance-fields">
      {visibleFields(kind, sector, values).map((item) => <EntryField key={item.name} item={item} kind={kind} sector={sector}
        values={values} error={errors[item.name]} onChange={update} />)}
    </div>
    <div className="company-finance-actions">
      <button type="submit" disabled={mutation.status.pending}><Save size={16} aria-hidden="true" />
        {mutation.status.pending ? "Enregistrement…" : "Enregistrer la pièce"}</button>
      <small>* champ obligatoire · montants avec virgule décimale (ex. 1 250,50)</small>
    </div>
    <Feedback status={mutation.status} />
  </form>;
}

function EntryList({ companyId, demoSector, kind, sector, currency, query, refreshKey, onChanged }) {
  const demo = Boolean(demoSector);
  const allDates = POINT_IN_TIME.has(kind);
  const start = allDates ? undefined : query.start_date;
  const end = allDates ? undefined : query.end_date;
  const list = useFinanceLoader(
    (signal) => fetchEntries({ companyId, demoSector, kind, query: { start_date: start, end_date: end }, signal }),
    [companyId, demoSector, kind, start, end, refreshKey],
  );
  const [confirming, setConfirming] = useState(null);
  const mutation = useMutation();
  const columns = entryColumns(kind, sector);
  const remove = async (entry) => {
    const outcome = await mutation.run((signal) => deleteEntry(companyId, kind, entry.id, signal), "Pièce supprimée et tracée dans le journal d’audit.");
    if (!outcome) return;
    setConfirming(null);
    onChanged();
  };
  const scope = allDates
    ? "toutes dates, les plus récentes d’abord"
    : kind === "overheads" ? `charges actives ${describePeriod(query)}` : describePeriod(query);
  const entries = list.data?.entries ?? [];

  return <div className="company-finance-entry-list">
    <h4>{ENTRY_KIND_LABELS[kind]} enregistrées</h4>
    {list.phase === "loading" && <p role="status">Chargement des pièces…</p>}
    {list.phase === "error" && <p role="alert">{list.error?.message}</p>}
    {list.phase === "ready" && <>
      {list.data.truncated && <p role="status">Liste limitée aux {MAX_ENTRY_LIST} pièces les plus récentes : réduisez la période pour tout afficher.</p>}
      <div className="numm-tech-table-wrap" role="region" aria-label={`${ENTRY_KIND_LABELS[kind]} enregistrées`} tabIndex={0}>
        <table className="numm-tech-table company-finance-entry-table">
          <caption>{ENTRY_KIND_LABELS[kind]} · {scope} · {plural(entries.length, "pièce", "pièces")}</caption>
          <thead><tr>
            {columns.map((column) => <th scope="col" key={column.key}>{column.label}</th>)}
            <th scope="col">Origine</th>
            {!demo && <th scope="col">Action</th>}
          </tr></thead>
          <tbody>
            {entries.map((entry) => <tr key={entry.id}>
              {columns.map((column) => <td key={column.key}>{formatEntryValue(column, entry.values[column.key], currency)}</td>)}
              <td>{ORIGINS[entry.origin] ?? entry.origin}</td>
              {!demo && <td>{confirming === entry.id ? <span className="company-finance-confirm">
                <button type="button" disabled={mutation.status.pending} onClick={() => remove(entry)}>Confirmer la suppression</button>
                <button type="button" onClick={() => setConfirming(null)}>Garder</button>
              </span> : <button type="button" onClick={() => { mutation.reset(); setConfirming(entry.id); }}
                aria-label={`Supprimer la pièce ${columns.slice(0, 2).map((column) => formatEntryValue(column, entry.values[column.key], currency)).join(" · ")}`}>
                <Trash2 size={15} aria-hidden="true" /> Supprimer</button>}</td>}
            </tr>)}
            {entries.length === 0 && <tr><td colSpan={columns.length + (demo ? 1 : 2)}>
              {allDates ? "Aucune pièce enregistrée." : "Aucune pièce sur cette période."}</td></tr>}
          </tbody>
        </table>
      </div>
    </>}
    <Feedback status={mutation.status} />
  </div>;
}

const auditObject = (kind) => ENTRY_KIND_LABELS[kind] ?? INGESTION_SOURCES[kind] ?? (kind === "profile" ? "Profil" : kind || "—");

function AuditLog({ companyId, refreshKey }) {
  const [open, setOpen] = useState(false);
  const audit = useFinanceLoader(open ? (signal) => fetchAudit(companyId, signal) : null, [open, companyId, refreshKey]);
  const events = audit.data ?? [];
  return <details className="numm-tech-card company-finance-audit" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Journal d’audit : qui a saisi, importé, supprimé ou modifié, et quand</summary>
    {audit.phase === "loading" && <p role="status">Chargement du journal d’audit…</p>}
    {audit.phase === "error" && <p role="alert">{audit.error?.message}</p>}
    {audit.phase === "ready" && (events.length === 0 ? <p>Aucun événement enregistré.</p>
      : <div className="numm-tech-table-wrap" role="region" aria-label="Journal d’audit" tabIndex={0}>
        <table className="numm-tech-table company-finance-entry-table">
          <caption>Événements les plus récents</caption>
          <thead><tr>{["Date", "Auteur (identifiant)", "Action", "Objet", "Détail"].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{events.map((item, index) => <tr key={item.id ?? index}>
            <td>{formatTimestamp(item.created_at)}</td>
            <td>{INGESTION_SOURCES[item.actor] ?? (item.actor || "—")}</td>
            <td>{AUDIT_ACTIONS[item.action] ?? item.action}</td>
            <td>{auditObject(item.entry_kind)}</td>
            <td>{item.summary || "—"}</td>
          </tr>)}</tbody>
        </table>
      </div>)}
  </details>;
}

export default function CompanyFinanceEntry({ companyId, companyName = "", demoSector = null, query, reloadKey = 0 }) {
  const demo = Boolean(demoSector);
  const profileState = useFinanceLoader(demo ? null : (signal) => fetchProfile(companyId, signal), [demo, companyId]);
  const [savedProfile, setSavedProfile] = useState(null);
  const [kind, setKind] = useState("revenues");
  const [localKey, setLocalKey] = useState(0);
  const bump = () => setLocalKey((key) => key + 1);
  // Les deux compteurs ne font que croître : leur somme change dès que l’un d’eux change.
  const refreshKey = localKey + reloadKey;
  const profile = savedProfile ?? profileState.data;
  const sector = demo ? demoSector : profile?.sector ?? null;
  const currency = demo ? "EUR" : profile?.currency ?? "EUR";

  return <div className="company-finance-entry" data-testid="company-finance-entry">
    {demo ? <p className="company-finance-demo-banner" role="note"><strong>Pièces fictives de démonstration, en lecture seule :
      la saisie et l’import sont réservés à votre entreprise.</strong></p> : <>
      {profileState.phase === "loading" && <p role="status">Chargement du profil financier…</p>}
      {profileState.phase === "error" && <p role="alert">{profileState.error?.message}</p>}
      {profileState.phase === "ready" && <ProfileCard companyId={companyId} profile={profile}
        defaultName={companyName} onSaved={(saved) => { setSavedProfile(saved); bump(); }} />}
    </>}
    {sector && <>
      {!demo && <BankImport companyId={companyId} refreshKey={refreshKey} onChanged={bump} />}
      <section className="numm-tech-card company-finance-ledger" aria-labelledby="company-finance-ledger-title">
        <h3 id="company-finance-ledger-title">{demo ? "Pièces de démonstration" : "Saisie des pièces"}</h3>
        <div className="company-finance-kinds" role="group" aria-label="Type de pièce">
          {ENTRY_KINDS.map((item) => <button type="button" key={item} aria-pressed={kind === item} onClick={() => setKind(item)}>
            {ENTRY_KIND_LABELS[item]}</button>)}
        </div>
        <p className="company-finance-intro">{ENTRY_KIND_HELP[kind]}</p>
        {!demo && <EntryForm key={`${kind}-${sector}`} companyId={companyId} kind={kind} sector={sector} onCreated={bump} />}
        <EntryList key={kind} companyId={companyId} demoSector={demoSector} kind={kind} sector={sector} currency={currency}
          query={query} refreshKey={refreshKey} onChanged={bump} />
      </section>
      {!demo && <AuditLog companyId={companyId} refreshKey={refreshKey} />}
    </>}
  </div>;
}

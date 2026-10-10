import { useState } from "react";
import { formatDocumentDate } from "./dateTime";
import { CalendarDays, Check, FileText, FolderOpen, Plus, ScrollText, Tags, Trash2, Workflow, X } from "lucide-react";
import { WORK_MODULES, workModuleName as displayName } from "@/workModules";
import { resolveBackendUrl } from "@/lib/api";
import { downloadWorkJson, emptyWorkData, loadWorkData, mergeWorkBackup, newWorkId, parseWorkBackup, serializeWorkBackup, WORK_BACKUP_MAX_BYTES } from "@/workModuleBackup";
import "./WorkModulesPanel.css";

const ICONS = { CalendarDays, FileText, FolderOpen, ScrollText, Tags, Workflow };
const FIELDS = {
  workflows: [{ key: "title", label: "Parcours", required: true }, { key: "dossier", label: "Dossier associé" }, { key: "steps", label: "Étapes (une par ligne)", multiline: true, required: true }],
  pricing: [{ key: "title", label: "Produit ou service", required: true }, { key: "supplier", label: "Fournisseur", required: true }, { key: "price", label: "Prix", type: "number", required: true }, { key: "unit", label: "Unité (kg, pièce, heure...)" }],
  dossiers: [{ key: "title", label: "Nom du dossier", required: true }, { key: "contact", label: "Client ou contact" }, { key: "details", label: "Description", multiline: true }],
  documents: [{ key: "title", label: "Titre du document", required: true }, { key: "dossier", label: "Dossier associé" }, { key: "content", label: "Contenu ou notes", multiline: true }],
  planning: [{ key: "title", label: "Tâche", required: true }, { key: "due", label: "Échéance", type: "date", required: true }, { key: "dossier", label: "Dossier associé" }],
};

export default function WorkModulesPanel({ initialModule, user, onClose, onOpenExisting }) {
  const storageKey = `sirius_work_modules_v1_${user?.id || user?._id || user?.email || "local"}`;
  return <WorkModulesWorkspace key={storageKey} storageKey={storageKey} initialModule={initialModule} onClose={onClose} onOpenExisting={onOpenExisting} />;
}

function WorkModulesWorkspace({ storageKey, initialModule, onClose, onOpenExisting }) {
  const [loaded] = useState(() => {
    try { return { data: loadWorkData(storageKey), error: "" }; }
    catch { return { data: emptyWorkData(), error: "Lecture du stockage local impossible ou données invalides. Vos données ne seront pas écrasées. Fermez ce module et vérifiez le stockage avant de continuer." }; }
  });
  const [data, setData] = useState(loaded.data);
  const [active, setActive] = useState(() => WORK_MODULES.some((entry) => entry.id === initialModule) ? initialModule : WORK_MODULES[0].id);
  const [form, setForm] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingBackup, setPendingBackup] = useState(null);
  const [importing, setImporting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [portraitAvailable, setPortraitAvailable] = useState(true);
  const module = WORK_MODULES.find((entry) => entry.id === active) || WORK_MODULES[0];
  const Icon = ICONS[module.icon];

  const update = (next, activity) => {
    if (loaded.error) { setError(loaded.error); return false; }
    const withAudit = { ...next, audit: [{ id: newWorkId(), at: new Date().toISOString(), activity }, ...next.audit] };
    try {
      localStorage.setItem(storageKey, JSON.stringify(withAudit));
      setData(withAudit);
      setError("");
      setNotice("");
      return true;
    } catch (_) {
      setError("Enregistrement local impossible : espace insuffisant ou stockage désactivé.");
      return false;
    }
  };

  const add = (event) => {
    event.preventDefault();
    const title = String(form.title || "").trim();
    if (!title || (active === "workflows" && !String(form.steps || "").trim())) return;
    const item = { ...form, title, id: newWorkId(), createdAt: new Date().toISOString() };
    if (active === "workflows") {
      item.steps = String(form.steps).split("\n").map((text) => ({ text: text.trim(), done: false })).filter((step) => step.text);
    }
    if (active === "planning") item.done = false;
    if (active === "pricing") item.price = Number(form.price);
    if (update({ ...data, [active]: [item, ...data[active]] }, `${displayName(module.label)} : ajout de « ${title} »`)) setForm({});
  };

  const remove = () => {
    if (update({ ...data, [active]: data[active].filter((entry) => entry.id !== pendingDelete.id) }, `${displayName(module.label)} : suppression de « ${pendingDelete.title} »`)) setPendingDelete(null);
  };
  const exportBackup = () => {
    try {
      downloadWorkJson(serializeWorkBackup(data), `sirius-metier-${new Date().toISOString().slice(0, 10)}.json`);
      setError("");
      setNotice("Sauvegarde préparée. Vérifiez que le fichier a bien été téléchargé et conservez-le dans un emplacement privé.");
    } catch (cause) { setError(cause.message || "Impossible de préparer la sauvegarde."); }
  };
  const readBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setPendingBackup(null);
    setError("");
    setNotice("");
    if (file.size > WORK_BACKUP_MAX_BYTES) { setError("Sauvegarde trop volumineuse (5 Mo maximum)."); return; }
    setImporting(true);
    try { setPendingBackup(parseWorkBackup(await file.text())); }
    catch (cause) { setError(cause.message || "Lecture de la sauvegarde impossible."); }
    finally { setImporting(false); }
  };
  const restoreBackup = () => {
    const merged = mergeWorkBackup(data, pendingBackup);
    if (!merged.added) { setPendingBackup(null); setNotice("Cette sauvegarde est déjà présente. Aucune donnée modifiée."); return; }
    if (update(merged.data, `Restauration de sauvegarde : ${merged.added} entrée(s) ajoutée(s), ${merged.conflicts} conflit(s) conservé(s) en copie.`)) {
      setPendingBackup(null);
      setNotice(`Restauration enregistrée sur cet appareil : ${merged.added} entrée(s) ajoutée(s). Les données existantes ont été conservées.`);
    }
  };
  const toggle = (item, stepIndex = null) => {
    const nextItem = stepIndex === null ? { ...item, done: !item.done } : {
      ...item, steps: (item.steps || []).map((step, index) => index === stepIndex ? { ...step, done: !step.done } : step),
    };
    update({ ...data, [active]: data[active].map((entry) => entry.id === item.id ? nextItem : entry) }, `${displayName(module.label)} : avancement de « ${item.title} »`);
  };

  const sortedItems = active === "pricing"
    ? [...data.pricing].sort((left, right) => String(left.title || "").localeCompare(String(right.title || "")) || String(left.unit || "").localeCompare(String(right.unit || "")) || (Number(left.price) || 0) - (Number(right.price) || 0))
    : active === "planning" ? [...data.planning].sort((left, right) => String(left.due || "").localeCompare(String(right.due || ""))) : data[active];

  return (
    <section className="prime-screen work-modules" data-testid="work-modules-panel" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="zeus-head work-header">
        <div className="oracle-title font-divine" data-module-name={displayName(module.label)}><Icon size={22} /> {displayName(module.label)} <small>{module.description}</small></div>
        <button className="setup-close zeus-close" type="button" onClick={onClose} title="Fermer" aria-label="Fermer"><X size={18} /></button>
      </header>
      <div className={`work-layout ${portraitAvailable ? "with-portrait" : ""}`}>
        <nav className="work-nav" aria-label="Modules de travail">
          {WORK_MODULES.map((entry) => {
            const EntryIcon = ICONS[entry.icon];
            return <button type="button" key={entry.id} className={active === entry.id ? "selected" : ""} aria-current={active === entry.id ? "page" : undefined} onClick={() => { setActive(entry.id); setForm({}); setPendingDelete(null); setError(""); setPortraitAvailable(true); }}><EntryIcon size={18} /><span>{displayName(entry.label)}<small>{entry.description}</small></span></button>;
          })}
        </nav>
        {portraitAvailable && <aside className="work-portrait"><img src={resolveBackendUrl(module.image)} alt={displayName(module.label)} onError={() => setPortraitAvailable(false)} /><span>{displayName(module.label)}</span></aside>}
        <div className="work-content">
          {error && <p className="work-error" role="alert">{error}</p>}
          {loaded.error && <p className="work-error" role="alert">{loaded.error}</p>}
          {notice && <p className="work-notice" role="status">{notice}</p>}
          <div className="work-backup">
            <p className="work-hint">{loaded.error ? "Stockage local indisponible" : "Données conservées sur cet appareil uniquement, pour le compte actuel. Aucune synchronisation automatique."}</p>
            <button type="button" disabled={!!loaded.error} onClick={exportBackup}>Sauvegarder les six modules</button>
            <label>Restaurer une sauvegarde (5 Mo max.)<input type="file" accept=".json,application/json" disabled={!!loaded.error || importing} onChange={readBackup} /></label>
            {importing && <p role="status">Lecture de la sauvegarde…</p>}
            {pendingBackup && <div className="work-confirm" role="group" aria-label="Confirmer la restauration">
              <p>Cette sauvegarde contient {Object.values(pendingBackup).reduce((sum, items) => sum + items.length, 0)} entrée(s), journal compris. La fusion ne supprime rien. En cas de conflit, la version importée sera ajoutée en copie. Ce fichier peut contenir des données confidentielles.</p>
              <button type="button" onClick={restoreBackup}>Confirmer la fusion</button>
              <button type="button" onClick={() => setPendingBackup(null)}>Annuler la restauration</button>
            </div>}
          </div>
          {pendingDelete && <div className="work-confirm" role="group" aria-label="Confirmer la suppression">
            <p>Supprimer « {pendingDelete.title} » ? Cette suppression ne pourra pas être annulée. Sauvegardez vos données si nécessaire.</p>
            <button type="button" onClick={remove}>Confirmer la suppression</button>
            <button type="button" onClick={() => setPendingDelete(null)}>Annuler la suppression</button>
          </div>}
          <fieldset className="work-editable" disabled={!!loaded.error}>
          {active === "audit" ? (
            <>
              <div className="work-section-head"><h2>Journal local</h2><button type="button" onClick={() => {
                try { downloadWorkJson(JSON.stringify(data.audit, null, 2), "sirius-audit.json"); }
                catch { setError("Export du journal impossible."); }
              }}>Exporter JSON</button></div>
              <p className="work-hint">Historique des modifications réalisées dans ces six modules sur cet appareil.</p>
              {data.audit.length === 0 && <p className="work-empty">Aucune modification enregistrée.</p>}
              <ol className="work-audit">{data.audit.map((entry) => <li key={entry.id}><time>{new Date(entry.at).toLocaleString("fr-FR")}</time><span>{entry.activity}</span></li>)}</ol>
            </>
          ) : (
            <>
              <form className="work-form" onSubmit={add}>
                {FIELDS[active].map((field) => <label key={field.key}>{field.label}
                  {field.multiline ? <textarea required={field.required} value={form[field.key] || ""} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} rows={3} /> :
                    <input required={field.required} type={field.type || "text"} min={field.type === "number" ? "0" : undefined} step={field.type === "number" ? "any" : undefined} value={form[field.key] || ""} onChange={(event) => setForm({ ...form, [field.key]: event.target.value })} />}
                </label>)}
                {active === "documents" && <label>Importer un fichier texte (max. 100 Ko)<input type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  if (file.size > 100000) { setError("Fichier trop volumineux (100 Ko maximum)."); return; }
                  const content = await file.text();
                  setForm((current) => ({ ...current, title: current.title || file.name, content }));
                  setError("");
                }} /></label>}
                <button className="work-add" type="submit"><Plus size={16} /> Ajouter</button>
              </form>
              {active === "workflows" && <div className="work-shortcuts"><span>Ouvrir un outil existant :</span><button type="button" onClick={() => onOpenExisting("promethee")}>PROMÉTHÉE</button><button type="button" onClick={() => onOpenExisting("themis")}>THÉMIS</button><button type="button" onClick={() => onOpenExisting("plans")}>PLANS</button></div>}
              <div className="work-section-head"><h2>{module.description}</h2><span>{sortedItems.length} entrée(s)</span></div>
              {sortedItems.length === 0 && <p className="work-empty">Aucune entrée pour le moment.</p>}
              <div className="work-list">{sortedItems.map((item) => <article className="work-item" key={item.id}>
                <div className="work-item-head"><strong>{item.title}</strong><button type="button" title="Supprimer" aria-label={`Supprimer ${item.title}`} onClick={() => setPendingDelete(item)}><Trash2 size={15} /></button></div>
                {active === "pricing" && <p>{item.supplier} · {Number(item.price).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })}{item.unit && ` / ${item.unit}`}</p>}
                {active === "dossiers" && <p>{item.contact}{item.contact && item.details && " · "}{item.details}</p>}
                {active === "documents" && <><p>{item.dossier && `Dossier : ${item.dossier}`}</p><pre className="work-document">{item.content}</pre></>}
                {active === "planning" && <button type="button" className={`work-check ${item.done ? "done" : ""}`} onClick={() => toggle(item)}><Check size={15} /> {item.done ? "Terminé" : "À faire"} · {item.due ? formatDocumentDate(item.due) : "sans échéance"}{item.dossier && ` · ${item.dossier}`}</button>}
                {active === "workflows" && <>{item.dossier && <p>Dossier : {item.dossier}</p>}<div className="work-steps">{(item.steps || []).map((step, index) => <button type="button" key={`${item.id}-${index}`} className={`work-check ${step.done ? "done" : ""}`} onClick={() => toggle(item, index)}><Check size={15} /> {step.text}</button>)}</div></>}
              </article>)}</div>
            </>
          )}
          </fieldset>
        </div>
      </div>
    </section>
  );
}
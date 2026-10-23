import { useEffect, useRef, useState } from "react";
import { Plus, Printer, Save, Trash2 } from "lucide-react";
import { haccpDocumentRequest, printHaccpDocument } from "./haccpDocuments";
import { formatDocumentDate } from "./dateTime";
import { SAFETY_SECTIONS, editableSafetyDocument, emptySafetyDossier, emptySafetyEntry,
  safetyPayload, safetyPrintHtml, shiftMinutes } from "./safetyDocuments";
import "./DuerpSection.css";

const request = (path = "", body) => haccpDocumentRequest("personnel-securite", path, body);

function EntryFields({ section, value, onChange }) {
  return <div className="duerp-grid">{section.fields.map((item) => {
    const props = { className: "cmd-input", value: value[item.key], required: item.required,
      onChange: (event) => onChange(item.key, event.target.value) };
    return <label key={item.key}>{item.label}{item.required ? " *" : ""}
      {item.type === "textarea" ? <textarea {...props} rows={3} maxLength={2000} />
        : item.type === "select" ? <select {...props}>{Object.entries(item.choices).map(([key, label]) =>
          <option key={key} value={key}>{label}</option>)}</select>
          : <input {...props} type={item.type} maxLength={item.required && item.type === "text" ? 300 : 2000}
            {...(item.type === "number" ? { min: 0, max: 1439, step: 1, required: true } : {})} />}
    </label>;
  })}</div>;
}

export default function SafetyDocumentation({ onDirtyChange }) {
  const [form, setForm] = useState(emptySafetyDossier);
  const [saved, setSaved] = useState(null);
  const [versions, setVersions] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const frame = useRef(null);
  const dirty = !saved || JSON.stringify(form) !== JSON.stringify(editableSafetyDocument(saved));
  const hasEdits = dirty && (Boolean(saved) || JSON.stringify(form) !== JSON.stringify(emptySafetyDossier()));
  const accept = (document) => {
    setSaved(document);
    setForm(document ? editableSafetyDocument(document) : emptySafetyDossier());
  };
  useEffect(() => {
    let active = true;
    const printFrame = frame;
    Promise.all([request("/current"), request()]).then(([current, history]) => {
      if (!active) return;
      accept(current.document); setVersions(history.items); setTruncated(history.truncated);
    }).catch((failure) => { if (active) setError(failure.message || "Chargement des cahiers impossible."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; printFrame.current?.remove(); };
  }, []);
  useEffect(() => {
    onDirtyChange?.(hasEdits);
    const warn = (event) => { if (hasEdits) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => { onDirtyChange?.(false); window.removeEventListener("beforeunload", warn); };
  }, [hasEdits, onDirtyChange]);

  const field = (key, value) => { setForm((old) => ({ ...old, [key]: value })); setNotice(""); };
  const updateEntry = (section, index, key, value) => field(section.key, section.single
    ? { ...form[section.key], [key]: value }
    : form[section.key].map((row, i) => i === index ? { ...row, [key]: value } : row));
  const save = async (event) => {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      if (["planning_cuisine", "planning_salle"].some((key) => form[key].some((row) => shiftMinutes(row) === null))) {
        throw new Error("Horaires de planning invalides : vérifiez le début, la fin, le lendemain et la pause.");
      }
      const result = await request("", safetyPayload(form));
      accept(result.document);
      setVersions((old) => [{ id: result.document.id, created_at: result.document.created_at,
        date_document: result.document.date_document }, ...old].slice(0, 100));
      if (versions.length >= 100) setTruncated(true);
      setNotice("Nouvelle version des cahiers enregistrée. Les versions précédentes sont conservées.");
    } catch (failure) { setError(failure.message || "Enregistrement impossible ; vos saisies sont conservées."); }
    finally { setBusy(false); }
  };
  const loadVersion = async (identity) => {
    if (!identity || (hasEdits && !window.confirm("Abandonner les modifications non enregistrées pour consulter cette version ?"))) return;
    setBusy(true); setError(""); setNotice("");
    try { accept((await request(`/${encodeURIComponent(identity)}`)).document); }
    catch (failure) { setError(failure.message || "Lecture de cette version impossible."); }
    finally { setBusy(false); }
  };
  const print = (section) => {
    if (!saved || dirty || busy) return;
    setError("");
    printHaccpDocument(safetyPrintHtml(saved, section), frame, setError);
  };
  return <section className="hc-section duerp-section" data-testid="haccp-section-safety" aria-busy={busy}>
    <h2 className="zc-section-title">PERSONNEL &amp; SÉCURITÉ — CAHIERS ET DOCUMENTATION</h2>
    <p>Accueil, formations, consignes incendie, exercices d'évacuation, vérifications et plannings cuisine / salle : des supports
      à renseigner pour votre établissement, enregistrer et imprimer. Ce suivi ne certifie aucune conformité.</p>
    <p className="hc-note">Accès limité au compte ou aux membres disposant de la permission HACCP de l'entreprise.
      Utilisez des noms ou références utiles seulement, sans données de santé, coordonnées privées ou pièces d'identité.
      Les justificatifs ne sont pas téléversés ici : notez leur référence et conservez les originaux.</p>
    <details><summary>Notice d'utilisation — documentation en français</summary>
      <ol>
        <li>Renseignez l'établissement, le responsable, la date et le motif de création ou de révision.</li>
        <li>Ajoutez les accueils, formations, exercices et vérifications réellement réalisés. Indiquez les responsables, observations et échéances utiles.</li>
        <li>Dans les plannings cuisine et salle, ajoutez un service par ligne (deux lignes pour un service coupé).
          Précisez la pause non travaillée et si la fin est le lendemain. L'impression produit une grille du lundi au dimanche et des totaux prévisionnels par semaine.</li>
        <li>Complétez les consignes incendie à partir des documents et de l'organisation validés sur votre site ; faites-les vérifier par la personne compétente.</li>
        <li>Enregistrez une version avant d'imprimer. Chaque cahier dispose de son bouton d'impression ; le dossier complet est disponible en bas de page.</li>
        <li>Dans la boîte d'impression, choisissez votre imprimante ou « Enregistrer en PDF » si disponible. Faites signer les documents papier et conservez les justificatifs avec leurs références.</li>
        <li>Lors d'une mise à jour, enregistrez une nouvelle version. Consultez les versions conservées dans la liste ; ne considérez jamais une ligne vierge comme une vérification effectuée.</li>
      </ol>
      <p>Les documents imprimés sont rédigés en français, avec des dates au format jour/mois/année.
        Le cahier d'accueil ne remplace pas le registre unique du personnel. Les modèles doivent être adaptés
        aux obligations de votre établissement ; aucune conformité ni durée légale d'archivage n'est garantie par l'application.</p>
    </details>
    {error && <p className="dev-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <label>Versions conservées <select className="cmd-input" aria-label="Version des cahiers" value={saved?.id || ""}
      disabled={busy} onChange={(event) => loadVersion(event.target.value)}>
      <option value="">Nouveau dossier</option>
      {versions.map((item) => <option key={item.id} value={item.id}>{formatDocumentDate(item.date_document)} · version du {formatDocumentDate(item.created_at)} · {item.id.slice(0, 8)}</option>)}
    </select></label>
    {truncated && <p>Les 100 versions les plus récentes sont affichées ; les autres restent archivées.</p>}
    <form onSubmit={save}>
      <fieldset disabled={busy}><legend>Établissement et version</legend><div className="duerp-grid">
        {[["etablissement", "Établissement", true], ["adresse", "Adresse"], ["responsable", "Responsable", true],
          ["motif_revision", "Motif de création / révision"]].map(([key, label, required]) =>
          <label key={key}>{label}{required ? " *" : ""}<input className="cmd-input" value={form[key]}
            maxLength={required ? 300 : 2000} required={!!required} onChange={(event) => field(key, event.target.value)} /></label>)}
        <label>Date du document *<input className="cmd-input" type="date" required value={form.date_document}
          onChange={(event) => field("date_document", event.target.value)} /></label>
      </div></fieldset>
      {SAFETY_SECTIONS.map((section) => <fieldset key={section.key} disabled={busy} data-testid={`safety-${section.key}`}>
        <legend>{section.title}</legend><p>{section.note}</p>
        {(section.single ? [form[section.key]] : form[section.key]).map((row, index) =>
          <div className="safety-entry" key={index}>
            {!section.single && <h3>Entrée {index + 1}</h3>}
            <EntryFields section={section} value={row} onChange={(key, value) => updateEntry(section, index, key, value)} />
            {section.planning && <p>{shiftMinutes(row) === null ? "Horaires à compléter ou à corriger."
              : `Durée prévisionnelle hors pause : ${Math.floor(shiftMinutes(row) / 60)} h ${String(shiftMinutes(row) % 60).padStart(2, "0")}`}</p>}
            {!section.single && <button type="button" className="memory-icon-btn danger" onClick={() => {
              if (window.confirm("Retirer cette entrée de la prochaine version ? Les versions précédentes sont conservées.")) {
                field(section.key, form[section.key].filter((_, i) => i !== index));
              }
            }}><Trash2 size={14} /> Retirer l'entrée {index + 1}</button>}
          </div>)}
        {!section.single && !form[section.key].length && <p>Aucune entrée enregistrée. Une impression produira un modèle à compléter.</p>}
        <div className="hc-form">
          {!section.single && <button type="button" className="cmd-send" disabled={form[section.key].length >= 200}
            onClick={() => field(section.key, [...form[section.key], emptySafetyEntry(section)])}>
            <Plus size={14} /> AJOUTER UNE ENTRÉE</button>}
          <button type="button" className="cmd-send" disabled={!saved || dirty}
            onClick={() => print(section.key)}><Printer size={14} /> IMPRIMER CE CAHIER / PDF</button>
        </div>
      </fieldset>)}
      <div className="hc-form">
        <button type="submit" className="cmd-send" disabled={busy || !dirty}><Save size={14} /> ENREGISTRER UNE VERSION</button>
        <button type="button" className="cmd-send" disabled={busy || !saved || dirty} onClick={() => print("all")}>
          <Printer size={14} /> IMPRIMER LE DOSSIER COMPLET / PDF</button>
      </div>
    </form>
    {hasEdits && <p role="status">Modifications non enregistrées. Enregistrez avant impression ou changement d'onglet.</p>}
    <p className="hc-note">Impression A4 sans le HUD, cahier par cahier ou dossier complet, avec zones de signature.
      « Enregistrer en PDF » dépend de votre appareil. L'enregistrement conserve une version déclarative,
      pas une signature électronique ni un archivage légal garanti. Faites valider les consignes sur place.</p>
  </section>;
}

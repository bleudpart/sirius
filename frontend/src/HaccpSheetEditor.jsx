import { useEffect, useRef, useState } from "react";
import { Copy, Plus, Printer, Save, Trash2 } from "lucide-react";
import { formatDocumentDate } from "./dateTime";
import { haccpDocumentRequest, printHaccpDocument } from "./haccpDocuments";
import "./DuerpSection.css";

const newSheet = (sheet) => ({
  titre: sheet.titre, sous: sheet.sous, etablissement: "", periode: "", responsable: "",
  equipement: "", cible: "", remarques: "", colonnes: [...sheet.colonnes],
  lignes: Array.from({ length: 6 }, () => sheet.colonnes.map(() => "")),
});
const editable = (document, sheet) => Object.fromEntries(Object.keys(newSheet(sheet)).map((key) => [key, document[key]]));

export default function HaccpSheetEditor({ sheet, onBack, onDirtyChange, loadRows, renderHtml }) {
  const [form, setForm] = useState(() => newSheet(sheet));
  const [saved, setSaved] = useState(null);
  const [versions, setVersions] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const frame = useRef(null);
  const dirty = !saved || JSON.stringify(form) !== JSON.stringify(editable(saved, sheet));
  const hasEdits = dirty && (Boolean(saved) || JSON.stringify(form) !== JSON.stringify(newSheet(sheet)));
  const request = (path = "", body) => haccpDocumentRequest(`feuilles/${sheet.id}`, path, body);
  useEffect(() => {
    let active = true;
    const printFrame = frame;
    const read = (path) => haccpDocumentRequest(`feuilles/${sheet.id}`, path);
    Promise.all([read("/current"), read("/versions")]).then(([current, history]) => {
      if (!active) return;
      if (current.document) { setSaved(current.document); setForm(editable(current.document, sheet)); }
      setVersions(history.items); setTruncated(history.truncated);
    }).catch((failure) => { if (active) setError(failure.message || "Chargement de la feuille impossible."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; printFrame.current?.remove(); };
  }, [sheet]);
  useEffect(() => {
    onDirtyChange?.(hasEdits);
    const warn = (event) => { if (hasEdits) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => { onDirtyChange?.(false); window.removeEventListener("beforeunload", warn); };
  }, [hasEdits, onDirtyChange]);

  const field = (key, value) => { setForm((old) => ({ ...old, [key]: value })); setNotice(""); };
  const save = async (event) => {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const result = await request("", form);
      setSaved(result.document); setForm(editable(result.document, sheet));
      setVersions((old) => [result.document, ...old].slice(0, 100));
      if (versions.length >= 100) setTruncated(true);
      setNotice("Feuille enregistrée dans une nouvelle version. Les versions précédentes sont conservées.");
    } catch (failure) { setError(failure.message || "Enregistrement impossible ; les cases saisies sont conservées."); }
    finally { setBusy(false); }
  };
  const loadVersion = async (identity) => {
    if (!identity || (hasEdits && !window.confirm("Abandonner les modifications pour ouvrir cette version ?"))) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request(`/versions/${encodeURIComponent(identity)}`);
      setSaved(result.document); setForm(editable(result.document, sheet));
    } catch (failure) { setError(failure.message || "Lecture de la version impossible."); }
    finally { setBusy(false); }
  };
  const importRows = async () => {
    if (form.lignes.some((row) => row.some((cell) => cell.trim())) &&
        !window.confirm("Remplacer les cases de ce brouillon par les relevés chargés ?")) return;
    setBusy(true); setError("");
    try {
      const rows = await loadRows();
      if (!rows.length) throw new Error("Aucun relevé correspondant dans la liste chargée. Vos cases restent inchangées.");
      // Imports use the original template; restoring its column names prevents mislabelling measurements.
      setForm((old) => ({ ...old, colonnes: [...sheet.colonnes], lignes: rows }));
      setNotice("Relevés copiés dans le brouillon. Les données d'origine ne sont pas modifiées ; enregistrez cette feuille.");
    } catch (failure) { setError(failure.message || "Import impossible ; les cases saisies restent inchangées."); }
    finally { setBusy(false); }
  };
  return <section className="hc-section duerp-section" data-testid="haccp-sheet-editor" aria-busy={busy}>
    <div className="hc-form"><button type="button" className="cmd-send" disabled={busy} onClick={() => {
      if (!hasEdits || window.confirm("Revenir aux modèles sans enregistrer les modifications ?")) onBack();
    }}>RETOUR AUX FEUILLES</button></div>
    <h2>{sheet.titre} — édition</h2>
    <p>Modifiez directement les cases et les intitulés. Ajoutez, dupliquez ou retirez des lignes.
      Chaque enregistrement crée une version ; il ne corrige pas les relevés HACCP d'origine.</p>
    {sheet.note && <p className="hc-note">{sheet.note}</p>}
    {error && <p className="dev-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <label>Versions de cette feuille <select className="cmd-input" aria-label="Version de la feuille"
      value={saved?.id || ""} disabled={busy} onChange={(event) => loadVersion(event.target.value)}>
      <option value="" disabled>Nouvelle feuille</option>
      {versions.map((item) => <option key={item.id} value={item.id}>{formatDocumentDate(item.created_at)} · {item.id.slice(0, 8)} · {item.titre}</option>)}
    </select></label>
    {truncated && <p>Les 100 versions les plus récentes sont affichées ; les autres restent archivées.</p>}
    <form onSubmit={save}><fieldset disabled={busy}><legend>Identification et cases de la feuille</legend>
      <div className="duerp-grid">{[["titre", "Titre", true], ["sous", "Sous-titre"], ["etablissement", "Établissement", true],
        ["periode", "Période / semaine"], ["responsable", "Responsable"], ["equipement", "Équipement / zone"],
        ["cible", "Plage cible / consigne validée"]].map(([key, label, required]) =>
        <label key={key}>{label}{required ? " *" : ""}<input className="cmd-input" value={form[key]}
          required={!!required} maxLength={required ? 300 : 2000} onChange={(event) => field(key, event.target.value)} /></label>)}</div>
      <div className="hc-sheet-edit-scroll"><table className="hc-sheet-edit-table"><thead><tr>
        {form.colonnes.map((column, index) => <th key={index}><input className="cmd-input" required maxLength={100}
          aria-label={`Intitulé colonne ${index + 1}`} value={column} onChange={(event) =>
            field("colonnes", form.colonnes.map((old, i) => i === index ? event.target.value : old))} /></th>)}
        <th>Actions</th></tr></thead><tbody>{form.lignes.map((row, index) => <tr key={index}>
          {row.map((cell, column) => <td key={column}><textarea className="cmd-input" rows={2} maxLength={1000}
            aria-label={`Ligne ${index + 1}, ${form.colonnes[column]}`} value={cell} onChange={(event) =>
              field("lignes", form.lignes.map((old, i) => i === index ? old.map((v, j) =>
                j === column ? event.target.value : v) : old))} /></td>)}
          <td><button type="button" className="memory-icon-btn" aria-label={`Dupliquer la ligne ${index + 1}`}
            disabled={form.lignes.length >= 200} onClick={() => field("lignes",
              [...form.lignes.slice(0, index + 1), [...row], ...form.lignes.slice(index + 1)])}><Copy size={14} /></button>
          <button type="button" className="memory-icon-btn danger" aria-label={`Supprimer la ligne ${index + 1}`}
            onClick={() => { if (window.confirm("Retirer cette ligne de la prochaine version ?")) {
              field("lignes", form.lignes.filter((_, i) => i !== index));
            } }}><Trash2 size={14} /></button></td>
        </tr>)}</tbody></table></div>
      <label>Remarques / actions correctives<textarea className="cmd-input" rows={3} value={form.remarques}
        maxLength={2000} onChange={(event) => field("remarques", event.target.value)} /></label>
      <div className="hc-form">
        <button type="button" className="cmd-send" onClick={() => {
          if (hasEdits && !window.confirm("Abandonner les modifications et préparer une nouvelle feuille vierge ?")) return;
          setForm((old) => ({ ...old, periode: "", remarques: "",
            lignes: Array.from({ length: 6 }, () => old.colonnes.map(() => "")) }));
          setSaved(null); setNotice("Nouvelle feuille préparée. Les versions enregistrées restent dans l'historique.");
        }}>NOUVELLE FEUILLE VIERGE</button>
        <button type="button" className="cmd-send" disabled={form.lignes.length >= 200} onClick={() =>
          field("lignes", [...form.lignes, form.colonnes.map(() => "")])}><Plus size={14} /> AJOUTER UNE LIGNE</button>
        {loadRows && <button type="button" className="cmd-send" onClick={importRows}>COPIER LES RELEVÉS EXISTANTS</button>}
        <button type="submit" className="cmd-send" disabled={!dirty}><Save size={14} /> ENREGISTRER UNE VERSION</button>
        <button type="button" className="cmd-send" disabled={!saved || dirty} onClick={() => {
          setError(""); printHaccpDocument(renderHtml({ ...sheet, titre: saved.titre, sous: saved.sous,
            colonnes: saved.colonnes, lignes: 0 }, saved.lignes, saved), frame, setError);
        }}><Printer size={14} /> IMPRIMER / PDF</button>
      </div>
    </fieldset></form>
    {hasEdits && <p role="status">Modifications non enregistrées. Enregistrez avant d'imprimer ou de quitter.</p>}
    <p className="hc-note">Les heures, températures et visas saisis dans ces cases sont déclaratifs.
      Les versions privées sont incluses dans l'export ; les documents entreprise dans les sauvegardes.
      Les cahiers ne constituent pas une signature électronique ou un archivage réglementaire garanti.</p>
  </section>;
}

import { useEffect, useRef, useState } from "react";
import { Plus, Printer, Save, Trash2 } from "lucide-react";
import { haccpDocumentRequest, printHaccpDocument } from "./haccpDocuments";
import { formatDocumentDate, getLocalDateKey } from "./dateTime";
import { DUERP_STATUS, duerpPrintHtml, riskPriority } from "./duerpDocument";
import "./DuerpSection.css";

const emptyDocument = () => ({
  etablissement: "", adresse: "", employeur: "", effectif: "", participants: "",
  date_evaluation: getLocalDateKey(), motif_revision: "", risques: [],
});
const emptyRisk = () => ({
  unite: "", situation: "", danger: "", personnes: "", dommages: "", mesures_existantes: "",
  gravite: 2, probabilite: 2, action: "", responsable: "", echeance: "", statut: "a_faire",
});
const editable = (document) => ({
  ...Object.fromEntries(Object.keys(emptyDocument()).map((key) => [key, document[key] ?? ""])),
  effectif: document.effectif ?? "",
  risques: document.risques.map((risk) => ({
    ...Object.fromEntries(Object.keys(emptyRisk()).map((key) => [key, risk[key] ?? ""])),
    echeance: risk.echeance || "",
  })),
});

const request = (path = "", body) => haccpDocumentRequest("duerp", path, body);

export default function DuerpSection({ onDirtyChange }) {
  const [form, setForm] = useState(emptyDocument);
  const [saved, setSaved] = useState(null);
  const [versions, setVersions] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const frame = useRef(null);
  const dirty = !saved || JSON.stringify(form) !== JSON.stringify(editable(saved));
  const hasEdits = dirty && (Boolean(saved) || JSON.stringify(form) !== JSON.stringify(emptyDocument()));
  useEffect(() => {
    onDirtyChange?.(hasEdits);
    return () => onDirtyChange?.(false);
  }, [hasEdits, onDirtyChange]);

  const accept = (document) => {
    setSaved(document);
    setForm(document ? editable(document) : emptyDocument());
  };
  useEffect(() => {
    let active = true;
    const printFrame = frame;
    Promise.all([request("/current"), request()]).then(([current, history]) => {
      if (!active) return;
      accept(current.document);
      setVersions(history.items);
      setTruncated(history.truncated);
    }).catch((failure) => { if (active) setError(failure.message || "Chargement DUERP impossible."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; printFrame.current?.remove(); };
  }, []);
  useEffect(() => {
    const warn = (event) => {
      if (hasEdits) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasEdits]);

  const field = (key, value) => { setForm((previous) => ({ ...previous, [key]: value })); setNotice(""); };
  const riskField = (index, key, value) => field("risques", form.risques.map((risk, i) =>
    i === index ? { ...risk, [key]: value } : risk));
  const save = async (event) => {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request("", {
        ...form, effectif: form.effectif === "" ? null : Number(form.effectif),
        risques: form.risques.map((risk) => ({ ...risk, echeance: risk.echeance || null })),
      });
      accept(result.document);
      setVersions((previous) => [{
        id: result.document.id, date_evaluation: result.document.date_evaluation,
        created_at: result.document.created_at, nombre_risques: result.document.risques.length,
      }, ...previous].slice(0, 100));
      if (versions.length >= 100) setTruncated(true);
      setNotice("Nouvelle version DUERP enregistrée. Les versions précédentes sont conservées.");
    } catch (failure) { setError(failure.message || "Enregistrement DUERP impossible ; vos saisies sont conservées."); }
    finally { setBusy(false); }
  };
  const loadVersion = async (identity) => {
    if (!identity || (dirty && !window.confirm("Abandonner les modifications non enregistrées pour consulter cette version ?"))) return;
    setBusy(true); setError(""); setNotice("");
    try { accept((await request(`/${encodeURIComponent(identity)}`)).document); }
    catch (failure) { setError(failure.message || "Lecture de la version impossible."); }
    finally { setBusy(false); }
  };
  const print = () => {
    if (!saved || dirty) return;
    setError("");
    printHaccpDocument(duerpPrintHtml(saved), frame, setError);
  };

  return <section className="hc-section duerp-section" data-testid="haccp-section-duerp" aria-busy={busy}>
    <h2 className="zc-section-title">DUERP — RISQUES PROFESSIONNELS</h2>
    <p>Évaluez les risques pour les travailleurs par unité de travail, puis planifiez la prévention.
      Ce document est distinct du PMS et de la sécurité alimentaire HACCP. Il doit être adapté et validé par l'employeur.</p>
    <p className="hc-note">Exemples à examiner sur le terrain : coupures, brûlures, glissades, manutention,
      produits chimiques, froid, bruit et risques psychosociaux. Aucune ligne n'est ajoutée automatiquement.</p>
    {error && <p className="dev-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="hc-form">
      <label>Versions conservées <select className="cmd-input" aria-label="Version DUERP" disabled={busy}
        value={saved?.id || ""} onChange={(event) => loadVersion(event.target.value)}>
        <option value="">Nouveau document</option>
        {versions.map((version) => <option key={version.id} value={version.id}>
          {formatDocumentDate(version.date_evaluation)} · version du {formatDocumentDate(version.created_at)} · {version.nombre_risques} risque(s) · {version.id.slice(0, 8)}
        </option>)}
      </select></label>
      {truncated && <span>Seules les 100 versions les plus récentes sont affichées ; les autres restent archivées.</span>}
    </div>
    <form onSubmit={save}>
      <fieldset disabled={busy}>
        <legend>Identification de l'établissement</legend>
        <div className="duerp-grid">
          {[["etablissement", "Établissement", true], ["employeur", "Employeur / responsable", true],
            ["adresse", "Adresse"], ["participants", "Participants à l'évaluation"],
            ["motif_revision", "Motif de création / révision"]].map(([key, label, required]) =>
            <label key={key}>{label}{required ? " *" : ""}<input className="cmd-input" value={form[key]}
              required={!!required} maxLength={required ? 300 : 2000} onChange={(event) => field(key, event.target.value)} /></label>)}
          <label>Effectif<input className="cmd-input" type="number" min="0" max="1000000" step="1" value={form.effectif}
            onChange={(event) => field("effectif", event.target.value)} /></label>
          <label>Date d'évaluation *<input className="cmd-input" type="date" required value={form.date_evaluation}
            onChange={(event) => field("date_evaluation", event.target.value)} /></label>
        </div>
      </fieldset>
      <p>Gravité : 1 faible, 2 significative, 3 grave, 4 très grave. Probabilité : 1 peu probable,
        2 possible, 3 probable, 4 très probable. Score = G × P : 1–5 priorité basse, 6–11 moyenne, 12–16 haute.
        Grille interne indicative, non réglementaire ; prenez en compte les mesures existantes, pas les actions futures.</p>
      {form.risques.map((risk, index) => <fieldset key={index} disabled={busy} data-testid={`duerp-risk-${index}`}>
        <legend>Risque {index + 1} — score {riskPriority(risk).score}, priorité {riskPriority(risk).label}</legend>
        <div className="duerp-grid">
          {[["unite", "Unité de travail / poste", true], ["situation", "Situation d'exposition", true],
            ["danger", "Danger", true], ["personnes", "Personnes / groupes exposés"], ["dommages", "Dommages possibles"],
            ["mesures_existantes", "Mesures de prévention existantes"], ["action", "Action de prévention à engager"],
            ["responsable", "Responsable de l'action"]].map(([key, label, required]) =>
            <label key={key}>{label}{required ? " *" : ""}<textarea className="cmd-input" rows={2}
              value={risk[key]} required={!!required} maxLength={required || key === "responsable" ? 300 : 2000}
              onChange={(event) => riskField(index, key, event.target.value)} /></label>)}
          {[["gravite", "Gravité"], ["probabilite", "Probabilité"]].map(([key, label]) =>
            <label key={key}>{label}<select className="cmd-input" value={risk[key]}
              onChange={(event) => riskField(index, key, Number(event.target.value))}>
              {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
            </select></label>)}
          <label>Échéance de l'action<input className="cmd-input" type="date" value={risk.echeance}
            onChange={(event) => riskField(index, "echeance", event.target.value)} /></label>
          <label>Avancement déclaré<select className="cmd-input" value={risk.statut}
            onChange={(event) => riskField(index, "statut", event.target.value)}>
            {Object.entries(DUERP_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        </div>
        <button className="memory-icon-btn danger" type="button" onClick={() => {
          if (window.confirm("Retirer ce risque de la prochaine version ? Les anciennes versions sont conservées.")) {
            field("risques", form.risques.filter((_, i) => i !== index));
          }
        }}><Trash2 size={14} /> Retirer ce risque</button>
      </fieldset>)}
      {!form.risques.length && <p>Aucun risque saisi : le document reste à compléter, ce n'est pas une déclaration d'absence de risques.</p>}
      <div className="hc-form">
        <button className="cmd-send" type="button" disabled={busy || form.risques.length >= 200}
          onClick={() => field("risques", [...form.risques, emptyRisk()])}><Plus size={14} /> AJOUTER UN RISQUE</button>
        <button className="cmd-send" type="submit" disabled={busy || !dirty}><Save size={14} /> ENREGISTRER UNE VERSION</button>
        <button className="cmd-send" type="button" disabled={busy || !saved || dirty} onClick={print}>
          <Printer size={14} /> IMPRIMER LE DUERP / PDF</button>
      </div>
    </form>
    {dirty && <p role="status">Modifications non enregistrées. Enregistrez une version avant de l'imprimer ou de quitter cet onglet.</p>}
    <p className="hc-note">L'impression utilise un document A4 paysage, sans le HUD, avec plan d'actions et zone de signature.
      Choisissez « Enregistrer en PDF » dans la boîte d'impression si votre appareil le propose.
      Gardez vos versions et sauvegardes : SIRIUS ne garantit ni archivage légal de longue durée ni conformité automatique.</p>
  </section>;
}

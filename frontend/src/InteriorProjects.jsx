import { useEffect, useRef, useState } from "react";
import { INTERIOR_PROJECT_FOLDER, listInteriorProjects, readInteriorProject, saveInteriorProject } from "./interiorProjectStorage";
import "./InteriorCamera.css";

export default function InteriorProjects({ draft, renderPlan }) {
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelected(null); setMessage(""); setName(""); }, [draft]);
  const run = async (operation) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setMessage("");
    try { await operation(); }
    catch (cause) { if (alive.current) setError(cause.message); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  const load = () => run(async () => {
    const items = await listInteriorProjects();
    if (alive.current) { setFiles(items); setOpen(true); }
  });
  const save = () => run(async () => {
    const project = { ...draft, name: name.trim() || draft.name };
    const file = await saveInteriorProject(project);
    if (alive.current) {
      setSelected(project);
      setMessage(`Enregistré : Médiathèque > ${INTERIOR_PROJECT_FOLDER} > ${file.original_filename}`);
      setFiles((items) => [file, ...items]);
      setOpen(true);
    }
  });
  const view = (file) => run(async () => {
    const project = await readInteriorProject(file.id);
    if (alive.current) setSelected(project);
  });
  const project = selected || draft;
  return <section className="interior-projects fp-card" aria-label="Projets avant et après">
    <h3>Mes projets · Avant / Après</h3>
    <p>Emplacement SIRIUS : <strong>Médiathèque → {INTERIOR_PROJECT_FOLDER}</strong>. Fichiers conservés sur le stockage SIRIUS de votre compte, pas dans un dossier du téléphone.</p>
    <label>Nom du projet<input maxLength={100} value={name} placeholder={draft?.name || "Ex. Salon à rénover"} onChange={(event) => setName(event.target.value)} /></label>
    <div className="interior-project-actions">
      <button type="button" disabled={!draft || busy} onClick={save} data-testid="interior-save-project">Enregistrer la proposition avant / après</button>
      <button type="button" disabled={busy} onClick={load} data-testid="interior-open-projects">Ouvrir mes projets enregistrés</button>
    </div>
    {!draft && <p>Demandez une proposition IA pour pouvoir enregistrer la photo avant et le projet après.</p>}
    {busy && <p role="status">Chargement / enregistrement…</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {open && <div aria-label="Dossier Architecture">
      <button type="button" onClick={() => { setOpen(false); setSelected(null); }}>Fermer le dossier</button>
      {!files.length && <p>Aucun projet enregistré dans ce dossier.</p>}
      {files.map((file) => <button type="button" key={file.id} disabled={busy} onClick={() => view(file)}>{file.original_filename}</button>)}
    </div>}
    {project && <section aria-label="Comparaison avant après">
      {selected && draft && <button type="button" onClick={() => setSelected(null)}>Revenir à la proposition en cours</button>}
      <h4>{project.name}</h4>
      <div className="interior-comparison">
        <article><h4>AVANT · Sans IA</h4>
          {project.before.photo ? <img src={project.before.photo.dataUrl} alt="Lieu réel avant aménagement, sans retouche IA" /> : <p>Aucune photo du lieu jointe.</p>}
          <p>Plan de référence fourni avant cette proposition.</p>
          {renderPlan(project.before.plan)}
        </article>
        <article><h4>APRÈS · Proposition IA</h4>
          <p>Simulation sur plan et recommandations, pas une photo générée ni des travaux réalisés.</p>
          {renderPlan(project.after.plan)}
          <p>Vos envies : {project.request || "Non précisées"}</p>
          <ul>{project.after.proposal.conseils.map((tip, index) => <li key={index}>{tip}</li>)}</ul>
          <p>{project.after.proposal.eclairage}</p>
          <ul>{(project.after.proposal.achats || []).map((item, index) => <li key={index}>{item.article} · × {item.quantite || 1}{Number.isFinite(item.budget_eur) ? ` · ${item.budget_eur} € / unité` : ""}</li>)}</ul>
          <p>Dimensions, structure, réseaux et faisabilité à vérifier sur place.</p>
        </article>
      </div>
    </section>}
  </section>;
}

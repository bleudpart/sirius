// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { FolderOpen, X, Upload, Trash2, Download, FileText, Music, Image as ImageIcon, File as FileIcon, Loader2, Sparkles, ChevronUp, Search, FolderPlus } from "lucide-react";
import DropZone, { autoAnalyze } from "./DropZone";
import FileViewer from "./FileViewer";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const MAX_MB = 20;

const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(b / 1024))} Ko`);
const iconFor = (ct) => {
  if ((ct || "").startsWith("image/")) return <ImageIcon size={16} />;
  if ((ct || "").startsWith("audio/")) return <Music size={16} />;
  if ((ct || "").includes("pdf") || (ct || "").startsWith("text/")) return <FileText size={16} />;
  return <FileIcon size={16} />;
};

// Médiathèque de Sirius : upload, aperçu, téléchargement et suppression de fichiers
export default function FilesPanel({ onClose }) {
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [dossier, setDossier] = useState("Tous");
  const [openAna, setOpenAna] = useState(null);
  const [anaBusy, setAnaBusy] = useState(null);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(null);
  const [overFolder, setOverFolder] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [windowsFolder, setWindowsFolder] = useState(() => localStorage.getItem("sirius_windows_folder") || "");
  const inputRef = useRef(null);

  const load = async () => {
    try {
      const resp = await fetch(`${API}/files`);
      if (resp.ok) setFiles(await resp.json());
    } catch (e) {}
  };
  useEffect(() => {
    load();
    const onUpd = () => load();
    window.addEventListener("sirius-files-updated", onUpd);
    return () => window.removeEventListener("sirius-files-updated", onUpd);
  }, []);

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  const upload = async (e) => {
    const list = Array.from(e.target.files || []);
    if (!list.length) return;
    setBusy(true);
    const uploaded = [];
    for (const f of list) {
      if (f.size > MAX_MB * 1048576) { flash(`« ${f.name} » dépasse ${MAX_MB} Mo, ignoré.`); continue; }
      try {
        const form = new FormData();
        form.append("file", f);
        const resp = await fetch(`${API}/files/upload`, { method: "POST", body: form });
        if (!resp.ok) throw new Error();
        uploaded.push(await resp.json());
        flash(`« ${f.name} » enregistré ✓`);
      } catch (err) {
        flash(`Échec de l'envoi de « ${f.name} ».`);
      }
    }
    if (inputRef.current) inputRef.current.value = "";
    setBusy(false);
    load();
    autoAnalyze(uploaded);
  };

  const del = async (f) => {
    try {
      await fetch(`${API}/files/${f.id}`, { method: "DELETE" });
      flash(`« ${f.original_filename} » supprimé ✓`);
      load();
    } catch (e) {}
  };

  const analyze = async (f) => {
    setAnaBusy(f.id);
    let keys = {};
    try { keys = JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch { keys = {}; }
    try {
      const resp = await fetch(`${API}/files/${f.id}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }),
      });
      const d = await resp.json();
      if (resp.ok) { flash("Analyse IA terminée ✓"); setOpenAna(f.id); load(); }
      else flash(d.detail || "Analyse impossible.");
    } catch { flash("Analyse impossible."); }
    setAnaBusy(null);
  };

  const ANALYZABLE = (ct) => (ct || "").startsWith("image/") || (ct || "").startsWith("text/") || ct === "application/pdf" || ct === "application/json";
  const STD = ["Photos", "Documents", "Sons", "Vidéos"];
  const present = [...new Set(files.map((f) => f.dossier || "Autres"))];
  const DOSSIERS = ["Tous", ...STD.filter((d) => present.includes(d) || dragging), ...present.filter((d) => !STD.includes(d)).sort()];

  const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const STOPW = ["la", "le", "les", "un", "une", "des", "de", "du", "d", "l", "avec", "photo", "photos", "image", "images", "fichier", "fichiers", "document", "documents", "doc", "video", "videos", "ma", "mon", "mes", "qui", "est", "dans", "sur", "et", "ou", "a", "au", "aux", "ce", "cette", "en", "pour"];
  const tokens = norm(query).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPW.includes(t));
  const matches = (f) => {
    if (!query.trim()) return true;
    const hay = norm([f.original_filename, f.dossier, f.analyse?.description, f.analyse?.texte].join(" "));
    if (tokens.length === 0) return hay.includes(norm(query.trim()));
    return tokens.every((t) => hay.includes(t));
  };
  const shown = files.filter((f) => (dossier === "Tous" || (f.dossier || "Autres") === dossier) && matches(f));
  const countIn = (d) => files.filter((f) => (d === "Tous" || (f.dossier || "Autres") === d) && matches(f)).length;

  const moveTo = async (fileId, d) => {
    setOverFolder(null); setDragging(null);
    if (!fileId || !d || d === "Tous") return;
    try {
      const resp = await fetch(`${API}/files/${fileId}/dossier`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dossier: d }),
      });
      if (resp.ok) { flash(`Déplacé vers « ${d} » ✓`); load(); }
    } catch { flash("Déplacement impossible."); }
  };

  const chooseWindowsFolder = async () => {
    if (!window.siriusFiles?.selectFolder) {
      flash("L'accès aux dossiers Windows est disponible dans l'application ΣIRIUS installée.");
      return;
    }
    const result = await window.siriusFiles.selectFolder();
    if (!result?.path) return;
    localStorage.setItem("sirius_windows_folder", result.path);
    setWindowsFolder(result.path);
  };

  const openWindowsFolder = async () => {
    if (!windowsFolder || !window.siriusFiles?.openFolder) return;
    const result = await window.siriusFiles.openFolder(windowsFolder);
    if (!result?.ok) flash(result?.error || "Impossible d'ouvrir ce dossier.");
  };

  return (
    <div className="setup-screen" data-testid="sirius-files-panel" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="setup-grid-bg" />
      <div className="setup-card files-modal">
        <button className="setup-close" onClick={onClose} data-testid="files-close-btn"><X size={18} /></button>
        <div className="setup-head">
          <FolderOpen size={22} />
          <div>
            <h2 className="setup-title">Médiathèque</h2>
            <p className="setup-sub">Vos fichiers, images, sons et documents, stockés par Sirius.</p>
          </div>
        </div>

        <DropZone onUploaded={load} />
        <div className="files-bar">
          <button className="files-workspace-action primary" onClick={() => inputRef.current && inputRef.current.click()} disabled={busy} data-testid="files-upload-btn">
            {busy ? <Loader2 size={15} className="dg-spin" /> : <Upload size={15} />}
            {busy ? "ENVOI EN COURS..." : "AJOUTER DES FICHIERS"}
          </button>
          <input ref={inputRef} type="file" multiple style={{ display: "none" }} onChange={upload} data-testid="files-input" />
          <button className="files-workspace-action" onClick={windowsFolder ? openWindowsFolder : chooseWindowsFolder} data-testid="files-windows-folder-btn">
            <FolderOpen size={15} /> {windowsFolder ? "OUVRIR LE DOSSIER" : "CHOISIR UN DOSSIER"}
          </button>
          <span className="files-hint">{files.length} fichier{files.length > 1 ? "s" : ""} · {MAX_MB} Mo max par fichier</span>
        </div>
        {windowsFolder && <p className="files-windows-path" title={windowsFolder}>Dossier Windows : {windowsFolder}</p>}
        {msg && <div className="memory-flash" data-testid="files-flash">{msg}</div>}

        <div className="files-search">
          <Search size={14} />
          <input
            placeholder="Rechercher un fichier… (nom, contenu, description IA — ex : « la photo avec le chat »)"
            value={query} onChange={(e) => setQuery(e.target.value)} data-testid="files-search-input"
          />
          {query && <button className="files-search-clear" onClick={() => setQuery("")} data-testid="files-search-clear"><X size={12} /></button>}
        </div>

        <div className="files-folders" data-testid="files-folders">
          {DOSSIERS.map((d) => (
            <button
              key={d}
              className={`files-folder ${dossier === d ? "on" : ""} ${overFolder === d && d !== "Tous" ? "drop-over" : ""}`}
              onClick={() => setDossier(d)}
              onDragOver={(e) => { if (dragging && d !== "Tous") { e.preventDefault(); setOverFolder(d); } }}
              onDragLeave={() => setOverFolder((o) => (o === d ? null : o))}
              onDrop={(e) => { e.preventDefault(); moveTo(e.dataTransfer.getData("text/sirius-file"), d); }}
              data-testid={`files-folder-${d}`}
            >
              {d} <i>{countIn(d)}</i>
            </button>
          ))}
          {dragging && (
            <button
              className={`files-folder new ${overFolder === "__new__" ? "drop-over" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOverFolder("__new__"); }}
              onDragLeave={() => setOverFolder((o) => (o === "__new__" ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/sirius-file");
                const name = window.prompt("Nom du nouveau dossier :");
                if (name && name.trim()) moveTo(id, name.trim());
                else { setOverFolder(null); setDragging(null); }
              }}
              data-testid="files-folder-new"
            >
              <FolderPlus size={12} /> NOUVEAU DOSSIER
            </button>
          )}
        </div>
        {dragging && <div className="files-drag-hint" data-testid="files-drag-hint">Déposez le fichier sur un dossier pour le déplacer</div>}

        <div className="files-grid" data-testid="files-grid">
          {shown.length === 0 && (
            <div className="architect-empty">Aucun fichier dans ce dossier. Ajoutez des images, musiques ou documents : Sirius les garde en lieu sûr.</div>
          )}
          {shown.map((f) => (
            <div
              className={`file-card ${dragging === f.id ? "dragging" : ""}`}
              key={f.id}
              draggable
              onDragStart={(e) => { e.dataTransfer.setData("text/sirius-file", f.id); e.dataTransfer.effectAllowed = "move"; setDragging(f.id); }}
              onDragEnd={() => { setDragging(null); setOverFolder(null); }}
              data-testid={`file-card-${f.id}`}
            >
              {(f.content_type || "").startsWith("image/") ? (
                <img className="file-thumb clickable" draggable={false} src={`${API}/files/${f.id}/download`} alt={f.original_filename} loading="lazy" onClick={() => setViewing(f)} data-testid={`file-open-${f.id}`} />
              ) : (
                <div className="file-thumb file-thumb-icon clickable" onClick={() => setViewing(f)} data-testid={`file-open-icon-${f.id}`}>{iconFor(f.content_type)}</div>
              )}
              <div className="file-meta">
                <span className="file-name clickable" title={`Ouvrir ${f.original_filename}`} onClick={() => setViewing(f)}>{f.original_filename}</span>
                <span className="file-info">{f.dossier ? `${f.dossier} · ` : ""}{fmtSize(f.size)} · {(f.created_at || "").slice(0, 10)}</span>
                {(f.content_type || "").startsWith("audio/") && (
                  <audio className="file-audio" controls preload="none" src={`${API}/files/${f.id}/download`} />
                )}
                {f.analyse && openAna === f.id && (
                  <div className="file-analyse" data-testid={`file-analyse-${f.id}`}>
                    <b>Description</b>
                    <p>{f.analyse.description}</p>
                    {f.analyse.texte && f.analyse.texte !== "Aucun texte visible" && (
                      <>
                        <b>Texte extrait</b>
                        <p>{f.analyse.texte}</p>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="file-actions">
                {f.analyse ? (
                  <button className="file-btn gold" onClick={() => setOpenAna(openAna === f.id ? null : f.id)} title="Analyse IA" data-testid={`file-ana-toggle-${f.id}`}>
                    {openAna === f.id ? <ChevronUp size={14} /> : <Sparkles size={14} />}
                  </button>
                ) : ANALYZABLE(f.content_type) && (
                  <button className="file-btn gold" onClick={() => analyze(f)} disabled={anaBusy === f.id} title="Analyser avec l'IA" data-testid={`file-ana-run-${f.id}`}>
                    {anaBusy === f.id ? <Loader2 size={14} className="dg-spin" /> : <Sparkles size={14} />}
                  </button>
                )}
                <a className="file-btn" href={`${API}/files/${f.id}/download?dl=1`} title="Télécharger" data-testid={`file-download-${f.id}`}><Download size={14} /></a>
                <button className="file-btn danger" onClick={() => del(f)} title="Supprimer" data-testid={`file-delete-${f.id}`}><Trash2 size={14} /></button>
              </div>
            </div>
          ))}
        </div>
        <div className="memory-foot">Stockage cloud persistant (ou dossier backend/uploads en installation locale Windows).</div>
      </div>
      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} onSaved={load} />}
    </div>
  );
}

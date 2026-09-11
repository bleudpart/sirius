// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { X, Save, Loader2, Eye, FileWarning, RotateCcw } from "lucide-react";
import "./FileViewer.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const TEXT_EXTS = ["txt", "json", "js", "jsx", "py", "html", "css", "md", "log", "xml", "yaml", "yml", "csv", "ts", "tsx", "sh", "ini", "conf", "env", "lien"];
const LANG = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python", html: "html", css: "css", md: "markdown", json: "json", xml: "xml", yaml: "yaml", yml: "yaml", sh: "shell", log: "plaintext", txt: "plaintext", csv: "plaintext", ini: "ini", conf: "plaintext", env: "plaintext", lien: "plaintext" };

export function fileKind(f) {
  const ct = (f.content_type || "").toLowerCase();
  const ext = (f.original_filename || "").split(".").pop().toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "application/pdf") return "pdf";
  if (ct.startsWith("audio/")) return "audio";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("text/") || ["application/json", "application/xml", "application/javascript"].includes(ct) || TEXT_EXTS.includes(ext)) return "text";
  return "other";
}

export default function FileViewer({ file, onClose, onSaved }) {
  const kind = fileKind(file);
  const ext = (file.original_filename || "").split(".").pop().toLowerCase();
  const [content, setContent] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [draftAvailable, setDraftAvailable] = useState(false);
  const draftKey = `sirius_draft_${file.id}`;
  const draftTimer = useRef(null);
  const url = `${API}/files/${file.id}/download`;

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  useEffect(() => {
    if (kind !== "text") return;
    fetch(`${API}/files/${file.id}/content`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.detail || "Lecture impossible");
        setContent(d.content);
        try {
          const draft = localStorage.getItem(draftKey);
          if (draft !== null && draft !== d.content) setDraftAvailable(true);
        } catch {}
      })
      .catch((e) => setErr(e.message));
  }, [file.id, kind, draftKey]);

  const onEdit = useCallback((v) => {
    setContent(v ?? "");
    setDirty(true);
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      try { localStorage.setItem(draftKey, v ?? ""); } catch {}
    }, 800);
  }, [draftKey]);

  const restoreDraft = () => {
    try {
      const draft = localStorage.getItem(draftKey);
      if (draft !== null) { setContent(draft); setDirty(true); setDraftAvailable(false); flash("Brouillon local restauré."); }
    } catch {}
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${API}/files/${file.id}/update`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: content ?? "" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || "Enregistrement impossible");
      setDirty(false); setDraftAvailable(false);
      try { localStorage.removeItem(draftKey); } catch {}
      flash("Enregistré dans Sirius ✓");
      if (onSaved) onSaved();
    } catch (e) { flash(e.message); }
    setSaving(false);
  };

  return (
    <div className="fv-overlay" data-testid="file-viewer" onMouseDown={(e) => { if (e.target === e.currentTarget && !dirty) onClose(); }}>
      <div className="fv-window">
        <div className="fv-bar">
          <Eye size={14} />
          <span className="fv-name" title={file.original_filename}>{file.original_filename}</span>
          {dirty && <span className="fv-dirty" data-testid="file-viewer-dirty">● modifié</span>}
          {kind === "text" && (
            <button className="fv-btn gold" onClick={save} disabled={saving || !dirty} data-testid="file-viewer-save-btn">
              {saving ? <Loader2 size={12} className="dg-spin" /> : <Save size={12} />} ENREGISTRER DANS ΣIRIUS
            </button>
          )}
          <button className="fv-btn" onClick={onClose} data-testid="file-viewer-close-btn"><X size={14} /></button>
        </div>
        {msg && <div className="fv-msg" data-testid="file-viewer-msg">{msg}</div>}
        {draftAvailable && (
          <div className="fv-draft" data-testid="file-viewer-draft">
            <FileWarning size={13} /> Un brouillon local non enregistré existe pour ce fichier.
            <button onClick={restoreDraft} data-testid="file-viewer-draft-restore"><RotateCcw size={11} /> RESTAURER</button>
          </div>
        )}
        <div className="fv-body">
          {kind === "image" && <img className="fv-image" src={url} alt={file.original_filename} data-testid="file-viewer-image" />}
          {kind === "pdf" && <iframe className="fv-pdf" src={url} title={file.original_filename} data-testid="file-viewer-pdf" />}
          {kind === "audio" && <audio className="fv-audio" controls autoPlay src={url} data-testid="file-viewer-audio" />}
          {kind === "video" && <video className="fv-video" controls src={url} data-testid="file-viewer-video" />}
          {kind === "text" && (
            err ? <div className="fv-error">{err}</div>
            : content === null ? <div className="fv-loading"><Loader2 size={18} className="dg-spin" /> Chargement…</div>
            : (
              <Editor
                height="100%"
                language={LANG[ext] || "plaintext"}
                value={content}
                onChange={onEdit}
                theme="vs-dark"
                options={{ fontSize: 13, minimap: { enabled: false }, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true }}
              />
            )
          )}
          {kind === "other" && (
            <div className="fv-error">
              Aperçu non disponible pour ce type de fichier.{" "}
              <a className="fv-dl" href={`${url}?dl=1`}>Télécharger</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { loadApiKeys } from "@/apiKeyStorage";
// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, HardDrive, ClipboardPaste, Loader2 } from "lucide-react";
import { progress } from "./SiriusProgress";
import "./DropZone.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const MAX_MB = 20;

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export function toFile(blob, hint = "collé") {
  if (blob instanceof File && blob.name) return blob;
  const ext = EXT[blob.type] || (blob.type || "").split("/")[1] || "bin";
  return new File([blob], `${hint}-${Date.now()}.${ext}`, { type: blob.type || "application/octet-stream" });
}

export function clipboardFiles(e) {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const out = [];
  for (const it of items) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) out.push(toFile(f));
    }
  }
  return out;
}

const ANALYZABLE = (ct) => (ct || "").startsWith("image/") || (ct || "").startsWith("text/") || ct === "application/pdf" || ct === "application/json";

// Analyse IA automatique en arrière-plan des fichiers déposés
export function autoAnalyze(records) {
  let keys = {};
  keys = loadApiKeys();
  (records || []).filter((r) => r && ANALYZABLE(r.content_type)).forEach((r) => {
    const pid = progress.start(`Analyse IA — ${r.original_filename}`, { silent: true });
    progress.log(pid, "Lecture du fichier et interrogation de l'IA…", 35);
    fetch(`${API}/files/${r.id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys }),
    }).then((resp) => {
      if (resp.ok) {
        progress.done(pid, "Description et texte extraits");
        window.dispatchEvent(new Event("sirius-files-updated"));
      } else {
        progress.error(pid, "Analyse impossible pour ce fichier");
      }
    }).catch(() => progress.error(pid, "Analyse interrompue"));
  });
}

// Hook d'upload unifié : envoi instantané vers le backend + prévisualisations
export function useFileUpload(onDone) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [previews, setPreviews] = useState([]);
  const flash = useCallback((m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); }, []);

  const uploadFiles = useCallback(async (list) => {
    const files = Array.from(list || []).filter(Boolean);
    if (!files.length) return;
    const imgs = files.filter((f) => (f.type || "").startsWith("image/")).map((f) => ({ url: URL.createObjectURL(f), name: f.name }));
    if (imgs.length) {
      setPreviews(imgs);
      setTimeout(() => { imgs.forEach((p) => URL.revokeObjectURL(p.url)); setPreviews([]); }, 5000);
    }
    setBusy(true);
    let ok = 0;
    const uploaded = [];
    const pid = progress.start(files.length === 1 ? `Dépôt — ${files[0].name}` : `Dépôt de ${files.length} fichiers`, { silent: true });
    let idx = 0;
    for (const f of files) {
      idx += 1;
      if (f.size > MAX_MB * 1048576) { flash(`« ${f.name} » dépasse ${MAX_MB} Mo, ignoré.`); progress.log(pid, `« ${f.name} » ignoré (trop volumineux)`); continue; }
      try {
        progress.log(pid, `Envoi de « ${f.name} »…`, Math.round((idx - 0.5) / files.length * 90));
        const form = new FormData();
        form.append("file", f);
        const resp = await fetch(`${API}/files/upload`, { method: "POST", body: form });
        if (!resp.ok) throw new Error();
        uploaded.push(await resp.json());
        ok += 1;
      } catch {
        flash(`Échec de l'envoi de « ${f.name} ».`);
        progress.log(pid, `Échec de l'envoi de « ${f.name} »`);
      }
    }
    setBusy(false);
    if (ok) {
      progress.done(pid, ok === 1 ? "Fichier enregistré dans la médiathèque" : `${ok} fichiers enregistrés dans la médiathèque`);
      flash(ok === 1 ? `« ${files[0].name} » enregistré ✓` : `${ok} fichiers enregistrés ✓`);
      window.dispatchEvent(new Event("sirius-files-updated"));
      if (onDone) onDone(ok);
      autoAnalyze(uploaded);
    } else {
      progress.error(pid, "Aucun fichier n'a pu être envoyé");
    }
  }, [flash, onDone]);

  return { busy, msg, previews, uploadFiles, flash };
}

// Zone de dépôt unifiée : drag & drop, Ctrl+V, explorateur PC, prévisualisation, upload instantané
export default function DropZone({ onUploaded, compact = false }) {
  const { busy, msg, previews, uploadFiles } = useFileUpload(onUploaded);
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    const onPaste = (e) => {
      const files = clipboardFiles(e);
      if (!files.length) return;
      const disp = document.querySelector("[data-testid='sirius-display']");
      if (disp && (disp.contains(document.activeElement) || (() => { try { return disp.matches(":hover"); } catch { return false; } })())) return;
      e.preventDefault();
      uploadFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [uploadFiles]);

  const onDrop = (e) => {
    e.preventDefault(); e.stopPropagation(); setOver(false);
    uploadFiles(e.dataTransfer.files);
  };

  return (
    <div
      className={`dropzone ${over ? "over" : ""} ${compact ? "compact" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      data-testid="dropzone"
    >
      <div className="dz-inner">
        {busy ? <Loader2 size={20} className="dg-spin" /> : <Upload size={20} />}
        <div className="dz-text">
          <b>{busy ? "Envoi en cours…" : "Glissez-déposez vos fichiers ici"}</b>
          <span><ClipboardPaste size={11} /> Collage direct Ctrl+V pris en charge</span>
        </div>
        <button className="dz-explore" onClick={() => inputRef.current && inputRef.current.click()} disabled={busy} data-testid="dropzone-explore-btn">
          <HardDrive size={13} /> EXPLORER MON PC
        </button>
        <input ref={inputRef} type="file" multiple style={{ display: "none" }} data-testid="dropzone-input"
          onChange={(e) => { uploadFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {previews.length > 0 && (
        <div className="dz-previews" data-testid="dropzone-previews">
          {previews.map((p, i) => <img key={i} src={p.url} alt={p.name} title={p.name} />)}
        </div>
      )}
      {msg && <div className="dz-msg" data-testid="dropzone-msg">{msg}</div>}
    </div>
  );
}

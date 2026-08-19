// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { X, Folder, FolderOpen, ArrowLeft, Film, RotateCw, Library, Link2 } from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

let zCounter = 85;
const fold = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

// Galerie de la médiathèque SIRIUS : dossiers navigables (souris + voix), fenêtre HUD dédiée
export default function ArchiveGallery({ nav, onClose, onOpen, onSpeak }) {
  const ref = useRef(null);
  const [z, setZ] = useState(() => ++zCounter);
  const [files, setFiles] = useState([]);
  const [folder, setFolder] = useState(null);
  const bringFront = () => setZ(++zCounter);

  const load = async () => {
    try {
      const r = await fetch(`${API}/archive/list`);
      if (r.ok) setFiles(await r.json());
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const folders = {};
  files.forEach((f) => {
    const d = f.dossier || "Divers";
    (folders[d] = folders[d] || []).push(f);
  });
  const names = Object.keys(folders).sort();

  // Navigation vocale pilotée par Sirius (« ouvre le dossier Clips », « retour »)
  useEffect(() => {
    if (!nav) return;
    if (nav.type === "back") {
      setFolder(null);
      onSpeak("Retour à la racine de la médiathèque.");
      return;
    }
    if (nav.type === "folder") {
      const q = fold(nav.q).replace(/s$/, "");
      const hit = names.find((n) => fold(n).replace(/s$/, "").includes(q) || q.includes(fold(n).replace(/s$/, "")));
      if (hit) {
        setFolder(hit);
        onSpeak(`Dossier ${hit} ouvert. ${folders[hit].length} archive${folders[hit].length > 1 ? "s" : ""}.`);
      } else {
        onSpeak(`Aucun dossier ${nav.q} dans ma médiathèque.`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav && nav.seq]);

  const onBarDown = (e) => {
    if (e.target.closest("button")) return;
    const el = ref.current;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    el.classList.add("dragging");
    bringFront();
    const move = (ev) => {
      el.style.left = Math.min(Math.max(0, ev.clientX - dx), window.innerWidth - 140) + "px";
      el.style.top = Math.min(Math.max(0, ev.clientY - dy), window.innerHeight - 60) + "px";
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
  };

  const onResizeDown = (e) => {
    const el = ref.current;
    const r = el.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const sw = r.width, sh = r.height;
    el.classList.add("dragging");
    bringFront();
    const move = (ev) => {
      el.style.width = Math.max(304, sw + ev.clientX - sx) + "px";
      el.style.height = Math.max(208, sh + ev.clientY - sy) + "px";
    };
    const up = () => {
      el.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="web-window archive-gallery"
      style={{ left: 140, top: 90, zIndex: z }}
      onPointerDown={bringFront}
      data-testid="archive-gallery"
    >
      <div className="ww-bar" onPointerDown={onBarDown} title="Glisser pour déplacer" data-testid="archive-gallery-bar">
        <Library size={13} />
        <div className="ww-titles">
          <span className="ww-title">ARCHIVES SIRIUS{folder ? ` — ${folder.toUpperCase()}` : ""}</span>
          <span className="ww-url">{files.length} archive{files.length > 1 ? "s" : ""} · {names.length} dossier{names.length > 1 ? "s" : ""}</span>
        </div>
        {folder && (
          <button onClick={() => setFolder(null)} title="Retour" data-testid="archive-gallery-back">
            <ArrowLeft size={13} />
          </button>
        )}
        <button onClick={load} title="Actualiser" data-testid="archive-gallery-refresh">
          <RotateCw size={13} />
        </button>
        <button onClick={onClose} title="Fermer" data-testid="archive-gallery-close">
          <X size={13} />
        </button>
      </div>

      {!folder ? (
        <div className="ag-folders" data-testid="archive-gallery-folders">
          {names.length === 0 && <div className="ag-empty">Aucune archive pour l'instant. Demandez-moi une création : elle sera archivée ici.</div>}
          {names.map((n) => (
            <button key={n} className="ag-folder" onClick={() => setFolder(n)} data-testid={`archive-folder-${n}`}>
              <Folder size={26} />
              <span className="ag-folder-name">{n}</span>
              <span className="ag-folder-count">{folders[n].length}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="ag-grid" data-testid="archive-gallery-grid">
          {(folders[folder] || []).map((f) => (
            <button key={f.id} className="ag-item" onClick={() => onOpen(f)} title={f.nom || f.original_filename} data-testid={`archive-item-${f.id}`}>
              {(f.content_type || "").startsWith("image/") ? (
                <img src={`${API}/files/${f.id}/download`} alt={f.original_filename} loading="lazy" />
              ) : (f.content_type || "").startsWith("video/") ? (
                <video src={`${API}/files/${f.id}/download`} preload="metadata" muted />
              ) : (f.content_type || "") === "text/x-sirius-link" ? (
                <div className="ag-item-icon"><Link2 size={22} /></div>
              ) : (
                <div className="ag-item-icon"><FolderOpen size={22} /></div>
              )}
              {(f.content_type || "").startsWith("video/") && <Film size={12} className="ag-item-badge" />}
              <span className="ag-item-name">{f.original_filename}</span>
            </button>
          ))}
        </div>
      )}

      <div className="ww-resize" onPointerDown={onResizeDown} title="Redimensionner" data-testid="archive-gallery-resize" />
    </div>
  );
}

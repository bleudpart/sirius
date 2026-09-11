// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { UploadCloud } from "lucide-react";
import { useFileUpload, clipboardFiles } from "./DropZone";
import { displayClaimsPaste } from "./SiriusDisplay";
import "./DropZone.css";

// Capteur global : drag & drop et Ctrl+V actifs dans TOUTES les fenêtres de Sirius
// (HUD, modules, médiathèque, personnages, paramètres...). Upload instantané vers la médiathèque.
export default function GlobalDrop() {
  const { busy, msg, previews, uploadFiles } = useFileUpload();
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes("Files");
    const onEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current += 1; setOver(true); };
    const onOver = (e) => { if (hasFiles(e)) e.preventDefault(); };
    const onLeave = (e) => { if (!hasFiles(e)) return; depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setOver(false); };
    const onDrop = (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0; setOver(false);
      if (e.target.closest && e.target.closest(".dropzone")) return;
      if (e.target.closest && e.target.closest("[data-testid='sirius-display']")) return;
      uploadFiles(e.dataTransfer.files);
    };
    // Filet de sécurité : si le drop est revendiqué ailleurs (display), on referme quand même l'overlay
    const onDropReset = () => { depth.current = 0; setOver(false); };
    const onPaste = (e) => {
      const files = clipboardFiles(e);
      if (!files.length) return;
      if (displayClaimsPaste()) return;
      if (document.querySelector(".dropzone")) return;
      e.preventDefault();
      uploadFiles(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("drop", onDropReset, true);
    window.addEventListener("dragend", onDropReset);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("drop", onDropReset, true);
      window.removeEventListener("dragend", onDropReset);
      window.removeEventListener("paste", onPaste);
    };
  }, [uploadFiles]);

  // Pendant un drag, neutralise les iframes du display pour que le drop atterrisse dessus
  useEffect(() => {
    document.body.classList.toggle("sirius-dragging", over);
    return () => document.body.classList.remove("sirius-dragging");
  }, [over]);

  return (
    <>
      {over && (
        <div className="gdrop-overlay" data-testid="global-drop-overlay">
          <div className="gdrop-box">
            <UploadCloud size={34} />
            <b>Déposez vos fichiers</b>
            <span>Sirius les enregistre dans la médiathèque</span>
          </div>
        </div>
      )}
      {(busy || msg || previews.length > 0) && (
        <div className="gdrop-toast" data-testid="global-drop-toast">
          {previews.length > 0 && (
            <div className="dz-previews">{previews.map((p, i) => <img key={i} src={p.url} alt={p.name} />)}</div>
          )}
          <span>{busy ? "Envoi vers la médiathèque…" : msg}</span>
        </div>
      )}
    </>
  );
}

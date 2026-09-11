// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useState } from "react";
import { X, RotateCw, ExternalLink, Globe, ShieldCheck } from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

let zCounter = 70;

// Fenêtre web indépendante du HUD : déplaçable, redimensionnable, superposable
// Sites bloquant l'iframe (X-Frame-Options / CSP) → affichés via le proxy ΣIRIUS
function WebWindow({ win, onClose }) {
  const ref = useRef(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [z, setZ] = useState(() => ++zCounter);

  const bringFront = () => setZ(++zCounter);
  const proxied = win.iframeOk === false;
  const frameSrc = proxied
    ? `${API}/webbrowser/proxy?url=${encodeURIComponent(win.url)}${win.noscript ? "&noscript=1" : ""}`
    : win.url;

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
      el.style.width = Math.max(256, sw + ev.clientX - sx) + "px";
      el.style.height = Math.max(176, sh + ev.clientY - sy) + "px";
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
      className="web-window"
      style={{ left: win.x, top: win.y, zIndex: z }}
      onPointerDown={bringFront}
      data-testid={`web-window-${win.id}`}
    >
      <div className="ww-bar" onPointerDown={onBarDown} title="Glisser pour déplacer" data-testid={`web-window-bar-${win.id}`}>
        <Globe size={13} />
        <div className="ww-titles">
          <span className="ww-title">{win.titre || win.url}</span>
          <span className="ww-url">{win.url}</span>
        </div>
        {proxied && (
          <span className="ww-proxy-badge" title="Site protégé — affiché via le proxy ΣIRIUS (certaines fonctions dynamiques peuvent être limitées)" data-testid={`web-window-proxy-badge-${win.id}`}>
            <ShieldCheck size={11} /> PROXY
          </span>
        )}
        <button onClick={() => setReloadKey((k) => k + 1)} title="Actualiser" data-testid={`web-window-refresh-${win.id}`}>
          <RotateCw size={13} />
        </button>
        <button onClick={() => window.open(win.url, "_blank")} title="Ouvrir dans un onglet" data-testid={`web-window-external-${win.id}`}>
          <ExternalLink size={13} />
        </button>
        <button onClick={() => onClose(win.id)} title="Fermer" data-testid={`web-window-close-${win.id}`}>
          <X size={13} />
        </button>
      </div>
      <iframe
        key={reloadKey}
        src={frameSrc}
        title={win.titre || win.url}
        className="ww-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
      <div className="ww-resize" onPointerDown={onResizeDown} title="Redimensionner" data-testid={`web-window-resize-${win.id}`} />
    </div>
  );
}

export default function WebWindows({ windows, onClose }) {
  return windows.map((w) => <WebWindow key={w.id} win={w} onClose={onClose} />);
}

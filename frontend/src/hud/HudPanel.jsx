import { useEffect, useRef, useState } from "react";
import { X, Anchor } from "lucide-react";
import {
  useHudHiddenKeys, hideHudPanel,
  readFloatPos, writeFloatPos, clearFloatPos,
} from "@/hud/hudPanelState";

export default function HudPanel({
  title,
  icon = null,
  meta = null,
  status = "on",
  className = "",
  delay = 0,
  side = "left",
  link = false,
  panelKey,
  children,
}) {
  const ref = useRef(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const key = panelKey || `${side}-${delay}`;
  const hiddenKeys = useHudHiddenKeys();
  const hidden = hiddenKeys.has(key);
  const [floatPos, setFloatPos] = useState(() => readFloatPos(key));

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      setTilt({ x: py * -3.5, y: px * 4.5 });
    };
    const onLeave = () => setTilt({ x: 0, y: 0 });
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  // Glisser l'en-tête : détache la fenêtre de sa colonne (position: fixed) et la fait
  // suivre le pointeur — comme une vraie fenêtre HUD flottante plutôt qu'une carte figée
  // dans la liste. Position mémorisée par fenêtre (panelKey) pour survivre au rechargement.
  const onHeaderPointerDown = (e) => {
    if (e.target.closest("button")) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const startLeft = r.left, startTop = r.top;
    el.style.position = "fixed";
    el.style.left = `${startLeft}px`;
    el.style.top = `${startTop}px`;
    el.style.width = `${r.width}px`;
    el.style.margin = "0";
    el.style.zIndex = "500";
    el.classList.add("shud-dragging");
    const sx = e.clientX, sy = e.clientY;
    const onMove = (ev) => {
      const nl = Math.min(Math.max(0, startLeft + (ev.clientX - sx)), window.innerWidth - 40);
      const nt = Math.min(Math.max(0, startTop + (ev.clientY - sy)), window.innerHeight - 40);
      el.style.left = `${nl}px`;
      el.style.top = `${nt}px`;
    };
    const onUp = () => {
      el.classList.remove("shud-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const rect = el.getBoundingClientRect();
      const pos = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      setFloatPos(pos);
      writeFloatPos(key, pos);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault();
  };

  const onResizePointerDown = (e) => {
    const el = ref.current;
    if (!el || !floatPos) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    el.classList.add("shud-dragging");
    const onMove = (ev) => {
      const width = Math.min(window.innerWidth - rect.left - 8, Math.max(240, rect.width + ev.clientX - startX));
      const height = Math.min(window.innerHeight - rect.top - 8, Math.max(120, rect.height + ev.clientY - startY));
      el.style.width = `${width}px`;
      el.style.height = `${height}px`;
    };
    const onUp = () => {
      el.classList.remove("shud-dragging");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const next = { left: rect.left, top: rect.top, width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height };
      setFloatPos(next);
      writeFloatPos(key, next);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    e.preventDefault();
    e.stopPropagation();
  };

  const redock = () => {
    const el = ref.current;
    if (el) {
      el.style.position = "";
      el.style.left = "";
      el.style.top = "";
      el.style.width = "";
      el.style.margin = "";
      el.style.zIndex = "";
    }
    setFloatPos(null);
    clearFloatPos(key);
  };

  if (hidden) return null;

  return (
    <section
      ref={ref}
      className={`shud-panel ${link ? `shud-link-${side}` : ""} ${className}`}
      style={{
        "--shud-delay": `${delay}ms`,
        "--shud-tilt-x": `${tilt.x}deg`,
        "--shud-tilt-y": `${tilt.y}deg`,
        ...(floatPos ? {
          position: "fixed", left: floatPos.left, top: floatPos.top, zIndex: 500, margin: 0,
          width: floatPos.width, height: floatPos.height, boxSizing: "border-box",
        } : {}),
      }}
      data-testid={`shud-panel-${key}`}
    >
      <header className="shud-head" onPointerDown={onHeaderPointerDown} title="Glisser pour déplacer cette fenêtre">
        {icon && <span className="shud-ico" aria-hidden="true">{icon}</span>}
        <h3 className="shud-title">{title}</h3>
        {meta && <span className="shud-meta">{meta}</span>}
        <span className={`shud-dot ${status}`} aria-hidden="true" />
        {floatPos && (
          <button
            type="button"
            className="shud-icon-btn"
            onClick={redock}
            title="Réancrer dans la colonne"
            data-testid={`shud-panel-redock-${key}`}
          >
            <Anchor size={11} />
          </button>
        )}
        <button
          type="button"
          className="shud-icon-btn shud-close"
          onClick={() => hideHudPanel(key)}
          title="Fermer cette fenêtre"
          data-testid={`shud-panel-close-${key}`}
        >
          <X size={12} />
        </button>
      </header>
      <div className="shud-body">{children}</div>
      {floatPos && <div className="shud-resize" onPointerDown={onResizePointerDown} title="Redimensionner" data-testid={`shud-panel-resize-${key}`} />}
    </section>
  );
}

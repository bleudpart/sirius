import { useCallback, useEffect, useRef, useState } from "react";

// Position conservée pendant la session pour retrouver la fenêtre là où on l'a laissée.
const savedOffsets = new Map();
const NO_DRAG = "button, input, textarea, select, a, label, [role='slider'], .modwheel-grid, .infowheel-content, .modwheel-dial";
const KEEP_VISIBLE = 90;

// Fenêtres en roue (modules, centre d'information) : glisser-déposer à la souris et réduction.
// Pendant le glissement, la position est appliquée directement au DOM (une fois par image)
// pour éviter de re-rendre tout le contenu React à chaque mouvement de souris.
export default function useWheelWindow(id) {
  const [offset, setOffset] = useState(() => savedOffsets.get(id) || { x: 0, y: 0 });
  const [minimized, setMinimized] = useState(false);
  const drag = useRef(null);

  useEffect(() => () => document.documentElement.classList.remove("sirius-dragging"), []);

  const onPointerDown = useCallback((e) => {
    if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(NO_DRAG)) return;
    const el = e.currentTarget;
    drag.current = {
      el,
      startX: e.clientX,
      startY: e.clientY,
      base: offset,
      rect: el.getBoundingClientRect(),
      next: offset,
      frame: 0,
    };
    el.setPointerCapture?.(e.pointerId);
    el.classList.add("is-dragging");
    document.documentElement.classList.add("sirius-dragging");
    e.preventDefault();
  }, [offset]);

  const onPointerMove = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dx = Math.min(Math.max(e.clientX - d.startX, KEEP_VISIBLE - d.rect.right), vw - KEEP_VISIBLE - d.rect.left);
    const dy = Math.min(Math.max(e.clientY - d.startY, -d.rect.top), vh - KEEP_VISIBLE - d.rect.top);
    d.next = { x: d.base.x + dx, y: d.base.y + dy };
    if (!d.frame) {
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        d.el.style.translate = `${d.next.x}px ${d.next.y}px`;
      });
    }
  }, []);

  const onPointerUp = useCallback((e) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    d.el.style.translate = `${d.next.x}px ${d.next.y}px`;
    d.el.releasePointerCapture?.(e.pointerId);
    d.el.classList.remove("is-dragging");
    document.documentElement.classList.remove("sirius-dragging");
    savedOffsets.set(id, d.next);
    setOffset(d.next);
  }, [id]);

  const resetPosition = useCallback(() => {
    savedOffsets.delete(id);
    setOffset({ x: 0, y: 0 });
  }, [id]);

  return {
    minimized,
    setMinimized,
    windowProps: {
      style: { translate: `${offset.x}px ${offset.y}px` },
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onDoubleClick: (e) => { if (!e.target.closest(NO_DRAG)) resetPosition(); },
    },
  };
}
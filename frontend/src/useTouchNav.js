// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef } from "react";

// Gestes tactiles globaux (tablette/mobile) : balayage gauche/droite + pincement 2 doigts.
// handlers : { onSwipeLeft, onSwipeRight, onPinchIn, onPinchOut } — toujours à jour via ref.
export default function useTouchNav(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    let sx = 0, sy = 0, st = 0, tracking = false, multi = false;
    let d0 = 0, pinchFired = false;

    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const skip = (el) =>
      el && el.closest &&
      el.closest(
        "input, textarea, select, button, a, video, " +
        ".card-drag-grip, .zc-section-title, .web-window, .task-window, .sirius-display, " +
        ".sirius-progress, .sp-journal, .modmenu, .setup-screen, [data-hud-panel], .float-card"
      );

    const onStart = (e) => {
      if (e.touches.length === 2) {
        multi = true;
        pinchFired = false;
        d0 = dist(e.touches);
        return;
      }
      if (e.touches.length !== 1) return;
      if (skip(e.target)) { tracking = false; return; }
      tracking = true;
      multi = false;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      st = Date.now();
    };

    const onMove = (e) => {
      if (multi && e.touches.length === 2 && !pinchFired && d0 > 0) {
        const r = dist(e.touches) / d0;
        if (r < 0.72) { pinchFired = true; if (ref.current.onPinchIn) ref.current.onPinchIn(); }
        else if (r > 1.38) { pinchFired = true; if (ref.current.onPinchOut) ref.current.onPinchOut(); }
      }
    };

    const onEnd = (e) => {
      if (multi) { if (e.touches.length === 0) multi = false; return; }
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - sx, dy = t.clientY - sy, dt = Date.now() - st;
      if (dt > 650 || Math.abs(dx) < 90 || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (dx < 0) { if (ref.current.onSwipeLeft) ref.current.onSwipeLeft(); }
      else if (ref.current.onSwipeRight) ref.current.onSwipeRight();
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
    };
  }, []);
}

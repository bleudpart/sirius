// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Éclat au survol : fines étincelles d'or quand la souris effleure le noyau ou le gardien.
import { useEffect, useRef } from "react";

export default function GoldSparkles() {
  const layerRef = useRef(null);

  useEffect(() => {
    const layer = layerRef.current;
    let last = 0;
    const inRect = (r, x, y) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

    const spawn = (x, y) => {
      const n = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) {
        const s = document.createElement("span");
        s.className = "gold-sparkle";
        const size = 3 + Math.random() * 5;
        s.style.width = s.style.height = `${size}px`;
        s.style.left = `${x + (Math.random() - 0.5) * 34}px`;
        s.style.top = `${y + (Math.random() - 0.5) * 34}px`;
        s.style.setProperty("--dx", `${(Math.random() - 0.5) * 26}px`);
        s.style.setProperty("--dy", `${-14 - Math.random() * 30}px`);
        s.style.animationDuration = `${0.55 + Math.random() * 0.5}s`;
        layer.appendChild(s);
        s.addEventListener("animationend", () => s.remove());
      }
    };

    const onMove = (e) => {
      const now = performance.now();
      if (now - last < 55) return;
      last = now;
      const { clientX: x, clientY: y } = e;
      const core = document.querySelector(".core-quote-zone");
      const guardian = document.querySelector(".antique-guardian");
      if (inRect(core && core.getBoundingClientRect(), x, y) ||
          inRect(guardian && guardian.getBoundingClientRect(), x, y)) {
        spawn(x, y);
      }
    };

    document.addEventListener("mousemove", onMove, { passive: true });
    return () => document.removeEventListener("mousemove", onMove);
  }, []);

  return <div ref={layerRef} className="gold-sparkle-layer" data-testid="gold-sparkle-layer" aria-hidden="true" />;
}

// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useEffect } from "react";

// Scène holographique : particules stellaires d'ambiance (mains et éclairs supprimés à la demande de l'utilisateur)
export default function HoloScene({ pulseRef, active }) {
  const canvasRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    let raf, running = true;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const pickStarColor = () => {
      const r = Math.random();
      if (r < 0.42) return "255,150,40";   // orange chaud
      if (r < 0.70) return "255,205,90";   // doré
      if (r < 0.84) return "0,220,255";    // cyan
      if (r < 0.93) return "170,80,255";   // violet
      if (r < 0.98) return "255,255,255";  // blanc
      return "80,255,140";                 // vert
    };
    const spriteCache = {};
    const getSprite = (rgb) => {
      if (spriteCache[rgb]) return spriteCache[rgb];
      const s = document.createElement("canvas");
      s.width = s.height = 32;
      const c = s.getContext("2d");
      const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, "rgba(255,255,255,0.95)");
      g.addColorStop(0.22, `rgba(${rgb},0.9)`);
      g.addColorStop(0.55, `rgba(${rgb},0.28)`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      c.fillStyle = g;
      c.fillRect(0, 0, 32, 32);
      spriteCache[rgb] = s;
      return s;
    };
    const particles = Array.from({ length: 750 }, () => {
      const big = Math.random() < 0.12;
      return {
        x: Math.random(), y: Math.random(),
        d: big ? 14 + Math.random() * 18 : 4 + Math.random() * 8,
        c: pickStarColor(),
        a: big ? 0.6 + Math.random() * 0.4 : 0.25 + Math.random() * 0.5,
        tw: 0.6 + Math.random() * 2.4,
        ph: Math.random() * Math.PI * 2,
        pu: Math.random() < 0.4 ? 0.3 : 0.1,
        vx: (Math.random() - 0.5) * 0.00022,
        vy: (Math.random() - 0.5) * 0.00022,
      };
    });

    let t = 0, lastTs = 0;
    const loop = (ts) => {
      if (!running) return;
      if (ts && ts - lastTs < 33) { raf = requestAnimationFrame(loop); return; }
      lastTs = ts || 0;
      t += 0.016;
      const w = window.innerWidth, h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      const pulse = pulseRef?.current ?? 0.5;
      const boost = activeRef.current ? 1 + pulse * 0.25 : 1;
      particles.forEach((p) => {
        p.x = (p.x + p.vx + 1) % 1;
        p.y = (p.y + p.vy + 1) % 1;
        const tw = 0.55 + 0.45 * Math.sin(t * p.tw + p.ph);
        const d = p.d * (1 + p.pu * Math.sin(t * p.tw * 0.7 + p.ph));
        ctx.globalAlpha = Math.min(1, p.a * tw * boost);
        ctx.drawImage(getSprite(p.c), p.x * w - d / 2, p.y * h - d / 2, d, d);
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [pulseRef]);

  return (
    <div className="holo-scene" data-testid="holo-scene">
      <canvas ref={canvasRef} className="holo-canvas" />
    </div>
  );
}

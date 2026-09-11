// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Ambiance « Sanctuaire Profond » : bokeh doré multi-profondeur, poussière d'or ascendante,
// nappes de brume et onde vocale cyan réactive qui se dissout en poussière d'or.
import { useRef, useEffect } from "react";

export default function SanctuaryAmbience({ statusPulseRef, eco = false }) {
  const canvasRef = useRef(null);

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

    const mk = (n, f) => Array.from({ length: eco ? Math.ceil(n / 2) : n }, f);
    // Bokeh doré — 3 couches de profondeur (grands flous lents → petits nets)
    const bokeh = mk(38, () => {
      const depth = Math.random();
      return {
        x: Math.random(), y: Math.random(),
        r: 6 + depth * 46,
        a: 0.05 + (1 - depth) * 0.16,
        vx: (Math.random() - 0.5) * 0.00008 * (1 + depth),
        vy: -0.00003 - Math.random() * 0.00006,
        tw: 0.2 + Math.random() * 0.5,
        ph: Math.random() * Math.PI * 2,
        warm: Math.random() < 0.85,
      };
    });
    // Poussière d'or ascendante
    const dust = mk(110, () => ({
      x: Math.random(), y: Math.random(),
      s: 0.6 + Math.random() * 1.8,
      a: 0.25 + Math.random() * 0.5,
      vy: 0.00012 + Math.random() * 0.00028,
      sway: 6 + Math.random() * 22,
      ph: Math.random() * Math.PI * 2,
    }));
    // Nappes de brume
    const fog = mk(4, (v, i) => ({
      x: Math.random(), y: 0.3 + Math.random() * 0.5,
      r: 0.35 + Math.random() * 0.3,
      a: 0.045 + Math.random() * 0.035,
      vx: (Math.random() - 0.5) * 0.00004,
    }));

    const bokehSprite = (() => {
      const s = document.createElement("canvas");
      s.width = s.height = 64;
      const c = s.getContext("2d");
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,225,150,0.9)");
      g.addColorStop(0.45, "rgba(216,184,117,0.5)");
      g.addColorStop(1, "rgba(216,184,117,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
      return s;
    })();

    let t = 0, lastTs = 0;
    const loop = (ts) => {
      if (!running) return;
      if (ts && ts - lastTs < 33) { raf = requestAnimationFrame(loop); return; }
      lastTs = ts || 0;
      t += 0.016;
      const w = window.innerWidth, h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);

      // Brume
      fog.forEach((f) => {
        f.x = (f.x + f.vx + 1) % 1;
        const g = ctx.createRadialGradient(f.x * w, f.y * h, 0, f.x * w, f.y * h, f.r * w);
        g.addColorStop(0, `rgba(215,175,90,${f.a})`);
        g.addColorStop(1, "rgba(215,175,90,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      });

      ctx.globalCompositeOperation = "lighter";

      // Bokeh
      bokeh.forEach((b) => {
        b.x = (b.x + b.vx + 1) % 1;
        b.y = (b.y + b.vy + 1) % 1;
        const tw = 0.6 + 0.4 * Math.sin(t * b.tw + b.ph);
        ctx.globalAlpha = b.a * tw;
        const d = b.r * 2;
        ctx.drawImage(bokehSprite, b.x * w - b.r, b.y * h - b.r, d, d);
      });

      // Poussière d'or
      dust.forEach((p) => {
        p.y -= p.vy;
        if (p.y < -0.02) { p.y = 1.02; p.x = Math.random(); }
        const x = p.x * w + Math.sin(t * 0.6 + p.ph) * p.sway;
        ctx.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(t * 1.4 + p.ph));
        ctx.fillStyle = "rgba(255,215,120,1)";
        ctx.beginPath();
        ctx.arc(x, p.y * h, p.s, 0, Math.PI * 2);
        ctx.fill();
      });

      // (liseré vocal cyan supprimé à la demande de l'utilisateur)

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
  }, [statusPulseRef, eco]);

  return <canvas ref={canvasRef} className="sanctuary-ambience" data-testid="sanctuary-ambience" />;
}

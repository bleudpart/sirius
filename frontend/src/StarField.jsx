// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef } from "react";

export default function StarField() {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    const x = c.getContext("2d");
    let raf, running = true, t = 0;
    const resize = () => { c.width = window.innerWidth; c.height = window.innerHeight; };
    resize();
    window.addEventListener("resize", resize);
    const COLORS = ["255,150,40", "255,205,90", "0,220,255", "170,80,255", "255,255,255"];
    const stars = Array.from({ length: 130 }, () => ({
      x: Math.random(), y: Math.random(),
      r: Math.random() < 0.12 ? 1.6 + Math.random() * 1.6 : 0.4 + Math.random() * 1,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
      a: 0.15 + Math.random() * 0.45, tw: 0.6 + Math.random() * 2, ph: Math.random() * Math.PI * 2,
    }));
    const loop = () => {
      if (!running) return;
      t += 0.016;
      x.clearRect(0, 0, c.width, c.height);
      stars.forEach((s) => {
        const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph);
        x.fillStyle = `rgba(${s.c},${(s.a * tw).toFixed(3)})`;
        x.beginPath();
        x.arc(s.x * c.width, s.y * c.height, s.r, 0, Math.PI * 2);
        x.fill();
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} className="prime-stars" />;
}

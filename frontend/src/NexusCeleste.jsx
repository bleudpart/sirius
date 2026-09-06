// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { X, Orbit, Radio, GaugeCircle, Waves } from "lucide-react";
import StarField from "@/StarField";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

const NODES = [
  { id: "cortex", name: "ZEUS CORTEX", color: "#e3c98e" },
  { id: "prime", name: "SIRIUS PRIME", color: "#91e6f2" },
  { id: "oracle", name: "ORACLE DIVIN", color: "#a855f7" },
  { id: "pantheon", name: "PANTHEON", color: "#ff9500" },
  { id: "dev", name: "COMPAGNON DEV", color: "#91e6f2" },
  { id: "files", name: "FICHIERS", color: "#38bdf8" },
];

export default function NexusCeleste({ onClose }) {
  const graphRef = useRef(null);
  const [latency, setLatency] = useState(null);
  const [levels, setLevels] = useState(NODES.map(() => 70 + Math.random() * 28));
  const [flux, setFlux] = useState(240);
  const [sync, setSync] = useState(96);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const t0 = performance.now();
      try {
        await fetch(`${API}/`);
        if (alive) setLatency(Math.round(performance.now() - t0));
      } catch {
        if (alive) setLatency(null);
      }
    };
    ping();
    const id = setInterval(ping, 5000);
    const id2 = setInterval(() => {
      setLevels((ls) => ls.map((v) => Math.max(55, Math.min(100, v + (Math.random() - 0.5) * 7))));
      setFlux((f) => Math.max(80, Math.min(900, Math.round(f + (Math.random() - 0.5) * 90))));
      setSync((s) => Math.max(88, Math.min(100, +(s + (Math.random() - 0.5) * 1.4).toFixed(1))));
    }, 1400);
    return () => { alive = false; clearInterval(id); clearInterval(id2); };
  }, []);

  useEffect(() => {
    const c = graphRef.current;
    const x = c.getContext("2d");
    let raf, running = true, t = 0;
    const resize = () => { c.width = c.clientWidth * 1.5; c.height = c.clientHeight * 1.5; x.setTransform(1.5, 0, 0, 1.5, 0, 0); };
    resize();
    window.addEventListener("resize", resize);

    const loop = () => {
      if (!running) return;
      t += 0.016;
      const w = c.clientWidth, h = c.clientHeight;
      x.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2;
      const R = Math.min(w, h) * 0.36;

      const pos = NODES.map((n, i) => {
        const a = (i / NODES.length) * Math.PI * 2 - Math.PI / 2 + t * 0.06;
        return { ...n, x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R };
      });

      // Liens + impulsions
      pos.forEach((n, i) => {
        const grad = x.createLinearGradient(cx, cy, n.x, n.y);
        grad.addColorStop(0, "rgba(145,230,242,0.55)");
        grad.addColorStop(1, n.color);
        x.strokeStyle = grad;
        x.lineWidth = 1.2;
        x.shadowColor = n.color;
        x.shadowBlur = 8;
        x.beginPath();
        x.moveTo(cx, cy);
        x.lineTo(n.x, n.y);
        x.stroke();
        const p = (t * (0.35 + i * 0.07)) % 1;
        const px = cx + (n.x - cx) * p, py = cy + (n.y - cy) * p;
        x.fillStyle = "#ffffff";
        x.shadowColor = n.color;
        x.shadowBlur = 12;
        x.beginPath();
        x.arc(px, py, 2.6, 0, Math.PI * 2);
        x.fill();
        // Nœud
        x.fillStyle = n.color;
        x.beginPath();
        x.arc(n.x, n.y, 7 + Math.sin(t * 2 + i) * 1.5, 0, Math.PI * 2);
        x.fill();
        x.shadowBlur = 0;
        x.fillStyle = "#cdeefb";
        x.font = "8px Orbitron";
        x.textAlign = "center";
        x.fillText(n.name, n.x, n.y + 20);
      });

      // Cœur SIRIUS
      const pr = 16 + Math.sin(t * 2.4) * 3;
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, pr * 2.4);
      g.addColorStop(0, "rgba(255,255,255,0.95)");
      g.addColorStop(0.4, "rgba(145,230,242,0.8)");
      g.addColorStop(1, "rgba(145,230,242,0)");
      x.fillStyle = g;
      x.beginPath();
      x.arc(cx, cy, pr * 2.4, 0, Math.PI * 2);
      x.fill();
      x.fillStyle = "#eafaff";
      x.font = "10px Orbitron";
      x.textAlign = "center";
      x.fillText("ΣIRIUS", cx, cy + 3);

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  return (
    <div className="prime-screen" data-testid="nexus-panel">
      <StarField />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><Orbit size={20} /> NEXUS CÉLESTE</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="nexus-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">CARTE DES CONNEXIONS INTER-MODULES</div>

      <div className="prime-grid nexus-grid">
        <section className="prime-card nexus-graph-card" data-testid="nexus-graph">
          <div className="zc-section-title"><Orbit size={12} style={{ marginRight: 6 }} />RÉSEAU NEURAL DES MODULES</div>
          <canvas ref={graphRef} className="nexus-canvas" />
        </section>

        <div className="nexus-side">
          <section className="prime-card" data-testid="nexus-levels">
            <div className="zc-section-title"><Waves size={12} style={{ marginRight: 6 }} />NIVEAU DE CONNEXION</div>
            {NODES.map((n, i) => (
              <div className="zc-bar-row" key={n.id}>
                <span className="prime-intent-name">{n.name}</span>
                <div className="zc-bar-track"><div className="zc-bar-fill" style={{ width: `${levels[i]}%`, background: n.color, boxShadow: `0 0 8px ${n.color}` }} /></div>
                <b className="prime-intent-count">{Math.round(levels[i])}%</b>
              </div>
            ))}
          </section>

          <section className="prime-card" data-testid="nexus-metrics">
            <div className="zc-section-title"><GaugeCircle size={12} style={{ marginRight: 6 }} />MÉTRIQUES DU NEXUS</div>
            <div className="zc-kv-row">
              <div className="zc-kv"><span><Radio size={10} /> LATENCE NOYAU</span><b data-testid="nexus-latency">{latency != null ? `${latency} ms` : "—"}</b></div>
              <div className="zc-kv"><span>FLUX DE DONNÉES</span><b>{flux} u/s</b></div>
            </div>
            <div className="zc-kv-row" style={{ marginTop: 10 }}>
              <div className="zc-kv"><span>SYNCHRONISATION</span><b>{sync}%</b></div>
              <div className="zc-kv"><span>ÉTAT DU NEXUS</span><b style={{ color: "#91e6f2" }}>STABLE</b></div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

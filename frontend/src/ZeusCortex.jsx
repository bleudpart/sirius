// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useRef, useState } from "react";
import { X, Send, BrainCircuit } from "lucide-react";
import StarField from "@/StarField";

function Corners() {
  return (
    <>
      <span className="zc-corner tl" /><span className="zc-corner tr" />
      <span className="zc-corner bl" /><span className="zc-corner br" />
    </>
  );
}

function RingGauge({ label, value, color, testid }) {
  const C = 2 * Math.PI * 34;
  return (
    <div className="zc-ring" data-testid={testid}>
      <svg viewBox="0 0 84 84" width="76" height="76">
        <circle cx="42" cy="42" r="34" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
        <circle
          cx="42" cy="42" r="34" fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - value / 100)}
          transform="rotate(-90 42 42)"
          style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: "stroke-dashoffset 0.9s ease" }}
        />
        <text x="42" y="48" textAnchor="middle" fill="#eafaff" fontSize="17" fontFamily="Orbitron">{Math.round(value)}</text>
      </svg>
      <div className="zc-ring-label">{label}</div>
    </div>
  );
}

const SUBSYSTEMS = [
  { name: "LOGIQUE", key: "logique", color: "#91e6f2" },
  { name: "LANGAGE", key: "langage", color: "#ff9500" },
  { name: "VISION", key: "vision", color: "#a855f7" },
  { name: "INTUITION", key: "intuition", color: "#91e6f2" },
];
const MODULES = [
  { name: "Oracle Divin", on: true },
  { name: "Sirius Prime", on: true },
  { name: "Pantheon System", on: true },
  { name: "Nexus Céleste", on: true },
];
const API = process.env.REACT_APP_BACKEND_URL;

export default function ZeusCortex({ onClose, onAsk, answer, speaking }) {
  const waveRef = useRef(null);
  const oscRef = useRef(null);
  const sinRef = useRef(null);
  const actRef = useRef(null);
  const [q, setQ] = useState("");
  const [stats, setStats] = useState({ cog: 0, mem: 0, ms: 0, temp: 0, verifL: 0, verifR: 0, link: 0, c1: 0, c2: 0 });
  const [totals, setTotals] = useState(null);
  const [subs, setSubs] = useState(null);

  // Statistiques réelles d'usage de Sirius (mémoire locale + système)
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await fetch(`${API}/api/cortex/stats`).then((r) => r.json());
        if (!alive) return;
        setStats({
          cog: d.activite_cognitive,
          mem: d.charge_memoire,
          ms: d.traitement_ms,
          temp: +(36 + d.cpu * 0.18).toFixed(1),
          verifL: d.ram,
          verifR: d.disque,
          link: Math.min(100, Math.round(55 + d.totaux.commandes / 15)),
          c1: Math.round(d.cpu),
          c2: Math.round(d.ram),
        });
        setTotals(d.totaux);
        setSubs(d.sous_systemes);
      } catch (e) { /* backend indisponible : on garde les dernières valeurs */ }
    };
    load();
    const id = setInterval(load, 8000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    let raf, running = true, t = 0;
    const bars = Array.from({ length: 26 }, () => Math.random());
    const setup = (c) => {
      if (!c) return null;
      c.width = c.clientWidth * 1.5;
      c.height = c.clientHeight * 1.5;
      const x = c.getContext("2d");
      x.setTransform(1.5, 0, 0, 1.5, 0, 0);
      return x;
    };
    const w1 = setup(waveRef.current), o1 = setup(oscRef.current);
    const s1 = setup(sinRef.current), a1 = setup(actRef.current);

    const line = (x, cw, ch, fn, color, lw = 1.6) => {
      x.clearRect(0, 0, cw, ch);
      x.strokeStyle = color;
      x.lineWidth = lw;
      x.shadowColor = color;
      x.shadowBlur = 8;
      x.beginPath();
      for (let i = 0; i <= cw; i += 2) {
        const y = fn(i);
        i === 0 ? x.moveTo(i, y) : x.lineTo(i, y);
      }
      x.stroke();
    };

    const loop = () => {
      if (!running) return;
      t += 0.045;
      if (w1) {
        const cw = waveRef.current.clientWidth, ch = waveRef.current.clientHeight;
        line(w1, cw, ch, (i) => ch / 2
          + Math.sin(i * 0.06 + t * 2.4) * ch * 0.16
          + Math.sin(i * 0.19 + t * 4.1) * ch * 0.10
          + Math.sin(i * 0.42 + t * 7.3) * ch * 0.05, "#91e6f2");
      }
      if (o1) {
        const cw = oscRef.current.clientWidth, ch = oscRef.current.clientHeight;
        line(o1, cw, ch, (i) => {
          const spike = Math.abs(((i + t * 90) % 70) - 35) < 3 ? (Math.random() - 0.5) * ch * 0.8 : 0;
          return ch / 2 + Math.sin(i * 0.3 + t * 6) * ch * 0.08 + spike;
        }, "#7CFC00", 1.3);
      }
      if (s1) {
        const cw = sinRef.current.clientWidth, ch = sinRef.current.clientHeight;
        line(s1, cw, ch, (i) => ch / 2 + Math.sin(i * 0.08 + t * 3) * ch * 0.34, "#ff9500");
      }
      if (a1) {
        const cw = actRef.current.clientWidth, ch = actRef.current.clientHeight;
        a1.clearRect(0, 0, cw, ch);
        const bw = cw / bars.length;
        bars.forEach((b, i) => {
          bars[i] = Math.max(0.08, Math.min(1, b + (Math.random() - 0.5) * 0.08));
          a1.fillStyle = "rgba(145,230,242,0.75)";
          a1.shadowColor = "#91e6f2";
          a1.shadowBlur = 5;
          a1.fillRect(i * bw + 1, ch * (1 - bars[i]), bw - 2, ch * bars[i]);
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, []);

  const ask = (e) => {
    e.preventDefault();
    const v = q.trim();
    if (!v) return;
    onAsk(v);
    setQ("");
  };

  return (
    <div className="zeus-screen" data-testid="zeus-cortex-panel">
      <StarField />
      <div className={`zeus-face-wrap ${speaking ? "speaking" : ""}`}>
        <img src="/holo/zeus.jpg" alt="Zeus" className="zeus-face" draggable={false} />
        <span className="zeus-mouth-glow" />
      </div>
      <div className="zeus-vignette" />

      <header className="zeus-head">
        <div className="zeus-title font-divine"><BrainCircuit size={20} /> ZEUS CORTEX</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="zeus-close-btn"><X size={18} /></button>
      </header>

      {/* Panneau gauche : données cérébrales */}
      <aside className="zeus-panel left" data-testid="zeus-left-panel">
        <Corners />
        <div className="zc-section-title">CANAL DE DONNÉES</div>
        <canvas ref={waveRef} className="zc-canvas" />
        <div className="zc-rings">
          <RingGauge label="ACTIVITÉ COGNITIVE" value={stats.cog} color="#91e6f2" testid="zeus-gauge-cog" />
          <RingGauge label="CHARGE MÉMOIRE" value={stats.mem} color="#ff9500" testid="zeus-gauge-mem" />
        </div>
        {totals && (
          <div className="zc-kv-row" data-testid="zeus-totals">
            <div className="zc-kv"><span>CMD AUJOURD'HUI</span><b>{totals.aujourdhui}</b></div>
            <div className="zc-kv"><span>CMD TOTALES</span><b>{totals.commandes}</b></div>
            <div className="zc-kv"><span>SOUVENIRS</span><b>{totals.souvenirs}</b></div>
          </div>
        )}
        <div className="zc-section-title">SUIVI DES PARAMÈTRES</div>
        {SUBSYSTEMS.map((s) => (
          <div className="zc-bar-row" key={s.name}>
            <span>{s.name}</span>
            <div className="zc-bar-track">
              <div className="zc-bar-fill" style={{ width: `${subs ? Math.min(100, subs[s.key]) : 8}%`, background: s.color, boxShadow: `0 0 8px ${s.color}`, transition: "width 0.9s ease" }} />
            </div>
          </div>
        ))}
        <div className="zc-section-title">ANALYSE DES SIGNAUX</div>
        <canvas ref={oscRef} className="zc-canvas" />
        <div className="zc-section-title">VÉRIFICATION SYSTÈME</div>
        <div className="zc-bar-track big">
          <div className="zc-bar-fill" style={{ width: `${stats.verifL}%`, background: "#91e6f2", boxShadow: "0 0 10px #91e6f2" }} />
        </div>
        <div className="zc-kv-row">
          <div className="zc-kv"><span>TRAITEMENT</span><b data-testid="zeus-speed">{stats.ms} ms</b></div>
          <div className="zc-kv"><span>TEMP. NOYAU</span><b data-testid="zeus-temp">{stats.temp}°C</b></div>
        </div>
      </aside>

      {/* Panneau droit : contrôle système */}
      <aside className="zeus-panel right" data-testid="zeus-right-panel">
        <Corners />
        <div className="zc-section-title">CONTRÔLE SÉQUENTIEL</div>
        <div className="zc-rings">
          <RingGauge label="CPU" value={stats.c1} color="#f43f5e" testid="zeus-cntrl-a" />
          <RingGauge label="RAM" value={stats.c2} color="#38bdf8" testid="zeus-cntrl-b" />
        </div>
        <canvas ref={sinRef} className="zc-canvas" />
        <div className="zc-section-title">VÉRIFICATION</div>
        <div className="zc-bar-track big">
          <div className="zc-bar-fill" style={{ width: `${stats.verifR}%`, background: "#ff9500", boxShadow: "0 0 10px #ff9500" }} />
        </div>
        <div className="zc-section-title">PROTOCOLE ZEUS-CORE — MODULES</div>
        {MODULES.map((m) => (
          <div className="zc-module-row" key={m.name} data-testid={`zeus-module-${m.name.split(" ")[0].toLowerCase()}`}>
            <span className={`zc-dot ${m.on ? "on" : "off"}`} />
            <span className="font-divine zc-module-name">{m.name}</span>
            <b>{m.on ? "ACTIF" : "VEILLE"}</b>
          </div>
        ))}
        <div className="zc-section-title">CONNEXION INTER-MODULES</div>
        <div className="zc-bar-track big">
          <div className="zc-bar-fill" style={{ width: `${stats.link}%`, background: "#a855f7", boxShadow: "0 0 10px #a855f7" }} />
        </div>
        <div className="zc-section-title">ACTIVITÉ RÉCENTE</div>
        <canvas ref={actRef} className="zc-canvas" />
      </aside>

      {/* Réponse + saisie */}
      <div className="zeus-bottom">
        {answer && <div className="zeus-answer" data-testid="zeus-answer">{answer}</div>}
        <form className="cmd-bar zeus-cmd" onSubmit={ask} data-testid="zeus-ask-form">
          <span className="cmd-prompt font-divine">SIRIUS&gt;</span>
          <input
            className="cmd-input"
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Posez votre question directement à Sirius..."
            data-testid="zeus-ask-input"
          />
          <button type="submit" className="cmd-send" data-testid="zeus-ask-send"><Send size={15} /></button>
        </form>
      </div>
    </div>
  );
}

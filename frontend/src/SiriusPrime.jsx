// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Sparkles, BookOpenText, Map, Database, Lightbulb, Trash2, Pencil, Check } from "lucide-react";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const DAYS = ["LUN", "MAR", "MER", "JEU", "VEN", "SAM", "DIM"];
const BAR_COLORS = ["#22d3ee", "#ff9500", "#a855f7", "#34d399", "#f43f5e", "#ffe600"];

function ConfidenceRing({ value }) {
  const C = 2 * Math.PI * 52;
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" data-testid="prime-confidence">
      <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
      <circle
        cx="60" cy="60" r="52" fill="none" stroke="#22d3ee" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={C * (1 - value / 100)} transform="rotate(-90 60 60)"
        style={{ filter: "drop-shadow(0 0 8px #22d3ee)", transition: "stroke-dashoffset 1s ease" }}
      />
      <text x="60" y="66" textAnchor="middle" fill="#eafaff" fontSize="26" fontFamily="Orbitron">{value}%</text>
    </svg>
  );
}

export default function SiriusPrime({ onClose }) {
  const [data, setData] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState("");
  const hoursRef = useRef(null);
  const starsRef = useRef(null);

  useEffect(() => {
    const c = starsRef.current;
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
      a: 0.15 + Math.random() * 0.45,
      tw: 0.6 + Math.random() * 2,
      ph: Math.random() * Math.PI * 2,
    }));
    const loop = () => {
      if (!running) return;
      t += 0.016;
      const w = c.width, h = c.height;
      x.clearRect(0, 0, w, h);
      stars.forEach((s) => {
        const tw = 0.55 + 0.45 * Math.sin(t * s.tw + s.ph);
        x.fillStyle = `rgba(${s.c},${(s.a * tw).toFixed(3)})`;
        x.beginPath();
        x.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
        x.fill();
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/prime/overview`);
      setData(await r.json());
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!data || !hoursRef.current) return;
    const c = hoursRef.current;
    c.width = c.clientWidth * 1.5;
    c.height = c.clientHeight * 1.5;
    const x = c.getContext("2d");
    x.setTransform(1.5, 0, 0, 1.5, 0, 0);
    const cw = c.clientWidth, ch = c.clientHeight;
    const hours = data.habits.hours;
    const max = Math.max(1, ...hours);
    const bw = cw / 24;
    hours.forEach((v, i) => {
      const h = (v / max) * (ch - 16);
      x.fillStyle = v > 0 ? "rgba(34,211,238,0.85)" : "rgba(255,255,255,0.07)";
      x.shadowColor = "#22d3ee";
      x.shadowBlur = v > 0 ? 6 : 0;
      x.fillRect(i * bw + 2, ch - 14 - Math.max(2, h), bw - 4, Math.max(2, h));
      if (i % 6 === 0) {
        x.shadowBlur = 0;
        x.fillStyle = "#6f95a6";
        x.font = "8px Orbitron";
        x.fillText(`${i}H`, i * bw + 2, ch - 3);
      }
    });
  }, [data]);

  const delFact = async (id) => {
    await fetch(`${API}/local-memory/${id}`, { method: "DELETE" });
    load();
  };
  const saveFact = async (id) => {
    const v = editText.trim();
    if (v) await fetch(`${API}/local-memory/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: v }),
    });
    setEditId(null);
    load();
  };

  const wdMax = data ? Math.max(1, ...data.habits.weekdays) : 1;

  return (
    <div className="prime-screen" data-testid="sirius-prime-panel">
      <canvas ref={starsRef} className="prime-stars" />
      <header className="zeus-head">
        <div className="prime-title font-divine"><Sparkles size={20} /> SIRIUS PRIME</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="prime-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">MOTEUR DE MÉMOIRE &amp; D'APPRENTISSAGE — {data ? `${data.totals.events} COMMANDES · ${data.totals.facts} SOUVENIRS · ${data.totals.days} JOURS D'OBSERVATION` : "CHARGEMENT..."}</div>

      <div className="prime-grid">
        {/* Journal d'apprentissage */}
        <section className="prime-card" data-testid="prime-journal">
          <div className="zc-section-title"><BookOpenText size={12} style={{ marginRight: 6 }} />JOURNAL D'APPRENTISSAGE — AUJOURD'HUI</div>
          <div className="prime-scroll">
            {data && data.journal.length === 0 && <div className="memory-empty">Rien d'appris aujourd'hui pour l'instant. Chaque commande m'entraîne.</div>}
            {data && data.journal.map((j, i) => (
              <div className="prime-journal-row" key={i}>
                <span className="prime-time">{j.time}</span>
                <span className={`prime-journal-text ${j.kind}`}>{j.text}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Carte des habitudes */}
        <section className="prime-card" data-testid="prime-habits">
          <div className="zc-section-title"><Map size={12} style={{ marginRight: 6 }} />CARTE DES HABITUDES</div>
          <div className="prime-hab-label">ACTIVITÉ PAR HEURE</div>
          <canvas ref={hoursRef} className="prime-hours-canvas" />
          <div className="prime-hab-label">ACTIVITÉ PAR JOUR</div>
          <div className="prime-weekdays">
            {data && data.habits.weekdays.map((v, i) => (
              <div className="prime-wd" key={i}>
                <div className="prime-wd-cell" style={{ opacity: 0.15 + 0.85 * (v / wdMax), boxShadow: v > 0 ? "0 0 8px #22d3ee" : "none" }} />
                <span>{DAYS[i]}</span>
              </div>
            ))}
          </div>
          <div className="prime-hab-label">TYPES DE COMMANDES</div>
          {data && data.habits.intents.map((it, i) => (
            <div className="zc-bar-row" key={it.name}>
              <span className="prime-intent-name">{it.name.toUpperCase()}</span>
              <div className="zc-bar-track">
                <div className="zc-bar-fill" style={{
                  width: `${(it.count / Math.max(1, data.habits.intents[0].count)) * 100}%`,
                  background: BAR_COLORS[i % BAR_COLORS.length],
                  boxShadow: `0 0 8px ${BAR_COLORS[i % BAR_COLORS.length]}`,
                }} />
              </div>
              <b className="prime-intent-count">{it.count}</b>
            </div>
          ))}
          {data && data.habits.intents.length === 0 && <div className="memory-empty">Aucun pattern détecté pour l'instant.</div>}
        </section>

        {/* Score + Suggestions */}
        <section className="prime-card" data-testid="prime-suggestions">
          <div className="zc-section-title">SCORE DE CONFIANCE</div>
          <div className="prime-conf-wrap">
            <ConfidenceRing value={data ? data.confidence : 0} />
            <div className="prime-conf-note">FIABILITÉ DES SUGGESTIONS BASÉE SUR {data ? data.totals.events : 0} OBSERVATIONS</div>
          </div>
          <div className="zc-section-title"><Lightbulb size={12} style={{ marginRight: 6 }} />SUGGESTIONS DU JOUR</div>
          {data && data.suggestions.map((s, i) => (
            <div className="prime-sugg" key={i} data-testid={`prime-suggestion-${i}`}>
              <span className="prime-sugg-num">{String(i + 1).padStart(2, "0")}</span>
              <span>{s}</span>
            </div>
          ))}
        </section>

        {/* Gestionnaire de mémoire */}
        <section className="prime-card" data-testid="prime-memories">
          <div className="zc-section-title"><Database size={12} style={{ marginRight: 6 }} />GESTIONNAIRE DE MÉMOIRE</div>
          <div className="prime-scroll">
            {data && data.memories.length === 0 && <div className="memory-empty">Aucun souvenir en base locale.</div>}
            {data && data.memories.map((f) => (
              <div className="memory-item" key={f.id} data-testid={`prime-memory-${f.id}`}>
                <span className={`local-mem-badge ${f.category}`}>{f.category.toUpperCase()}</span>
                {editId === f.id ? (
                  <>
                    <input className="cmd-input prime-edit-input" value={editText} onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveFact(f.id)} autoFocus data-testid="prime-edit-input" />
                    <button className="memory-icon-btn" onClick={() => saveFact(f.id)} data-testid="prime-edit-save"><Check size={15} /></button>
                  </>
                ) : (
                  <>
                    <span className="memory-text">{f.text}</span>
                    <button className="memory-icon-btn" onClick={() => { setEditId(f.id); setEditText(f.text); }} title="Modifier" data-testid={`prime-memory-edit-${f.id}`}><Pencil size={15} /></button>
                    <button className="memory-icon-btn danger" onClick={() => delFact(f.id)} title="Supprimer" data-testid={`prime-memory-delete-${f.id}`}><Trash2 size={15} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

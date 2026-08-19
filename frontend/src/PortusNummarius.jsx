// © 2026 Daniel Partel – SIRIUS Assistant. PORTUS NUMMARIUS# — bourse & marchés (courbes d'évolution).
import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, RefreshCw, Landmark } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

const API = process.env.REACT_APP_BACKEND_URL;
const RANGES = [["1s", "1 SEM"], ["1m", "1 MOIS"], ["3m", "3 MOIS"], ["max", "MAX"]];

const fmtPrice = (v) => (v >= 1000 ? v.toLocaleString("fr-FR", { maximumFractionDigits: 0 }) : v);
const fmtT = (t, type) => {
  const d = type === "crypto" ? new Date(t * 1000) : new Date(t);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
};

function Spark({ data, up }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * 70},${22 - ((v - min) / span) * 20}`).join(" ");
  return (
    <svg width="70" height="24" className="numm-spark">
      <polyline points={pts} fill="none" stroke={up ? "#34d399" : "#f87171"} strokeWidth="1.5" />
    </svg>
  );
}

export default function PortusNummarius({ onClose }) {
  const [assets, setAssets] = useState(null);
  const [errs, setErrs] = useState([]);
  const [sel, setSel] = useState(null);
  const [range, setRange] = useState("1m");
  const [hist, setHist] = useState(null);
  const [loadingHist, setLoadingHist] = useState(false);
  const [err, setErr] = useState("");

  const loadMarket = async () => {
    setErr("");
    try {
      const r = await fetch(`${API}/api/nummarius/market`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Marché indisponible");
      setAssets(data.assets);
      setErrs(data.errors || []);
      if (!sel && data.assets.length) setSel(data.assets[0]);
    } catch (e) { setErr(e.message); }
  };

  useEffect(() => { loadMarket(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!sel) return;
    let dead = false;
    setLoadingHist(true);
    fetch(`${API}/api/nummarius/history/${sel.id}?range=${range}`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.detail); return d; })
      .then((d) => { if (!dead) setHist(d); })
      .catch((e) => { if (!dead) { setHist(null); setErr(e.message); } })
      .finally(() => { if (!dead) setLoadingHist(false); });
    return () => { dead = true; };
  }, [sel, range]);

  const up = hist && hist.points.length > 1 && hist.points[hist.points.length - 1].v >= hist.points[0].v;
  const chartData = hist ? hist.points.map((p) => ({ ...p, d: fmtT(p.t, hist.type) })) : [];

  return (
    <div className="prime-screen" data-testid="nummarius-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><Landmark size={20} /> PORTUS NUMMARIUS — BOURSE & MARCHÉS</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="file-btn" onClick={loadMarket} title="Actualiser" data-testid="nummarius-refresh-btn"><RefreshCw size={13} /></button>
          <button className="setup-close zeus-close" onClick={onClose} data-testid="nummarius-close-btn">✕</button>
        </div>
      </header>
      <div className="gcal-body numm-body">
        <aside className="numm-side">
          <img src="/holo/nummarius.jpg" alt="Portus Nummarius" className="numm-avatar" data-testid="nummarius-avatar" draggable={false} />
          <div className="numm-avatar-caption font-divine">GARDIEN DES MARCHÉS</div>
          <div className="numm-list" data-testid="nummarius-asset-list">
            {assets === null && !err && <div className="admin-loading">Consultation des marchés…</div>}
            {assets && assets.map((a) => (
              <button key={a.id} className={`numm-asset ${sel && sel.id === a.id ? "active" : ""}`}
                onClick={() => setSel(a)} data-testid={`nummarius-asset-${a.id}`}>
                <span className="numm-asset-name">
                  <b>{a.label}</b>
                  <small>{a.type === "crypto" ? "CRYPTO" : "ACTION"}</small>
                </span>
                <Spark data={a.spark} up={a.change >= 0} />
                <span className={`numm-asset-price ${a.change >= 0 ? "up" : "down"}`}>
                  <b>{fmtPrice(a.price)} $</b>
                  <small>{a.change >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />} {a.change >= 0 ? "+" : ""}{a.change}%</small>
                </span>
              </button>
            ))}
          </div>
        </aside>
        <section className="numm-main">
          {err && <div className="auth-error" data-testid="nummarius-error">{err}</div>}
          {errs.length > 0 && <div className="numm-warn" data-testid="nummarius-warnings">{errs.join(" · ")}</div>}
          {sel && (
            <>
              <div className="numm-chart-head">
                <div className="numm-chart-title font-divine" data-testid="nummarius-chart-title">
                  {sel.label} <span className={sel.change >= 0 ? "up" : "down"}>{fmtPrice(sel.price)} $ ({sel.change >= 0 ? "+" : ""}{sel.change}%)</span>
                </div>
                <div className="numm-ranges">
                  {RANGES.map(([k, lbl]) => (
                    <button key={k} className={`numm-range ${range === k ? "active" : ""}`} onClick={() => setRange(k)} data-testid={`nummarius-range-${k}`}>{lbl}</button>
                  ))}
                </div>
              </div>
              <div className="numm-chart" data-testid="nummarius-chart">
                {loadingHist && <div className="admin-loading">Tracé de la courbe…</div>}
                {!loadingHist && hist && (
                  <ResponsiveContainer width="100%" height={340}>
                    <AreaChart data={chartData} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
                      <defs>
                        <linearGradient id="nummFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={up ? "#34d399" : "#f87171"} stopOpacity={0.45} />
                          <stop offset="100%" stopColor={up ? "#34d399" : "#f87171"} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(245,197,66,0.08)" vertical={false} />
                      <XAxis dataKey="d" tick={{ fill: "#8aa2b5", fontSize: 10 }} tickLine={false} axisLine={{ stroke: "rgba(245,197,66,0.25)" }} minTickGap={40} />
                      <YAxis domain={["auto", "auto"]} tick={{ fill: "#8aa2b5", fontSize: 10 }} tickLine={false} axisLine={false} width={62}
                        tickFormatter={(v) => fmtPrice(v)} />
                      <Tooltip contentStyle={{ background: "rgba(5,14,22,0.95)", border: "1px solid rgba(245,197,66,0.5)", borderRadius: 8, fontSize: 12, color: "#ffe9a8" }}
                        formatter={(v) => [`${fmtPrice(v)} $`, sel.label]} labelStyle={{ color: "#7fd4e8" }} />
                      <Area type="monotone" dataKey="v" stroke={up ? "#34d399" : "#f87171"} strokeWidth={2} fill="url(#nummFill)" dot={false} animationDuration={600} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
              <p className="admin-note">Actions : Alpha Vantage (clôtures journalières, mise en cache 6 h). Cryptos : CoinGecko (temps quasi réel).</p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

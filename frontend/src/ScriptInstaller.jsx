// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useState } from "react";
import { X, FileCode2, ScanSearch, Download, Trash2, Loader2, ShieldAlert, History } from "lucide-react";
import { progress } from "@/SiriusProgress";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const RISK_LABEL = { auto: "AUTO", severe: "SÉVÈRE", critical: "CRITIQUE" };

export default function ScriptInstaller({ onClose, onSpeak }) {
  const [tab, setTab] = useState("new");
  const [script, setScript] = useState("");
  const [name, setName] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState("");
  const [installed, setInstalled] = useState([]);

  const loadInstalled = useCallback(async () => {
    try {
      const r = await fetch(`${API}/scripts`);
      setInstalled((await r.json()).scripts || []);
    } catch (_) {}
  }, []);
  useEffect(() => { if (tab === "list") loadInstalled(); }, [tab, loadInstalled]);

  const analyze = async () => {
    setBusy(true); setResult(""); setAnalysis(null); setConfirming(false);
    const pid = progress.start(`ANALYSE — ${(name || "script").toUpperCase().slice(0, 34)}`);
    progress.log(pid, "Envoi du script au moteur d'analyse de sécurité", 25);
    try {
      const r = await fetch(`${API}/scripts/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, name }),
      });
      progress.log(pid, "Évaluation du niveau de risque", 70);
      const d = await r.json();
      if (!r.ok) { progress.error(pid, d.detail || "Analyse impossible"); setResult(d.detail || "Analyse impossible."); setBusy(false); return; }
      setAnalysis(d);
      progress.done(pid, `Analyse terminée — risque ${(d.parameters && d.parameters.riskLevel) || "évalué"}`);
      onSpeak && onSpeak(d.responseText);
    } catch (_) { progress.error(pid, "Backend injoignable"); setResult("Backend injoignable."); }
    setBusy(false);
  };

  const install = async () => {
    if (!analysis) return;
    if (analysis.requiresConfirmation && !confirming) { setConfirming(true); return; }
    setBusy(true);
    const pid = progress.start(`INSTALLATION MODULE — ${(name || "script").toUpperCase().slice(0, 30)}`);
    progress.log(pid, "Préparation de l'installation", 20);
    try {
      progress.log(pid, "Déploiement du script dans SIRIUS", 55);
      const r = await fetch(`${API}/scripts/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, name, confirmed: true, actionToken: analysis.actionToken }),
      });
      const d = await r.json();
      setResult(d.message || "");
      if (d.ok) { progress.done(pid, d.message || "Module installé"); onSpeak && onSpeak(d.message); setAnalysis(null); setScript(""); setName(""); }
      else progress.error(pid, d.message || "Installation refusée");
    } catch (_) { progress.error(pid, "Backend injoignable"); setResult("Backend injoignable."); }
    setBusy(false); setConfirming(false);
  };

  const p = analysis && analysis.parameters;
  return (
    <div className="prime-screen" data-testid="script-installer">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><FileCode2 size={20} /> INSTALLATEUR DE SCRIPTS</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="scripts-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">ANALYSE DE SÉCURITÉ · AUTO / SÉVÈRE / CRITIQUE · JAMAIS EXÉCUTÉ AUTOMATIQUEMENT</div>

      <div className="argus-body">
        <div className="haccp-tabs">
          <button className={`haccp-tab ${tab === "new" ? "active" : ""}`} onClick={() => setTab("new")} data-testid="scripts-tab-new">
            <ScanSearch size={13} /> ANALYSER & INSTALLER
          </button>
          <button className={`haccp-tab ${tab === "list" ? "active" : ""}`} onClick={() => setTab("list")} data-testid="scripts-tab-list">
            <History size={13} /> SCRIPTS INSTALLÉS
          </button>
        </div>

        {tab === "new" && (
          <section className="prime-card argus-wide" data-testid="scripts-new">
            <input
              className="vision-question"
              style={{ marginTop: 0, marginBottom: 8 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom du script (optionnel)"
              data-testid="scripts-name-input"
            />
            <textarea
              className="mm-edit-area"
              style={{ width: "100%", minHeight: 180, background: "rgba(0,18,30,0.9)", border: "1px solid rgba(0,240,255,0.4)", color: "#d5f6ff", fontFamily: "monospace", fontSize: 12, padding: 10, outline: "none", resize: "vertical" }}
              value={script}
              onChange={(e) => { setScript(e.target.value); setAnalysis(null); }}
              placeholder="Collez ici le script à installer (Python, JS, TS, Bash, config, module SIRIUS)..."
              data-testid="scripts-textarea"
            />
            <div className="argus-actions" style={{ marginTop: 10 }}>
              <button className="argus-btn" onClick={analyze} disabled={busy || script.trim().length < 10} data-testid="scripts-analyze-btn">
                {busy ? <Loader2 size={10} className="argus-spin" /> : <ScanSearch size={10} />} ANALYSER
              </button>
              {analysis && (
                <button className={`argus-btn ${confirming ? "confirm" : ""}`} onClick={install} disabled={busy} data-testid="scripts-install-btn">
                  <Download size={10} /> {confirming ? "CONFIRMER L'INSTALLATION" : "INSTALLER"}
                </button>
              )}
              {confirming && (
                <button className="argus-btn ghost" onClick={() => setConfirming(false)} data-testid="scripts-cancel-btn">ANNULER</button>
              )}
            </div>

            {analysis && (
              <div className={`argus-row sev-${p.riskLevel}`} style={{ marginTop: 12 }} data-testid="scripts-analysis">
                <div className="argus-row-head">
                  <span className={`argus-badge sev-${p.riskLevel}`}>
                    {p.riskLevel !== "auto" && <ShieldAlert size={9} />} {RISK_LABEL[p.riskLevel]}
                  </span>
                  <span className="argus-type">{p.scriptType.toUpperCase()}</span>
                  {analysis.actionToken && <span className="argus-badge sev-critical">JETON SERVEUR REQUIS</span>}
                </div>
                <p className="argus-msg">{analysis.responseText}</p>
                <p className="argus-fix">{p.summary}</p>
                <pre className="iw-json" data-testid="scripts-json">{JSON.stringify({ ...analysis, parameters: { ...p, script: `«${p.script.length} caractères»` } }, null, 2)}</pre>
              </div>
            )}
            {result && <p className="argus-result" data-testid="scripts-result">{result}</p>}
          </section>
        )}

        {tab === "list" && (
          <section className="prime-card argus-wide" data-testid="scripts-list">
            {installed.length === 0 && <div className="memory-empty">Aucun script installé.</div>}
            {installed.map((s) => (
              <div className="argus-hist-row" key={s.id}>
                <span className={`argus-badge sev-${s.risk}`}>{RISK_LABEL[s.risk] || s.risk}</span>
                <span className="argus-hist-label">{s.name} ({s.stype}, {s.size} car.)</span>
                <span className="argus-hist-date">{(s.created_at || "").slice(0, 16).replace("T", " ")}</span>
                <button className="mm-icon-btn danger" title="Supprimer"
                  onClick={async () => { await fetch(`${API}/scripts/${s.id}`, { method: "DELETE" }); loadInstalled(); }}
                  data-testid="scripts-delete-btn">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

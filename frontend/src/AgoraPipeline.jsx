// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
import { useEffect, useState, useCallback, useRef } from "react";
import { X, Plus, Trash2, ChevronLeft, ChevronRight, BellRing, TrendingUp, FileText, Receipt, Swords, Send, Award, History, Target, Mail, Download, Euro, Copy, ExternalLink, Loader2, CheckCircle2 } from "lucide-react";
import { speakAsCharacter, cancelSpeech } from "@/voice";
import { ConfirmButton } from "@/ConfirmButton";
import "./AgoraPipeline.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const ACTIVE_STAGES = ["PROSPECTION", "QUALIFICATION", "PROPOSITION", "NÉGOCIATION", "CLOSING"];
const SCENARIOS = ["Objection prix", "Concurrent moins cher", "Pas de besoin identifié", "Décideur absent", "Délai repoussé"];
const euro = (v) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v || 0);
const today = () => new Date().toISOString().slice(0, 10);
const getKeys = () => { try { return JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch (e) { return {}; } };
const getSmtp = () => {
  try {
    const b = JSON.parse(localStorage.getItem("themis_keys")) || {};
    return (b.smtp_host || "").trim()
      ? { host: b.smtp_host.trim(), port: Number(b.smtp_port || 587), user: b.smtp_user || "", password: b.smtp_pass || "", from_email: b.smtp_from || "", from_name: b.smtp_name || "HERMÈS AGORA — SIRIUS" }
      : {};
  } catch (e) { return {}; }
};

// ---- Coaching objections : Hermès Agora joue un prospect difficile ----
function AgoraCoach() {
  const [scenario, setScenario] = useState(SCENARIOS[0]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [debrief, setDebrief] = useState("");
  const [sessions, setSessions] = useState([]);
  const [showHisto, setShowHisto] = useState(false);
  const threadRef = useRef(null);
  const sessionRef = useRef(crypto.randomUUID());

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch(`${API}/agora/coach/history`);
      const d = await r.json();
      if (r.ok) setSessions(d.sessions || []);
    } catch (e) { /* historique indisponible */ }
  }, []);
  useEffect(() => { loadSessions(); }, [loadSessions]);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [history, debrief]);
  useEffect(() => () => cancelSpeech(), []);

  const callCoach = async (hist, mode) => {
    const r = await fetch(`${API}/agora/coach`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ history: hist, scenario, mode, keys: getKeys(), session_id: sessionRef.current }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.reponse) throw new Error(typeof d.detail === "string" ? d.detail : "Coaching indisponible.");
    return d.reponse;
  };

  const start = async () => {
    setBusy(true); setDebrief(""); setHistory([]);
    sessionRef.current = crypto.randomUUID();
    try {
      const rep = await callCoach([], "play");
      setHistory([{ role: "assistant", content: rep }]);
      cancelSpeech(); speakAsCharacter(rep, { profile: "M1" });
    } catch (e) { setHistory([{ role: "assistant", content: e.message }]); }
    setBusy(false);
  };

  const send = async () => {
    const msg = input.trim();
    if (!msg || busy) return;
    const hist = [...history, { role: "user", content: msg }];
    setHistory(hist); setInput(""); setBusy(true);
    try {
      const rep = await callCoach(hist, "play");
      setHistory([...hist, { role: "assistant", content: rep }]);
      cancelSpeech(); speakAsCharacter(rep, { profile: "M1" });
    } catch (e) { setHistory([...hist, { role: "assistant", content: e.message }]); }
    setBusy(false);
  };

  const askDebrief = async () => {
    if (busy || history.length < 2) return;
    setBusy(true);
    try {
      const rep = await callCoach(history, "debrief");
      setDebrief(rep);
      loadSessions();
      cancelSpeech(); speakAsCharacter("Débrief prêt. Note, points forts, axes d'amélioration : tout est à l'écran.", { module: "HERMÈS AGORA#" });
    } catch (e) { setDebrief(e.message); }
    setBusy(false);
  };

  return (
    <div className="ag-coach" data-testid="agora-coach">
      <div className="ag-coach-bar">
        <select value={scenario} onChange={(e) => setScenario(e.target.value)} disabled={busy} data-testid="agora-coach-scenario">
          {SCENARIOS.map((s) => <option key={s}>{s}</option>)}
        </select>
        <button onClick={start} disabled={busy} data-testid="agora-coach-start"><Swords size={13} /> {history.length ? "NOUVEL ENTRAÎNEMENT" : "DÉMARRER"}</button>
        <button onClick={askDebrief} disabled={busy || history.length < 2} data-testid="agora-coach-debrief"><Award size={13} /> DÉBRIEF</button>
        <button className={showHisto ? "on" : ""} onClick={() => setShowHisto(!showHisto)} data-testid="agora-coach-histo-btn"><History size={13} /> HISTORIQUE {sessions.length ? `(${sessions.length})` : ""}</button>
      </div>
      {showHisto && (
        <div className="ag-histo" data-testid="agora-coach-histo">
          {!sessions.length && <div className="ag-coach-hint">Aucune session débriefée pour l'instant.</div>}
          {sessions.length > 1 && (
            <div className="ag-histo-trend" data-testid="agora-coach-trend">
              PROGRESSION : {[...sessions].reverse().map((s, i) => (
                <span key={s.id || i} className="ag-histo-note">{s.note != null ? s.note : "—"}</span>
              ))}
            </div>
          )}
          {sessions.map((s, i) => (
            <details className="ag-histo-item" key={s.id || i} data-testid={`agora-coach-session-${i}`}>
              <summary>
                <b className={`ag-histo-score ${s.note >= 7 ? "good" : s.note >= 5 ? "mid" : "low"}`}>{s.note != null ? `${s.note}/10` : "—"}</b>
                <span>{s.scenario}</span>
                <em>{s.tours} tour{s.tours > 1 ? "s" : ""} · {new Date(s.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</em>
              </summary>
              <pre>{s.debrief}</pre>
            </details>
          ))}
        </div>
      )}
      <div className="ag-coach-thread" ref={threadRef} data-testid="agora-coach-thread">
        {!history.length && <div className="ag-coach-hint">Choisissez un scénario puis DÉMARRER — le prospect ouvre le feu. Défendez votre offre, puis demandez le DÉBRIEF.</div>}
        {history.map((m, i) => (
          <div key={i} className={`ag-msg ${m.role === "user" ? "me" : "prospect"}`} data-testid={`agora-coach-msg-${i}`}>
            <span className="ag-msg-who">{m.role === "user" ? "VOUS" : "PROSPECT"}</span>
            <p>{m.content}</p>
          </div>
        ))}
        {busy && <div className="ag-coach-hint" data-testid="agora-coach-busy">Le prospect réfléchit…</div>}
        {debrief && (
          <div className="ag-debrief" data-testid="agora-coach-debrief-text">
            <span className="ag-msg-who">HERMÈS AGORA — DÉBRIEF</span>
            <pre>{debrief}</pre>
          </div>
        )}
      </div>
      <div className="ag-coach-input">
        <input
          placeholder="Votre réponse au prospect…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          disabled={busy || !history.length}
          data-testid="agora-coach-input"
        />
        <button onClick={send} disabled={busy || !input.trim() || !history.length} data-testid="agora-coach-send"><Send size={14} /></button>
      </div>
    </div>
  );
}

export default function AgoraPipeline({ onClose, onOpenThemis }) {
  const [view, setView] = useState("pipeline");
  const [deals, setDeals] = useState([]);
  const [stages, setStages] = useState([]);
  const [form, setForm] = useState({ nom: "", entreprise: "", email: "", valeur: "", relance: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [objectif, setObjectif] = useState(null);
  const [objEdit, setObjEdit] = useState("");
  const [objEditing, setObjEditing] = useState(false);
  const [relancing, setRelancing] = useState("");

  const loadObjectif = useCallback(async () => {
    try {
      const r = await fetch(`${API}/agora/objectif`);
      const d = await r.json();
      if (r.ok) setObjectif(d);
    } catch (e) { /* objectif indisponible */ }
  }, []);

  const saveObjectif = async () => {
    const montant = parseFloat(objEdit) || 0;
    try {
      const r = await fetch(`${API}/agora/objectif`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ montant }) });
      const d = await r.json();
      if (r.ok) { setObjectif(d); setObjEditing(false); }
    } catch (e) { setErr("Objectif non enregistré."); }
  };

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/agora/deals`);
      const d = await r.json();
      if (r.ok) { setDeals(d.deals || []); setStages(d.stages || []); }
      else setErr("Pipeline injoignable.");
    } catch (e) { setErr("Pipeline injoignable."); }
  }, []);
  useEffect(() => { load(); loadObjectif(); }, [load, loadObjectif]);

  // Paiements Stripe : statut d'encaissement par deal + génération de lien
  const [payStatus, setPayStatus] = useState({});
  const [payOpen, setPayOpen] = useState(null);
  const [payPct, setPayPct] = useState(30);
  const [payLink, setPayLink] = useState(null);
  const [payBusy, setPayBusy] = useState(false);
  const [payMsg, setPayMsg] = useState("");

  const loadPayments = useCallback(async () => {
    try {
      const r = await fetch(`${API}/payments/deals-status`);
      const d = await r.json();
      setPayStatus(d.deals || {});
    } catch (e) { /* hors ligne */ }
  }, []);
  useEffect(() => { loadPayments(); }, [loadPayments]);
  useEffect(() => {
    if (!payLink) return;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${API}/payments/status/${payLink.session_id}`);
        const d = await r.json();
        if (d.payment_status === "paid") {
          setPayMsg("Paiement reçu — Hermès salue votre encaissement.");
          setPayLink(null);
          loadPayments();
        }
      } catch (e) { /* attente */ }
    }, 5000);
    return () => clearInterval(iv);
  }, [payLink, loadPayments]);

  const createPayLink = async (deal) => {
    if (payBusy) return;
    setPayBusy(true); setPayMsg(""); setPayLink(null);
    try {
      const r = await fetch(`${API}/payments/deal-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: deal.id, percent: payPct, origin_url: window.location.origin }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) setPayLink({ url: d.checkout_url, session_id: d.session_id, amount: d.amount });
      else setPayMsg(typeof d.detail === "string" ? d.detail : "Lien de paiement impossible.");
    } catch (e) { setPayMsg("Lien de paiement impossible — backend injoignable."); }
    setPayBusy(false);
  };

  // Historique des encaissements + relances impayés
  const smtpConf = () => {
    let k = {};
    try { k = JSON.parse(localStorage.getItem("sirius_keys")) || {}; } catch (e) { k = {}; }
    if (!(k.smtp_host || "").trim()) return null;
    return { host: k.smtp_host.trim(), port: Number(k.smtp_port || 587), user: k.smtp_user || "", password: k.smtp_pass || "", from_email: k.smtp_from || "", from_name: k.smtp_name || "HERMÈS AGORA — SIRIUS" };
  };
  const [txs, setTxs] = useState([]);
  const [txMsg, setTxMsg] = useState("");
  const autoRemindDone = useRef(false);

  const loadTxs = useCallback(async () => {
    try {
      const r = await fetch(`${API}/payments/transactions`);
      const d = await r.json();
      setTxs(d.transactions || []);
      return d.transactions || [];
    } catch (e) { return []; }
  }, []);

  const remind = useCallback(async (sessionId, silent = false) => {
    const smtp = smtpConf();
    if (!smtp) { if (!silent) setTxMsg("Serveur SMTP non configuré — renseignez-le dans THÉMIS (Réglages)."); return false; }
    try {
      const r = await fetch(`${API}/payments/remind`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, smtp }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { if (!silent) setTxMsg(`Relance envoyée à ${d.to}.`); return true; }
      if (!silent) setTxMsg(typeof d.detail === "string" ? d.detail : "Relance impossible.");
    } catch (e) { if (!silent) setTxMsg("Relance impossible — backend injoignable."); }
    return false;
  }, []);

  // Relance automatique : impayés de plus de 3 jours, jamais relancés, avec email client + SMTP configuré
  useEffect(() => {
    if (view !== "paiements" || autoRemindDone.current) return;
    autoRemindDone.current = true;
    (async () => {
      const list = await loadTxs();
      if (!smtpConf()) return;
      const limit = Date.now() - 3 * 24 * 3600 * 1000;
      const targets = list.filter((t) => t.payment_status === "pending" && !t.reminded_at && t.deal_email && new Date(t.created_at).getTime() < limit);
      let sent = 0;
      for (const t of targets.slice(0, 5)) {
        if (await remind(t.session_id, true)) sent += 1;
      }
      if (sent > 0) { setTxMsg(`Hermès a relancé automatiquement ${sent} impayé${sent > 1 ? "s" : ""} de plus de 3 jours.`); loadTxs(); }
    })();
  }, [view, loadTxs, remind]);

  const downloadReceipt = async (sessionId) => {
    try {
      const r = await fetch(`${API}/payments/receipt/${sessionId}`);
      if (!r.ok) { const d = await r.json().catch(() => ({})); setTxMsg(d.detail || "Reçu indisponible."); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "recu-paiement.pdf"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setTxMsg("Reçu indisponible — backend injoignable."); }
  };

  const addDeal = async () => {
    if (!form.nom.trim()) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API}/agora/deals`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, valeur: parseFloat(form.valeur) || 0 }),
      });
      if (r.ok) { setForm({ nom: "", entreprise: "", email: "", valeur: "", relance: "", note: "" }); await load(); await loadObjectif(); }
      else setErr("Création impossible.");
    } catch (e) { setErr("Création impossible."); }
    setBusy(false);
  };

  const move = async (deal, dir) => {
    const idx = stages.indexOf(deal.etape);
    const next = stages[idx + dir];
    if (!next) return;
    try {
      const r = await fetch(`${API}/agora/deals/${deal.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ etape: next }) });
      if (!r.ok) { setErr("Déplacement impossible."); return; }
      setErr("");
    } catch (e) { setErr("Déplacement impossible — backend injoignable."); return; }
    load(); loadObjectif();
  };

  const del = async (deal) => {
    try {
      const r = await fetch(`${API}/agora/deals/${deal.id}`, { method: "DELETE" });
      if (!r.ok) { setErr("Suppression impossible."); return; }
      setErr("");
    } catch (e) { setErr("Suppression impossible — backend injoignable."); return; }
    load();
  };

  const toThemis = async (deal, kind) => {
    setErr("");
    try {
      const r = await fetch(`${API}/themis/from-deal`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deal_id: deal.id, kind }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.doc) { setErr(typeof d.detail === "string" ? d.detail : "Génération Thémis impossible."); return; }
      cancelSpeech();
      speakAsCharacter(`${kind === "devis" ? "Devis" : "Facture"} ${d.doc.number} transmis à Thémis, monsieur.`, { module: "HERMÈS AGORA#" });
      await load();
      if (onOpenThemis) onOpenThemis();
    } catch (e) { setErr("Génération Thémis impossible — backend injoignable."); }
  };

  const relancer = async (deal) => {
    setErr(""); setRelancing(deal.id);
    try {
      const r = await fetch(`${API}/agora/deals/${deal.id}/relance`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ smtp: getSmtp() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(typeof d.detail === "string" ? d.detail : "Relance impossible."); setRelancing(""); return; }
      cancelSpeech();
      speakAsCharacter(`Relance envoyée à ${d.sent_to}. Prochaine relance programmée dans sept jours, monsieur.`, { module: "HERMÈS AGORA#" });
      await load();
    } catch (e) { setErr("Relance impossible — backend injoignable."); }
    setRelancing("");
  };

  const isLate = (d) => d.relance && d.relance <= today() && !["GAGNÉ", "PERDU"].includes(d.etape);
  const totalActive = deals.filter((d) => ACTIVE_STAGES.includes(d.etape)).reduce((s, d) => s + (d.valeur || 0), 0);
  const totalWon = deals.filter((d) => d.etape === "GAGNÉ").reduce((s, d) => s + (d.valeur || 0), 0);
  const lateCount = deals.filter(isLate).length;

  return (
    <div className="prime-screen agora-screen" data-testid="agora-pipeline">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><TrendingUp size={20} /> HERMÈS AGORA# — {view === "pipeline" ? "PIPELINE DE VENTE" : view === "coach" ? "COACHING OBJECTIONS" : "ENCAISSEMENTS"}</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="agora-close-btn"><X size={18} /></button>
      </header>

      <div className="ag-views">
        <button className={view === "pipeline" ? "active" : ""} onClick={() => setView("pipeline")} data-testid="agora-view-pipeline">PIPELINE</button>
        <button className={view === "coach" ? "active" : ""} onClick={() => setView("coach")} data-testid="agora-view-coach"><Swords size={12} /> COACHING</button>
        <button className={view === "paiements" ? "active" : ""} onClick={() => setView("paiements")} data-testid="agora-view-paiements"><Euro size={12} /> ENCAISSEMENTS</button>
        {view === "pipeline" && (
          <a className="ag-export" href={`${API}/agora/deals/export.csv`} download="pipeline-agora.csv" data-testid="agora-export-csv">
            <Download size={12} /> EXPORT CSV
          </a>
        )}
      </div>

      {view === "coach" ? <AgoraCoach /> : view === "paiements" ? (
        <div className="ag-payments" data-testid="agora-payments-view">
          {txMsg && <div className="cal-notice" data-testid="agora-tx-msg">{txMsg}</div>}
          <div className="ag-tx-summary">
            {(() => {
              const paid = txs.filter((t) => t.payment_status === "paid");
              const total = paid.reduce((s, t) => s + (t.amount || 0), 0);
              return <>{paid.length} paiement{paid.length > 1 ? "s" : ""} reçu{paid.length > 1 ? "s" : ""} — <b>{euro(total / 100)}</b> encaissés · {txs.filter((t) => t.payment_status === "pending").length} en attente</>;
            })()}
          </div>
          {txs.length === 0 && <div className="cal-empty">Aucun encaissement pour le moment — générez un lien Stripe depuis un deal GAGNÉ.</div>}
          {txs.map((t) => (
            <div key={t.session_id} className="ag-tx-row" data-testid="agora-tx-row">
              <span className="ag-tx-date">{(t.created_at || "").slice(0, 10)}</span>
              <span className="ag-tx-name">{t.deal_nom}{t.deal_entreprise ? ` (${t.deal_entreprise})` : ""} · {t.percent < 100 ? `acompte ${t.percent}%` : "total"}</span>
              <span className="ag-tx-amount">{euro((t.amount || 0) / 100)}</span>
              <span className={`ag-tx-status ${t.payment_status}`} data-testid="agora-tx-status">
                {t.payment_status === "paid" ? "PAYÉ" : t.payment_status === "pending" ? "EN ATTENTE" : t.payment_status.toUpperCase()}
              </span>
              {t.payment_status === "paid" && (
                <button className="ag-pay-btn" onClick={() => downloadReceipt(t.session_id)} data-testid={`agora-receipt-${t.session_id.slice(-8)}`}>
                  <Receipt size={11} /> REÇU PDF
                </button>
              )}
              {t.payment_status === "pending" && (
                <button className="ag-pay-btn" onClick={() => remind(t.session_id)} data-testid={`agora-remind-${t.session_id.slice(-8)}`}>
                  <BellRing size={11} /> RELANCER{t.reminded_at ? ` (${t.reminded_at.slice(5, 10)})` : ""}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="ag-stats">
            <div className="ag-stat" data-testid="agora-stat-pipeline"><span>PIPELINE ACTIF</span><b>{euro(totalActive)}</b></div>
            <div className="ag-stat won" data-testid="agora-stat-won"><span>GAGNÉ</span><b>{euro(totalWon)}</b></div>
            <div className={`ag-stat ${lateCount ? "late" : ""}`} data-testid="agora-stat-late"><span>RELANCES EN RETARD</span><b>{lateCount}</b></div>
            <div className="ag-stat obj" data-testid="agora-stat-objectif" onClick={() => { if (!objEditing) { setObjEdit(String(objectif?.montant || "")); setObjEditing(true); } }}>
              <span><Target size={10} /> OBJECTIF DU MOIS</span>
              {objEditing ? (
                <span className="ag-obj-edit" onClick={(e) => e.stopPropagation()}>
                  <input type="number" min="0" autoFocus value={objEdit} onChange={(e) => setObjEdit(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveObjectif(); if (e.key === "Escape") setObjEditing(false); }}
                    data-testid="agora-objectif-input" />
                  <button onClick={saveObjectif} data-testid="agora-objectif-save">OK</button>
                </span>
              ) : objectif?.montant > 0 ? (
                <>
                  <b>{euro(objectif.gagne_mois)} / {euro(objectif.montant)}</b>
                  <div className="ag-obj-bar"><div style={{ width: `${Math.min(objectif.progression_pct, 100)}%` }} /></div>
                  <em data-testid="agora-objectif-pct">{objectif.progression_pct}%</em>
                </>
              ) : (
                <b className="ag-obj-hint">Cliquer pour fixer</b>
              )}
            </div>
          </div>

          <div className="ag-form" data-testid="agora-add-form">
            <input placeholder="Prospect *" value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} data-testid="agora-input-nom" />
            <input placeholder="Entreprise" value={form.entreprise} onChange={(e) => setForm({ ...form, entreprise: e.target.value })} data-testid="agora-input-entreprise" />
            <input placeholder="E-mail" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="agora-input-email" />
            <input placeholder="Valeur €" type="number" min="0" value={form.valeur} onChange={(e) => setForm({ ...form, valeur: e.target.value })} data-testid="agora-input-valeur" />
            <label className="ag-date" data-testid="agora-relance-field">
              <span>RELANCE</span>
              <input type="date" lang="fr" value={form.relance} onChange={(e) => setForm({ ...form, relance: e.target.value })} data-testid="agora-input-relance" />
            </label>
            <input placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} data-testid="agora-input-note" />
            <button onClick={addDeal} disabled={busy || !form.nom.trim()} data-testid="agora-add-btn"><Plus size={14} /> AJOUTER</button>
          </div>
          {err && <div className="ag-err" data-testid="agora-error">{err}</div>}

          <div className="ag-board" data-testid="agora-board">
            {stages.map((st) => {
              const list = deals.filter((d) => d.etape === st);
              const sum = list.reduce((s, d) => s + (d.valeur || 0), 0);
              return (
                <div className={`ag-col ${st === "GAGNÉ" ? "won" : st === "PERDU" ? "lost" : ""}`} key={st} data-testid={`agora-col-${st}`}>
                  <div className="ag-col-head">
                    <span>{st}</span>
                    <em>{list.length} · {euro(sum)}</em>
                  </div>
                  {list.map((d) => (
                    <div className={`ag-card ${isLate(d) ? "late" : ""}`} key={d.id} data-testid={`agora-deal-${d.id}`}>
                      <div className="ag-card-top">
                        <b>{d.nom}</b>
                        <ConfirmButton className="ag-del" title="Supprimer" testId={`agora-del-${d.id}`} onConfirm={() => del(d)}>
                          <Trash2 size={12} />
                        </ConfirmButton>
                      </div>
                      {d.entreprise && <div className="ag-card-ent">{d.entreprise}</div>}
                      <div className="ag-card-val">{euro(d.valeur)}</div>
                      {d.relance && (
                        <div className={`ag-card-relance ${isLate(d) ? "late" : ""}`}>
                          <BellRing size={11} /> Relance {new Date(d.relance + "T00:00:00").toLocaleDateString("fr-FR")}
                          {!["GAGNÉ", "PERDU"].includes(st) && (
                            <button className={`ag-relancer ${isLate(d) ? "late" : ""}`} disabled={relancing === d.id}
                              onClick={() => relancer(d)} title="Envoyer l'e-mail de relance" data-testid={`agora-relancer-${d.id}`}>
                              <Mail size={10} /> {relancing === d.id ? "ENVOI…" : "RELANCER"}
                            </button>
                          )}
                        </div>
                      )}
                      {d.relances_envoyees > 0 && <div className="ag-card-sent" data-testid={`agora-relances-count-${d.id}`}>{d.relances_envoyees} relance{d.relances_envoyees > 1 ? "s" : ""} envoyée{d.relances_envoyees > 1 ? "s" : ""}</div>}
                      {d.note && <div className="ag-card-note">{d.note}</div>}
                      {d.themis_doc_number && (
                        <div className="ag-card-themis" data-testid={`agora-themis-badge-${d.id}`}>
                          <FileText size={11} /> {d.themis_doc_kind === "facture" ? "Facture" : "Devis"} {d.themis_doc_number}
                        </div>
                      )}
                      {st === "GAGNÉ" && !d.themis_doc_number && (
                        <div className="ag-card-tobiz">
                          <button onClick={() => toThemis(d, "devis")} data-testid={`agora-devis-${d.id}`}><FileText size={11} /> DEVIS</button>
                          <button onClick={() => toThemis(d, "facture")} data-testid={`agora-facture-${d.id}`}><Receipt size={11} /> FACTURE</button>
                        </div>
                      )}
                      {st === "GAGNÉ" && (
                        <div className="ag-card-pay" data-testid={`agora-pay-${d.id}`}>
                          {payStatus[d.id] && payStatus[d.id].paid > 0 && (
                            <div className="ag-pay-badge" data-testid={`agora-paid-badge-${d.id}`}>
                              <CheckCircle2 size={11} /> ENCAISSÉ {euro((payStatus[d.id].amount_paid || 0) / 100)}
                            </div>
                          )}
                          {payOpen !== d.id && (
                            <button className="ag-pay-btn" onClick={() => { setPayOpen(d.id); setPayLink(null); setPayMsg(""); }} data-testid={`agora-encaisser-${d.id}`}>
                              <Euro size={11} /> ENCAISSER
                            </button>
                          )}
                          {payOpen === d.id && (
                            <div className="ag-pay-form">
                              <div className="ag-pay-row">
                                <select value={payPct} onChange={(e) => setPayPct(Number(e.target.value))} data-testid={`agora-pay-pct-${d.id}`}>
                                  <option value={30}>Acompte 30% — {euro((d.valeur || 0) * 0.3)}</option>
                                  <option value={50}>Acompte 50% — {euro((d.valeur || 0) * 0.5)}</option>
                                  <option value={100}>Total — {euro(d.valeur || 0)}</option>
                                </select>
                                <button onClick={() => createPayLink(d)} disabled={payBusy} data-testid={`agora-pay-generate-${d.id}`}>
                                  {payBusy ? <Loader2 size={11} className="spin" /> : <Euro size={11} />} LIEN STRIPE
                                </button>
                                <button onClick={() => { setPayOpen(null); setPayLink(null); }} data-testid={`agora-pay-close-${d.id}`}><X size={11} /></button>
                              </div>
                              {payLink && (
                                <div className="ag-pay-link" data-testid={`agora-pay-link-${d.id}`}>
                                  <span>{euro((payLink.amount || 0) / 100)} — lien prêt à envoyer au client :</span>
                                  <div className="ag-pay-row">
                                    <button onClick={() => { navigator.clipboard && navigator.clipboard.writeText(payLink.url); setPayMsg("Lien copié — envoyez-le à votre client."); }} data-testid={`agora-pay-copy-${d.id}`}>
                                      <Copy size={11} /> COPIER
                                    </button>
                                    <button onClick={() => window.open(payLink.url, "_blank")} data-testid={`agora-pay-open-${d.id}`}>
                                      <ExternalLink size={11} /> OUVRIR
                                    </button>
                                  </div>
                                </div>
                              )}
                              {payMsg && <div className="ag-pay-msg" data-testid={`agora-pay-msg-${d.id}`}>{payMsg}</div>}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="ag-card-actions">
                        <button onClick={() => move(d, -1)} disabled={stages.indexOf(st) === 0} data-testid={`agora-prev-${d.id}`}><ChevronLeft size={13} /></button>
                        <button onClick={() => move(d, 1)} disabled={stages.indexOf(st) === stages.length - 1} data-testid={`agora-next-${d.id}`}><ChevronRight size={13} /></button>
                      </div>
                    </div>
                  ))}
                  {!list.length && <div className="ag-empty">—</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

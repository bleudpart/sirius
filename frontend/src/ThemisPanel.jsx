// © 2026 Daniel Partel – ΣIRIUS Assistant. THÉMIS# — gestion d'entreprise (devis, factures, commandes, clients, compta, stocks, pièces PDF/OCR, modèles, BYOK).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, LayoutDashboard, FileText, Package, Users, Coins, Boxes, LayoutTemplate, KeyRound, Plus, Trash2, ArrowRightLeft, Minus, FileDown, Archive, Upload, Eye, Bell, AlertTriangle, Mail, Download } from "lucide-react";
import { ConfirmButton } from "@/ConfirmButton";
import { speakAsCharacter } from "@/voice";
import "./Themis.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api/themis";
const EUR = (n) => `${Number(n || 0).toFixed(2)} €`;
const DOC_STATUSES = ["brouillon", "envoyé", "accepté", "payé", "refusé"];
const ORDER_STATUSES = ["en_attente", "en_cours", "expédiée", "livrée", "annulée"];
const frToIso = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((s || "").trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
};
const isoToFr = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (s || "—");
};

const TABS = [
  ["dash", "TABLEAU DE BORD", LayoutDashboard],
  ["docs", "DEVIS & FACTURES", FileText],
  ["orders", "COMMANDES", Package],
  ["clients", "CLIENTS", Users],
  ["pay", "PAIEMENTS & COMPTA", Coins],
  ["pieces", "PIÈCES & PDF", Archive],
  ["stock", "STOCKS", Boxes],
  ["templates", "MODÈLES", LayoutTemplate],
  ["byok", "CLÉS API", KeyRound],
];

function MonthlyChart({ data }) {
  if (!data || data.length === 0 || !data.some((d) => d.in > 0 || d.out > 0)) return null;
  const W = 720, H = 190, P = 34;
  const max = Math.max(1, ...data.map((d) => Math.max(d.in, d.out)));
  const x = (i) => P + (i * (W - 2 * P)) / Math.max(1, data.length - 1);
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const path = (key) => data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const area = (key) => `${path(key)} L${x(data.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`;
  return (
    <div className="th-chart" data-testid="themis-chart">
      <div className="th-chart-legend">
        <span className="th-gold">— ENCAISSEMENTS</span>
        <span className="th-cyan">— DÉPENSES (pièces fournisseurs)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={P} x2={W - P} y1={y(max * f)} y2={y(max * f)} stroke="rgba(216,184,117,0.12)" strokeWidth="1" />
        ))}
        <path d={area("in")} fill="rgba(216,184,117,0.13)" />
        <path d={area("out")} fill="rgba(145,230,242,0.10)" />
        <path d={path("in")} fill="none" stroke="#d8b875" strokeWidth="2" />
        <path d={path("out")} fill="none" stroke="#91e6f2" strokeWidth="2" />
        {data.map((d, i) => (
          <g key={d.m}>
            <circle cx={x(i)} cy={y(d.in)} r="2.6" fill="#ffd75e" />
            <circle cx={x(i)} cy={y(d.out)} r="2.6" fill="#8be1ff" />
            <text x={x(i)} y={H - 10} textAnchor="middle" fill="#7fb6cc" fontSize="9">{d.m.slice(5)}/{d.m.slice(2, 4)}</text>
          </g>
        ))}
        <text x={P} y={y(max) - 6} fill="#9fc5d6" fontSize="9">{Math.round(max)} €</text>
      </svg>
    </div>
  );
}

function Lines({ lines, setLines }) {
  const upd = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div className="th-lines">
      {lines.map((l, i) => (
        <div className="th-line" key={i}>
          <input className="th-input" placeholder="Désignation" value={l.label} onChange={(e) => upd(i, "label", e.target.value)} data-testid={`themis-line-label-${i}`} />
          <input className="th-input th-qty" type="number" min="0" value={l.qty} onChange={(e) => upd(i, "qty", e.target.value)} title="Quantité" data-testid={`themis-line-qty-${i}`} />
          <input className="th-input th-qty" type="number" step="0.01" value={l.unit_price} onChange={(e) => upd(i, "unit_price", e.target.value)} title="Prix unitaire HT" data-testid={`themis-line-price-${i}`} />
          <button className="th-icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} data-testid={`themis-line-del-${i}`}><Trash2 size={12} /></button>
        </div>
      ))}
      <button className="th-mini-btn" onClick={() => setLines([...lines, { label: "", qty: 1, unit_price: 0 }])} data-testid="themis-add-line"><Plus size={12} /> LIGNE</button>
    </div>
  );
}

export default function ThemisPanel({ onClose }) {
  const [char, setChar] = useState(null);
  useEffect(() => {
    fetch((process.env.REACT_APP_BACKEND_URL || "") + "/api/mythos/characters")
      .then(r => r.json())
      .then(d => {
        const p = d.characters.find(c => c.module === "THÉMIS#");
        setChar(p);
      });
  }, []);
  const [tab, setTab] = useState("dash");
  const [stats, setStats] = useState(null);
  const [bilan, setBilan] = useState(null);
  const [docs, setDocs] = useState([]);
  const [orders, setOrders] = useState([]);
  const [clients, setClients] = useState([]);
  const [items, setItems] = useState([]);
  const [payments, setPayments] = useState([]);
  const [pieces, setPieces] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [err, setErr] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const [docForm, setDocForm] = useState({ kind: "devis", client_id: "", lines: [{ label: "", qty: 1, unit_price: 0 }], tva: 20, template: "antique", due_date: "" });
  const [orderForm, setOrderForm] = useState({ client_id: "", lines: [{ label: "", qty: 1, unit_price: 0 }] });
  const [clientForm, setClientForm] = useState({ name: "", company: "", email: "", phone: "", address: "" });
  const [itemForm, setItemForm] = useState({ name: "", ref: "", price: 0, stock: 0, alert: 5 });
  const [payForm, setPayForm] = useState({ doc_id: "", amount: "", method: "virement" });
  const [emailDoc, setEmailDoc] = useState(null);
  const [emailForm, setEmailForm] = useState({ to: "", subject: "", message: "", mail_type: "envoi" });
  const [sending, setSending] = useState(false);
  const [byok, setByok] = useState(() => { try { return JSON.parse(localStorage.getItem("themis_keys")) || {}; } catch (e) { return {}; } });

  const load = useCallback(async () => {
    try {
      const [s, b, d, o, c, it, p, pc, t] = await Promise.all(
        ["stats", "bilan", "docs", "orders", "clients", "items", "payments", "pieces", "templates"].map((e) =>
          fetch(`${API}/${e}`).then((r) => { if (!r.ok) throw new Error(e); return r.json(); })));
      setStats(s); setBilan(b); setDocs(d.docs); setOrders(o.orders); setClients(c.clients);
      setItems(it.items); setPayments(p.payments); setPieces(pc.pieces); setTemplates(t.templates);
    } catch (e) { setErr("Impossible de joindre le backend THÉMIS."); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setTimeout(() => speakAsCharacter("Thémis, gardienne de l'ordre. Votre entreprise est entre des mains rigoureuses.", { pitch: 0.95, rate: 0.88 }), 400);
    return () => clearTimeout(t);
  }, []);

  const post = async (path, body, method = "POST") => {
    let res;
    try {
      res = await fetch(`${API}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { setErr("Backend THÉMIS injoignable."); return false; }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const detail = typeof d.detail === "string" ? d.detail
        : Array.isArray(d.detail) && d.detail[0] ? String(d.detail[0].msg || "Champs invalides.").replace(/^Value error,\s*/, "")
        : `Requête refusée (erreur ${res.status}).`;
      setErr(detail);
      return false;
    }
    setErr("");
    load();
    return true;
  };

  const groqKey = () => { try { return (JSON.parse(localStorage.getItem("sirius_keys")) || {}).groq || ""; } catch (e) { return ""; } };

  const uploadPiece = async (file) => {
    if (!file || uploading) return;
    setUploading(true); setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("k3_key", groqKey());
      const res = await fetch(`${API}/pieces/upload`, { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setErr(typeof d.detail === "string" ? d.detail : "Envoi refusé.");
      else if (d.piece && d.piece.note) setErr(d.piece.note);
      else speakAsCharacter("Pièce comptable archivée et analysée, monsieur.", { pitch: 0.95, rate: 0.9 });
      await load();
    } catch (e) { setErr("Envoi impossible — backend injoignable."); }
    setUploading(false);
  };

  const clientName = (id) => (clients.find((c) => c.id === id) || {}).name || "";
  const smtpConf = () => (byok.smtp_host || "").trim()
    ? { host: byok.smtp_host.trim(), port: Number(byok.smtp_port || 587), user: byok.smtp_user || "", password: byok.smtp_pass || "", from_email: byok.smtp_from || "", from_name: byok.smtp_name || "THÉMIS — ΣIRIUS" }
    : null;
  const openEmail = (d, relance = false) => {
    const cl = clients.find((c) => c.id === d.client_id) || {};
    const restant = Number(d.total_ttc || 0) - Number(d.paid || 0);
    if (relance) {
      setEmailForm({
        to: cl.email || "",
        subject: `Relance — Facture ${d.number}`,
        message: `Bonjour${cl.name ? " " + cl.name : ""},\n\nSauf erreur de notre part, la facture ${d.number} d’un montant restant de ${restant.toFixed(2)} € TTC${d.due_date ? `, arrivée à échéance le ${isoToFr(d.due_date)}` : ""}, demeure impayée à ce jour.\n\nNous vous serions reconnaissants de bien vouloir procéder à son règlement dans les meilleurs délais. Si votre paiement nous est déjà parvenu, veuillez ne pas tenir compte de ce message.\n\nCordialement,\n${emetteur || "ΣIRIUS"}`,
        mail_type: "relance",
      });
    } else {
      const kind = d.kind === "facture" ? "la facture" : "le devis";
      setEmailForm({
        to: cl.email || "",
        subject: `${d.kind === "facture" ? "Facture" : "Devis"} ${d.number}`,
        message: `Bonjour${cl.name ? " " + cl.name : ""},\n\nVeuillez trouver ci-joint ${kind} ${d.number} d’un montant de ${Number(d.total_ttc || 0).toFixed(2)} € TTC${d.due_date ? `, à régler avant le ${isoToFr(d.due_date)}` : ""}.\n\nCordialement,\n${emetteur || "ΣIRIUS"}`,
        mail_type: "envoi",
      });
    }
    setEmailDoc(d);
  };
  const sendEmail = async () => {
    setSending(true);
    const ok = await post(`docs/${emailDoc.id}/email`, { ...emailForm, emetteur, smtp: smtpConf() });
    setSending(false);
    if (ok) {
      const num = emailDoc.number;
      setEmailDoc(null);
      speakAsCharacter(`Le document ${num} a été transmis par e-mail, monsieur.`, { pitch: 0.95, rate: 0.9 });
    }
  };
  const totalOf = (lines, tva = 0) => {
    const ht = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.unit_price || 0), 0);
    return ht * (1 + Number(tva) / 100);
  };
  const factures = docs.filter((d) => d.kind === "facture");
  const todayIso = new Date().toISOString().slice(0, 10);
  const isLate = (d) => d.kind === "facture" && d.due_date && !["payé", "refusé"].includes(d.status) && d.due_date.slice(0, 10) < todayIso;
  const lastMail = (d) => (d.emails || [])[(d.emails || []).length - 1];
  const emetteur = (() => { try { const p = JSON.parse(localStorage.getItem("sirius_profile")) || {}; return p.company || p.name || ""; } catch (e) { return ""; } })();
  const pdfUrl = (d) => `${API}/docs/${d.id}/pdf?emetteur=${encodeURIComponent(emetteur)}`;

  return (
    <div className="prime-screen themis-screen" data-testid="themis-panel">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><img src="/holo/logo-themis.png" alt="" className="th-logo" data-testid="themis-logo" /> THÉMIS# — GESTION D’ENTREPRISE</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="themis-close-btn"><X size={18} /></button>
      </header>
      {char && (
        <img
          src={char.image}
          alt={char.character}
          className="mythos-avatar"
        />
      )}
      <div className="prime-sub">DEVIS · FACTURES · COMMANDES · CLIENTS · COMPTABILITÉ · PIÈCES PDF · STOCKS · MODÈLES · BYOK</div>

      <div className="th-tabs">
        {TABS.map(([id, label, Icon]) => (
          <button key={id} className={`th-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)} data-testid={`themis-tab-${id}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {err && (
        <div className="th-error" data-testid="themis-error">
          <AlertTriangle size={14} /> {err}
          <button className="th-error-close" onClick={() => setErr("")} data-testid="themis-error-close"><X size={13} /></button>
        </div>
      )}

      <div className="argus-body th-body">
        {tab === "dash" && stats && (
          <>
            <div className="th-cards" data-testid="themis-stats">
              <div className="th-card gold"><span>ENCAISSÉ</span><b>{EUR(stats.encaisse)}</b></div>
              <div className="th-card"><span>À ENCAISSER</span><b>{EUR(stats.a_encaisser)}</b></div>
              <div className="th-card"><span>DEVIS EN COURS</span><b>{stats.devis_en_cours}</b></div>
              <div className="th-card"><span>FACTURES IMPAYÉES</span><b>{stats.factures_impayees}</b></div>
              <div className="th-card"><span>COMMANDES ACTIVES</span><b>{stats.commandes_actives}</b></div>
              <div className="th-card"><span>CLIENTS</span><b>{stats.nb_clients}</b></div>
            </div>
            <div className="th-dash-actions">
              <a className="th-btn" href={`${API}/export`} download data-testid="themis-export-btn"><Download size={13} /> EXPORT COMPTABLE (ZIP)</a>
            </div>
            <MonthlyChart data={stats.monthly} />
            {stats.stock_alerts.length > 0 && (
              <div className="th-alert" data-testid="themis-stock-alerts"><AlertTriangle size={13} /> STOCK BAS : {stats.stock_alerts.map((i) => `${i.name} (${i.stock})`).join(" · ")}</div>
            )}
            {bilan && bilan.pieces_a_payer > 0 && (
              <div className="th-alert th-alert-gold" data-testid="themis-pieces-alert"><Archive size={13} /> {bilan.pieces_a_payer} pièce(s) fournisseur à payer — {EUR(bilan.total_pieces_a_payer)}</div>
            )}
            {bilan && bilan.echeances.length > 0 && (
              <>
                <div className="th-section-title"><Bell size={11} /> RAPPELS D’ÉCHÉANCES</div>
                <table className="th-table" data-testid="themis-echeances"><tbody>
                  {bilan.echeances.map((e) => (
                    <tr key={e.number}>
                      <td><b className="th-gold">{e.number}</b></td><td>{e.client || "—"}</td>
                      <td>{EUR(e.restant)}</td><td>{isoToFr(e.due_date)}</td>
                      <td><span className={`th-ech ${e.days < 0 ? "late" : e.days <= 7 ? "soon" : ""}`}>
                        {e.days < 0 ? `RETARD ${-e.days} J` : e.days === 0 ? "AUJOURD’HUI" : `DANS ${e.days} J`}</span></td>
                      <td>{e.days < 0 && (() => { const doc = docs.find((x) => x.number === e.number); return doc ? <button className="th-icon-btn th-late-btn" title="Relancer le client" onClick={() => openEmail(doc, true)} data-testid={`themis-ech-relance-${e.number}`}><Bell size={12} /></button> : null; })()}</td>
                    </tr>
                  ))}
                </tbody></table>
              </>
            )}
            <div className="th-section-title">DERNIERS DOCUMENTS</div>
            <table className="th-table"><tbody>
              {stats.derniers_docs.map((d) => (
                <tr key={d.id}><td>{d.number}</td><td>{d.client_name || clientName(d.client_id)}</td><td>{EUR(d.total_ttc)}</td><td><span className={`th-badge s-${d.status}`}>{d.status}</span></td></tr>
              ))}
            </tbody></table>
          </>
        )}

        {tab === "docs" && (
          <div className="th-split">
            <div className="th-form-card">
              <div className="th-section-title">NOUVEAU DOCUMENT</div>
              <div className="th-row">
                <select className="th-input" value={docForm.kind} onChange={(e) => setDocForm({ ...docForm, kind: e.target.value })} data-testid="themis-doc-kind">
                  <option value="devis">Devis</option><option value="facture">Facture</option>
                </select>
                <select className="th-input" value={docForm.client_id} onChange={(e) => setDocForm({ ...docForm, client_id: e.target.value })} data-testid="themis-doc-client">
                  <option value="">— Client —</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <Lines lines={docForm.lines} setLines={(l) => setDocForm({ ...docForm, lines: l })} />
              <div className="th-row">
                <input className="th-input th-qty" type="number" value={docForm.tva} onChange={(e) => setDocForm({ ...docForm, tva: e.target.value })} title="TVA %" data-testid="themis-doc-tva" />
                <select className="th-input" value={docForm.template} onChange={(e) => setDocForm({ ...docForm, template: e.target.value })} data-testid="themis-doc-template">
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <input className="th-input" placeholder="Échéance — JJ/MM/AAAA" value={docForm.due_date} onChange={(e) => setDocForm({ ...docForm, due_date: e.target.value })} title="Date d’échéance" data-testid="themis-doc-due" />
              <div className="th-total">TOTAL TTC : <b>{EUR(totalOf(docForm.lines, docForm.tva))}</b></div>
              <button className="th-btn gold" data-testid="themis-doc-create" onClick={async () => {
                const ok = await post("docs", { ...docForm, due_date: frToIso(docForm.due_date), client_name: clientName(docForm.client_id), tva: Number(docForm.tva), lines: docForm.lines.map((l) => ({ ...l, qty: Number(l.qty), unit_price: Number(l.unit_price) })) });
                if (ok) setDocForm({ ...docForm, lines: [{ label: "", qty: 1, unit_price: 0 }], due_date: "" });
              }}>CRÉER</button>
            </div>
            <div className="th-list">
              <table className="th-table" data-testid="themis-docs-table"><tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <b className={d.kind === "facture" ? "th-gold" : "th-cyan"}>{d.number}</b>
                      {lastMail(d) && (
                        <><br /><span className="th-mailtrace" data-testid={`themis-mails-${d.number}`} title={(d.emails || []).map((m) => `${m.type === "relance" ? "Relance" : "Envoi"} le ${isoToFr(m.date.slice(0, 10))} → ${m.to}`).join("\n")}>
                          <Mail size={9} /> {(d.emails || []).length} envoi{(d.emails || []).length > 1 ? "s" : ""} · {isoToFr(lastMail(d).date.slice(0, 10))} → {lastMail(d).to}
                        </span></>
                      )}
                    </td>
                    <td>{d.client_name || clientName(d.client_id)}</td>
                    <td>{EUR(d.total_ttc)}{d.kind === "facture" && d.paid > 0 && <small> ({EUR(d.paid)} reçu)</small>}</td>
                    <td>
                      <select className="th-input th-status" value={d.status} onChange={(e) => post(`docs/${d.id}/status`, { status: e.target.value }, "PUT")} data-testid={`themis-doc-status-${d.number}`}>
                        {DOC_STATUSES.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td className="th-actions">
                      <a className="th-icon-btn" href={pdfUrl(d)} target="_blank" rel="noreferrer" title="Télécharger le PDF" data-testid={`themis-pdf-${d.number}`}><FileDown size={12} /></a>
                      <button className="th-icon-btn" title="Envoyer par e-mail" onClick={() => openEmail(d)} data-testid={`themis-email-${d.number}`}><Mail size={12} /></button>
                      {isLate(d) && <button className="th-icon-btn th-late-btn" title="Relancer le client (facture en retard)" onClick={() => openEmail(d, true)} data-testid={`themis-relance-${d.number}`}><Bell size={12} /></button>}
                      {d.kind === "devis" && <button className="th-icon-btn" title="Convertir en facture" onClick={() => post(`docs/${d.id}/convert`)} data-testid={`themis-convert-${d.number}`}><ArrowRightLeft size={12} /></button>}
                      <ConfirmButton className="th-icon-btn" onConfirm={() => post(`docs/${d.id}`, null, "DELETE")} testId={`themis-doc-del-${d.number}`}><Trash2 size={12} /></ConfirmButton>
                    </td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          </div>
        )}

        {tab === "orders" && (
          <div className="th-split">
            <div className="th-form-card">
              <div className="th-section-title">NOUVELLE COMMANDE</div>
              <select className="th-input" value={orderForm.client_id} onChange={(e) => setOrderForm({ ...orderForm, client_id: e.target.value })} data-testid="themis-order-client">
                <option value="">— Client —</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <Lines lines={orderForm.lines} setLines={(l) => setOrderForm({ ...orderForm, lines: l })} />
              <div className="th-total">TOTAL : <b>{EUR(totalOf(orderForm.lines, 20))}</b></div>
              <button className="th-btn gold" data-testid="themis-order-create" onClick={async () => {
                const ok = await post("orders", { ...orderForm, client_name: clientName(orderForm.client_id), lines: orderForm.lines.map((l) => ({ ...l, qty: Number(l.qty), unit_price: Number(l.unit_price) })) });
                if (ok) setOrderForm({ client_id: "", lines: [{ label: "", qty: 1, unit_price: 0 }] });
              }}>ENREGISTRER</button>
            </div>
            <div className="th-list">
              <table className="th-table" data-testid="themis-orders-table"><tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td><b className="th-gold">{o.number}</b></td><td>{o.client_name}</td><td>{EUR(o.total)}</td>
                    <td>
                      <select className="th-input th-status" value={o.status} onChange={(e) => post(`orders/${o.id}/status`, { status: e.target.value }, "PUT")} data-testid={`themis-order-status-${o.number}`}>
                        {ORDER_STATUSES.map((s) => <option key={s}>{s}</option>)}
                      </select>
                    </td>
                    <td><ConfirmButton className="th-icon-btn" onConfirm={() => post(`orders/${o.id}`, null, "DELETE")} testId={`themis-order-del-${o.number}`}><Trash2 size={12} /></ConfirmButton></td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          </div>
        )}

        {tab === "clients" && (
          <div className="th-split">
            <div className="th-form-card">
              <div className="th-section-title">NOUVEAU CLIENT</div>
              {["name", "company", "email", "phone", "address"].map((k) => (
                <input key={k} className="th-input" placeholder={{ name: "Nom *", company: "Société", email: "E-mail", phone: "Téléphone", address: "Adresse" }[k]} value={clientForm[k]} onChange={(e) => setClientForm({ ...clientForm, [k]: e.target.value })} data-testid={`themis-client-${k}`} />
              ))}
              <button className="th-btn gold" data-testid="themis-client-create" disabled={!clientForm.name.trim()} onClick={async () => {
                const ok = await post("clients", clientForm);
                if (ok) setClientForm({ name: "", company: "", email: "", phone: "", address: "" });
              }}>AJOUTER</button>
            </div>
            <div className="th-list">
              <table className="th-table" data-testid="themis-clients-table"><tbody>
                {clients.map((c) => (
                  <tr key={c.id}><td><b className="th-gold">{c.name}</b></td><td>{c.company}</td><td>{c.email}<br />{c.phone}</td>
                    <td><ConfirmButton className="th-icon-btn" onConfirm={() => post(`clients/${c.id}`, null, "DELETE")} testId={`themis-client-del-${c.name}`}><Trash2 size={12} /></ConfirmButton></td></tr>
                ))}
              </tbody></table>
            </div>
          </div>
        )}

        {tab === "pay" && stats && (
          <div className="th-split">
            <div className="th-form-card">
              <div className="th-section-title">ENREGISTRER UN PAIEMENT</div>
              <select className="th-input" value={payForm.doc_id} onChange={(e) => setPayForm({ ...payForm, doc_id: e.target.value })} data-testid="themis-pay-doc">
                <option value="">— Facture —</option>
                {factures.filter((f) => f.status !== "payé").map((f) => <option key={f.id} value={f.id}>{f.number} · {EUR(f.total_ttc - (f.paid || 0))} restant</option>)}
              </select>
              <div className="th-row">
                <input className="th-input" type="number" step="0.01" placeholder="Montant €" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} data-testid="themis-pay-amount" />
                <select className="th-input" value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })} data-testid="themis-pay-method">
                  {["virement", "carte", "espèces", "chèque", "crypto"].map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <button className="th-btn gold" data-testid="themis-pay-create" disabled={!payForm.amount} onClick={async () => {
                const ok = await post("payments", { ...payForm, amount: Number(payForm.amount) });
                if (ok) setPayForm({ doc_id: "", amount: "", method: "virement" });
              }}>ENCAISSER</button>
              <div className="th-section-title" style={{ marginTop: 18 }}>COMPTABILITÉ</div>
              <div className="th-compta">
                <div>Encaissé : <b className="th-gold">{EUR(stats.encaisse)}</b></div>
                <div>À encaisser : <b className="th-cyan">{EUR(stats.a_encaisser)}</b></div>
                {bilan && <div>Pièces fournisseurs à payer : <b className="th-gold">{EUR(bilan.total_pieces_a_payer)}</b></div>}
                {Object.entries(stats.by_method).map(([m, v]) => <div key={m}>— {m} : {EUR(v)}</div>)}
              </div>
            </div>
            <div className="th-list">
              <table className="th-table" data-testid="themis-payments-table"><tbody>
                {payments.map((p) => (
                  <tr key={p.id}><td><b className="th-gold">{EUR(p.amount)}</b></td><td>{p.method}</td>
                    <td>{(factures.find((f) => f.id === p.doc_id) || {}).number || "—"}</td>
                    <td>{p.created_at.slice(0, 10)}</td>
                    <td><ConfirmButton className="th-icon-btn" onConfirm={() => post(`payments/${p.id}`, null, "DELETE")} testId={`themis-pay-del-${p.id}`}><Trash2 size={12} /></ConfirmButton></td></tr>
                ))}
              </tbody></table>
            </div>
          </div>
        )}

        {tab === "pieces" && (
          <div className="th-pieces">
            <div
              className={`th-drop ${uploading ? "busy" : ""}`}
              data-testid="themis-drop-zone"
              onClick={() => !uploading && fileRef.current && fileRef.current.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); uploadPiece(e.dataTransfer.files && e.dataTransfer.files[0]); }}
            >
              <input ref={fileRef} type="file" accept=".pdf,image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={(e) => { uploadPiece(e.target.files && e.target.files[0]); e.target.value = ""; }} data-testid="themis-file-input" />
              <Upload size={22} />
              {uploading
                ? <span className="th-drop-busy">LECTURE DE LA PIÈCE EN COURS — extraction IA de la date, du fournisseur et des montants…</span>
                : <span>Déposez ici une facture PDF ou un document scanné (PNG, JPG) — Thémis lit automatiquement la date, le fournisseur, le HT, la TVA et le TTC.</span>}
            </div>
            {!groqKey() && <p className="th-note">Astuce : renseignez votre clé Kimi K3 dans les réglages de Sirius pour activer la lecture automatique (OCR) des pièces.</p>}
            <table className="th-table" data-testid="themis-pieces-table"><tbody>
              {pieces.map((p) => (
                <tr key={p.id} className={p.status === "à_payer" ? "" : "th-paid"}>
                  <td><b className="th-gold">{p.fournisseur || p.filename}</b><br /><small>{p.numero || p.filename}</small></td>
                  <td>{isoToFr(p.date)}</td>
                  <td><small>HT</small> {EUR(p.total_ht)}<br /><small>TVA</small> {EUR(p.tva)}</td>
                  <td><b className="th-cyan">{EUR(p.total_ttc)}</b></td>
                  <td>
                    <select className="th-input th-status" value={p.status} onChange={(e) => post(`pieces/${p.id}`, { status: e.target.value }, "PUT")} data-testid={`themis-piece-status-${p.id}`}>
                      <option value="à_payer">à payer</option><option value="payé">payé</option>
                    </select>
                  </td>
                  <td className="th-actions">
                    <a className="th-icon-btn" href={`${API}/pieces/${p.id}/file`} target="_blank" rel="noreferrer" title="Voir la pièce" data-testid={`themis-piece-view-${p.id}`}><Eye size={12} /></a>
                    <ConfirmButton className="th-icon-btn" onConfirm={() => post(`pieces/${p.id}`, null, "DELETE")} testId={`themis-piece-del-${p.id}`}><Trash2 size={12} /></ConfirmButton>
                  </td>
                </tr>
              ))}
              {pieces.length === 0 && <tr><td className="th-empty">Aucune pièce archivée pour l’instant.</td></tr>}
            </tbody></table>
          </div>
        )}

        {tab === "stock" && (
          <div className="th-split">
            <div className="th-form-card">
              <div className="th-section-title">NOUVEL ARTICLE</div>
              <input className="th-input" placeholder="Nom *" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} data-testid="themis-item-name" />
              <div className="th-row">
                <input className="th-input" placeholder="Réf." value={itemForm.ref} onChange={(e) => setItemForm({ ...itemForm, ref: e.target.value })} data-testid="themis-item-ref" />
                <input className="th-input th-qty" type="number" step="0.01" placeholder="Prix" value={itemForm.price} onChange={(e) => setItemForm({ ...itemForm, price: e.target.value })} title="Prix HT" data-testid="themis-item-price" />
              </div>
              <div className="th-row">
                <input className="th-input th-qty" type="number" placeholder="Stock" value={itemForm.stock} onChange={(e) => setItemForm({ ...itemForm, stock: e.target.value })} title="Stock initial" data-testid="themis-item-stock" />
                <input className="th-input th-qty" type="number" placeholder="Seuil" value={itemForm.alert} onChange={(e) => setItemForm({ ...itemForm, alert: e.target.value })} title="Seuil d’alerte" data-testid="themis-item-alert" />
              </div>
              <button className="th-btn gold" data-testid="themis-item-create" disabled={!itemForm.name} onClick={async () => {
                const ok = await post("items", { ...itemForm, price: Number(itemForm.price), stock: Number(itemForm.stock), alert: Number(itemForm.alert) });
                if (ok) setItemForm({ name: "", ref: "", price: 0, stock: 0, alert: 5 });
              }}>AJOUTER</button>
            </div>
            <div className="th-list">
              <table className="th-table" data-testid="themis-items-table"><tbody>
                {items.map((i) => (
                  <tr key={i.id} className={i.stock <= i.alert ? "th-low" : ""}>
                    <td><b className="th-gold">{i.name}</b> <small>{i.ref}</small></td><td>{EUR(i.price)}</td>
                    <td className="th-stock-cell">
                      <button className="th-icon-btn" onClick={() => post(`items/${i.id}/stock`, { delta: -1 }, "PUT")} data-testid={`themis-stock-minus-${i.name}`}><Minus size={11} /></button>
                      <b>{i.stock}</b>
                      <button className="th-icon-btn" onClick={() => post(`items/${i.id}/stock`, { delta: 1 }, "PUT")} data-testid={`themis-stock-plus-${i.name}`}><Plus size={11} /></button>
                    </td>
                    <td>{i.stock <= i.alert && <span className="th-badge s-refusé">STOCK BAS</span>}</td>
                    <td><ConfirmButton className="th-icon-btn" onConfirm={() => post(`items/${i.id}`, null, "DELETE")} testId={`themis-item-del-${i.name}`}><Trash2 size={12} /></ConfirmButton></td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          </div>
        )}

        {tab === "templates" && (
          <div className="th-templates" data-testid="themis-templates">
            {templates.map((t) => (
              <div className="th-template" key={t.id} style={{ borderColor: t.accent }}>
                <div className="th-template-preview" style={{ background: `linear-gradient(160deg, ${t.accent}22, transparent 60%)` }}>
                  <div className="th-tp-head" style={{ borderColor: t.accent, color: t.accent }}>ΣIRIUS · {t.name}</div>
                  <div className="th-tp-line" /><div className="th-tp-line short" /><div className="th-tp-line" />
                  <div className="th-tp-total" style={{ color: t.accent }}>TOTAL TTC — 1 234,00 €</div>
                </div>
                <b style={{ color: t.accent }}>{t.name}</b>
                <p>{t.desc}</p>
              </div>
            ))}
          </div>
        )}

        {tab === "byok" && (
          <div className="th-form-card th-byok" data-testid="themis-byok">
            <div className="th-section-title">BYOK — VOS PROPRES CLÉS API</div>
            <p className="th-note">Vos clés restent stockées localement dans ce navigateur. Les identifiants SMTP ne transitent par votre serveur Sirius qu’au moment d’un envoi, sans jamais y être conservés.</p>
            {[["stripe", "Clé API Paiements (Stripe, PayPal…)"], ["compta", "Clé API Comptabilité (Pennylane, QuickBooks…)"], ["autre", "Autre clé / service personnalisé"]].map(([k, label]) => (
              <div key={k}>
                <label className="th-label">{label}</label>
                <input className="th-input" type="password" placeholder="••••••••" value={byok[k] || ""} onChange={(e) => setByok({ ...byok, [k]: e.target.value })} data-testid={`themis-byok-${k}`} />
              </div>
            ))}
            <div className="th-section-title" style={{ marginTop: 14 }}>ENVOI D’E-MAILS — VOTRE SERVEUR SMTP</div>
            <p className="th-note">Ex. Gmail : smtp.gmail.com, port 587, votre adresse + un mot de passe d’application (compte Google → Sécurité).</p>
            <div className="th-row">
              <input className="th-input" placeholder="Serveur SMTP (smtp.gmail.com)" value={byok.smtp_host || ""} onChange={(e) => setByok({ ...byok, smtp_host: e.target.value })} data-testid="themis-byok-smtp-host" />
              <input className="th-input th-qty" type="number" placeholder="587" title="Port (587 STARTTLS / 465 SSL)" value={byok.smtp_port || ""} onChange={(e) => setByok({ ...byok, smtp_port: e.target.value })} data-testid="themis-byok-smtp-port" />
            </div>
            <input className="th-input" placeholder="Identifiant / adresse e-mail" value={byok.smtp_user || ""} onChange={(e) => setByok({ ...byok, smtp_user: e.target.value })} data-testid="themis-byok-smtp-user" />
            <input className="th-input" type="password" placeholder="Mot de passe (ou mot de passe d’application)" value={byok.smtp_pass || ""} onChange={(e) => setByok({ ...byok, smtp_pass: e.target.value })} data-testid="themis-byok-smtp-pass" />
            <div className="th-row">
              <input className="th-input" placeholder="Adresse expéditeur (vide = identifiant)" value={byok.smtp_from || ""} onChange={(e) => setByok({ ...byok, smtp_from: e.target.value })} data-testid="themis-byok-smtp-from" />
              <input className="th-input" placeholder="Nom d’expéditeur" value={byok.smtp_name || ""} onChange={(e) => setByok({ ...byok, smtp_name: e.target.value })} data-testid="themis-byok-smtp-name" />
            </div>
            <button className="th-btn gold" data-testid="themis-byok-save" onClick={() => { localStorage.setItem("themis_keys", JSON.stringify(byok)); speakAsCharacter("Vos clés sont scellées dans le sanctuaire local, monsieur.", { pitch: 0.95, rate: 0.88 }); }}>SCELLER LES CLÉS</button>
          </div>
        )}
      </div>

      {emailDoc && createPortal(
        <div className="th-modal-back" data-testid="themis-email-modal">
          <div className="th-modal">
            <div className="th-section-title"><Mail size={12} /> {emailForm.mail_type === "relance" ? "RELANCE — FACTURE" : `ENVOYER ${emailDoc.kind === "facture" ? "LA FACTURE" : "LE DEVIS"}`} {emailDoc.number} PAR E-MAIL</div>
            {!smtpConf() && <p className="th-note" data-testid="themis-email-nosmtp">Configurez d’abord votre serveur SMTP dans l’onglet CLÉS API, puis revenez ici.</p>}
            {err && (
              <div className="th-error" style={{ margin: 0 }} data-testid="themis-email-error">
                <AlertTriangle size={14} /> {err}
                <button className="th-error-close" onClick={() => setErr("")} data-testid="themis-email-error-close"><X size={13} /></button>
              </div>
            )}
            <input className="th-input" placeholder="Destinataire (e-mail du client)" value={emailForm.to} onChange={(e) => setEmailForm({ ...emailForm, to: e.target.value })} data-testid="themis-email-to" />
            <input className="th-input" placeholder="Objet" value={emailForm.subject} onChange={(e) => setEmailForm({ ...emailForm, subject: e.target.value })} data-testid="themis-email-subject" />
            <textarea className="th-input" rows={6} value={emailForm.message} onChange={(e) => setEmailForm({ ...emailForm, message: e.target.value })} data-testid="themis-email-message" />
            <p className="th-note">Le PDF {emailDoc.number} sera joint automatiquement.</p>
            <div className="th-row">
              <button className="th-btn gold" disabled={!smtpConf() || sending || !emailForm.to.trim()} onClick={sendEmail} data-testid="themis-email-send">{sending ? "ENVOI EN COURS…" : "ENVOYER"}</button>
              <button className="th-btn" onClick={() => setEmailDoc(null)} data-testid="themis-email-cancel">ANNULER</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

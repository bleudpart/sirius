// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  X, Database, Search, Star, Trash2, Pencil, Check, Download, ScrollText,
  BrainCircuit, AlertTriangle, CheckCircle2, Loader2,
} from "lucide-react";
import "./MemoryManager.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const TYPE_LABELS = {
  episodic: "ÉPISODIQUE", semantic: "SÉMANTIQUE",
  procedural: "PROCÉDURALE", prospective: "PROSPECTIVE",
};
const SOURCE_LABELS = { explicite: "EXPLICITE", observation: "OBSERVATION", inference: "INFÉRENCE" };

function Badge({ cls, children }) {
  return <span className={`mm-badge ${cls}`}>{children}</span>;
}

export default function MemoryManager({ onClose }) {
  const [tab, setTab] = useState("memories");
  const [memories, setMemories] = useState([]);
  const [stats, setStats] = useState(null);
  const [audit, setAudit] = useState([]);
  const [q, setQ] = useState("");
  const [mtype, setMtype] = useState("");
  const [status, setStatus] = useState("active");
  const [loading, setLoading] = useState(false);
  const [editId, setEditId] = useState(null);
  const [editText, setEditText] = useState("");
  const starsRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ q, mtype, status });
      const r = await fetch(`${API}/memory/list?${p}`);
      const d = await r.json();
      setMemories(d.memories || []);
      setStats(d.stats || null);
    } catch (_) {}
    setLoading(false);
  }, [q, mtype, status]);

  const loadAudit = async () => {
    try {
      const r = await fetch(`${API}/memory/audit?limit=80`);
      setAudit((await r.json()).audit || []);
    } catch (_) {}
  };

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === "audit") loadAudit(); }, [tab]);

  const patch = async (id, fields) => {
    await fetch(`${API}/memory/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }).catch(() => {});
    load();
  };

  const remove = async (id) => {
    await fetch(`${API}/memory/${id}`, { method: "DELETE" }).catch(() => {});
    setMemories((l) => l.filter((m) => m.id !== id));
  };

  const exportAll = async () => {
    try {
      const r = await fetch(`${API}/memory/export`);
      const d = await r.json();
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sirius-memoire-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (_) {}
  };

  const startEdit = (m) => { setEditId(m.id); setEditText(m.content); };
  const saveEdit = async () => {
    if (editText.trim()) await patch(editId, { content: editText.trim() });
    setEditId(null);
  };

  const chips = useMemo(() => {
    if (!stats) return [];
    return [
      ["TOTAL", stats.total],
      ...Object.entries(stats.by_type || {}).map(([k, v]) => [TYPE_LABELS[k] || k, v]),
      ...Object.entries(stats.by_source || {}).map(([k, v]) => [SOURCE_LABELS[k] || k, v]),
    ];
  }, [stats]);

  return (
    <div className="prime-screen" data-testid="memory-manager">
      <canvas ref={starsRef} className="prime-stars" />
      <header className="zeus-head">
        <div className="oracle-title font-divine"><BrainCircuit size={20} /> GESTION DE LA MÉMOIRE</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="memorymgr-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">
        MÉMOIRE LONGUE DURÉE — CONSULTER · CORRIGER · EXPORTER · SUPPRIMER
      </div>

      <div className="mm-body">
        <div className="haccp-tabs">
          <button className={`haccp-tab ${tab === "memories" ? "active" : ""}`} onClick={() => setTab("memories")} data-testid="mm-tab-memories">
            <Database size={13} /> SOUVENIRS
          </button>
          <button className={`haccp-tab ${tab === "audit" ? "active" : ""}`} onClick={() => setTab("audit")} data-testid="mm-tab-audit">
            <ScrollText size={13} /> JOURNAL D'AUDIT
          </button>
          <button className="haccp-tab mm-export" onClick={exportAll} data-testid="mm-export-btn">
            <Download size={13} /> EXPORTER (JSON)
          </button>
        </div>

        {tab === "memories" && (
          <section className="prime-card mm-wide" data-testid="mm-memories">
            <div className="mm-stats-row">
              {chips.map(([label, v]) => (
                <span className="mm-chip" key={label}>{label} <b>{v}</b></span>
              ))}
            </div>
            <div className="mm-filters">
              <div className="mm-search">
                <Search size={13} />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && load()}
                  placeholder="Rechercher un souvenir..."
                  data-testid="mm-search-input"
                />
              </div>
              <select value={mtype} onChange={(e) => setMtype(e.target.value)} data-testid="mm-type-filter">
                <option value="">TOUS TYPES</option>
                {Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <select value={status} onChange={(e) => setStatus(e.target.value)} data-testid="mm-status-filter">
                <option value="active">ACTIFS</option>
                <option value="contested">EN CONFLIT</option>
                <option value="archive">ARCHIVÉS</option>
                <option value="">TOUS STATUTS</option>
              </select>
            </div>

            {loading && <div className="haccp-loading"><Loader2 size={20} className="haccp-spin" /><span>Chargement...</span></div>}
            {!loading && memories.length === 0 && (
              <div className="memory-empty" data-testid="mm-empty">Aucun souvenir pour ces critères. Dites « souviens-toi que... » à Sirius pour enrichir sa mémoire.</div>
            )}
            {!loading && memories.map((m) => (
              <div className={`mm-row ${m.status !== "active" ? "muted" : ""}`} key={m.id} data-testid={`mm-row-${m.id}`}>
                <div className="mm-row-main">
                  {editId === m.id ? (
                    <div className="mm-edit">
                      <textarea value={editText} onChange={(e) => setEditText(e.target.value)} data-testid="mm-edit-input" />
                      <button className="mm-icon-btn ok" onClick={saveEdit} data-testid="mm-edit-save"><Check size={13} /></button>
                    </div>
                  ) : (
                    <p className="mm-content">{m.content}</p>
                  )}
                  <div className="mm-meta">
                    <Badge cls={`t-${m.mtype}`}>{TYPE_LABELS[m.mtype] || m.mtype}</Badge>
                    <Badge cls={`s-${m.source}`}>{SOURCE_LABELS[m.source] || m.source}</Badge>
                    {m.status === "contested" && <Badge cls="contested"><AlertTriangle size={9} /> EN CONFLIT</Badge>}
                    <span className="mm-num">IMP {Math.round((m.importance || 0) * 100)}%</span>
                    <span className="mm-num">CONF {Math.round((m.confidence || 0) * 100)}%</span>
                    <span className="mm-num">UTILISÉ ×{m.use_count || 0}</span>
                    <span className="mm-date">{(m.created_at || "").slice(0, 10)}</span>
                  </div>
                </div>
                <div className="mm-row-actions">
                  {m.status === "contested" && (
                    <button className="mm-icon-btn ok" title="Confirmer cette information"
                      onClick={() => patch(m.id, { status: "active", confidence: 0.95 })}
                      data-testid="mm-confirm-btn">
                      <CheckCircle2 size={14} />
                    </button>
                  )}
                  <button className={`mm-icon-btn ${m.pinned ? "pin-on" : ""}`} title={m.pinned ? "Désépingler" : "Épingler (toujours prioritaire)"}
                    onClick={() => patch(m.id, { pinned: m.pinned ? 0 : 1 })} data-testid="mm-pin-btn">
                    <Star size={13} />
                  </button>
                  <button className="mm-icon-btn" title="Corriger" onClick={() => startEdit(m)} data-testid="mm-edit-btn">
                    <Pencil size={13} />
                  </button>
                  <button className="mm-icon-btn danger" title="Supprimer définitivement" onClick={() => remove(m.id)} data-testid="mm-delete-btn">
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {tab === "audit" && (
          <section className="prime-card mm-wide" data-testid="mm-audit">
            <div className="zc-section-title"><ScrollText size={12} style={{ marginRight: 6 }} />JOURNAL DES OPÉRATIONS MÉMOIRE &amp; SUGGESTIONS</div>
            {audit.length === 0 && <div className="memory-empty">Journal vide.</div>}
            {audit.map((a) => (
              <div className="mm-audit-row" key={a.id}>
                <span className={`mm-audit-kind k-${a.kind}`}>{a.kind.toUpperCase()}</span>
                <span className="mm-audit-detail">{a.detail}</span>
                <span className="mm-date">{(a.created_at || "").slice(0, 16).replace("T", " ")}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

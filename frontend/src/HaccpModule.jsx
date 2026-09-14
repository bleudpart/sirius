// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useState } from "react";
import {
  X, ClipboardCheck, Tag, Thermometer, ShieldCheck, AlertTriangle, SprayCan,
  Wheat, FileText, Plus, Trash2, Check, Printer, FileDown,
} from "lucide-react";
import SectionSheets from "./HaccpSheets";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api/haccp";

const api = async (path, opts) => {
  let r;
  try {
    r = await fetch(`${API}${path}`, opts ? { headers: { "Content-Type": "application/json" }, ...opts } : undefined);
  } catch (e) {
    window.dispatchEvent(new CustomEvent("haccp-error", { detail: "Serveur HACCP injoignable" }));
    throw e;
  }
  if (!r.ok) {
    const detail = (await r.json().catch(() => ({}))).detail;
    const msg = typeof detail === "string" ? detail : "Saisie invalide ou erreur serveur";
    window.dispatchEvent(new CustomEvent("haccp-error", { detail: msg }));
    throw new Error(msg);
  }
  return r.json();
};

const requireField = () => window.dispatchEvent(new CustomEvent("haccp-error", { detail: "Champ obligatoire manquant (*)" }));
const fmtDate = (s) => (s ? s.slice(0, 10).split("-").reverse().join("/") : "—");
const fmtDT = (s) => (s ? `${fmtDate(s)} ${s.slice(11, 16)}` : "—");

const TABS = [
  { key: "trace", label: "TRAÇABILITÉ", Icon: Tag },
  { key: "temp", label: "TEMPÉRATURES", Icon: Thermometer },
  { key: "pms", label: "PMS", Icon: ShieldCheck },
  { key: "nc", label: "NON-CONFORMITÉS", Icon: AlertTriangle },
  { key: "clean", label: "NETTOYAGE", Icon: SprayCan },
  { key: "allerg", label: "ALLERGÈNES", Icon: Wheat },
  { key: "docs", label: "DOCUMENTS", Icon: FileText },
  { key: "sheets", label: "FEUILLES", Icon: Printer },
  { key: "audit", label: "AUDIT PDF", Icon: FileDown },
];

const Dot = ({ tone }) => <span className={`hc-dot ${tone}`} />;

// ---------- 1. Traçabilité & étiquetage ----------
function SectionTrace() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ produit: "", lot: "", fournisseur: "", dlc: "", temperature_reception: "", quantite: "" });
  const [label, setLabel] = useState(null);
  const load = useCallback(() => api("/trace").then((d) => setItems(d.items)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!form.produit.trim()) { requireField(); return; }
    try {
      await api("/trace", { method: "POST", body: JSON.stringify({ ...form, temperature_reception: form.temperature_reception === "" ? null : parseFloat(form.temperature_reception), dlc: form.dlc || null }) });
      setForm({ produit: "", lot: "", fournisseur: "", dlc: "", temperature_reception: "", quantite: "" });
      load();
    } catch (e) {}
  };
  const del = async (id) => { await api(`/trace/${id}`, { method: "DELETE" }).catch(() => {}); load(); };

  return (
    <div className="hc-section" data-testid="haccp-section-trace">
      <div className="hc-form">
        <input className="cmd-input" placeholder="Produit *" value={form.produit} onChange={(e) => setForm({ ...form, produit: e.target.value })} data-testid="haccp-trace-produit" />
        <input className="cmd-input" placeholder="N° de lot" value={form.lot} onChange={(e) => setForm({ ...form, lot: e.target.value })} data-testid="haccp-trace-lot" />
        <input className="cmd-input" placeholder="Fournisseur" value={form.fournisseur} onChange={(e) => setForm({ ...form, fournisseur: e.target.value })} />
        <input className="cmd-input" type="date" title="DLC / DDM" value={form.dlc} onChange={(e) => setForm({ ...form, dlc: e.target.value })} data-testid="haccp-trace-dlc" />
        <input className="cmd-input" type="number" step="0.1" placeholder="T° réception °C" value={form.temperature_reception} onChange={(e) => setForm({ ...form, temperature_reception: e.target.value })} />
        <input className="cmd-input" placeholder="Quantité" value={form.quantite} onChange={(e) => setForm({ ...form, quantite: e.target.value })} />
        <button className="cmd-send" onClick={add} data-testid="haccp-trace-add"><Plus size={14} /> ENREGISTRER</button>
      </div>
      <div className="prime-scroll hc-list">
        {items.map((it) => (
          <div className="hc-row" key={it.id} data-testid={`haccp-trace-row-${it.id}`}>
            <Dot tone={it.statut === "expire" ? "ko" : it.statut === "bientot" ? "warn" : "ok"} />
            <div className="hc-row-main">
              <b>{it.produit}</b>
              <span>Lot {it.lot || "—"} · {it.fournisseur || "—"} · Reçu {fmtDate(it.date_reception)} · DLC {fmtDate(it.dlc)}{it.temperature_reception != null ? ` · ${it.temperature_reception}°C` : ""}{it.quantite ? ` · ${it.quantite}` : ""}</span>
            </div>
            <button className="memory-icon-btn" title="Étiquette" onClick={() => setLabel(it)} data-testid={`haccp-trace-label-${it.id}`}><Printer size={14} /></button>
            <button className="memory-icon-btn danger" title="Supprimer" onClick={() => del(it.id)} data-testid={`haccp-trace-del-${it.id}`}><Trash2 size={14} /></button>
          </div>
        ))}
        {items.length === 0 && <div className="memory-empty">Aucun produit tracé. Enregistrez une réception ci-dessus.</div>}
      </div>
      {label && (
        <div className="hc-label-back" onClick={() => setLabel(null)} data-testid="haccp-label-viewer">
          <div className="hc-label" onClick={(e) => e.stopPropagation()}>
            <div className="hc-label-title">ÉTIQUETTE ΣIRIUS · HACCP</div>
            <div className="hc-label-prod">{label.produit}</div>
            <div className="hc-label-grid">
              <span>LOT</span><b>{label.lot || "—"}</b>
              <span>FOURNISSEUR</span><b>{label.fournisseur || "—"}</b>
              <span>RÉCEPTION</span><b>{fmtDate(label.date_reception)}</b>
              <span>DLC / DDM</span><b>{fmtDate(label.dlc)}</b>
              {label.quantite ? <><span>QUANTITÉ</span><b>{label.quantite}</b></> : null}
            </div>
            <button className="cmd-send" onClick={() => window.print()}><Printer size={13} /> IMPRIMER</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- 2. Températures réglementaires ----------
function SectionTemp() {
  const [equips, setEquips] = useState([]);
  const [hist, setHist] = useState([]);
  const [eqForm, setEqForm] = useState({ nom: "", type: "frigo" });
  const [reads, setReads] = useState({});
  const load = useCallback(() => Promise.all([
    api("/equipements").then((d) => setEquips(d.items)),
    api("/temperatures").then((d) => setHist(d.items)),
  ]).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const addEquip = async () => {
    if (!eqForm.nom.trim()) { requireField(); return; }
    try {
      await api("/equipements", { method: "POST", body: JSON.stringify(eqForm) });
      setEqForm({ nom: "", type: "frigo" });
      load();
    } catch (e) {}
  };
  const releve = async (eq) => {
    const v = reads[eq.id];
    if (v === undefined || v === "") return;
    await api("/temperatures", { method: "POST", body: JSON.stringify({ equipement_id: eq.id, valeur: parseFloat(v) }) }).catch(() => {});
    setReads((s) => ({ ...s, [eq.id]: "" }));
    load();
  };

  return (
    <div className="hc-section" data-testid="haccp-section-temp">
      <div className="hc-form">
        <input className="cmd-input" placeholder="Nouvel équipement (ex : Frigo pâtisserie)" value={eqForm.nom} onChange={(e) => setEqForm({ ...eqForm, nom: e.target.value })} data-testid="haccp-equip-nom" />
        <select className="cmd-input hc-select" value={eqForm.type} onChange={(e) => setEqForm({ ...eqForm, type: e.target.value })} data-testid="haccp-equip-type">
          <option value="frigo">Froid positif (0 à +4°C)</option>
          <option value="congelateur">Congélateur (≤ -18°C)</option>
          <option value="chaud">Liaison chaude (≥ +63°C)</option>
        </select>
        <button className="cmd-send" onClick={addEquip} data-testid="haccp-equip-add"><Plus size={14} /> AJOUTER</button>
      </div>
      <div className="hc-equip-grid">
        {equips.map((eq) => {
          const last = eq.dernier_releve;
          return (
            <div className="hc-equip" key={eq.id} data-testid={`haccp-equip-${eq.id}`}>
              <div className="hc-equip-head">
                <b>{eq.nom}</b>
                <span>[{eq.min}°C ; {eq.max}°C]</span>
              </div>
              <div className={`hc-equip-val ${last ? (last.conforme ? "ok" : "ko") : ""}`}>
                {last ? `${last.valeur}°C` : "—"}
              </div>
              <div className="hc-equip-sub">{last ? `${fmtDT(last.created_at)} · ${last.conforme ? "CONFORME" : "NON CONFORME"}` : "Aucun relevé"}</div>
              <div className="hc-equip-form">
                <input className="cmd-input" type="number" step="0.1" placeholder="°C" value={reads[eq.id] ?? ""} onChange={(e) => setReads((s) => ({ ...s, [eq.id]: e.target.value }))} data-testid={`haccp-temp-input-${eq.id}`} />
                <button className="cmd-send" onClick={() => releve(eq)} data-testid={`haccp-temp-save-${eq.id}`}><Check size={13} /></button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="zc-section-title" style={{ marginTop: 14 }}>HISTORIQUE DES RELEVÉS</div>
      <div className="prime-scroll hc-list" style={{ maxHeight: 180 }}>
        {hist.map((h) => (
          <div className="hc-row" key={h.id}>
            <Dot tone={h.conforme ? "ok" : "ko"} />
            <div className="hc-row-main"><b>{h.equipement}</b><span>{h.valeur}°C · {fmtDT(h.created_at)} · {h.conforme ? "conforme" : "NON CONFORME"}</span></div>
          </div>
        ))}
        {hist.length === 0 && <div className="memory-empty">Aucun relevé enregistré.</div>}
      </div>
    </div>
  );
}

// ---------- 3. Plan de maîtrise sanitaire ----------
const PMS_STATUS = { en_place: ["EN PLACE", "ok"], a_mettre_a_jour: ["À METTRE À JOUR", "warn"], a_verifier: ["À VÉRIFIER", "ko"] };
function SectionPms() {
  const [items, setItems] = useState([]);
  const load = useCallback(() => api("/pms").then((d) => setItems(d.items)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const cycle = async (it) => {
    const order = ["a_verifier", "a_mettre_a_jour", "en_place"];
    const next = order[(order.indexOf(it.statut) + 1) % 3];
    await api(`/pms/${it.id}`, { method: "PATCH", body: JSON.stringify({ statut: next }) }).catch(() => {});
    load();
  };
  const cats = [...new Set(items.map((i) => i.categorie))];
  return (
    <div className="hc-section" data-testid="haccp-section-pms">
      <p className="pantheon-hint">Cliquez sur le statut d'un élément pour le faire évoluer : à vérifier → à mettre à jour → en place.</p>
      {cats.map((cat) => (
        <div key={cat}>
          <div className="zc-section-title" style={{ marginTop: 12 }}>{cat.toUpperCase()}</div>
          {items.filter((i) => i.categorie === cat).map((it) => {
            const [txt, tone] = PMS_STATUS[it.statut] || PMS_STATUS.a_verifier;
            return (
              <div className="hc-row" key={it.id}>
                <Dot tone={tone} />
                <div className="hc-row-main"><b>{it.intitule}</b><span>{it.code} · Dernière révision : {fmtDate(it.derniere_revision)}</span></div>
                <button className={`hc-badge ${tone}`} onClick={() => cycle(it)} data-testid={`haccp-pms-status-${it.id}`}>{txt}</button>
              </div>
            );
          })}
        </div>
      ))}
      {items.length === 0 && <div className="memory-empty">Chargement du plan de maîtrise sanitaire...</div>}
    </div>
  );
}

// ---------- 4. Non-conformités ----------
function SectionNc() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ type: "température", description: "", action_corrective: "", gravite: "mineure" });
  const load = useCallback(() => api("/nc").then((d) => setItems(d.items)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!form.description.trim()) { requireField(); return; }
    try {
      await api("/nc", { method: "POST", body: JSON.stringify(form) });
      setForm({ type: "température", description: "", action_corrective: "", gravite: "mineure" });
      load();
    } catch (e) {}
  };
  const close = async (id) => { await api(`/nc/${id}/cloture`, { method: "PATCH", body: JSON.stringify({}) }).catch(() => {}); load(); };
  const del = async (id) => { await api(`/nc/${id}`, { method: "DELETE" }).catch(() => {}); load(); };
  return (
    <div className="hc-section" data-testid="haccp-section-nc">
      <div className="hc-form">
        <select className="cmd-input hc-select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} data-testid="haccp-nc-type">
          {["température", "réception", "hygiène", "corps étranger", "DLC dépassée", "autre"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="cmd-input hc-select" value={form.gravite} onChange={(e) => setForm({ ...form, gravite: e.target.value })} data-testid="haccp-nc-gravite">
          {["mineure", "majeure", "critique"].map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <input className="cmd-input hc-wide" placeholder="Description *" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} data-testid="haccp-nc-desc" />
        <input className="cmd-input hc-wide" placeholder="Action corrective" value={form.action_corrective} onChange={(e) => setForm({ ...form, action_corrective: e.target.value })} data-testid="haccp-nc-action" />
        <button className="cmd-send" onClick={add} data-testid="haccp-nc-add"><Plus size={14} /> DÉCLARER</button>
      </div>
      <div className="prime-scroll hc-list">
        {items.map((it) => (
          <div className="hc-row" key={it.id} data-testid={`haccp-nc-row-${it.id}`}>
            <Dot tone={it.statut === "ouverte" ? (it.gravite === "critique" ? "ko" : "warn") : "ok"} />
            <div className="hc-row-main">
              <b>{it.type.toUpperCase()} · {it.gravite}{it.auto ? " · auto (relevé T°)" : ""}</b>
              <span>{it.description}{it.action_corrective ? ` — Action : ${it.action_corrective}` : ""} · {fmtDT(it.created_at)}{it.statut === "cloturee" ? ` · clôturée le ${fmtDate(it.cloture_le)}` : ""}</span>
            </div>
            {it.statut === "ouverte" && <button className="hc-badge ok" onClick={() => close(it.id)} data-testid={`haccp-nc-close-${it.id}`}>CLÔTURER</button>}
            <button className="memory-icon-btn danger" onClick={() => del(it.id)} title="Supprimer" data-testid={`haccp-nc-del-${it.id}`}><Trash2 size={14} /></button>
          </div>
        ))}
        {items.length === 0 && <div className="memory-empty">Aucune non-conformité enregistrée.</div>}
      </div>
    </div>
  );
}

// ---------- 5. Nettoyage & désinfection ----------
function SectionClean() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ zone: "", surface: "", produit: "", frequence: "quotidien", responsable: "" });
  const load = useCallback(() => api("/nettoyage/taches").then((d) => setItems(d.items)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!form.zone.trim()) { requireField(); return; }
    try {
      await api("/nettoyage/taches", { method: "POST", body: JSON.stringify(form) });
      setForm({ zone: "", surface: "", produit: "", frequence: "quotidien", responsable: "" });
      load();
    } catch (e) {}
  };
  const done = async (id) => { await api("/nettoyage/logs", { method: "POST", body: JSON.stringify({ tache_id: id }) }).catch(() => {}); load(); };
  const del = async (id) => { await api(`/nettoyage/taches/${id}`, { method: "DELETE" }).catch(() => {}); load(); };
  return (
    <div className="hc-section" data-testid="haccp-section-clean">
      <div className="hc-form">
        <input className="cmd-input" placeholder="Zone * (ex : Plan de travail)" value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} data-testid="haccp-clean-zone" />
        <input className="cmd-input" placeholder="Produit utilisé" value={form.produit} onChange={(e) => setForm({ ...form, produit: e.target.value })} data-testid="haccp-clean-produit" />
        <select className="cmd-input hc-select" value={form.frequence} onChange={(e) => setForm({ ...form, frequence: e.target.value })} data-testid="haccp-clean-frequence">
          <option value="quotidien">Quotidien</option>
          <option value="hebdomadaire">Hebdomadaire</option>
          <option value="mensuel">Mensuel</option>
        </select>
        <input className="cmd-input" placeholder="Responsable" value={form.responsable} onChange={(e) => setForm({ ...form, responsable: e.target.value })} data-testid="haccp-clean-responsable" />
        <button className="cmd-send" onClick={add} data-testid="haccp-clean-add"><Plus size={14} /> AJOUTER AU PLAN</button>
      </div>
      <div className="prime-scroll hc-list">
        {items.map((it) => (
          <div className="hc-row" key={it.id} data-testid={`haccp-clean-row-${it.id}`}>
            <Dot tone={it.a_faire ? "warn" : "ok"} />
            <div className="hc-row-main">
              <b>{it.zone}</b>
              <span>{it.frequence}{it.produit ? ` · ${it.produit}` : ""}{it.responsable ? ` · ${it.responsable}` : ""} · Dernier : {it.dernier_nettoyage ? fmtDT(it.dernier_nettoyage) : "jamais"}</span>
            </div>
            <button className={`hc-badge ${it.a_faire ? "warn" : "ok"}`} onClick={() => done(it.id)} data-testid={`haccp-clean-done-${it.id}`}>
              {it.a_faire ? "À FAIRE — VALIDER" : "FAIT ✓"}
            </button>
            <button className="memory-icon-btn danger" onClick={() => del(it.id)} title="Supprimer" data-testid={`haccp-clean-del-${it.id}`}><Trash2 size={14} /></button>
          </div>
        ))}
        {items.length === 0 && <div className="memory-empty">Plan de nettoyage vide. Ajoutez vos zones ci-dessus.</div>}
      </div>
    </div>
  );
}

// ---------- 6. Allergènes ----------
function SectionAllerg() {
  const [items, setItems] = useState([]);
  const [liste, setListe] = useState([]);
  const [plat, setPlat] = useState("");
  const [sel, setSel] = useState([]);
  const load = useCallback(() => api("/allergenes").then((d) => { setItems(d.items); setListe(d.liste_14); }).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const toggle = (a) => setSel((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a]));
  const add = async () => {
    if (!plat.trim()) { requireField(); return; }
    try {
      await api("/allergenes", { method: "POST", body: JSON.stringify({ plat, allergenes: sel }) });
      setPlat(""); setSel([]);
      load();
    } catch (e) {}
  };
  const del = async (id) => { await api(`/allergenes/${id}`, { method: "DELETE" }).catch(() => {}); load(); };
  return (
    <div className="hc-section" data-testid="haccp-section-allerg">
      <div className="hc-form">
        <input className="cmd-input hc-wide" placeholder="Nom du plat *" value={plat} onChange={(e) => setPlat(e.target.value)} data-testid="haccp-allerg-plat" />
        <button className="cmd-send" onClick={add} data-testid="haccp-allerg-add"><Plus size={14} /> AJOUTER LE PLAT</button>
      </div>
      <div className="hc-allerg-picker">
        {liste.map((a) => (
          <button key={a} className={`hc-chip ${sel.includes(a) ? "on" : ""}`} onClick={() => toggle(a)} data-testid={`haccp-allerg-chip-${a}`}>{a}</button>
        ))}
      </div>
      <div className="prime-scroll hc-list">
        {items.map((it) => (
          <div className="hc-row" key={it.id} data-testid={`haccp-allerg-row-${it.id}`}>
            <Dot tone={it.allergenes.length ? "warn" : "ok"} />
            <div className="hc-row-main">
              <b>{it.plat}</b>
              <span>{it.allergenes.length ? it.allergenes.join(" · ") : "Sans allergène majeur déclaré"}</span>
            </div>
            <button className="memory-icon-btn danger" onClick={() => del(it.id)} title="Supprimer" data-testid={`haccp-allerg-del-${it.id}`}><Trash2 size={14} /></button>
          </div>
        ))}
        {items.length === 0 && <div className="memory-empty">Aucun plat déclaré. Les 14 allergènes majeurs (UE) sont sélectionnables ci-dessus.</div>}
      </div>
    </div>
  );
}

// ---------- 7. Documentation obligatoire ----------
function SectionDocs() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ nom: "", categorie: "agrément", date_expiration: "" });
  const load = useCallback(() => api("/documents").then((d) => setItems(d.items)).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  const add = async () => {
    if (!form.nom.trim()) { requireField(); return; }
    try {
      await api("/documents", { method: "POST", body: JSON.stringify({ ...form, date_expiration: form.date_expiration || null }) });
      setForm({ nom: "", categorie: "agrément", date_expiration: "" });
      load();
    } catch (e) {}
  };
  const del = async (id) => { await api(`/documents/${id}`, { method: "DELETE" }).catch(() => {}); load(); };
  return (
    <div className="hc-section" data-testid="haccp-section-docs">
      <div className="hc-form">
        <input className="cmd-input hc-wide" placeholder="Document * (ex : Attestation formation hygiène)" value={form.nom} onChange={(e) => setForm({ ...form, nom: e.target.value })} data-testid="haccp-doc-nom" />
        <select className="cmd-input hc-select" value={form.categorie} onChange={(e) => setForm({ ...form, categorie: e.target.value })} data-testid="haccp-doc-categorie">
          {["agrément", "formation", "analyses", "contrats (nuisibles, hotte...)", "fiches techniques", "autre"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="cmd-input" type="date" title="Date d'expiration" value={form.date_expiration} onChange={(e) => setForm({ ...form, date_expiration: e.target.value })} data-testid="haccp-doc-expiration" />
        <button className="cmd-send" onClick={add} data-testid="haccp-doc-add"><Plus size={14} /> ENREGISTRER</button>
      </div>
      <div className="prime-scroll hc-list">
        {items.map((it) => (
          <div className="hc-row" key={it.id} data-testid={`haccp-doc-row-${it.id}`}>
            <Dot tone={it.statut === "expire" ? "ko" : it.statut === "bientot" ? "warn" : "ok"} />
            <div className="hc-row-main">
              <b>{it.nom}</b>
              <span>{it.categorie} · Expiration : {fmtDate(it.date_expiration)}{it.statut === "expire" ? " · EXPIRÉ" : it.statut === "bientot" ? " · expire bientôt" : ""}</span>
            </div>
            <button className="memory-icon-btn danger" onClick={() => del(it.id)} title="Supprimer" data-testid={`haccp-doc-del-${it.id}`}><Trash2 size={14} /></button>
          </div>
        ))}
        {items.length === 0 && <div className="memory-empty">Registre documentaire vide (agrément, formations, analyses, contrats...).</div>}
      </div>
    </div>
  );
}

function SectionAudit() {
  const [dateDebut, setDateDebut] = useState("");
  const [dateFin, setDateFin] = useState("");
  const [busy, setBusy] = useState(false);
  const [sections, setSections] = useState({ trace: true, temp: true, pms: true, nc: true, clean: true, allerg: true, docs: true });
  const labels = { trace: "Traçabilité", temp: "Températures", pms: "PMS", nc: "Non-conformités", clean: "Nettoyage", allerg: "Allergènes", docs: "Documents" };

  const generate = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${API}/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date_debut: dateDebut || null, date_fin: dateFin || null, inclure_sections: Object.keys(sections).filter((key) => sections[key]) }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))).detail;
        throw new Error(typeof detail === "string" ? detail : "Génération du rapport refusée.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `audit_haccp_${new Date().toISOString().slice(0, 10)}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      window.dispatchEvent(new CustomEvent("haccp-error", { detail: error.message || "Génération du rapport impossible." }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hc-section" data-testid="haccp-section-audit">
      <div className="zc-section-title">RAPPORT D’AUDIT HACCP</div>
      <p className="pantheon-hint">Synthèse PDF des contrôles enregistrés pour préparer un audit interne.</p>
      <div className="hc-form">
        <div className="hc-row-main"><label>Du <input className="cmd-input" type="date" value={dateDebut} onChange={(e) => setDateDebut(e.target.value)} /></label><label>Au <input className="cmd-input" type="date" value={dateFin} onChange={(e) => setDateFin(e.target.value)} /></label></div>
        <div className="hc-row-main">{Object.entries(sections).map(([key, checked]) => <label key={key}><input type="checkbox" checked={checked} onChange={(e) => setSections({ ...sections, [key]: e.target.checked })} /> {labels[key]}</label>)}</div>
        <button className="cmd-send" onClick={generate} disabled={busy || !Object.values(sections).some(Boolean)}><FileDown size={14} /> {busy ? "GÉNÉRATION…" : "GÉNÉRER LE PDF"}</button>
      </div>
      <p className="hc-note">Ce rapport est un outil de suivi interne et ne constitue pas une certification officielle.</p>
    </div>
  );
}

const SECTIONS = { trace: SectionTrace, temp: SectionTemp, pms: SectionPms, nc: SectionNc, clean: SectionClean, allerg: SectionAllerg, docs: SectionDocs, sheets: SectionSheets, audit: SectionAudit };

export default function HaccpModule({ onClose }) {
  const [tab, setTab] = useState("trace");
  const [ov, setOv] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const onErr = (e) => {
      setErr(e.detail || "Erreur");
      setTimeout(() => setErr(""), 4000);
    };
    window.addEventListener("haccp-error", onErr);
    return () => window.removeEventListener("haccp-error", onErr);
  }, []);
  useEffect(() => {
    const load = () => fetch(`${API}/overview`).then((r) => r.json()).then(setOv).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [tab]);
  const Section = SECTIONS[tab];
  return (
    <div className="prime-screen" data-testid="haccp-panel">
      <header className="zeus-head">
        <div className="oracle-title font-divine"><ClipboardCheck size={20} /> HACCP — HYGIÈNE &amp; SÉCURITÉ ALIMENTAIRE</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="haccp-close-btn"><X size={18} /></button>
      </header>
      <div className="prime-sub">TRAÇABILITÉ · TEMPÉRATURES · PMS · NON-CONFORMITÉS · NETTOYAGE · ALLERGÈNES · DOCUMENTS</div>
      {ov && (
        <div className="hc-alerts" data-testid="haccp-alerts">
          <span className={ov.dlc_alertes ? "ko" : "ok"}>DLC : {ov.dlc_alertes} alerte(s)</span>
          <span className={ov.temp_non_conformes_jour ? "ko" : "ok"}>T° non conformes (jour) : {ov.temp_non_conformes_jour}</span>
          <span className={ov.nc_ouvertes ? "warn" : "ok"}>NC ouvertes : {ov.nc_ouvertes}</span>
          <span className={ov.docs_alertes ? "warn" : "ok"}>Documents à renouveler : {ov.docs_alertes}</span>
        </div>
      )}
      <div className="hc-tabs" data-testid="haccp-tabs">
        {TABS.map(({ key, label, Icon }) => (
          <button key={key} className={`hc-tab ${tab === key ? "on" : ""}`} onClick={() => setTab(key)} data-testid={`haccp-tab-${key}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>
      <div className="hc-body prime-card">
        {err && <div className="dev-error" data-testid="haccp-error">{err}</div>}
        <Section />
      </div>
    </div>
  );
}

// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
import { useCallback, useEffect, useState } from "react";
import { BarChart3, Building2, CreditCard, Download, Link2, MapPin, Printer, RefreshCw, Search, ShieldCheck, Users, X } from "lucide-react";

const API = process.env.REACT_APP_BACKEND_URL;
const ROLES = ["admin", "manager", "operator", "viewer"];

const requestApi = async (path, options) => {
  const response = await fetch(`${API}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Action impossible");
  return data;
};

const fmtDate = (value) => {
  if (!value) return "—";
  try { return new Date(value).toLocaleString("fr-FR"); } catch (e) { return value; }
};

export default function EnterprisePanel({ onClose }) {
  const [context, setContext] = useState(null);
  const [members, setMembers] = useState([]);
  const [sites, setSites] = useState([]);
  const [stats, setStats] = useState(null);
  const [license, setLicense] = useState(null);
  const [integrations, setIntegrations] = useState([]);
  const [audit, setAudit] = useState([]);
  const [backups, setBackups] = useState([]);
  const [companyName, setCompanyName] = useState("");
  const [newMemberEmail, setNewMemberEmail] = useState("");
  const [newMemberRole, setNewMemberRole] = useState("operator");
  const [newSiteName, setNewSiteName] = useState("");
  const [newSiteAddress, setNewSiteAddress] = useState("");
  const [search, setSearch] = useState("");
  const [auditAction, setAuditAction] = useState("all");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const data = await requestApi("/api/enterprise/context");
      setContext(data);
      if (data.company) {
        const [memberData, auditData, backupData, siteData, statsData, licenseData, integrationData] = await Promise.all([
          requestApi("/api/enterprise/members"),
          requestApi("/api/enterprise/audit?limit=100"),
          requestApi("/api/enterprise/backups"),
          requestApi("/api/enterprise/sites"),
          requestApi("/api/enterprise/stats"),
          requestApi("/api/enterprise/license"),
          requestApi("/api/enterprise/integrations"),
        ]);
        setMembers(memberData.members || []);
        setAudit(auditData.items || []);
        setBackups(backupData.items || []);
        setSites(siteData.items || []);
        setStats(statsData.values || null);
        setLicense(licenseData);
        setIntegrations(integrationData.items || []);
      }
    } catch (e) { setError(e.message); }
    setBusy(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const createCompany = async (event) => {
    event.preventDefault();
    if (!companyName.trim()) return;
    setBusy(true); setError("");
    try {
      await requestApi("/api/enterprise", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: companyName }) });
      setCompanyName(""); await load();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const updateRole = async (member, role) => {
    setError("");
    try { await requestApi(`/api/enterprise/members/${encodeURIComponent(member.user_id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role }) }); await load(); }
    catch (e) { setError(e.message); }
  };

  const addMember = async (event) => {
    event.preventDefault();
    if (!newMemberEmail.trim()) return;
    setBusy(true); setError("");
    try {
      await requestApi("/api/enterprise/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: newMemberEmail, role: newMemberRole }) });
      setNewMemberEmail(""); setNewMemberRole("operator"); await load();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const addSite = async (event) => {
    event.preventDefault();
    if (!newSiteName.trim()) return;
    setBusy(true); setError("");
    try {
      await requestApi("/api/enterprise/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newSiteName, address: newSiteAddress }) });
      setNewSiteName(""); setNewSiteAddress(""); await load();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const downloadBackup = async () => {
    setError("");
    try {
      const response = await fetch(`${API}/api/enterprise/backups`, { method: "POST" });
      if (!response.ok) throw new Error((await response.json()).detail || "Sauvegarde impossible");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a"); link.href = url; link.download = "sirius-entreprise-backup.zip"; link.click(); URL.revokeObjectURL(url);
      await load();
    } catch (e) { setError(e.message); }
  };

  const restoreBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || role !== "admin") return;
    if (!window.confirm("Restaurer cette sauvegarde et remplacer les données de l'entreprise ?")) return;
    setBusy(true); setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`${API}/api/enterprise/backups/restore?confirm=true`, { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Restauration impossible");
      await load();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const normalizedSearch = search.trim().toLowerCase();
  const visibleMembers = members.filter((member) => !normalizedSearch || [member.name, member.email, member.role].join(" ").toLowerCase().includes(normalizedSearch));
  const auditActions = [...new Set(audit.map((event) => event.action).filter(Boolean))].sort();
  const visibleAudit = audit.filter((event) => (auditAction === "all" || event.action === auditAction) && (!normalizedSearch || [event.action, event.resource, event.user_email, event.details && JSON.stringify(event.details)].join(" ").toLowerCase().includes(normalizedSearch)));

  const printAudit = () => window.print();

  const role = context?.membership?.role;
  return (
    <div className="prime-screen" data-testid="enterprise-panel">
      <header className="zeus-head">
        <div className="zeus-title enterprise-title font-divine"><Building2 size={20} /> ΣIRIUS ENTREPRISE</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="file-btn" onClick={load} disabled={busy} title="Actualiser"><RefreshCw size={13} /></button>
          <button className="setup-close zeus-close" onClick={onClose} title="Fermer"><X size={15} /></button>
        </div>
      </header>
      <div className="gcal-body">
        {error && <div className="auth-error" role="alert">{error}</div>}
        {!context && !error && <div className="admin-loading">Chargement de l'espace entreprise…</div>}
        {context && !context.company && (
          <form onSubmit={createCompany} className="setup-card" style={{ maxWidth: 560 }}>
            <h2><Building2 size={18} /> Créer un espace entreprise</h2>
            <p>Le premier espace créé sera administré par ton compte.</p>
            <input value={companyName} onChange={(event) => setCompanyName(event.target.value)} placeholder="Nom de l'entreprise" maxLength={160} />
            <button className="setup-primary" disabled={busy || !companyName.trim()}>Créer l'espace</button>
          </form>
        )}
        {context?.company && (
          <>
            <div className="admin-total"><Building2 size={15} /> {context.company.name} · rôle {role}</div>
            <div className="enterprise-tools" role="search">
              <label className="enterprise-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Rechercher membres, actions, ressources…" aria-label="Recherche globale entreprise" /></label>
              <select value={auditAction} onChange={(event) => setAuditAction(event.target.value)} aria-label="Filtrer le journal">
                <option value="all">Toutes les actions</option>
                {auditActions.map((action) => <option key={action} value={action}>{action}</option>)}
              </select>
              <button className="file-btn enterprise-print" onClick={printAudit} title="Imprimer le journal"><Printer size={14} /></button>
            </div>
            <section className="setup-card enterprise-admin-grid">
              <div>
                <h2><BarChart3 size={18} /> Tableau de bord</h2>
                <div className="enterprise-stats">
                  {Object.entries(stats || {}).map(([key, value]) => <div key={key} className="enterprise-stat"><b>{value}</b><span>{key.replaceAll("_", " ")}</span></div>)}
                </div>
              </div>
              {license && <div className="enterprise-license"><h2><CreditCard size={18} /> Licence</h2><b>{license.plan}</b><span>{license.status} · {license.billing}</span><small>Support : {license.support}</small></div>}
            </section>
            <section className="setup-card">
              <h2><MapPin size={18} /> Établissements</h2>
              {(role === "admin" || role === "manager") && <form onSubmit={addSite} className="enterprise-site-form">
                <input value={newSiteName} onChange={(event) => setNewSiteName(event.target.value)} placeholder="Nom de l'établissement" required />
                <input value={newSiteAddress} onChange={(event) => setNewSiteAddress(event.target.value)} placeholder="Adresse (facultatif)" />
                <button className="setup-primary" disabled={busy || !newSiteName.trim()}><MapPin size={14} /> Ajouter</button>
              </form>}
              <div className="enterprise-sites">{sites.map((site) => <div className="enterprise-site" key={site.id}><MapPin size={14} /><span><b>{site.name}</b><small>{site.address || "Adresse non renseignée"}</small></span><em>{site.active ? "ACTIF" : "INACTIF"}</em></div>)}{!sites.length && <p className="pantheon-hint">Aucun établissement configuré.</p>}</div>
            </section>
            <section className="setup-card">
              <h2><Link2 size={18} /> Intégrations</h2>
              <div className="enterprise-integrations">{integrations.map((item) => <div className="enterprise-integration" key={item.id}><span><b>{item.label}</b><small>{item.action}</small></span><em className={item.connected ? "connected" : item.configured ? "configured" : "offline"}>{item.connected ? "CONNECTÉ" : item.configured ? "CONFIGURÉ" : "À CONFIGURER"}</em></div>)}</div>
            </section>
            <section className="setup-card">
              <h2><Users size={18} /> Membres et rôles</h2>
              {(role === "admin" || role === "manager") && <form onSubmit={addMember} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <input type="email" value={newMemberEmail} onChange={(event) => setNewMemberEmail(event.target.value)} placeholder="E-mail d'un compte existant" required />
                <select value={newMemberRole} onChange={(event) => setNewMemberRole(event.target.value)} aria-label="Rôle du nouveau membre">
                  {ROLES.filter((item) => item !== "admin").map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <button className="setup-primary" disabled={busy || !newMemberEmail.trim()}><Users size={14} /> Ajouter</button>
              </form>}
              {visibleMembers.map((member) => (
                <div key={member.user_id} className="admin-user-cell" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                  <span><b>{member.name || member.email}</b><small>{member.email}</small></span>
                  <select value={member.role} disabled={role !== "admin" && role !== "manager"} onChange={(event) => updateRole(member, event.target.value)}>
                    {ROLES.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </div>
              ))}
            </section>
            <section className="setup-card">
              <h2><Download size={18} /> Sauvegardes</h2>
              <button className="setup-primary" onClick={downloadBackup} disabled={busy || !["admin", "manager"].includes(role)}><Download size={14} /> Créer une sauvegarde</button>
              <div className="admin-table-wrap" style={{ marginTop: 12 }}>
                <table className="admin-table"><thead><tr><th>DATE</th><th>TAILLE</th><th>FICHIER</th></tr></thead><tbody>
                  {backups.map((backup) => <tr key={backup.name}><td>{fmtDate(backup.created_at)}</td><td>{Math.ceil(backup.size / 1024)} Ko</td><td>{backup.name}</td></tr>)}
                  {!backups.length && <tr><td colSpan="3">Aucune sauvegarde disponible.</td></tr>}
                </tbody></table>
              </div>
              {role === "admin" && <label className="setup-primary" style={{ display: "inline-flex", marginTop: 10, cursor: busy ? "wait" : "pointer" }}>
                <RefreshCw size={14} /> Restaurer une sauvegarde
                <input type="file" accept=".zip,application/zip" onChange={restoreBackup} disabled={busy} hidden />
              </label>}
            </section>
            <section className="setup-card">
              <h2><ShieldCheck size={18} /> Journal auditable</h2>
              <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>DATE</th><th>ACTION</th><th>RESSOURCE</th><th>UTILISATEUR</th></tr></thead><tbody>
                {visibleAudit.map((event) => <tr key={event.id}><td>{fmtDate(event.created_at)}</td><td>{event.action}</td><td>{event.resource}</td><td>{event.user_email || event.user_id}</td></tr>)}
                {!visibleAudit.length && <tr><td colSpan="4">Aucun événement correspondant.</td></tr>}
              </tbody></table></div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
// © 2026 Daniel Partel – SIRIUS Assistant. Panneau d'administration : comptes inscrits, activité, désactivation et suppression.
import { useEffect, useState } from "react";
import { ShieldCheck, RefreshCw, User, Ban, CheckCircle2, Trash2 } from "lucide-react";
import { ConfirmButton } from "@/ConfirmButton";

const API = process.env.REACT_APP_BACKEND_URL;

const fmtDate = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  } catch (e) { return iso.slice(0, 10); }
};

export default function AdminPanel({ onClose }) {
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API}/api/admin/users`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Accès refusé");
      setUsers(data.users);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  useEffect(() => { load(); }, []);

  const toggleDisable = async (u) => {
    setErr("");
    const r = await fetch(`${API}/api/admin/users/${u.user_id}/disable`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !u.disabled }),
    });
    if (r.ok) load();
    else setErr((await r.json()).detail || "Action impossible");
  };

  const removeUser = async (u) => {
    setErr("");
    const r = await fetch(`${API}/api/admin/users/${u.user_id}`, { method: "DELETE" });
    if (r.ok) load();
    else setErr((await r.json()).detail || "Suppression impossible");
  };

  return (
    <div className="prime-screen" data-testid="admin-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><ShieldCheck size={20} /> ADMINISTRATION — COMPTES</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="file-btn" onClick={load} disabled={busy} title="Actualiser" data-testid="admin-refresh-btn"><RefreshCw size={13} /></button>
          <button className="setup-close zeus-close" onClick={onClose} data-testid="admin-close-btn">✕</button>
        </div>
      </header>
      <div className="gcal-body">
        {err && <div className="auth-error" data-testid="admin-error">{err}</div>}
        {!err && users === null && <div className="admin-loading" data-testid="admin-loading">Chargement des comptes…</div>}
        {users && (
          <>
            <div className="admin-total" data-testid="admin-total">{users.length} compte{users.length > 1 ? "s" : ""} inscrit{users.length > 1 ? "s" : ""}</div>
            <div className="admin-table-wrap">
              <table className="admin-table" data-testid="admin-users-table">
                <thead>
                  <tr>
                    <th>COMPTE</th><th>INSCRIT LE</th><th>DERNIÈRE ACTIVITÉ</th>
                    <th>MESSAGES</th><th>SOUVENIRS</th><th>DEALS</th><th>PAIEMENTS</th><th>DOCS THÉMIS</th><th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.user_id} className={u.disabled ? "admin-row-disabled" : ""} data-testid={`admin-user-row-${u.user_id}`}>
                      <td>
                        <div className="admin-user-cell">
                          {u.picture ? <img src={u.picture} alt="" /> : <span className="admin-user-ico"><User size={12} /></span>}
                          <div>
                            <b>{u.name || u.email}
                              {u.role === "admin" && <span className="auth-admin-badge">ADMIN</span>}
                              {u.disabled && <span className="admin-badge-disabled" data-testid={`admin-disabled-badge-${u.user_id}`}>DÉSACTIVÉ</span>}
                            </b>
                            <small>{u.email} · {u.provider === "google" ? "Google" : "Email"}</small>
                          </div>
                        </div>
                      </td>
                      <td>{fmtDate(u.created_at)}</td>
                      <td>{fmtDate(u.activity.last_activity)}</td>
                      <td className="admin-num">{u.activity.messages}</td>
                      <td className="admin-num">{u.activity.facts}</td>
                      <td className="admin-num">{u.activity.deals}</td>
                      <td className="admin-num">{u.activity.transactions}</td>
                      <td className="admin-num">{u.activity.themis_docs}</td>
                      <td>
                        {u.role !== "admin" && (
                          <div className="admin-actions">
                            <button className="file-btn" title={u.disabled ? "Réactiver le compte" : "Désactiver le compte"}
                              onClick={() => toggleDisable(u)} data-testid={`admin-disable-btn-${u.user_id}`}>
                              {u.disabled ? <CheckCircle2 size={13} /> : <Ban size={13} />}
                            </button>
                            <ConfirmButton className="file-btn danger" title="Supprimer le compte et TOUTES ses données"
                              label="SÛR ?" testId={`admin-delete-btn-${u.user_id}`} onConfirm={() => removeUser(u)}>
                              <Trash2 size={13} />
                            </ConfirmButton>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="admin-note">Désactiver = connexion bloquée, données conservées. Supprimer = compte et toutes ses données (chats, mémoire, deals, Thémis, paiements) effacés définitivement.</p>
          </>
        )}
      </div>
    </div>
  );
}

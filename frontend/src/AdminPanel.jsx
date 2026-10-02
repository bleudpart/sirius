// © 2026 Daniel Partel – ΣIRIUS Assistant. Panneau d'administration : comptes inscrits, activité, désactivation et suppression.
import { useEffect, useState } from "react";
import { ShieldCheck, RefreshCw, User, Ban, CheckCircle2, Trash2 } from "lucide-react";
import { ConfirmButton } from "@/ConfirmButton";
import { BACKEND_BASE_URL } from "@/lib/api";

const API = BACKEND_BASE_URL;

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
  const [reviewOnly, setReviewOnly] = useState(false);
  const [notice, setNotice] = useState("");
  const [deletionPlan, setDeletionPlan] = useState(null);
  const [reviewId, setReviewId] = useState("");
  const [externalReviewed, setExternalReviewed] = useState(false);
  const [activityStopped, setActivityStopped] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const needsReview = (u) => Boolean(u.deletion_request)
    || ["review_required", "unknown"].includes(u.inactivity_review?.status);

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
    const r = await fetch(`${API}/api/admin/users/${encodeURIComponent(u.user_id)}/disable`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !u.disabled }),
    });
    if (r.ok) load();
    else setErr((await r.json()).detail || "Action impossible");
  };

  const removeUser = async (u) => {
    setErr(""); setNotice("");
    try {
      const r = await fetch(`${API}/api/admin/users/${encodeURIComponent(u.user_id)}`, { method: "DELETE" });
      const result = await r.json();
      if (!r.ok) throw new Error(result.detail || "Demande de suppression impossible");
      setNotice(result.message || "La suppression n’est pas confirmée.");
      await load();
    } catch (error) {
      setErr(error.message || "Demande de suppression impossible");
    }
  };

  const inspectDeletion = async (u) => {
    setErr(""); setDeletionPlan(null); setReviewId("");
    setExternalReviewed(false); setActivityStopped(false);
    try {
      const response = await fetch(`${API}/api/admin/users/${encodeURIComponent(u.user_id)}/deletion-plan`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || "Examen impossible");
      setDeletionPlan(result);
    } catch (error) {
      setErr(error.message || "Examen impossible");
    }
  };

  const finalizeDeletion = async () => {
    setErr(""); setDeleting(true);
    try {
      const response = await fetch(`${API}/api/admin/users/${encodeURIComponent(deletionPlan.user_id)}/finalize-deletion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirm_user_id: reviewId,
          external_review_complete: externalReviewed,
          activity_stopped: activityStopped,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        const detail = result.detail;
        throw new Error(typeof detail === "string" ? detail :
          [detail?.message, ...(detail?.blockers || [])].filter(Boolean).join(" "));
      }
      if (result.account_deleted !== true) throw new Error("Effacement non confirmé.");
      setNotice(result.message); setDeletionPlan(null);
      await load();
    } catch (error) {
      setErr(error.message || "Effacement impossible");
    } finally {
      setDeleting(false);
    }
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
        {notice && <p role="status">{notice}</p>}
        {deletionPlan && (
          <section aria-label="Examen de suppression">
            <h3>Examen de suppression : {deletionPlan.user_id}</h3>
            <p>{deletionPlan.external_review}</p>
            <ul>{deletionPlan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            <p>{Object.values(deletionPlan.collections).reduce((sum, count) => sum + count, 0)} enregistrements et {deletionPlan.file_paths.length} fichiers dans le périmètre.</p>
            <label>Identifiant à recopier <input value={reviewId} onChange={(event) => setReviewId(event.target.value)} /></label>
            <label><input type="checkbox" checked={externalReviewed} onChange={(event) => setExternalReviewed(event.target.checked)} /> Stockages distincts, copies, exceptions et abonnements examinés et traités séparément</label>
            <label><input type="checkbox" checked={activityStopped} onChange={(event) => setActivityStopped(event.target.checked)} /> Compte désactivé et opérations en cours terminées</label>
            <button className="file-btn danger" disabled={deleting || deletionPlan.blockers.length > 0 || reviewId !== deletionPlan.user_id || !externalReviewed || !activityStopped} onClick={finalizeDeletion}>
              {deleting ? "Effacement en cours…" : "EFFACER LE PÉRIMÈTRE SERVEUR VÉRIFIÉ"}
            </button>
            <button className="file-btn" disabled={deleting} onClick={() => setDeletionPlan(null)}>Fermer l’examen</button>
          </section>
        )}
        {!err && users === null && <div className="admin-loading" data-testid="admin-loading">Chargement des comptes…</div>}
        {users && (
          <>
            <div className="admin-total" data-testid="admin-total">{users.length} compte{users.length > 1 ? "s" : ""} inscrit{users.length > 1 ? "s" : ""}</div>
            <label>
              <input type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} />
              {" "}Comptes à examiner : {users.filter(needsReview).length}
            </label>
            <div className="admin-table-wrap">
              <table className="admin-table" data-testid="admin-users-table">
                <thead>
                  <tr>
                    <th>COMPTE</th><th>INSCRIT LE</th><th>DERNIÈRE ACTIVITÉ</th>
                    <th>INACTIVITÉ — 12 MOIS</th><th>MESSAGES</th><th>SOUVENIRS</th><th>DEALS</th><th>PAIEMENTS</th><th>DOCS THÉMIS</th><th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {users.filter((u) => !reviewOnly || needsReview(u)).map((u) => (
                    <tr key={u.user_id} className={u.disabled ? "admin-row-disabled" : ""} data-testid={`admin-user-row-${u.user_id}`}>
                      <td>
                        {u.deletion_request?.status === "pending_review" && <b>Demande de suppression à traiter. </b>}
                        {u.deletion_request?.status === "processing" && <b>Effacement en cours ou incomplet : contrôle requis. </b>}
                        {u.deletion_request?.status === "failed" && <b>Effacement incomplet : corriger l’erreur puis refaire l’examen. </b>}
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
                      <td>{fmtDate(u.activity.last_activity * 1000)}</td>
                      <td>
                        {u.inactivity_review?.status === "review_required" ? "À examiner" :
                          u.inactivity_review?.status === "excluded" ? "Examen distinct (admin)" :
                          u.inactivity_review?.status === "observing" ? `Suivi jusqu’au ${fmtDate(u.inactivity_review.review_after)}` :
                          "Suivi à vérifier"}
                        {u.inactivity_review?.status === "unknown" && <small>{u.inactivity_review.reason}</small>}
                      </td>
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
                            <ConfirmButton className="file-btn danger" title="Demander la suppression après examen manuel"
                              label="SÛR ?" testId={`admin-delete-btn-${u.user_id}`} onConfirm={() => removeUser(u)}>
                              <Trash2 size={13} />
                            </ConfirmButton>
                            {u.deletion_request && <button className="file-btn" onClick={() => inspectDeletion(u)} data-testid={`admin-review-btn-${u.user_id}`}>EXAMINER</button>}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="admin-note">Le suivi porte sur l’activité authentifiée auprès de ce serveur, pas sur l’usage hors ligne. Le délai de 12 mois commence au plus tôt à l’activation de ce suivi. Aucun compte n’est supprimé automatiquement. Avant toute suppression, vérifier l’usage réel, les fichiers et les obligations de conservation. Désactiver bloque la connexion et conserve les données. Le bouton de suppression enregistre une demande à examiner : il n’efface ni le compte ni ses données et ne résilie aucun abonnement.</p>
          </>
        )}
      </div>
    </div>
  );
}

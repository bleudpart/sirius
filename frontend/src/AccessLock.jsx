// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Écran affiché quand ni l'essai de 15 jours ni une licence ne sont actifs.
import { useState } from "react";
import { ExternalLink, Link2, LogOut, RefreshCw, User } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import { CoreRings, ReactorCore } from "@/components/ReactorVisuals";

export const STORE_URL = "https://sirius-assistant.fr/";

export async function fetchAccessStatus(refresh = false, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${API_BASE_URL}/access/status${refresh ? "?refresh=true" : ""}`);
    // Un serveur sans contrôle d'accès (ancienne version) ne bloque pas l'interface ; le backend reste l'autorité.
    if (!response.ok) return { state: "unknown", allowed: true };
    return await response.json();
  } catch {
    return { state: "unknown", allowed: true };
  }
}

export function trialDaysLeft(status) {
  const seconds = status?.trial?.remaining_seconds;
  if (status?.state !== "trial" || typeof seconds !== "number") return null;
  return Math.max(0, Math.ceil(seconds / 86400));
}

const TIER_LABELS = { standard: "Standard", pro: "Pro", lifetime: "Lifetime", monthly: "Location mensuelle" };

export function accessLabel(status) {
  switch (status?.state) {
    case "admin": return "ADMINISTRATEUR";
    case "licensed": return `LICENCE ${(TIER_LABELS[status.license?.tier] || "ACTIVE").toUpperCase()}`;
    case "trial": {
      const days = trialDaysLeft(status);
      return days === null ? "ESSAI EN COURS" : `ESSAI — ${days} JOUR${days > 1 ? "S" : ""} RESTANT${days > 1 ? "S" : ""}`;
    }
    case "unlinked": return "PC NON RELIÉ";
    case "offline": return "VÉRIFICATION IMPOSSIBLE";
    default: return "ESSAI TERMINÉ";
  }
}

const TITLES = {
  expired: "Votre essai de 15 jours est terminé",
  unlinked: "Reliez ce PC à votre compte ΣIRIUS",
  offline: "Vérification de votre accès impossible",
};

export default function AccessLock({ status, accountEmail = "", onRefresh, onLogout, onProfile }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: accountEmail, password: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetCodeSent, setResetCodeSent] = useState(false);
  const state = status?.state || "expired";
  const cloudEmail = status?.cloud?.email || "";

  const refresh = async () => {
    setBusy(true);
    setMessage("");
    const next = await onRefresh();
    if (next && !next.allowed) setMessage(next.state === "expired" ? "Aucune licence active trouvée pour ce compte." : next.detail || "");
    setBusy(false);
  };

  const link = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setNotice("");
    try {
      const response = await fetch(`${API_BASE_URL}/cloud/${mode === "register" ? "register" : "link"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email.trim(), password: form.password, name: form.name.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Connexion à ΣIRIUS Cloud impossible.");
      const next = await onRefresh();
      if (next && !next.allowed) setMessage(next.detail || "");
    } catch (error) {
      setMessage(error.message || "ΣIRIUS Cloud est injoignable. Vérifiez la connexion Internet.");
    } finally {
      setBusy(false);
    }
  };

  const changeMode = (next) => {
    setMode(next);
    setMessage("");
    setNotice("");
    setResetCode("");
    setResetCodeSent(false);
    setForm({ ...form, password: "" });
  };

  const resetPassword = async (event) => {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setNotice("");
    try {
      const response = await fetch(`${API_BASE_URL}/cloud/password-reset/${resetCodeSent ? "confirm" : "request"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resetCodeSent
          ? { email: form.email.trim(), code: resetCode, password: form.password }
          : { email: form.email.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Récupération du mot de passe impossible.");
      if (resetCodeSent) {
        changeMode("login");
        setNotice("Mot de passe modifié. Utilisez le nouveau mot de passe pour relier ce PC.");
      } else {
        setResetCodeSent(true);
        setNotice(data.message || "Si ce compte existe, un code vient d’être envoyé. Vérifiez aussi les spams.");
      }
    } catch (error) {
      setMessage(error.message || "ΣIRIUS Cloud est injoignable. Vérifiez la connexion Internet.");
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    try {
      await fetch(`${API_BASE_URL}/cloud/link`, { method: "DELETE" });
    } finally {
      await onRefresh();
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen" data-testid="access-lock" role="alertdialog" aria-labelledby="access-lock-title">
      <div className="auth-card">
        <header className="auth-brand">
          <div className="auth-brand-main">
            <span className="auth-core-logo" aria-hidden="true">
              <CoreRings />
              <ReactorCore status="idle" volume={0.2} color="#91e6f2" eco={false} />
            </span>
            <h1 className="auth-title">ΣIRIUS</h1>
          </div>
        </header>
        <h2 className="auth-sub" id="access-lock-title">{TITLES[state] || TITLES.expired}</h2>
        {state === "unlinked" ? (
          <>
            <p className="auth-tagline">Après 15 jours d'essai, ΣIRIUS demande une licence ou une location. Votre compte permet de vérifier votre accès.</p>
            <form className="auth-form" onSubmit={mode === "reset" ? resetPassword : link} data-testid="access-link-form">
              {mode === "register" && (
                <input type="text" placeholder="Prénom et nom" value={form.name} required autoComplete="name"
                  onChange={(event) => setForm({ ...form, name: event.target.value })} />
              )}
              <input type="email" placeholder="Email" value={form.email} required autoComplete="email"
                disabled={busy || (mode === "reset" && resetCodeSent)}
                onChange={(event) => setForm({ ...form, email: event.target.value })} data-testid="access-email" />
              {mode === "reset" && resetCodeSent && (
                <input type="text" inputMode="numeric" autoComplete="one-time-code" placeholder="Code à 6 chiffres"
                  value={resetCode} required pattern="[0-9]{6}" maxLength={6} disabled={busy}
                  onChange={(event) => setResetCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                  data-testid="access-reset-code" />
              )}
              {(mode !== "reset" || resetCodeSent) && <input type="password"
                placeholder={mode === "reset" ? "Nouveau mot de passe (8 caractères minimum)" : mode === "register" ? "Mot de passe (8 caractères minimum)" : "Mot de passe"}
                value={form.password} required minLength={mode !== "login" ? 8 : undefined} disabled={busy}
                autoComplete={mode !== "login" ? "new-password" : "current-password"}
                onChange={(event) => setForm({ ...form, password: event.target.value })} data-testid="access-password" />
              }
              {message && <div className="auth-error" role="alert">{message}</div>}
              {notice && <p className="auth-powered" role="status">{notice}</p>}
              <button type="submit" className="auth-submit" disabled={busy} data-testid="access-link-submit">
                <Link2 size={15} /> {mode === "reset"
                  ? (resetCodeSent ? "VALIDER LE NOUVEAU MOT DE PASSE" : "RECEVOIR UN CODE")
                  : mode === "register" ? "CRÉER MON COMPTE" : "RELIER CE PC"}
              </button>
            </form>
            <button type="button" className="auth-switch" disabled={busy} onClick={() => changeMode(mode === "login" ? "register" : "login")}>
              {mode === "reset" ? "Retour à la connexion" : mode === "register" ? "J’ai déjà un compte — Se connecter" : "Pas encore de compte — Créer mon compte"}
            </button>
            {mode === "login" && (
              <button type="button" className="auth-link" disabled={busy} onClick={() => changeMode("reset")} data-testid="access-forgot-password">
                Mot de passe oublié ?
              </button>
            )}
          </>
        ) : (
          <>
            <p className="auth-tagline">
              {state === "offline"
                ? "Connectez ce PC à Internet pour confirmer votre essai ou votre licence."
                : "Choisissez une licence ou une location pour continuer. Achetez-la avec l'adresse e-mail de votre compte : l'accès se débloque automatiquement."}
            </p>
            {(cloudEmail || accountEmail) && <p className="auth-powered">Compte : <strong>{cloudEmail || accountEmail}</strong></p>}
            <p className="auth-powered">Vos données sont conservées ; vous pouvez toujours les exporter ou supprimer votre compte.</p>
            {message && <div className="auth-error" role="alert">{message}</div>}
            <div className="auth-form">
              {state !== "offline" && (
                <a className="auth-submit" href={STORE_URL} target="_blank" rel="noreferrer" data-testid="access-store-link">
                  <ExternalLink size={15} /> VOIR LES FORMULES
                </a>
              )}
              <button type="button" className="auth-submit" disabled={busy} onClick={refresh} data-testid="access-refresh">
                <RefreshCw size={15} /> {state === "offline" ? "RÉESSAYER" : "J’AI ACHETÉ — VÉRIFIER"}
              </button>
            </div>
            {cloudEmail && (
              <button type="button" className="auth-switch" disabled={busy} onClick={unlink}>Relier un autre compte</button>
            )}
          </>
        )}
        {onProfile && (
          <button type="button" className="auth-link access-lock-link" onClick={onProfile} data-testid="access-profile">
            <User size={13} /> Mon profil — exporter ou supprimer mes données
          </button>
        )}
        {onLogout && (
          <button type="button" className="auth-link access-lock-link" onClick={onLogout} data-testid="access-logout"><LogOut size={13} /> Se déconnecter</button>
        )}
      </div>
    </div>
  );
}

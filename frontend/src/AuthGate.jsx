// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Porte d'authentification : connexion email/mot de passe + Microsoft, profil et déconnexion.
import { useEffect, useState, createContext, useContext } from "react";
import { LogIn, LogOut, User, Save } from "lucide-react";
import { BACKEND_BASE_URL, resolveBackendUrl } from "@/lib/api";

const API = BACKEND_BASE_URL;
const BACKEND_URL_PREFIX = `${BACKEND_BASE_URL.replace(/\/$/, "")}/`;
const TEMPORARY_AUTH_BYPASS = process.env.NODE_ENV !== "production";
export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

// Toutes les requêtes vers notre backend portent les cookies de session
const SIRIUS_FETCH_PATCH_FLAG = "__siriusApiFetchPatched";
let localSessionBootstrap = null;
// Fallback Bearer : le cookie SameSite=Strict n'est pas rejoué quand la page
// (localhost:3000) et l'API (127.0.0.1:8001) sont des sites différents.
let siriusAccessToken = null;

function rememberAccessToken(payload) {
  if (payload && typeof payload.access_token === "string" && payload.access_token) {
    siriusAccessToken = payload.access_token;
  }
}

function requestLocalSession() {
  if (!localSessionBootstrap) {
    localSessionBootstrap = window.fetch(`${BACKEND_URL_PREFIX}api/auth/local-session`, {
      method: "POST",
      credentials: "include",
    }).then(async (response) => {
      const user = response.ok ? await response.json() : null;
      rememberAccessToken(user);
      return { response, user };
    }).finally(() => {
      localSessionBootstrap = null;
    });
  }
  return localSessionBootstrap;
}

if (!window[SIRIUS_FETCH_PATCH_FLAG]) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = typeof input === "string" ? input : input.url || "";
    const resolvedUrl = resolveBackendUrl(url);
    const isBackendRequest = resolvedUrl.startsWith(BACKEND_URL_PREFIX);
    const isAuthRequest = resolvedUrl.startsWith(`${BACKEND_URL_PREFIX}api/auth/`);
    const resolvedInput = typeof input === "string"
      ? resolvedUrl
      : resolvedUrl === url
        ? input
        : new Request(resolvedUrl, input);
    const requestOptions = isBackendRequest
      ? { ...options, credentials: "include" }
      : options;
    const applyBearer = () => {
      if (!isBackendRequest || !siriusAccessToken) return;
      const headers = new Headers(
        options.headers || (resolvedInput instanceof Request ? resolvedInput.headers : undefined)
      );
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${siriusAccessToken}`);
      requestOptions.headers = headers;
    };
    applyBearer();
    const retryInput = resolvedInput instanceof Request ? resolvedInput.clone() : resolvedInput;
    const response = await nativeFetch(resolvedInput, requestOptions);

    if (!isBackendRequest || isAuthRequest || response.status !== 401) return response;

    const bootstrap = await requestLocalSession();
    if (!bootstrap.response.ok) return response;
    applyBearer();
    return nativeFetch(retryInput, requestOptions);
  };
  window[SIRIUS_FETCH_PATCH_FLAG] = true;
}

const fmtErr = (d) => {
  if (d == null) return "Une erreur est survenue. Réessaie.";
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return d.map((e) => (e && typeof e.msg === "string" ? e.msg : "")).filter(Boolean).join(" ") || "Requête invalide.";
  return String(d.msg || d);
};

function syncLocalProfile(user) {
  try {
    const p = JSON.parse(localStorage.getItem("sirius_profile")) || {};
    p.name = user.name || p.name;
    localStorage.setItem("sirius_profile", JSON.stringify(p));
  } catch (e) { localStorage.setItem("sirius_profile", JSON.stringify({ name: user.name })); }
}

function AuthScreen({ onAuth }) {
  const [form, setForm] = useState({ email: "", password: "" });
  const [resetCode, setResetCode] = useState("");
  const [resetCodeSent, setResetCodeSent] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetMode, setResetMode] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await fetch(`${API}/api/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.email, password: form.password }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(fmtErr(data.detail));
      rememberAccessToken(data);
      syncLocalProfile(data);
      onAuth(data);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  };

  const resetPassword = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const path = resetCodeSent ? "/api/auth/password-reset/confirm" : "/api/auth/password-reset/request";
      const payload = resetCodeSent
        ? { email: form.email, code: resetCode, password: form.password }
        : { email: form.email };
      const r = await fetch(`${API}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(fmtErr(data.detail));
      if (!resetCodeSent) {
        setResetCodeSent(true);
        setErr(data.message || "Un code vient d'être envoyé par email.");
      } else {
        setResetMode(false);
        setResetCodeSent(false);
        setResetCode("");
        setErr("Mot de passe modifié. Tu peux maintenant te connecter.");
      }
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-screen" data-testid="auth-screen">
      <div className="auth-card">
        <header className="auth-brand">
          <h1 className="auth-title">ΣIRIUS</h1>
          <p className="auth-tagline">VOTRE ASSISTANT PRIVILÉGIÉ</p>
        </header>
        <p className="auth-sub">Identifiez-vous pour accéder à ΣIRIUS</p>
        <form onSubmit={resetMode ? resetPassword : submit} className="auth-form" data-testid="auth-form">
          <input type="email" placeholder="Email" value={form.email} required autoComplete="email"
            onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="auth-email-input" />
          {resetMode && resetCodeSent && (
            <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              placeholder="Code à 6 chiffres" value={resetCode} required
              onChange={(e) => setResetCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              data-testid="auth-reset-code-input" />
          )}
          <input type="password" placeholder="Mot de passe" value={form.password} required autoComplete="current-password"
            style={resetMode && !resetCodeSent ? { display: "none" } : undefined}
            disabled={resetMode && !resetCodeSent}
            onChange={(e) => setForm({ ...form, password: e.target.value })} data-testid="auth-password-input" />
          {err && <div className="auth-error" data-testid="auth-error">{err}</div>}
          <button type="submit" className="auth-submit" disabled={busy} data-testid="auth-submit-btn">
            <LogIn size={15} /> {resetMode ? (resetCodeSent ? "VALIDER LE NOUVEAU MOT DE PASSE" : "RECEVOIR UN CODE") : "SE CONNECTER"}
          </button>
        </form>
        <button className="auth-link" onClick={() => { setResetMode(!resetMode); setResetCodeSent(false); setResetCode(""); setErr(""); }}>
          {resetMode ? "Retour à la connexion" : "Mot de passe oublié ?"}
        </button>
      </div>
    </div>
  );
}

export function ProfilePanel({ user, onClose, onUpdate, onLogout }) {
  const [name, setName] = useState(user.name || "");
  const [notes, setNotes] = useState((user.preferences || {}).notes || "");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    const r = await fetch(`${API}/api/auth/profile`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, preferences: { ...(user.preferences || {}), notes } }),
    });
    if (r.ok) { const u = await r.json(); syncLocalProfile(u); onUpdate(u); setSaved(true); setTimeout(() => setSaved(false), 2000); }
  };
  return (
    <div className="prime-screen" data-testid="profile-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><User size={20} /> MON PROFIL</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="profile-close-btn">✕</button>
      </header>
      <div className="gcal-body">
        <div className="profile-row"><span>EMAIL</span><b data-testid="profile-email">{user.email}</b></div>
        <div className="profile-row"><span>CONNEXION</span><b>{user.provider === "google" ? "Google" : user.provider === "microsoft" ? "Microsoft" : "Email + mot de passe"}</b></div>
        <label className="profile-label">PRÉNOM / NOM AFFICHÉ</label>
        <input className="profile-input" value={name} onChange={(e) => setName(e.target.value)} data-testid="profile-name-input" />
        <label className="profile-label">PRÉFÉRENCES PERSONNELLES (Sirius en tiendra compte)</label>
        <textarea className="profile-input" rows={4} value={notes} placeholder="Ex. : je préfère des réponses courtes, je travaille dans la restauration…"
          onChange={(e) => setNotes(e.target.value)} data-testid="profile-notes-input" />
        <div className="gcal-toolbar">
          <button className="auth-submit" style={{ width: "auto", padding: "10px 18px" }} onClick={save} data-testid="profile-save-btn"><Save size={14} /> {saved ? "ENREGISTRÉ ✓" : "ENREGISTRER"}</button>
          <button className="file-btn danger" onClick={onLogout} data-testid="profile-logout-btn"><LogOut size={13} /> DÉCONNEXION</button>
        </div>
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [showProfile, setShowProfile] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const authenticate = async () => {
      try {
        const bootstrap = await requestLocalSession();
        let authenticatedUser = bootstrap.user;
        if (!bootstrap.response.ok) {
          const response = await fetch(`${API}/api/auth/me`);
          if (!response.ok) throw new Error("Session ΣIRIUS indisponible.");
          authenticatedUser = await response.json();
        }
        if (!cancelled) {
          syncLocalProfile(authenticatedUser);
          setUser(authenticatedUser);
        }
      } catch (error) {
        console.warn("Authentification ΣIRIUS interrompue.", error);
        if (!cancelled) {
          setUser(TEMPORARY_AUTH_BYPASS ? {
            email: "danielpartel@hotmail.com",
            user_id: "danielpartel@hotmail.com",
            name: "Daniel",
            role: "admin",
            provider: "local",
            preferences: {},
          } : null);
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    };
    void authenticate();
    return () => { cancelled = true; };
  }, []);

  const logout = async () => {
    await fetch(`${API}/api/auth/logout`, { method: "POST" });
    siriusAccessToken = null;
    setShowProfile(false);
    setUser(null);
  };

  if (checking) {
    return <div className="auth-screen"><div className="auth-checking" data-testid="auth-checking">Vérification de la session…</div></div>;
  }
  if (!user) return <AuthScreen onAuth={setUser} />;

  return (
    <AuthContext.Provider value={{ user, setUser, logout, openProfile: () => setShowProfile(true) }}>
      {children}
      <button className="auth-chip" onClick={() => setShowProfile(true)} title="Mon profil" data-testid="auth-user-chip">
        {user.picture ? <img src={user.picture} alt="" /> : <User size={13} />}
        <span>{user.name || user.email}</span>
        {user.role === "admin" && <span className="auth-admin-badge" data-testid="auth-admin-badge">ADMIN</span>}
      </button>
      {showProfile && <ProfilePanel user={user} onClose={() => setShowProfile(false)} onUpdate={setUser} onLogout={logout} />}
    </AuthContext.Provider>
  );
}
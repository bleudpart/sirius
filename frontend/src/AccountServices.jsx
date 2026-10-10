import { useEffect, useState } from "react";
import { readAccountSetup } from "@/accountSetup";

const STATE_LABELS = {
  configured: "Configuré — pas encore testé", available: "Disponible selon le serveur",
  not_configured: "Non configuré", restricted: "Non accessible avec les clés de SIRIUS",
};
const QUOTA_LABELS = { chat: "Messages IA", stt: "Transcriptions", tts: "Lectures vocales" };
const SCOPE_LABELS = {
  owner: "Configuration du serveur. La présence d'une clé ne prouve pas le fonctionnement du fournisseur.",
  personal: "Après l'essai, déverrouillez votre coffre personnel pour utiliser ce service.",
  none: "Ce service n'est pas disponible dans la configuration actuelle.",
  cloud: "Service relié à votre compte SIRIUS Cloud, avec ses limites d'essai.",
  local: "Fonction locale disponible sans clé de fournisseur.",
};

export default function AccountServices() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    readAccountSetup().then((data) => { if (active) setStatus(data); })
      .catch((failure) => { if (active) { setStatus(null); setError(failure.message); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  return (
    <section data-testid="account-services">
      <h2>Essai et services de mon compte</h2>
      <p className="setup-note">Pendant 7 jours, les services autorisés utilisent les clés du serveur sans vous les transmettre. Ensuite, configurez vos propres clés.</p>
      <p className="setup-warn">Après 7 jours, les services utilisant les clés de SIRIUS sont bloqués. Vos propres clés deviennent obligatoires pour continuer ces services. Les dossiers et outils locaux restent accessibles.</p>
      {loading && <p role="status">Vérification des services…</p>}
      {error && <p className="fw-status ko" role="alert">{error}</p>}
      {!loading && <button type="button" className="setup-io-btn" onClick={() => setAttempt((value) => value + 1)}>Revérifier</button>}
      {status && (
        <>
          <p data-testid="setup-account-role">Compte : {status.role === "admin" ? "Administrateur" : "Utilisateur"}</p>
          <p data-testid="setup-trial">
            {status.trial?.state === "admin" ? "Administrateur : hors période d'essai."
              : status.trial?.state === "active" ? `Essai actif jusqu'au ${new Date(status.trial.expires_at).toLocaleString("fr-FR")}.`
                : "Essai terminé : utilisez vos clés personnelles. Les fonctions locales restent accessibles."}
          </p>
          <ul className="fw-summary">
            {status.services.map((service) => (
              <li key={service.id}><b>{service.label}</b> : {STATE_LABELS[service.state] || "État non reconnu"}
                <p className="setup-note">{service.description || SCOPE_LABELS[service.scope] || "Configuration du service non reconnue."}</p>
              </li>
            ))}
          </ul>
          {status.quotas?.enabled ? (
            <div data-testid="setup-account-quotas">
              <p>Consommation des services SIRIUS — remise à zéro à minuit UTC.</p>
              {Object.entries(status.quotas.limits).map(([kind, limit]) => (
                <p key={kind}>{QUOTA_LABELS[kind] || kind} : {status.quotas.usage?.[kind] || 0} / {limit}</p>
              ))}
            </div>
          ) : <p className="setup-note">Quotas de compte non appliqués à cette session. Les limites des fournisseurs restent applicables.</p>}
          {status.role === "admin" && <p className="setup-note">Vos clés de serveur restent dans son environnement. Le coffre personnel ne donne aucun droit administrateur.</p>}
        </>
      )}
    </section>
  );
}

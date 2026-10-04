import { useState } from "react";
import { WORK_MODULES } from "../workModules";
import "./GettingStarted.css";

export function gettingStartedKey(user) {
  return `sirius_getting_started_v1:${user?.id || user?._id || user?.user_id || user?.email || "local"}`;
}

export default function GettingStarted({ storageKey, ready, requested, onClose, onAssistant, onModule }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === "done"; }
    catch (error) { console.error("Lecture du guide de démarrage impossible :", error); return false; }
  });
  const [error, setError] = useState("");
  const finish = () => {
    try { localStorage.setItem(storageKey, "done"); }
    catch (cause) {
      console.error("Enregistrement du guide de démarrage impossible :", cause);
      setError("Votre choix n'a pas pu être enregistré. Le guide pourra réapparaître au prochain démarrage.");
      return false;
    }
    setDismissed(true);
    setError("");
    onClose();
    return true;
  };
  if (!ready || (dismissed && !requested)) return null;
  const choose = (action) => { if (finish()) action(); };
  return (
    <section className="getting-started" aria-labelledby="getting-started-title" data-testid="getting-started">
      <header>
        <h2 id="getting-started-title">Par où commencer ?</h2>
        <button type="button" onClick={finish} aria-label="Fermer le guide de démarrage">×</button>
      </header>
      <p>Choisissez une fonction. Vous retrouverez ce guide dans <strong>Modules → Guide de démarrage</strong>.</p>
      <div className="getting-started-actions">
        <button type="button" onClick={() => choose(onAssistant)}>
          <strong>Poser une question</strong><span>Écrivez dans le chat. L'IA nécessite une connexion réseau ; vérifiez ses réponses.</span>
        </button>
        <button type="button" onClick={() => choose(() => onModule("dossiers"))}>
          <strong>Organiser mon travail</strong><span>Créez un dossier local, puis ajoutez vos documents et échéances. Pensez à exporter une sauvegarde.</span>
        </button>
        <button type="button" onClick={() => choose(() => onModule("connections"))}>
          <strong>Connecter mes comptes</strong><span>Les emails et agendas nécessitent un compte connecté et ses autorisations. Cette étape est facultative.</span>
        </button>
      </div>
      <details>
        <summary>Comprendre les noms des modules</summary>
        <ul>{WORK_MODULES.map((module) => <li key={module.id}><strong>{module.description}</strong> — {module.label}</li>)}</ul>
        <p>Ces six modules gardent leurs données sur cet appareil. Les services connectés et les autres modules ont leur propre stockage.</p>
        <p>Devis, factures et stocks : <strong>THÉMIS#</strong>. Agenda Google : <strong>AGENDA</strong>. Domotique : <strong>KERAUNOS#</strong>, avec des équipements compatibles configurés.</p>
      </details>
      <p className="getting-started-voice">Pour parler, maintenez ESPACE ou le bouton du microphone, puis relâchez pour envoyer. Autorisez le micro uniquement si vous souhaitez l'utiliser. <strong>Arrêter</strong> abandonne l'écoute et coupe la réponse, sans annuler une action déjà envoyée.</p>
      {error && <p role="alert">{error} <button type="button" onClick={() => { setDismissed(true); onClose(); }}>Continuer sans enregistrer</button></p>}
      <button type="button" className="getting-started-dismiss" onClick={finish}>Découvrir à mon rythme</button>
    </section>
  );
}

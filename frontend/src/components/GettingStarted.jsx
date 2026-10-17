import { useState } from "react";
import { WORK_MODULES, workModuleName } from "../workModules";
import "./GettingStarted.css";
import GuidedFirstAction from "./GuidedFirstAction";

export function gettingStartedKey(user) {
  return `sirius_getting_started_v1:${user?.id || user?._id || user?.user_id || user?.email || "local"}`;
}

export default function GettingStarted({ storageKey, ready, requested, onClose, onAssistant, onModule, onSearch }) {
  const [guided, setGuided] = useState(false);
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
        <h2 id="getting-started-title">Que voulez-vous faire avec ΣIRIUS ?</h2>
        <button type="button" onClick={finish} aria-label="Fermer le guide de démarrage">×</button>
      </header>
      <p>Parlez simplement de votre objectif. ΣIRIUS peut retrouver les informations, préparer le travail et vous demander votre accord avant une action sensible.
        Retrouvez ce guide dans <strong>Modules → Guide de démarrage</strong>.</p>
      {guided ? <GuidedFirstAction onBack={() => setGuided(false)} onDossiers={() => choose(() => onModule("dossiers"))} /> : <>
      <div className="getting-started-actions">
        <button type="button" onClick={() => setGuided(true)}>
          <strong>Préparer ma journée</strong><span>Une première action guidée : lire mes échéances et recevoir un bilan, sans rien envoyer.</span>
        </button>
        <button type="button" onClick={() => choose(onAssistant)}>
          <strong>Parler à ΣIRIUS</strong><span>Essayez « Que dois-je traiter aujourd'hui ? » ou « Où en est ce dossier ? ». Les réponses métier s'appuient sur les sources accessibles ; vérifiez les informations importantes.</span>
        </button>
        <button type="button" onClick={() => choose(() => onModule("dossiers"))}>
          <strong>Retrouver mes dossiers</strong><span>Réunissez vos documents, décisions et échéances. Sélectionnez un dossier pour que ΣIRIUS sache de quoi vous parlez.</span>
        </button>
        <button type="button" onClick={() => choose(() => onModule("workflows"))}>
          <strong>Voir ce qui est à traiter</strong><span>Dans ARIANE, retrouvez les validations, blocages et rappels du service connecté. Une relance Outlook se prépare puis se valide avant envoi.</span>
        </button>
        <button type="button" onClick={() => choose(() => onModule("connections"))}>
          <strong>Connecter mes comptes</strong><span>Les emails et agendas nécessitent un compte connecté et ses autorisations. Cette étape est facultative.</span>
        </button>
        {onSearch && <button type="button" onClick={() => choose(onSearch)}>
          <strong>Rechercher dans mes informations</strong><span>Dossiers, contacts, courriels, rendez-vous et fonctions, avec le statut de chaque source.</span>
        </button>}
        <button type="button" onClick={() => choose(() => onModule("odysseia"))}>
          <strong>Découvrir ODYSSEIA</strong><span>Accédez à la bibliothèque des mythes anciens : citations, récits historiques et sources pour comprendre l'univers mythologique de ΣIRIUS.</span>
        </button>
      </div>
      <details>
        <summary>Comprendre les noms des modules</summary>
        <ul>{WORK_MODULES.map((module) => <li key={module.id}><strong>{module.description}</strong> — <span className="getting-started-module-name">{workModuleName(module.label)}</span></li>)}</ul>
        <p>Les listes manuelles de ces six modules restent sur cet appareil. Les dossiers, parcours communs et rappels sont conservés dans le service connecté : même compte et même service pour les retrouver sur PC et téléphone. Les autres modules ont leur propre stockage.</p>
        <p>Les rappels de la boîte À traiter nécessitent un serveur en fonctionnement. Leurs notifications sont internes à l'application, pas des notifications push lorsque celle-ci est fermée. Les réponses générales de l'IA nécessitent une connexion réseau.</p>
        <p>Devis, factures et stocks : <strong className="getting-started-module-name">THÉMIS</strong>. Agenda Google : <strong className="getting-started-module-name">AGENDA</strong>. Domotique : <strong className="getting-started-module-name">KERAUNOS</strong>, avec des équipements compatibles configurés.</p>
      </details>
      </>}
      <p className="getting-started-voice">Pour parler, maintenez ESPACE ou le bouton du microphone, puis relâchez pour envoyer. Autorisez le micro uniquement si vous souhaitez l'utiliser. <strong>Arrêter</strong> abandonne l'écoute et coupe la réponse, sans annuler une action déjà envoyée.</p>
      {error && <p role="alert">{error} <button type="button" onClick={() => { setDismissed(true); onClose(); }}>Continuer sans enregistrer</button></p>}
      <button type="button" className="getting-started-dismiss" onClick={finish}>Découvrir à mon rythme</button>
    </section>
  );
}

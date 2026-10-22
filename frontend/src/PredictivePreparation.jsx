import { useEffect, useState } from "react";
import { configurePredictions, forgetPredictions, PREDICTION_EVENT, readPredictions, refreshPredictions } from "./localPredictions";
import { downloadWorkJson } from "./workModuleBackup";

export default function PredictivePreparation({ owner, templates, onPrepare, disabled, auditOnly }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    const read = () => {
      try { setData(readPredictions(owner)); setError(""); }
      catch (cause) { setData(null); setError(cause.message); }
    };
    read();
    window.addEventListener(PREDICTION_EVENT, read); window.addEventListener("storage", read);
    return () => { window.removeEventListener(PREDICTION_EVENT, read); window.removeEventListener("storage", read); };
  }, [owner]);
  const operation = (callback) => {
    try { callback(); setConsent(false); }
    catch { setError("Stockage local indisponible ; réglage non confirmé."); }
  };
  return <section aria-label="Préparations prédictives locales">
    <h3>Préparations prédictives · sur cet appareil seulement</h3>
    <p>Option volontaire : mémoriser seulement le type de parcours guidé ARIANE préparé, le jour et l'heure locale.
      Aucun texte, symbole personnalisé, écran, touche, mail ou contenu de fichier. Aucun envoi au serveur.
      Historique limité à 28 jours, isolé par compte sur cet appareil.</p>
    <p>Après trois jours distincts d'usage autour de cette heure (± une heure), SIRIUS prépare un modèle local à relire.
      Ce sont des habitudes possibles, pas une prédiction certaine. Aucun appel d'API ni lancement automatique.
      Les paramètres sont ceux du modèle standard, pas vos anciennes saisies. SIRIUS doit rester ouvert.</p>
    {error && <p role="alert">{error}</p>}
    <p>Collecte : {data?.enabled ? "activée" : "désactivée ou indisponible"}.</p>
    {!auditOnly && <fieldset disabled={!owner || disabled}>
      <legend>Autorisation de télémétrie minimale</legend>
      {!data?.enabled && <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        J'autorise ces agrégats locaux pour préparer des modèles ARIANE.</label>}
      <button type="button" disabled={!data?.enabled && !consent}
        onClick={() => operation(() => configurePredictions(owner, !data?.enabled))}>
        {data?.enabled ? "Désactiver et effacer les habitudes" : "Activer les préparations prédictives"}</button>
      <button type="button" onClick={() => operation(() => forgetPredictions(owner))}>Effacer les données prédictives locales</button>
      <button type="button" onClick={() => operation(() => refreshPredictions(owner))}>Actualiser les modèles préparés</button>
      <button type="button" onClick={() => operation(() =>
        downloadWorkJson(JSON.stringify(readPredictions(owner), null, 2), "sirius-habitudes-locales.json"))}>
        Exporter les habitudes locales</button>
    </fieldset>}
    <ul>{data?.enabled && data.suggestions.map((item) => <li key={item.template}>
      {templates[item.template].title} · observé sur {item.days} jours distincts à cette heure.
      {!auditOnly && <button type="button" disabled={disabled}
        onClick={() => onPrepare(item.template)}>Relire le modèle préparé : {templates[item.template].title}</button>}
    </li>)}</ul>
  </section>;
}

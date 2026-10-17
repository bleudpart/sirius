import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "../lib/api";
import ActionFeedback from "./ActionFeedback";

export default function GuidedFirstAction({ onBack, onDossiers }) {
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const requestRef = useRef(null);
  useEffect(() => () => { requestRef.current?.abort(); requestRef.current = null; }, []);
  const prepare = async () => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true); setError(""); setInterrupted(false);
    let expired = false;
    const timeout = setTimeout(() => { expired = true; controller.abort(); }, 12000);
    try {
      const response = await fetch(`${API_BASE_URL}/work-dossiers/briefing`, { credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? "Votre session a expiré." : `Les dossiers sont indisponibles (HTTP ${response.status}).`);
      const data = await response.json();
      if (data.kind !== "work" || data.read_only !== true || typeof data.briefing !== "string" || !data.briefing.trim()) {
        throw new Error("Le bilan reçu est incomplet.");
      }
      if (!controller.signal.aborted) setResult(data.briefing);
    } catch (cause) {
      if (!controller.signal.aborted || expired) {
        console.error("Première action guidée :", cause);
        setError(expired ? "Le service n'a pas répondu à temps." : cause.message);
      }
    } finally {
      clearTimeout(timeout);
      if (requestRef.current === controller) { requestRef.current = null; setLoading(false); }
    }
  };
  return <section aria-label="Préparer ma journée pas à pas">
    <h3>Préparer ma journée</h3>
    <ol>
      <li>Lire les dossiers, engagements et échéances accessibles à votre compte.</li>
      <li>Présenter le bilan réel ci-dessous, sans envoyer de message ni modifier une donnée.</li>
      <li>Choisir vous-même la prochaine étape dans vos dossiers.</li>
    </ol>
    <p>Aucune clé IA ni connexion Outlook n'est nécessaire pour ce bilan. Le service des dossiers doit être accessible. Sans données, aucun rendez-vous ni tâche n'est inventé.</p>
    <button type="button" onClick={prepare} disabled={loading}>{result ? "Actualiser le bilan" : "Préparer mon bilan"}</button>
    {loading && <><p role="status">Lecture des dossiers et échéances…</p><button type="button" onClick={() => {
      requestRef.current?.abort(); setInterrupted(true);
    }}>Arrêter la préparation</button></>}
    {interrupted && <p role="status">Préparation interrompue. Le dernier bilan reçu reste affiché ; il n'a pas été actualisé.</p>}
    {error && <ActionFeedback title={error} impact="La préparation n'a pas abouti. Aucun changement n'a été effectué."
      recovery="Vérifiez votre connexion au service et votre session, puis réessayez." onRetry={prepare} busy={loading} />}
    {result && <><h4>Bilan reçu du service · lecture seule</h4><p className="guided-result">{result}</p>
      <button type="button" onClick={onDossiers}>Choisir la suite dans mes dossiers</button></>}
    <button type="button" onClick={onBack}>Retour aux objectifs</button>
  </section>;
}

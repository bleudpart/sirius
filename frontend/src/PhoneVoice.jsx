import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";

const ROOT = `${API_BASE_URL}/ariane/phone`;

export default function PhoneVoice({ disabled, auditOnly = false, onPrepare }) {
  const [overview, setOverview] = useState(null);
  const [number, setNumber] = useState("");
  const [objective, setObjective] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const requests = useRef(new Set());
  const alive = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    const controllers = requests.current;
    return () => { alive.current = false; controllers.forEach((controller) => controller.abort()); controllers.clear(); };
  }, []);
  const request = async (path = "", method = "GET", body) => {
    const controller = new AbortController();
    requests.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${ROOT}${path}`, { method, credentials: "include",
        signal: controller.signal, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Demande téléphonique refusée.");
      return result;
    } finally { clearTimeout(timer); requests.current.delete(controller); }
  };
  const operate = async (operation) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setMessage("");
    try { await operation(); }
    catch (failure) {
      if (alive.current) setError(failure.name === "AbortError"
        ? "Résultat non confirmé : rechargez le suivi ou consultez Vapi avant de recommencer." : failure.message);
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const load = async () => {
    const result = await request();
    if (!result.settings || !Array.isArray(result.settings.allowed_numbers) || !Array.isArray(result.history?.items))
      throw new Error("Suivi téléphonique incomplet.");
    if (alive.current) setOverview(result);
  };
  const prepare = () => {
    onPrepare({ title: `Appeler ${number}`, steps: [{
      id: "appel", action: "phone.dial", inputs: { number, objective: objective.trim(), recipient_consent: consent },
    }] });
    setMessage("Formulaire ARIANE rempli, aucun appel effectué. Démarrez le parcours puis autorisez explicitement l'étape appel.");
  };
  return <section aria-label="Téléphonie Vapi">
    <h3>Téléphone · SIRIUS via Vapi</h3>
    <p>Appels réels payants, désactivés sans configuration serveur. Vapi gère le réseau téléphonique,
      l'audio bidirectionnel, la transcription, le dialogue et la voix. Aucun accès aux outils internes de SIRIUS.</p>
    <p>Annonce IA et accord de l'interlocuteur avant la conversation. Deux minutes maximum par appel,
      cinq tentatives par jour UTC pour les entrants et sortants réunis. Ce n'est pas un plafond financier garanti.</p>
    <p>Audio, objectif et conversation sont transmis à Vapi et à ses fournisseurs STT/IA/TTS.
      SIRIUS garde seulement le suivi et les paramètres du parcours, sans audio ni transcription.
      Vérifiez la conservation et la facturation chez Vapi. Aucun secret ni donnée sensible dans l'objectif.</p>
    <button type="button" disabled={busy} onClick={() => operate(load)}>
      {overview ? "Actualiser le suivi téléphonique" : "Charger la configuration téléphonique"}</button>
    {busy && <p role="status">Lecture ou demande en cours…</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {overview && <>
      <p>{overview.settings.configured ? "Configuration serveur présente, assistant contrôlé avant chaque appel."
        : "Téléphonie désactivée ou configuration serveur incomplète."}</p>
      <p>Réception : {overview.settings.inbound_enabled ? "autorisée" : "désactivée"}.
        Désactiver la réception ne raccroche pas un appel déjà commencé.</p>
      {!auditOnly && <>
        <button type="button" disabled={busy || disabled || (!overview.settings.configured && !overview.settings.inbound_enabled)}
          onClick={() => operate(async () => {
            await request("/inbound", "PUT", { enabled: !overview.settings.inbound_enabled });
            await load();
          })}>{overview.settings.inbound_enabled ? "Désactiver les appels entrants" : "Autoriser les appels entrants payants"}</button>
        <fieldset disabled={busy || disabled || !overview.settings.configured}>
          <legend>Préparer un appel sortant sans composer</legend>
          <label>Numéro autorisé <select value={number} onChange={(event) => setNumber(event.target.value)}>
            <option value="">Choisir un destinataire</option>
            {overview.settings.allowed_numbers.map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label>Objectif limité de la conversation <textarea maxLength={1000} value={objective}
            onChange={(event) => setObjective(event.target.value)} /></label>
          <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            Le destinataire a accepté cet appel par un assistant IA ; je suis autorisé à le contacter.</label>
          <button type="button" disabled={!number || !objective.trim() || !consent}
            onClick={prepare}>Préparer cet appel dans ARIANE</button>
        </fieldset>
      </>}
      <details><summary>Modèle d'assistant à configurer côté Vapi</summary>
        <p>À enregistrer dans Vapi, pas dans les clés du navigateur. Le numéro doit appeler le webhook
          sans assistant direct ni transfert de repli. La clé privée et le secret webhook restent sur le serveur.</p>
        <pre>{JSON.stringify(overview.settings.blueprint, null, 2)}</pre>
      </details>
      <h4>Suivi des appels</h4>
      {!overview.history.items.length && <p>Aucun appel enregistré.</p>}
      {overview.history.truncated && <p>Vingt derniers appels seulement.</p>}
      <ul>{overview.history.items.map((item) => <li key={item.id}>
        {item.direction === "inbound" ? "Entrant" : "Sortant"} {item.number || ""} · {item.state} · {item.created_at}
        <p>Référence : {item.id}. {item.reason}</p>
        {item.reported_cost_usd != null && <p>Coût rapporté par Vapi : {item.reported_cost_usd} USD, pas un devis.</p>}
        {!auditOnly && item.state !== "ended" && <button type="button" disabled={busy}
          onClick={() => operate(async () => {
            const result = await request(`/${encodeURIComponent(item.id)}/stop`, "POST");
            if (alive.current) setMessage(result.message || "Appel déjà terminé.");
            await load();
          })}>Demander le raccrochage de {item.id}</button>}
      </li>)}</ul>
      <p>Un délai dépassé ne prouve pas l'absence d'appel. État UNKNOWN ou SUBMITTING :
        vérifiez le tableau de bord Vapi et ne créez pas une nouvelle demande pour contourner le blocage.
        Arrêter le parcours ARIANE ne raccroche pas le téléphone.</p>
    </>}
  </section>;
}

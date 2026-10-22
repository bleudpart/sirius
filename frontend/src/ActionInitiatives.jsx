import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";

export default function ActionInitiatives({ auditOnly, onReview }) {
  const [data, setData] = useState(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const locked = useRef(false);
  const controllers = useRef(new Set());
  const generation = useRef(0);
  const readVersion = useRef(0);
  const request = useCallback(async (path, options = {}) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${API_BASE_URL}/ariane/initiatives${path}`, {
        credentials: "include", ...options, signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result.detail === "string" ? result.detail : "Demande proactive refusée.");
      return result;
    } finally { clearTimeout(timer); controllers.current.delete(controller); }
  }, []);
  const validate = (result) => {
    if (!Array.isArray(result.items) || typeof result.settings?.enabled !== "boolean")
      throw new Error("Suivi des propositions incomplet.");
    return result;
  };
  useEffect(() => {
    active.current = true;
    locked.current = false;
    const epoch = ++generation.current;
    const requests = controllers.current;
    let reading = false;
    const refresh = async () => {
      if (reading || locked.current) return;
      reading = true;
      const version = ++readVersion.current;
      try {
        const result = validate(await request(""));
        if (active.current && generation.current === epoch && readVersion.current === version) { setData(result); setError(""); }
      } catch (cause) {
        if (active.current && generation.current === epoch && readVersion.current === version)
          setError(cause.message || "Suivi proactif indisponible.");
      } finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 60000);
    return () => {
      active.current = false; generation.current += 1; clearInterval(timer);
      requests.forEach((controller) => controller.abort()); requests.clear();
    };
  }, [request]);
  const operation = async (path, body) => {
    if (locked.current) return;
    const epoch = generation.current;
    readVersion.current += 1;
    locked.current = true; setBusy(true); setError("");
    try {
      await request(path, { method: body ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!active.current || generation.current !== epoch) return;
      const result = validate(await request(""));
      if (active.current && generation.current === epoch) { setData(result); setConsent(false); }
    } catch (cause) {
      if (active.current && generation.current === epoch) setError(cause.message || "Modification non confirmée ; actualisez le suivi.");
    } finally {
      if (active.current && generation.current === epoch) { locked.current = false; setBusy(false); }
    }
  };
  return <section aria-label="Initiatives locales ARIANE">
    <h3>Déclencheurs proactifs locaux · sans appel IA</h3>
    <p>Après activation, contrôle toutes les quinze minutes des vingt parcours non expirés les plus récents,
      créés depuis au moins quinze minutes. Un blocage ou un accord en attente produit une proposition
      consultable ici, sans exécuter ni reprendre le parcours. SIRIUS connecté doit rester allumé.</p>
    <p>Le contrôle fonctionne côté serveur même si ce panneau est fermé. Aucun courriel, notification OS,
      paiement, code modifié ou appel fournisseur n'est déclenché par ce contrôle.</p>
    {error && <p role="alert">{error}</p>}
    {data?.settings.last_error && <p role="alert">{data.settings.last_error}</p>}
    <p>État : {data ? data.settings.enabled ? "activé" : "désactivé" : "chargement"}.
      {data?.settings.next_check_at && ` Prochain contrôle au plus tôt : ${data.settings.next_check_at}.`}</p>
    {!auditOnly && <fieldset disabled={busy || !data}>
      <legend>Autorisation persistante, désactivée par défaut</legend>
      {!data?.settings.enabled && <label><input type="checkbox" checked={consent}
        onChange={(event) => setConsent(event.target.checked)} />J'autorise les contrôles locaux et les propositions en arrière-plan</label>}
      <button type="button" disabled={!data?.settings.enabled && !consent}
        onClick={() => operation("/settings", { enabled: !data.settings.enabled })}>
        {data?.settings.enabled ? "Arrêter les déclencheurs locaux" : "Activer les déclencheurs locaux"}
      </button>
    </fieldset>}
    {data?.truncated && <p>Affichage limité aux vingt dernières propositions non masquées.</p>}
    {data && !data.items.length && <p>Aucune proposition enregistrée.</p>}
    <ul>{data?.items.map((item) => <li key={item.id}>
      <strong>{item.title}</strong> · {item.created_at}<p>{item.reason}</p><p>{item.proposal}</p>
      <p>{item.current ? "État encore présent lors de la dernière lecture." : "Proposition devenue obsolète ; ne pas agir sur cette ancienne alerte."}
        {" "}Aucune action exécutée.</p>
      <button type="button" disabled={busy} onClick={() => onReview(item.run_id)}>Consulter le parcours {item.run_id}</button>
      {!auditOnly && <button type="button" disabled={busy} onClick={() => operation(`/${item.id}/dismiss`)}>Masquer cette proposition</button>}
    </li>)}</ul>
  </section>;
}

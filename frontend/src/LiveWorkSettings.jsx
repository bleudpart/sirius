import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { assertSecureKeyTransport, loadApiKeys } from "./apiKeyStorage";

async function liveRequest(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}/work-dossiers${path}`, {
    credentials: "include", ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${response.status}`);
  }
  return response.json();
}

export function liveWorkKeys() {
  const stored = loadApiKeys();
  const keys = Object.fromEntries(["groq_key", "groq", "k3", "kimi"].filter((key) => stored[key])
    .map((key) => [key, stored[key]]));
  if (Object.keys(keys).length) assertSecureKeyTransport();
  return keys;
}

export default function LiveWorkSettings({ dossier, disabled, queue, onError }) {
  const settings = dossier.live_settings || { enabled: false, allow_ai: false };
  const [live, setLive] = useState(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setLive(null);
    if (!settings.enabled) return undefined;
    let active = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      liveRequest(`/${encodeURIComponent(dossier.id)}/live`)
        .then((data) => { if (active) setLive(data); })
        .catch((error) => { if (active) onError(`Suivi du dossier : ${error.message}`); });
    };
    refresh();
    const timer = window.setInterval(refresh, 60000);
    return () => { active = false; window.clearInterval(timer); };
  }, [dossier.id, settings.enabled, settings.updated_at, onError]);

  const configure = (enabled, allow_ai) => queue({
    title: enabled ? "Autoriser le suivi de ce dossier ?" : "Arrêter le suivi de ce dossier ?",
    text: enabled
      ? `${dossier.title} : seules les sources déjà liées seront comparées, toutes les minutes quand SIRIUS est ouvert. ${
        allow_ai ? "J'autorise l'envoi à l'IA en ligne des champs modifiés et de leurs anciennes/nouvelles valeurs. Aucun document complet ni autre dossier n'est transmis."
          : "Aucune donnée ne sera envoyée à l'IA pour ce suivi."} Aucune opération métier ne sera exécutée. Un nouveau point de comparaison sera établi.`
      : "Les analyses cessent et la mémoire de comparaison de ce suivi est effacée. Les sources métier ne sont pas modifiées.",
    operation: async () => {
      const result = await liveRequest(`/${encodeURIComponent(dossier.id)}/live-settings`, {
        method: "PUT", body: JSON.stringify({ enabled, allow_ai }),
      });
      setLive(null);
      window.dispatchEvent(new CustomEvent("sirius:live-settings-changed", { detail: dossier.id }));
      return result;
    },
  });
  const check = async () => {
    setChecking(true);
    try {
      const data = await liveRequest("/live/evaluate", {
        method: "POST", body: JSON.stringify({ keys: liveWorkKeys(), dossier_id: dossier.id }),
      });
      if (data.errors?.length) throw new Error(data.errors.map((item) => item.message).join(" "));
      setLive(await liveRequest(`/${encodeURIComponent(dossier.id)}/live`));
    } catch (error) {
      onError(`Suivi du dossier : ${error.message}`);
    } finally {
      setChecking(false);
    }
  };
  return <section className="work-dossiers-live" aria-label="Intelligence contextuelle du dossier">
    <h2>Comprendre le travail en cours</h2>
    <p>Sources liées uniquement · comparaison des valeurs · aucune surveillance générale du PC.</p>
    <p role="status">{settings.enabled ? `Suivi actif · ${settings.allow_ai ? "interprétation IA autorisée" : "comparaison sans IA"}` : "Suivi désactivé"}</p>
    <div className="work-dossiers-actions">
      {!settings.enabled && <button disabled={disabled} onClick={() => configure(true, false)}>Activer le suivi sans IA</button>}
      <button disabled={disabled || (settings.enabled && settings.allow_ai)}
        onClick={() => configure(true, true)}>Autoriser le suivi avec IA</button>
      {settings.enabled && <>
        {settings.allow_ai && <button disabled={disabled} onClick={() => configure(true, false)}>Retirer l'autorisation IA</button>}
        <button disabled={disabled} onClick={() => configure(false, false)}>Arrêter le suivi</button>
        <button disabled={disabled || checking} onClick={check}>{checking ? "Comparaison en cours…" : "Comparer maintenant"}</button>
      </>}
    </div>
    {settings.enabled && live?.checked_at && <p>Dernière vérification : {new Date(live.checked_at).toLocaleString("fr-FR")}</p>}
    {settings.enabled && live?.latest && <div className="work-dossiers-entry">
      <p>{live.latest.description}</p>
      {live.latest.analysis.text && <><h3>Interprétation IA · à vérifier</h3><p>{live.latest.analysis.text}</p></>}
      {live.latest.analysis.error && <p role="status">{live.latest.analysis.error}</p>}
      <details><summary>Différences calculées et sources</summary>
        {live.latest.changes.map((change) => <div key={`${change.source.kind}:${change.source.id}`}>
          <strong>{change.source.kind} · {change.source.id}</strong>
          <ul>{change.fields.map((field) => <li key={field.name}>
            {field.name} : {JSON.stringify(field.before)} → {JSON.stringify(field.after)}
            {field.delta != null && ` · différence ${field.delta}${field.percent != null ? ` (${field.percent} %)` : ""}`}
          </li>)}</ul>
        </div>)}
      </details>
    </div>}
  </section>;
}

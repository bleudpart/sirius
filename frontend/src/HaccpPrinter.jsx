import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { haccpFetch } from "./haccpRequest";

export function haccpPrintStatus(status) {
  const labels = {
    pending: "En attente du poste Windows",
    claimed: "Pris en charge par le poste Windows",
    accepted: "Transmis à Windows — vérifiez la sortie papier",
    cancelled: "Impression annulée — vérifiez la fiche",
    uncertain: "Impression incertaine — vérifiez le papier, ne relancez pas automatiquement",
  };
  if (!labels[status]) throw new Error("État d’impression inconnu. Vérifiez le poste avant toute nouvelle demande.");
  return labels[status];
}

const API = `${API_BASE_URL}/haccp/impression`;
const RELAY_KEY = "sirius_haccp_print_relay_id";

export async function haccpPrintRequest(path, body) {
  return haccpFetch(API + path, {
    credentials: "include",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  }, async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Impression indisponible (${response.status}).`);
    return data;
  });
}

function relayId() {
  let id = localStorage.getItem(RELAY_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(RELAY_KEY, id);
  }
  return id;
}

export function useHaccpPrinterRelay(accountKey) {
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const stopped = useRef(false);
  useEffect(() => {
    const bridge = window.siriusHaccpPrinter;
    if (!bridge || !accountKey) return undefined;
    let timer;
    let cancelled = false;
    stopped.current = false;
    async function tick() {
      try {
        const config = await bridge.getConfig();
        if (cancelled || stopped.current) return;
        if (!config?.enabled) {
          setStatus("Relais d’impression désactivé.");
        } else {
          const response = await haccpPrintRequest("/prochaine", { relay_id: relayId() });
          if (cancelled) return; // Une prise en charge abandonnée reste incertaine, jamais réémise.
          if (response.job) {
            let accepted = false;
            let detail = "";
            try {
              const result = await bridge.printJob(response.job);
              accepted = result?.accepted === true;
              if (!accepted) detail = "Le poste n’a pas confirmé l’envoi à Windows.";
            } catch (failure) {
              detail = failure.message;
            }
            await haccpPrintRequest(`/demandes/${response.job.id}/confirmation`, {
              relay_id: relayId(), status: accepted ? "accepted" : "uncertain",
              detail: detail.slice(0, 500) || null,
            });
            if (!accepted) throw new Error(detail || "Impression incertaine : vérifiez le papier.");
            setStatus("Travail accepté par Windows. Vérifiez la sortie papier.");
          } else {
            setStatus("Relais connecté, en attente d’étiquettes.");
          }
          setError("");
        }
      } catch (failure) {
        if (!cancelled) {
          setError(failure.message);
          stopped.current = true;
        }
      } finally {
        if (!cancelled && !stopped.current) timer = setTimeout(tick, 5000);
      }
    }
    tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [accountKey]);
  return { error, status };
}

export default function HaccpPrinter() {
  const bridge = window.siriusHaccpPrinter;
  const [printers, setPrinters] = useState([]);
  const [config, setConfig] = useState({ deviceName: "", widthMm: 60, heightMm: 50, enabled: false });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!bridge) return;
    setError("");
    try {
      const [available, saved] = await Promise.all([bridge.listPrinters(), bridge.getConfig()]);
      setPrinters(available);
      if (saved) setConfig(saved);
    } catch (failure) { setError(failure.message); }
  }, [bridge]);
  useEffect(() => { load(); }, [load]);
  const save = async (event) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const settings = { ...config, widthMm: Number(config.widthMm), heightMm: Number(config.heightMm) };
      // Desactiver d'abord le poste local jusqu'a confirmation du serveur.
      await bridge.configure({ ...settings, enabled: false });
      if (settings.enabled) {
        await haccpPrintRequest("/poste", {
          relay_id: relayId(), device_name: settings.deviceName,
          width_mm: settings.widthMm, height_mm: settings.heightMm,
        });
      }
      await bridge.configure(settings);
      setMessage("Configuration enregistrée. Rechargez ΣIRIUS pour démarrer ou reprendre le relais.");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <section aria-label="Imprimante ΣIRIUS">
    <h4>Imprimante d’étiquettes</h4>
    {!bridge ? <p>Configurez le relais dans l’application Windows ΣIRIUS. Le PC doit rester ouvert, connecté au même compte Cloud ou à la même entreprise.</p> : <>
      <button type="button" onClick={load} disabled={busy}>Détecter les imprimantes Windows</button>
      <form onSubmit={save}><fieldset disabled={busy} style={{ display: "grid", gap: 8 }}>
        <legend>Configuration initiale</legend>
        <label>Imprimante Windows
          <select value={config.deviceName} required onChange={(e) => setConfig({ ...config, deviceName: e.target.value })}>
            <option value="">Choisir une imprimante</option>
            {printers.map((printer) => <option key={printer.name} value={printer.name}>{printer.displayName || printer.name}</option>)}
          </select>
        </label>
        <label>Largeur étiquette (mm)<input type="number" min="20" max="150" step="1" required value={config.widthMm} onChange={(e) => setConfig({ ...config, widthMm: e.target.value })} /></label>
        <label>Hauteur étiquette (mm)<input type="number" min="20" max="300" step="1" required value={config.heightMm} onChange={(e) => setConfig({ ...config, heightMm: e.target.value })} /></label>
        <label><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} /> Autoriser l’impression sans dialogue après validation d’une ouverture</label>
        <button type="submit">Enregistrer l’imprimante</button>
      </fieldset></form>
      <p>Le pilote et les dimensions doivent correspondre au rouleau. Testez le cadrage sur votre matériel ; la compatibilité n’est pas universelle.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

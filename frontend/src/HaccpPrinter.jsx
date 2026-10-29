import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { haccpFetch } from "./haccpRequest";
import { androidHaccpPrinter, hasAndroidHaccpPrinter, isAndroidHaccp, printAndroidOpening, validateAndroidPrinter } from "./nativeHaccpPrinter";

export function haccpPrintStatus(status, transport = "windows") {
  const labels = {
    pending: "En attente du poste Windows",
    claimed: "Pris en charge par le poste Windows",
    accepted: "Transmis à Windows — vérifiez la sortie papier",
    cancelled: "Impression annulée — vérifiez la fiche",
    uncertain: "Impression incertaine — vérifiez le papier, ne relancez pas automatiquement",
  };
  if (transport === "android") {
    Object.assign(labels, {
      pending: "En attente de prise en charge par le téléphone Android",
      claimed: "Pris en charge par le téléphone — ne pas réimprimer",
      accepted: "SDK Brother sans erreur — vérifiez la sortie papier",
    });
  }
  if (!labels[status]) throw new Error("État d’impression inconnu. Vérifiez le poste avant toute nouvelle demande.");
  return labels[status];
}

export async function printHaccpOpening(labelId) {
  if (hasAndroidHaccpPrinter()) {
    const config = await androidHaccpPrinter.getConfig();
    if (config.enabled) return printAndroidOpening(labelId, haccpPrintRequest);
  }
  return haccpPrintRequest("/demandes", { label_id: labelId, reviewed: true });
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
    if (!bridge || !accountKey || isAndroidHaccp()) return undefined;
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
  if (isAndroidHaccp()) return <AndroidHaccpPrinter />;
  return <WindowsHaccpPrinter />;
}

function AndroidHaccpPrinter() {
  const available = hasAndroidHaccpPrinter();
  const [config, setConfig] = useState({ ip: "", model: "QL-820NWB", roll: "DK-22205", widthMm: 62, heightMm: 50, enabled: false });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (available) androidHaccpPrinter.getConfig().then((saved) => {
      if (active) setConfig(saved);
    }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [available]);
  const save = async (event) => {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const settings = validateAndroidPrinter(config);
      if (settings.enabled && (await androidHaccpPrinter.requestNetworkAccess())?.granted !== true) {
        throw new Error("Permission réseau local refusée. Autorisez-la dans les paramètres Android.");
      }
      setConfig(await androidHaccpPrinter.configure(settings));
      setMessage("Configuration Android sauvegardée sur ce téléphone. Aucun poste Windows modifié.");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await androidHaccpPrinter.printTest();
      if (result?.accepted !== true) throw new Error(result?.detail || "Test non confirmé : vérifiez le papier, aucun nouvel essai automatique.");
      setMessage("TEST hors registre : SDK Brother sans erreur. Vérifiez le papier, les marges et la coupe.");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <section aria-label="Imprimante ΣIRIUS">
    <h4>Imprimante Android Wi-Fi · Brother QL-820NWB</h4>
    {!available ? <p role="alert">Pont Brother absent de cette application. Une nouvelle compilation Android est nécessaire ; le site web ne peut pas imprimer directement.</p> : <>
      <form onSubmit={save}><fieldset disabled={busy} style={{ display: "grid", gap: 8 }}>
        <legend>Impression directe depuis ce téléphone, sans PC</legend>
        <label>Adresse IPv4 LAN de l’imprimante<input required inputMode="decimal" placeholder="192.168.1.50" value={config.ip}
          onChange={(e) => setConfig({ ...config, ip: e.target.value })} /></label>
        <p>Modèle : QL-820NWB uniquement · rouleau continu DK-22205 · largeur 62 mm · coupe 50 mm (zone imprimable 58,9 mm).</p>
        <label><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} /> Utiliser l’impression Android directe après validation d’une ouverture</label>
        <button type="submit">Enregistrer l’imprimante Android</button>
      </fieldset></form>
      <button type="button" disabled={busy || !config.enabled} onClick={test}>Imprimer une étiquette TEST — hors registre</button>
      <p>Enregistrez avant le test. Autorisez l’accès au réseau local si Android le demande.
        Même réseau Wi-Fi privé, sans VPN ni isolation des clients ; réservez l’IP dans le routeur.
        Gardez ΣIRIUS au premier plan. Pas d’impression garantie en arrière-plan.
        Un retour SDK sans erreur ne garantit pas la sortie papier. Après toute incertitude, vérifiez l’imprimante ; aucune réimpression automatique.</p>
      <p>Tant que l’impression Android directe n’est pas activée et enregistrée, les demandes utilisent le relais Windows existant.
        Une erreur d’impression Android ne déclenche jamais un deuxième envoi vers Windows.</p>
      <p>Impression via le SDK officiel Brother, sous sa <a href="https://support.brother.com/g/s/agreement/English/es_mobilesdk.html"
        target="_blank" rel="noopener noreferrer">licence d’utilisation</a>. Le SDK inclus ne doit pas être extrait ni redistribué séparément.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

function WindowsHaccpPrinter() {
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

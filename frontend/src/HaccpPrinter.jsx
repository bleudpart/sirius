import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { haccpFetch } from "./haccpRequest";
import { androidHaccpPrinter, hasAndroidHaccpPrinter, isAndroidHaccp, printAndroidLabel, validateAndroidPrinter } from "./nativeHaccpPrinter";

export function haccpPrintStatus(status, transport = "windows") {
  const labels = {
    pending: "En attente du poste Windows",
    claimed: "Pris en charge par le poste Windows",
    accepted: "Transmis à Windows — vérifiez la sortie papier",
    cancelled: "Impression annulée — vérifiez la fiche",
    uncertain: "Impression incertaine — vérifiez le papier, ne relancez pas automatiquement",
  };
  if (transport === "linux") {
    Object.assign(labels, {
      pending: "En attente du relais Raspberry Pi",
      claimed: "Pris en charge par le Raspberry Pi",
      accepted: "Transmis à CUPS — vérifiez la sortie papier",
    });
  }
  if (transport === "android") {
    Object.assign(labels, {
      pending: "En attente de prise en charge par le téléphone Android",
      claimed: "Pris en charge par le téléphone — ne pas réimprimer",
      accepted: "SDK Brother sans erreur — vérifiez la sortie papier",
    });
  }
  if (transport === "mobile") {
    Object.assign(labels, {
      pending: "Aperçu réservé sur un téléphone — aucune impression confirmée",
      uncertain: "Impression téléphone non confirmée — vérifiez le papier avant toute nouvelle impression",
    });
  }
  if (!labels[status]) throw new Error("État d’impression inconnu. Vérifiez le poste avant toute nouvelle demande.");
  return labels[status];
}

export async function printHaccpLabel(labelId, operation = "ouverture", kitchenToken = "") {
  if (!kitchenToken && hasAndroidHaccpPrinter()) {
    const config = await androidHaccpPrinter.getConfig();
    if (config.enabled) return printAndroidLabel(labelId, haccpPrintRequest, operation);
  }
  return haccpPrintRequest("/demandes", { label_id: labelId, reviewed: true }, kitchenToken);
}

const API = `${API_BASE_URL}/haccp/impression`;
const RELAY_KEY = "sirius_haccp_print_relay_id";
const MOBILE_DEVICE_KEY = "sirius_cuisine_print_device_id";

export async function haccpPrintRequest(path, body, kitchenToken = "") {
  const headers = {
    ...(body ? { "Content-Type": "application/json" } : {}),
    ...(kitchenToken ? { "X-Sirius-Cuisine": kitchenToken } : {}),
  };
  return haccpFetch(API + path, {
    credentials: "include",
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  }, async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Impression indisponible (${response.status}).`);
    return data;
  });
}

function mobileDeviceId() {
  try {
    let id = localStorage.getItem(MOBILE_DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(MOBILE_DEVICE_KEY, id);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error("Identité du téléphone invalide.");
    }
    return id;
  } catch (failure) {
    throw new Error(`Impossible de conserver l’identité du téléphone : ${failure.message}`);
  }
}

function checkMobilePreview(frame) {
  const article = frame?.contentDocument?.querySelector("article");
  if (!article || !frame.clientWidth || !frame.clientHeight) {
    throw new Error("Aperçu de l’étiquette indisponible. Ouvrez le QR dans Safari ou Chrome.");
  }
  const bounds = article.getBoundingClientRect();
  if (!bounds.width || !bounds.height) {
    throw new Error("Impossible de vérifier le format de l’étiquette.");
  }
  if (bounds.width > frame.clientWidth || bounds.height > frame.clientHeight - 2
      || article.scrollWidth > frame.clientWidth || article.scrollHeight > frame.clientHeight - 2) {
    throw new Error("Étiquette trop longue pour 62 × 50 mm : aucune impression. Demandez au chef de vérifier la fiche.");
  }
}

export function MobileHaccpLabelPrinter({ labelId, kitchenToken, busy, onBusyChange, className, label }) {
  const [preview, setPreview] = useState(null);
  const [ready, setReady] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [status, setStatus] = useState("");
  const [statusDetail, setStatusDetail] = useState("");
  const [error, setError] = useState("");
  const [errorAdvice, setErrorAdvice] = useState("");
  const frame = useRef(null);
  const pending = useRef(false);
  const claimStarted = useRef(false);
  const printStarted = useRef(false);
  const expiration = useRef(null);
  const timer = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const prepare = async () => {
    if (pending.current || busy) return;
    pending.current = true; onBusyChange(true); setError(""); setErrorAdvice(""); setStatus(""); setStatusDetail("");
    let waitingForPreview = false;
    try {
      const deviceId = mobileDeviceId();
      const response = await haccpPrintRequest("/mobile/demandes", {
        label_id: labelId, reviewed: true, device_id: deviceId,
      }, kitchenToken);
      if (!mounted.current) return;
      if (!response?.job || response.job.label_id !== labelId || typeof response.job.id !== "string") {
        throw new Error("Réponse d’impression invalide. Vérifiez le registre et le papier.");
      }
      if (response.job.transport !== "mobile" || response.job.status !== "pending" || typeof response.html !== "string") {
        setStatus(haccpPrintStatus(response.job.status, response.job.transport));
        setStatusDetail(response.job.detail || "");
        return;
      }
      claimStarted.current = false;
      setPreview({ id: response.job.id, deviceId, html: response.html });
      setStatus("Vérification du format de l’étiquette…");
      waitingForPreview = true;
      timer.current = setTimeout(() => {
        if (!mounted.current || claimStarted.current) return;
        claimStarted.current = true;
        setPreview(null); setStatus("");
        setError("Aperçu indisponible. Aucune impression lancée ; réessayez dans Safari ou Chrome.");
        onBusyChange(false);
      }, 15000);
    } catch (failure) {
      if (mounted.current) {
        setError(failure.message);
        setErrorAdvice("Aucune impression n’a été lancée depuis ce téléphone.");
      }
    } finally {
      pending.current = false;
      if (mounted.current && !waitingForPreview) onBusyChange(false);
    }
  };

  const previewLoaded = async () => {
    if (!preview || claimStarted.current) return;
    claimStarted.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      checkMobilePreview(frame.current);
      const start = { wall: Date.now(), monotonic: performance.now() };
      const response = await haccpPrintRequest(`/mobile/demandes/${preview.id}/prise`, {
        device_id: preview.deviceId,
      }, kitchenToken);
      if (!mounted.current) return;
      if (!response?.job) {
        if (!response?.state) throw new Error("Prise en charge non confirmée.");
        setStatus(haccpPrintStatus(response.state.status, response.state.transport));
        setStatusDetail(response.state.detail || "");
        return;
      }
      if (response.job.id !== preview.id || response.job.label_id !== labelId
          || response.job.transport !== "mobile" || response.job.status !== "uncertain"
          || response.html !== preview.html || !Number.isSafeInteger(response.valid_for_ms)
          || response.valid_for_ms <= 0) {
        throw new Error("La fiche ou la réponse d’impression a changé. Aucun envoi à l’imprimante.");
      }
      if (mounted.current) {
        expiration.current = {
          wall: start.wall + response.valid_for_ms,
          monotonic: start.monotonic + response.valid_for_ms,
        };
        setReady(true);
        setStatus("Étiquette prête. Vérifiez l’aperçu et choisissez la Brother.");
      }
    } catch (failure) {
      if (mounted.current) {
        setError(failure.message);
        setErrorAdvice("Vérifiez le papier avant toute nouvelle demande.");
        setStatus("Impression non confirmée.");
      }
    } finally {
      if (mounted.current) onBusyChange(false);
    }
  };

  const print = () => {
    if (!ready || printStarted.current) return;
    try {
      if (!expiration.current || Date.now() >= expiration.current.wall || performance.now() >= expiration.current.monotonic) {
        setReady(false);
        throw new Error("DLC dépassée : aucune impression d’utilisation.");
      }
      checkMobilePreview(frame.current);
      const printWindow = frame.current?.contentWindow;
      if (!printWindow || typeof printWindow.print !== "function") {
        throw new Error("Impression indisponible. Ouvrez le QR dans Safari ou Chrome.");
      }
      printStarted.current = true; setAttempted(true); setReady(false);
      printWindow.focus();
      printWindow.print();
      setStatus("Fenêtre d’impression demandée. Vérifiez le papier avant de coller ou de réimprimer.");
    } catch (failure) {
      setError(failure.message);
      setErrorAdvice("Vérifiez le papier avant toute nouvelle demande.");
    }
  };

  return <div className="haccp-mobile-print">
    {!preview && !status && <button type="button" className={className} disabled={busy} onClick={prepare}>
      {label}
    </button>}
    {preview && <>
      <p>Aperçu 62 × 50 mm · Choisissez la Brother et vérifiez que tout tient sur une seule étiquette.</p>
      <p className="haccp-notice">Sur Android, le service Brother ne liste pas le format 62 × 50 mm : vérifiez la taille et la coupe sur papier.</p>
      <div className="haccp-mobile-preview">
        <iframe ref={frame} title="Aperçu de l’étiquette Brother" srcDoc={preview.html}
          sandbox="allow-same-origin allow-modals" onLoad={previewLoaded} />
      </div>
      <button type="button" className="haccp-primary haccp-kitchen-print" disabled={!ready || attempted || busy} onClick={print}>
        Imprimer sur la Brother
      </button>
    </>}
    {status && <p role="status"><span>{status}</span>{statusDetail && <>. <span>{statusDetail}</span></>}</p>}
    {error && <p role="alert"><span>{error}</span>{errorAdvice && <> <span>{errorAdvice}</span></>}</p>}
  </div>;
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
  return window.siriusHaccpPrinter ? <WindowsHaccpPrinter /> : <LinuxHaccpPrinter />;
}

function LinuxHaccpPrinter() {
  const [config, setConfig] = useState({
    deviceName: "Brother_QL_820NWBc", widthMm: 62, heightMm: 50, replaceExisting: false,
  });
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const pair = async (event) => {
    event.preventDefault();
    setBusy(true); setError(""); setMessage(""); setToken("");
    try {
      const result = await haccpPrintRequest("/relais/associer", {
        relay_id: relayId(), device_name: config.deviceName.trim(),
        width_mm: Number(config.widthMm), height_mm: Number(config.heightMm),
        replace_existing: config.replaceExisting,
      });
      if (typeof result.token !== "string" || !result.token) {
        throw new Error("Le serveur n’a pas remis l’autorisation du relais. Ne configurez pas le Raspberry.");
      }
      setToken(result.token);
      setMessage("Relais associé. Cette autorisation ne sera affichée qu’une fois.");
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setMessage("Autorisation copiée. Collez-la uniquement dans le terminal SSH du Raspberry.");
    } catch (failure) { setError(`Copie impossible : ${failure.message}`); }
  };
  return <section aria-label="Relais d’impression Linux">
    <h4>Relais Raspberry Pi (Linux)</h4>
    <p>Associez le Raspberry au compte chef. Le jeton dédié ne permet que l’accès à cette file d’impression ; il ne remplace pas votre mot de passe.</p>
    <form onSubmit={pair}><fieldset disabled={busy} style={{ display: "grid", gap: 8 }}>
      <legend>Configuration de la Brother sur le Raspberry Pi</legend>
      <label>Nom de la file CUPS sur le Raspberry
        <input required maxLength={255} value={config.deviceName} onChange={(e) => setConfig({ ...config, deviceName: e.target.value })} />
      </label>
      <label>Largeur d’étiquette (mm)<input type="number" min="20" max="150" step="1" required value={config.widthMm} onChange={(e) => setConfig({ ...config, widthMm: e.target.value })} /></label>
      <label>Hauteur d’étiquette (mm)<input type="number" min="20" max="300" step="1" required value={config.heightMm} onChange={(e) => setConfig({ ...config, heightMm: e.target.value })} /></label>
      <label><input type="checkbox" checked={config.replaceExisting} onChange={(e) => setConfig({ ...config, replaceExisting: e.target.checked })} />
        Remplacer explicitement un autre poste d’impression associé</label>
      <button type="submit">Associer le Raspberry et créer son autorisation</button>
    </fieldset></form>
    {token && <div role="group" aria-label="Autorisation du relais">
      <label>Jeton à saisir une seule fois sur le Raspberry
        <input type="password" readOnly value={token} autoComplete="new-password" />
      </label>
      <button type="button" onClick={copyToken}>Copier le jeton</button>
      <p>Ne partagez pas ce jeton dans le chat. Il est lié à ce poste et sera remplacé lors d’un nouvel appairage.</p>
    </div>}
    <p>Le nom CUPS doit correspondre exactement à celui créé sur le Pi. La Brother doit être configurée sur le même réseau ; faites un test papier avant utilisation.</p>
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
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
    <h4>Imprimante Android Wi-Fi · Brother QL-820NWBc</h4>
    {!available ? <p role="alert">Pont Brother absent de cette application. Une nouvelle compilation Android est nécessaire ; le site web ne peut pas imprimer directement.</p> : <>
      <form onSubmit={save}><fieldset disabled={busy} style={{ display: "grid", gap: 8 }}>
        <legend>Impression directe depuis ce téléphone, sans PC</legend>
        <label>Adresse IPv4 LAN de l’imprimante<input required inputMode="decimal" placeholder="192.168.1.50" value={config.ip}
          onChange={(e) => setConfig({ ...config, ip: e.target.value })} /></label>
        <p>Modèle : QL-820NWBc (ou QL-820NWB) uniquement · rouleau continu DK-22205 · largeur 62 mm · coupe 50 mm (zone imprimable 58,9 mm).</p>
        <label><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} /> Utiliser l’impression Android directe après validation d’une ouverture ou préparation</label>
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
        <label><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} /> Autoriser l’impression sans dialogue après validation d’une ouverture ou préparation</label>
        <button type="submit">Enregistrer l’imprimante</button>
      </fieldset></form>
      <p>Le pilote et les dimensions doivent correspondre au rouleau. Testez le cadrage sur votre matériel ; la compatibilité n’est pas universelle.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}

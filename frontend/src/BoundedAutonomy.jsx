import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";

const ROOT = `${API_BASE_URL}/ariane/autonomy`;
const activeStates = ["ACTIVE", "EXECUTING"];
const validSession = (body, identity) => typeof body.state === "string" && body.run?.id === identity &&
  Array.isArray(body.run.steps) && body.run.summary && body.run.plan;

export default function BoundedAutonomy({ run, onRun, auditOnly }) {
  const [session, setSession] = useState(null);
  const [consent, setConsent] = useState(false);
  const [cycles, setCycles] = useState(2);
  const [seconds, setSeconds] = useState(120);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const requests = useRef(new Set());
  const locked = useRef(false);
  const readRevision = useRef(0);
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const identity = run?.id;
  useEffect(() => {
    const generation = ++epoch.current;
    const controllers = requests.current;
    locked.current = false;
    setSession(null); setConsent(false); setError(""); setBusy(false);
    if (!identity) return undefined;
    let reading = false;
    const refresh = async () => {
      if (reading || locked.current) return;
      reading = true;
      const revision = readRevision.current;
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`${ROOT}/${identity}`, { credentials: "include", signal: controller.signal });
        if (response.status === 404) return;
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail || "Lecture autonome indisponible.");
        if (!validSession(body, identity)) throw new Error("Session autonome incomplète.");
        if (generation !== epoch.current || locked.current || revision !== readRevision.current) return;
        setSession(body); setError("");
        onRunRef.current(body.run);
      } catch (cause) {
        if (generation === epoch.current && !locked.current && revision === readRevision.current)
          setError(cause.message || "Suivi interrompu.");
      } finally { reading = false; clearTimeout(timer); controllers.delete(controller); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      epoch.current += 1; clearInterval(timer);
      controllers.forEach((controller) => controller.abort()); controllers.clear();
    };
  }, [identity]);
  const operation = async (action) => {
    if (locked.current) return;
    readRevision.current += 1;
    locked.current = true; setBusy(true); setError("");
    const generation = epoch.current;
    const controller = new AbortController();
    requests.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${ROOT}/${identity}/${action}`, {
        method: "POST", credentials: "include", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        ...(action === "start" ? { body: JSON.stringify({ confirm: true, max_cycles: cycles, max_seconds: seconds }) } : {}),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : "Autorisation autonome refusée.");
      if (!validSession(body, identity)) throw new Error("Session autonome incomplète ; consultez le même parcours.");
      if (epoch.current !== generation) return;
      setSession(body); setConsent(false); onRunRef.current(body.run);
    } catch (cause) {
      if (epoch.current === generation) setError(`${cause.message} L'autorisation peut être enregistrée ; consultez le même parcours.`);
    } finally {
      clearTimeout(timer); requests.current.delete(controller);
      if (epoch.current === generation) { locked.current = false; setBusy(false); }
    }
  };
  if (!identity) return null;
  return <section aria-label="Autonomie bornée">
    <h3>Exécution autonome encadrée · lectures uniquement</h3>
    <p>Le serveur suit ce parcours même si ce panneau est fermé. Pas de contrôle d'écran, shell, code modifié,
      négociation envoyée ou démarche déposée. Seules les lectures du catalogue autorisé sont acceptées.</p>
    <p>Au plus trois cycles et 180 secondes. Une lecture terminée n'est jamais rejouée ; seuls les refus temporaires
      502/503/504 sans résultat peuvent être retentés après quinze secondes, dans la limite du contrat.
      Quota, accès refusé, résultat partiel ou délai incertain imposent un arrêt. Aucune correction de paramètres inventée.</p>
    {error && <p role="alert">{error}</p>}
    {session && <p>Session : {session.state} · {session.cycles}/{session.max_cycles} cycles · {session.reason}</p>}
    {!auditOnly && !session && <fieldset disabled={busy}>
      <legend>Autoriser uniquement le parcours affiché et ses entrées</legend>
      <label>Cycles maximum <select value={cycles} onChange={(event) => setCycles(Number(event.target.value))}>
        {[1, 2, 3].map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Durée maximum <select value={seconds} onChange={(event) => setSeconds(Number(event.target.value))}>
        {[30, 60, 120, 180].map((value) => <option key={value} value={value}>{value} secondes</option>)}</select></label>
      <label><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        J'autorise ces lectures autonomes et les éventuelles reprises temporaires, sans nouvelle IA.</label>
      <button type="button" disabled={!consent} onClick={() => operation("start")}>Autoriser ce parcours autonome</button>
    </fieldset>}
    {!auditOnly && activeStates.includes(session?.state) &&
      <button type="button" disabled={busy} onClick={() => operation("stop")}>Arrêter l'autonomie de ce parcours</button>}
  </section>;
}

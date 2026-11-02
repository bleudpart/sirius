import React, { Component, lazy, Suspense, useEffect, useRef, useState } from "react";
import { API_BASE_URL, websocketUrl } from "./lib/api";
import { websocketProtocols } from "./lib/sessionToken";
import { withTimeout } from "./companyFinance";
import "./ZeusTriCortex.css";

const Graph = lazy(() => import("./three/TriCortexGraph"));
const MAIN = ["brain_1", "brain_2", "brain_3"];
const SATELLITES = ["vision", "sanitary_guard", "margin_audit", "archivist"];
const IDS = [...MAIN, ...SATELLITES];
const LABELS = {
  brain_1: "Brain 1 · Fast Stream / HUD", brain_2: "Brain 2 · Logique métier",
  brain_3: "Brain 3 · Sentinel Master", vision: "Vision", sanitary_guard: "SanitaryGuard",
  margin_audit: "MarginAudit", archivist: "Archivist",
};
const STATES = { stopped: "Arrêté", idle: "Disponible", busy: "En activité", degraded: "Dégradé", failed: "En échec" };
const TASKS = {
  vision_label: "Lecture d’étiquette", vision_invoice: "Lecture de facture", sanitary_check: "Contrôle DLC / allergènes",
  price_audit: "Audit des prix", financial_analysis: "Analyse financière", compress_receipt: "Compression d’une copie",
  purge_caches: "Nettoyage des caches", dialogue: "Dialogue", dialogue_stream: "Dialogue en flux",
  raisonnement: "Raisonnement", raisonnement_stream: "Raisonnement en flux", hud_result: "Mise à jour du HUD",
  validation_document: "Validation documentaire", calcul_marges: "Calcul des marges",
  analyse_financiere: "Analyse financière", finance_direct: "Finance directe", ticket_caisse: "Ticket de caisse",
};
const JOB_STATES = { pending: "En attente", running: "En cours", retry: "Reprise planifiée", done: "Terminée", failed: "En échec" };
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const fraction = (value) => finite(value) && value >= 0 && value <= 1;
const date = (value) => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const nullableLatency = (value) => value === null || (finite(value) && value >= 0);
const own = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

export function validateCortexFrame(frame) {
  const nodes = [...(Array.isArray(frame?.nodes) ? frame.nodes : []), ...(Array.isArray(frame?.satellites) ? frame.satellites : [])];
  const valid = frame?.version === 1 && typeof frame.runtime_id === "string" && frame.runtime_id.length > 0
    && count(frame.sequence) && date(frame.emitted_at) && (frame.heartbeat_at === null || date(frame.heartbeat_at))
    && ["local", "cloud"].includes(frame.source) && count(frame.dropped_events)
    && frame.nodes?.length === 3 && frame.satellites?.length === 4
    && new Set(nodes.map((node) => node?.id)).size === 7
    && nodes.every((node) => node && IDS.includes(node.id) && own(STATES, node.status)
      && node.parent === (SATELLITES.includes(node.id) ? "brain_3" : null)
      && fraction(node.load) && fraction(node.pulse_level)
      && nullableLatency(node.latency_ms) && nullableLatency(node.first_token_ms)
      && [node.queued, node.completed, node.failures, node.restarts].every(count)
      && (node.current_task === null || own(TASKS, node.current_task)))
    && frame.nodes.every((node) => MAIN.includes(node.id)) && frame.satellites.every((node) => SATELLITES.includes(node.id))
    && Array.isArray(frame.edge_flows) && frame.edge_flows.every((edge) => edge && IDS.includes(edge.source)
      && IDS.includes(edge.target) && edge.source !== edge.target && count(edge.count) && edge.count > 0 && date(edge.last_at));
  if (!valid) throw new Error("Télémétrie Sentinel incohérente : aucune activité supposée.");
  return frame;
}

class GraphBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error) { console.error("[ZEUS CORTEX] Vue 3D indisponible", error); }
  render() {
    return this.state.failed ? <p className="tri-notice">Vue 3D indisponible. Les mesures restent lisibles ci-dessous.</p> : this.props.children;
  }
}

function supports3D() {
  if (typeof window.WebGL2RenderingContext === "undefined") return false;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) return false;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

async function request(path, options = {}) {
  return withTimeout(async (signal) => {
    const response = await fetch(`${API_BASE_URL}/cortex/tri${path}`, { credentials: "include", ...options, signal });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body?.detail === "string" ? body.detail : "Sentinel ne répond pas.");
    return body;
  }, { signal: options.signal, timeoutMs: 10000, message: "Sentinel ne répond pas dans le délai prévu." });
}

export default function ZeusTriCortex() {
  const [frame, setFrame] = useState(null);
  const [notice, setNotice] = useState("Connexion à Sentinel…");
  const [refresh, setRefresh] = useState(0);
  const [webgl] = useState(supports3D);
  const [jobs, setJobs] = useState([]);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [jobsError, setJobsError] = useState("");
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(null);
  const [jobsVersion, setJobsVersion] = useState(0);
  const mutation = useRef(null);
  const mounted = useRef(false);
  const accessEpoch = useRef(0);
  const connected = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; mutation.current?.abort(); };
  }, []);

  useEffect(() => {
    setFrame(null);
    setDetail(null);
    setJobs([]);
    setJobsLoaded(false);
    setNotice("Connexion à Sentinel…");
    connected.current = false;
    accessEpoch.current += 1;
    mutation.current?.abort();
    let alive = true;
    let socket;
    let reconnect;
    let attempts = 0;
    let received = 0;
    let latest = null;
    let staleDetected = false;
    const controller = new AbortController();
    const accept = (data) => {
      const valid = validateCortexFrame(data);
      if (latest?.runtime_id === valid.runtime_id && latest.sequence >= valid.sequence) return;
      latest = valid;
      received = Date.now();
      if (alive) {
        setFrame(valid); setNotice("");
        if (!connected.current) { connected.current = true; setJobsVersion((value) => value + 1); }
      }
    };
    const disconnected = (message) => {
      if (!alive) return;
      accessEpoch.current += 1;
      connected.current = false;
      mutation.current?.abort();
      setFrame(null); setDetail(null); setJobs([]); setJobsLoaded(false);
      setNotice(message);
    };
    const connect = async () => {
      staleDetected = false;
      try {
        const snapshot = await request("", { signal: controller.signal });
        if (!alive) return;
        accept(snapshot);
        socket = new WebSocket(websocketUrl("/cortex/tri/stream"), websocketProtocols());
        socket.onmessage = (event) => {
          if (!alive) return;
          try { accept(JSON.parse(event.data)); }
          catch (error) {
            latest = null;
            disconnected(error.message);
            socket.onclose = null;
            socket.close();
          }
        };
        socket.onerror = () => disconnected("Flux Sentinel interrompu. Aucune mesure récente affichée.");
        socket.onclose = (event) => {
          if (!alive) return;
          disconnected([4401, 4402, 4403].includes(event.code)
            ? "Session ou droits indisponibles. Reconnectez-vous."
            : staleDetected ? "Flux périmé : aucune mesure reçue depuis plus de 5 secondes."
              : "Connexion Sentinel fermée. Les agents peuvent continuer côté serveur.");
          if (![4401, 4402, 4403].includes(event.code) && attempts < 3) {
            attempts += 1;
            reconnect = setTimeout(connect, attempts * 2000);
          }
        };
      } catch (error) {
        if (error.name !== "AbortError") disconnected(error.message);
      }
    };
    connect();
    const stale = setInterval(() => {
      if (received && Date.now() - received > 5000 && latest) {
        latest = null;
        staleDetected = true;
        disconnected("Flux périmé : aucune mesure reçue depuis plus de 5 secondes.");
        if (socket) socket.close();
      }
    }, 1000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(stale);
      clearTimeout(reconnect);
      if (socket) { socket.onclose = null; socket.close(); }
    };
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    let timer;
    const controller = new AbortController();
    const load = async () => {
      if (!connected.current) {
        if (alive) timer = setTimeout(load, 5000);
        return;
      }
      const epoch = accessEpoch.current;
      try {
        const result = await request("/jobs", { signal: controller.signal });
        if (!Array.isArray(result?.items) || !result.items.every((job) => job && /^[a-f0-9]{32}$/.test(job.id)
          && own(TASKS, job.kind) && own(JOB_STATES, job.state) && count(job.attempts) && date(job.updated_at)
          && (job.error_message === null || typeof job.error_message === "string")
          && typeof job.requires_human_review === "boolean")) {
          throw new Error("File Sentinel incohérente : liste non affichée.");
        }
        if (alive && epoch === accessEpoch.current) {
          setJobs(result.items); setJobsError("");
          setJobsLoaded(true);
          setDetail((previous) => previous && result.items.some((job) => job.id === previous.id) ? previous : null);
        }
      } catch (error) {
        if (alive && error.name !== "AbortError") {
          setJobs([]); setDetail(null); setJobsLoaded(false); setJobsError(error.message);
        }
      } finally {
        if (alive) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [jobsVersion, refresh]);

  const action = async (job, retry = false) => {
    if (busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    const epoch = accessEpoch.current;
    setBusy(job.id);
    try {
      const result = await request(`/jobs/${job.id}${retry ? "/retry" : ""}`, {
        signal: controller.signal,
        ...(retry ? { method: "POST" } : {}),
      });
      if (result?.id !== job.id || !own(JOB_STATES, result.state) || result.input?.kind !== job.kind
        || !Object.prototype.hasOwnProperty.call(result, "result")
        || (result.result !== null && (typeof result.result !== "object" || Array.isArray(result.result)))
        || (result.state === "done" && result.result === null)
        || (retry && !["pending", "running"].includes(result.state))) throw new Error("Confirmation Sentinel invalide.");
      if (!mounted.current || controller.signal.aborted || epoch !== accessEpoch.current) return;
      setJobsError("");
      if (retry) {
        setDetail(null);
        setJobsVersion((value) => value + 1);
      } else {
        setDetail({ id: job.id, result: result.result, state: result.state });
      }
    } catch (error) {
      if (mounted.current && error.name !== "AbortError") { setJobsError(error.message); setDetail(null); }
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const measured = new Map([...(frame?.nodes || []), ...(frame?.satellites || [])].map((node) => [node.id, node]));
  return <section className="tri-cortex" aria-label="TriCortex et ses quatre subagents" data-testid="zeus-tricortex">
    <header className="tri-head">
      <div><h2>TRICORTEX · SENTINEL MASTER</h2>
        <p>Deux processeurs directs · quatre agents supervisés · {frame?.source === "cloud" ? "Cloud via relais" : "instance API"}</p></div>
      <button type="button" className="zcx-brain-button" onClick={() => setRefresh((value) => value + 1)}>Reconnecter</button>
    </header>
    {notice && <p role="status" className="tri-notice">{notice}</p>}
    {frame && webgl ? <GraphBoundary key={refresh}>
      <Suspense fallback={<p className="tri-notice">Chargement du graphe 3D…</p>}>
        <Graph frame={frame} />
      </Suspense>
    </GraphBoundary> : <div className="tri-graph-placeholder">
      {frame ? "Vue compatible sans WebGL 2 : toutes les mesures restent disponibles." : "En attente de mesures authentifiées."}
    </div>}
    <p className="tri-caption">Orbites = architecture. Intensité = charge de travail mesurée, pas CPU. Arêtes = transferts des 2 dernières secondes.</p>
    <div className="tri-nodes">
      {IDS.map((id) => {
        const node = measured.get(id);
        return <article key={id} className="tri-node" data-node={id} data-status={node?.status || "unknown"}>
          <h3>{LABELS[id]}</h3>
          <strong>{node ? STATES[node.status] : "Mesure indisponible"}</strong>
          <p>{node?.current_task ? TASKS[node.current_task] : "—"}</p>
          <dl>
            <div><dt>Charge</dt><dd>{node ? `${Math.round(node.load * 100)} %` : "—"}</dd></div>
            <div><dt>Dernière durée</dt><dd>{node?.latency_ms == null ? "—" : `${Math.round(node.latency_ms)} ms`}</dd></div>
            {id === "brain_1" && <div><dt>Premier fragment</dt><dd>{node?.first_token_ms == null ? "—" : `${Math.round(node.first_token_ms)} ms`}</dd></div>}
            <div><dt>File / terminées</dt><dd>{node ? `${node.queued} / ${node.completed}` : "—"}</dd></div>
            <div><dt>Échecs / redémarrages</dt><dd>{node ? `${node.failures} / ${node.restarts}` : "—"}</dd></div>
          </dl>
        </article>;
      })}
    </div>
    {frame && <p className="tri-caption">Relevé {new Date(frame.emitted_at).toLocaleTimeString("fr-FR")}
      {" "}· {frame.edge_flows.length} flux récent(s) · {frame.dropped_events} notification(s) regroupée(s).
      Les résultats sont conservés dans la file durable.</p>}
    <details className="tri-jobs">
      <summary>File locale et dernières analyses ({jobs.length})</summary>
      <p>Trois tentatives automatiques au maximum. Une lecture reste à vérifier ; elle ne valide ni réception physique ni écriture comptable.</p>
      {jobsError && <p role="alert" className="tri-notice">{jobsError}</p>}
      {!frame && <p>File indisponible hors connexion.</p>}
      {frame && !jobsLoaded && !jobsError && <p>Chargement de la file…</p>}
      {frame && jobsLoaded && !jobs.length && !jobsError && <p>Aucune tâche dans le périmètre autorisé.</p>}
      {jobs.map((job) => <article key={job.id} className="tri-job">
        <div><b>{TASKS[job.kind]}</b> · {JOB_STATES[job.state]} · {job.attempts} tentative(s)
          {job.error_message && <p>{job.error_message}</p>}</div>
        <button type="button" className="zcx-brain-button" disabled={Boolean(busy)} onClick={() => action(job)}>Voir le résultat</button>
        {job.state === "failed" && <button type="button" className="zcx-brain-button" disabled={Boolean(busy)}
          onClick={() => action(job, true)}>Relancer cette analyse</button>}
      </article>)}
      {detail && <div className="tri-result">
        <h3>Résultat de l’analyse · {JOB_STATES[detail.state]}</h3>
        <p>Confiances OCR autoévaluées, non calibrées. Aucun score ne remplace le contrôle humain.</p>
        <pre>{detail.result === null ? "Aucun résultat disponible." : JSON.stringify(detail.result, null, 2)}</pre>
        <button type="button" className="zcx-brain-button" onClick={() => setDetail(null)}>Fermer le résultat</button>
      </div>}
    </details>
  </section>;
}

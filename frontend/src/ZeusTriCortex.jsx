import React, { useEffect, useRef, useState } from "react";
import { API_BASE_URL, websocketUrl } from "./lib/api";
import { websocketProtocols } from "./lib/sessionToken";
import { withTimeout } from "./companyFinance";
import { recordFrame } from "./cortexHistory";
import { ExchangeChart, OutcomeDonut, SquadRose } from "./ZeusBrainCharts";
import "./ZeusTriCortex.css";

const MAIN = ["brain_1", "brain_2", "brain_3"];
const SATELLITES = ["vision", "sanitary_guard", "margin_audit", "archivist"];
const IDS = [...MAIN, ...SATELLITES];
const LABELS = {
  brain_1: "Cerveau 1 · Fast Stream / HUD", brain_2: "Cerveau 2 · Logique métier",
  brain_3: "Cerveau 3 · Sentinel Master", vision: "Vision", sanitary_guard: "SanitaryGuard",
  margin_audit: "MarginAudit", archivist: "Archivist",
};
const ROLES = {
  brain_1: "Dialogue et HUD en direct", brain_2: "Règles HACCP, TVA et marges", brain_3: "Superviseur de quatre agents",
};
const COLORS = {
  brain_1: "#7fb2d4", brain_2: "#d8b875", brain_3: "#70c5b4",
  vision: "#8d8fc4", sanitary_guard: "#77b18b", margin_audit: "#d29f68", archivist: "#b783a4",
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

async function request(path, options = {}) {
  return withTimeout(async (signal) => {
    const response = await fetch(`${API_BASE_URL}/cortex/tri${path}`, { credentials: "include", ...options, signal });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body?.detail === "string" ? body.detail : "Sentinel ne répond pas.");
    return body;
  }, { signal: options.signal, timeoutMs: 10000, message: "Sentinel ne répond pas dans le délai prévu." });
}

const SHORT = Object.fromEntries(IDS.map((id) => [id, LABELS[id].split(" · ")[0]]));
const duration = (value) => (value == null ? "—" : `${Math.round(value)} ms`);

function Stats({ id, node }) {
  const tiles = [
    ["Charge", node ? `${Math.round(node.load * 100)} %` : "—"],
    ["Dernière durée", duration(node?.latency_ms)],
    ...(id === "brain_1" ? [["Premier fragment", duration(node?.first_token_ms)]] : []),
    ["File / terminées", node ? `${node.queued} / ${node.completed}` : "—"],
    ["Échecs / redémarrages", node ? `${node.failures} / ${node.restarts}` : "—"],
  ];
  return <dl className="tri-stats" data-tiles={tiles.length}>
    {tiles.map(([term, value]) => <div key={term}><dt>{term}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function State({ node }) {
  return <div className="tri-state">
    <strong>{node ? STATES[node.status] : "Mesure indisponible"}</strong>
    <p>{!node ? "—" : node.current_task ? TASKS[node.current_task] : "Aucune tâche en cours"}</p>
  </div>;
}

function Flows({ frame }) {
  return <div className="tri-flows" role="group" aria-label="Transferts récents entre les cerveaux et les agents">
    <span className="tri-flows-title">Transferts · 2 dernières secondes</span>
    {frame?.edge_flows.length > 0
      ? <ul>{frame.edge_flows.map((edge, index) => <li key={`${edge.source}-${edge.target}-${index}`}
        style={{ "--from": COLORS[edge.source], "--to": COLORS[edge.target] }}>
        <b>{SHORT[edge.source]}</b><i aria-label="vers">→</i><b>{SHORT[edge.target]}</b>
        {edge.count > 1 && <em>×{edge.count}</em>}
      </li>)}</ul>
      : <span className="tri-flow-empty">{frame ? "Aucun transfert récent" : "Mesure indisponible"}</span>}
  </div>;
}

export default function ZeusTriCortex() {
  const [frame, setFrame] = useState(null);
  const [notice, setNotice] = useState("Connexion à Sentinel…");
  const [refresh, setRefresh] = useState(0);
  const [history, setHistory] = useState(null);
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
    setHistory(null);
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
        setHistory((previous) => recordFrame(previous, valid));
        if (!connected.current) { connected.current = true; setJobsVersion((value) => value + 1); }
      }
    };
    const disconnected = (message) => {
      if (!alive) return;
      accessEpoch.current += 1;
      connected.current = false;
      mutation.current?.abort();
      setFrame(null); setHistory(null); setDetail(null); setJobs([]); setJobsLoaded(false);
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
  const charts = {
    brain_1: <ExchangeChart exchanges={history?.exchanges || []} busy={measured.get("brain_1")?.status === "busy"}
      available={Boolean(frame)} />,
    brain_2: <OutcomeDonut completed={measured.get("brain_2")?.completed ?? 0} failures={measured.get("brain_2")?.failures ?? 0}
      queued={measured.get("brain_2")?.queued ?? 0} busy={measured.get("brain_2")?.status === "busy"} available={Boolean(frame)} />,
    brain_3: <SquadRose available={Boolean(frame)} agents={SATELLITES.map((id) => {
      const agent = measured.get(id);
      return {
        id, label: LABELS[id], color: COLORS[id], completed: agent?.completed ?? 0, failures: agent?.failures ?? 0,
        status: agent?.status ?? "unknown", statusLabel: agent ? STATES[agent.status] : "Mesure indisponible",
      };
    })} />,
  };
  return <section className="tri-cortex" aria-label="TriCortex et ses quatre subagents" data-testid="zeus-tricortex">
    <header className="tri-head">
      <div><h2>TRICORTEX · SENTINEL MASTER</h2>
        <p>Deux processeurs directs · quatre agents supervisés · {frame?.source === "cloud" ? "Cloud via relais" : "instance API"}</p></div>
      <div className="tri-head-actions">
        {frame && <span className="tri-live-chip">En direct</span>}
        <button type="button" className="zcx-brain-button" onClick={() => setRefresh((value) => value + 1)}>Reconnecter</button>
      </div>
    </header>
    {notice && <p role="status" className="tri-notice">{notice}</p>}
    <div className="tri-brains">
      {MAIN.map((id) => {
        const node = measured.get(id);
        return <article key={id} className="tri-node tri-brain" data-node={id} data-status={node?.status || "unknown"}
          style={{ "--accent": COLORS[id], "--load": node ? node.load : 0 }}>
          <header>
            <span className="tri-role">{ROLES[id]}</span>
            <h3>{LABELS[id]}</h3>
            <State node={node} />
          </header>
          {charts[id]}
          <Stats id={id} node={node} />
        </article>;
      })}
    </div>
    <Flows frame={frame} />
    <p className="tri-caption">Chaque graphe est tracé uniquement avec les mesures reçues de Sentinel : aucune valeur n’est simulée.
      Les compteurs cumulent l’activité de l’instance ; la charge est un travail en cours, pas un usage CPU.</p>
    <p className="tri-section">Escouade supervisée par le Cerveau 3</p>
    <div className="tri-nodes">
      {SATELLITES.map((id) => {
        const node = measured.get(id);
        return <article key={id} className="tri-node tri-agent" data-node={id} data-status={node?.status || "unknown"}
          style={{ "--accent": COLORS[id] }}>
          <h3>{LABELS[id]}</h3>
          <State node={node} />
          <Stats id={id} node={node} />
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

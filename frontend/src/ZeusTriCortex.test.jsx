import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ZeusTriCortex, { validateCortexFrame } from "./ZeusTriCortex";
import { API_BASE_URL, websocketUrl } from "./lib/api";
import { setSessionToken } from "./lib/sessionToken";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const clone = (value) => JSON.parse(JSON.stringify(value));
const MAIN = ["brain_1", "brain_2", "brain_3"];
const SATELLITES = ["vision", "sanitary_guard", "margin_audit", "archivist"];
const STAMP = "2026-11-02T12:00:00Z";
const JOB_ID = "a".repeat(32);
const makeNode = (id) => ({
  id, parent: SATELLITES.includes(id) ? "brain_3" : null, status: "idle",
  latency_ms: null, first_token_ms: null, load: 0, pulse_level: 0, current_task: null,
  queued: 0, completed: 0, failures: 0, restarts: 0,
});
const makeFrame = (sequence = 1) => ({
  version: 1, runtime_id: "runtime-test", sequence, emitted_at: STAMP, heartbeat_at: STAMP, source: "local",
  nodes: MAIN.map(makeNode), satellites: SATELLITES.map(makeNode), edge_flows: [], dropped_events: 0,
});
const makeJob = (state = "done") => ({
  id: JOB_ID, kind: "vision_label", state, attempts: 1, updated_at: STAMP,
  error_message: null, requires_human_review: true,
});

class Socket {
  static instances = [];
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols; this.closed = false;
    Socket.instances.push(this);
  }
  emit(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
  disconnect(code) { this.closed = true; this.onclose?.({ code }); }
  close() { this.disconnect(1000); }
}

let originalFetch;
let originalSocket;
let host;
let root;
let rows;
let jobState;
let detailReply;
let sequence;
const reply = (status, data) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => clone(data) });
const mount = async () => act(async () => root.render(<ZeusTriCortex />));
const click = async (label) => {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button).toBeTruthy();
  await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const socket = () => Socket.instances[Socket.instances.length - 1];
const node = (id) => host.querySelector(`[data-node="${id}"]`);

beforeEach(() => {
  jest.useFakeTimers();
  originalFetch = global.fetch; originalSocket = global.WebSocket;
  Socket.instances = [];
  global.WebSocket = Socket;
  rows = [];
  jobState = "done";
  detailReply = null;
  sequence = 0;
  setSessionToken("test-session-token");
  global.fetch = jest.fn((url, options = {}) => {
    const path = String(url).slice(`${API_BASE_URL}/cortex/tri`.length);
    if (path === "") return reply(200, makeFrame(++sequence));
    if (path === "/jobs") return reply(200, { items: rows });
    if (path === `/jobs/${JOB_ID}`) return detailReply || reply(200, {
      id: JOB_ID, input: { kind: "vision_label" }, state: jobState,
      result: jobState === "done" ? { private_result: "LOT CONFIDENTIEL", requires_human_review: true } : null,
    });
    if (path === `/jobs/${JOB_ID}/retry` && options.method === "POST") {
      rows = [makeJob("pending")];
      return reply(202, { id: JOB_ID, input: { kind: "vision_label" }, state: "pending", result: null });
    }
    return reply(404, { detail: "Route inattendue" });
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch; global.WebSocket = originalSocket;
  setSessionToken(null);
  jest.useRealTimers();
});

test("affiche exactement trois cerveaux et quatre satellites avec le transport authentifié centralisé", async () => {
  await mount();
  expect(host.querySelectorAll(".tri-node")).toHaveLength(7);
  expect(node("brain_3").textContent).toContain("Sentinel Master");
  expect(node("vision").textContent).toContain("Disponible");
  expect(socket().url).toBe(websocketUrl("/cortex/tri/stream"));
  expect(socket().protocols).toEqual(["sirius.bearer", "test-session-token"]);
  expect(socket().url).not.toContain("test-session-token");
  expect(global.fetch.mock.calls.every(([url, options]) =>
    String(url).startsWith(API_BASE_URL) && options.credentials === "include")).toBe(true);
});

test("l'activité et les arêtes changent uniquement à réception d'une mesure réelle", async () => {
  await mount();
  const update = makeFrame(10);
  Object.assign(update.satellites[0], { status: "busy", load: 1, pulse_level: 1, current_task: "vision_label" });
  update.nodes[0].first_token_ms = 24;
  update.edge_flows = [{ source: "vision", target: "brain_2", count: 1, last_at: STAMP }];
  await act(async () => socket().emit(update));
  expect(node("vision").dataset.status).toBe("busy");
  expect(node("vision").textContent).toContain("Lecture d’étiquette");
  expect(node("brain_1").textContent).toContain("24 ms");
  expect(host.textContent).toContain("1 flux récent");
  await act(async () => socket().emit(makeFrame(2)));
  expect(node("vision").dataset.status).toBe("busy");
});

test.each([
  (frame) => { frame.satellites[0].pulse_level = 1.01; },
  (frame) => { frame.satellites[0].pulse_level = -0.1; },
  (frame) => { frame.satellites.pop(); },
  (frame) => { frame.nodes[0].id = "brain_3"; },
  (frame) => { frame.satellites[0].parent = "brain_2"; },
  (frame) => { frame.edge_flows = [{ source: "private-company", target: "brain_1", count: 1, last_at: STAMP }]; },
])("refuse un contrat invalide au lieu d'inventer une activité", (change) => {
  const frame = makeFrame();
  change(frame);
  expect(() => validateCortexFrame(frame)).toThrow("incohérente");
});

test("retire les anciennes mesures après un message invalide ou un flux périmé", async () => {
  await mount();
  const invalid = makeFrame(20);
  invalid.satellites[0].load = 2;
  await act(async () => socket().emit(invalid));
  expect(host.textContent).toContain("Télémétrie Sentinel incohérente");
  expect(node("vision").dataset.status).toBe("unknown");
  await click("Reconnecter");
  expect(node("vision").dataset.status).toBe("idle");
  await act(async () => jest.advanceTimersByTime(6000));
  expect(node("vision").dataset.status).toBe("unknown");
  expect(host.textContent).toContain("Flux périmé");
});

test("efface un résultat privé et ignore sa réponse tardive lors d'une révocation", async () => {
  rows = [makeJob()];
  await mount();
  await click("Voir le résultat");
  expect(host.textContent).toContain("LOT CONFIDENTIEL");
  await act(async () => socket().disconnect(4403));
  expect(host.textContent).not.toContain("LOT CONFIDENTIEL");
  expect(host.textContent).toContain("Session ou droits indisponibles");
  await act(async () => jest.advanceTimersByTime(6000));
  expect(host.querySelectorAll(".tri-job")).toHaveLength(0);
  await click("Reconnecter");
  let resolve;
  detailReply = new Promise((done) => { resolve = done; });
  await click("Voir le résultat");
  await act(async () => socket().disconnect(4403));
  await act(async () => resolve({
    ok: true, status: 200, json: async () => ({
      id: JOB_ID, input: { kind: "vision_label" }, state: "done", result: { private_result: "TROP TARD" },
    }),
  }));
  expect(host.textContent).not.toContain("TROP TARD");
});

test("relance uniquement une tâche en échec et conserve la validation humaine", async () => {
  rows = [makeJob("failed")];
  await mount();
  expect(host.textContent).toContain("Trois tentatives automatiques");
  await click("Relancer cette analyse");
  expect(global.fetch.mock.calls.some(([url, options]) => url.endsWith("/retry") && options.method === "POST")).toBe(true);
  expect(host.textContent).toContain("En attente");
  expect(host.textContent).not.toContain("Relancer cette analyse");
});

test("un serveur silencieux ne conserve pas indéfiniment une ancienne mesure", async () => {
  await mount();
  global.fetch = jest.fn(() => new Promise(() => {}));
  await click("Reconnecter");
  expect(node("brain_1").dataset.status).toBe("unknown");
  await act(async () => jest.advanceTimersByTime(10001));
  expect(host.textContent).toContain("délai prévu");
});

test("ferme la socket et annule les temporisations au démontage", async () => {
  await mount();
  const current = socket();
  await act(async () => root.render(null));
  expect(current.closed).toBe(true);
  const requests = global.fetch.mock.calls.length;
  await act(async () => jest.advanceTimersByTime(20000));
  expect(global.fetch).toHaveBeenCalledTimes(requests);
});

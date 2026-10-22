import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import BoundedAutonomy from "./BoundedAutonomy";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const run = { id: "run", steps: [], summary: {}, plan: { objective: "Lecture" } };
const response = (body, status = 200) => ({ status, ok: status < 400, json: async () => body });
let root, host, originalFetch, onRun, state;
const render = (props = {}) => act(async () => root.render(<StrictMode><BoundedAutonomy run={run} onRun={onRun} {...props} /></StrictMode>));
const click = (text) => act(async () => [...host.querySelectorAll("button")].find((item) => item.textContent === text).click());
beforeEach(() => {
  jest.useFakeTimers();
  originalFetch = global.fetch;
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  onRun = jest.fn(); state = null;
  global.fetch = jest.fn(async (url, options) => {
    if (url.endsWith("/start")) state = "ACTIVE";
    if (url.endsWith("/stop")) state = "STOPPED";
    return state ? response({ run, state, cycles: 0, max_cycles: 2 }) : response({}, 404);
  });
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); jest.useRealTimers(); global.fetch = originalFetch;
});

test("consentement exact puis lancement explicite et arrêt, aucun POST au montage", async () => {
  await render();
  expect(global.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  expect([...host.querySelectorAll("button")][0].disabled).toBe(true);
  await act(async () => host.querySelector("input").click());
  await click("Autoriser ce parcours autonome");
  const post = global.fetch.mock.calls.find(([, options]) => options.method === "POST");
  expect(JSON.parse(post[1].body)).toEqual({ confirm: true, max_cycles: 2, max_seconds: 120 });
  expect(onRun).toHaveBeenCalledWith(run);
  await click("Arrêter l'autonomie de ce parcours");
  expect(host.textContent).toContain("STOPPED");
  expect(global.fetch.mock.calls.some(([url]) => url.endsWith("/stop"))).toBe(true);
});

test("le suivi restitue les preuves mais ne reprend jamais un parcours", async () => {
  state = "ACTIVE";
  await render();
  state = "COMPLETED";
  await act(async () => jest.advanceTimersByTime(3000));
  expect(host.textContent).toContain("COMPLETED");
  expect(global.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

test("un échec autonome restitue également l'état bloqué au panneau de preuves", async () => {
  state = "BLOCKED";
  await render();
  expect(host.textContent).toContain("BLOCKED");
  expect(onRun).toHaveBeenCalledWith(run);
  expect(global.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

test("lecture seule interdit les boutons d'autorisation et d'arrêt", async () => {
  state = "ACTIVE";
  await render({ auditOnly: true });
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(global.fetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

test("erreur d'autorisation explicite, sans répétition", async () => {
  await render();
  await act(async () => host.querySelector("input").click());
  global.fetch.mockImplementationOnce(async () => response({ detail: "Action non autorisée." }, 422));
  await click("Autoriser ce parcours autonome");
  expect(host.textContent).toContain("Action non autorisée.");
  expect(global.fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
});

test("une lecture ancienne ne peut pas écraser l'arrêt confirmé", async () => {
  state = "ACTIVE"; await render();
  let finish;
  global.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => jest.advanceTimersByTime(3000));
  await click("Arrêter l'autonomie de ce parcours");
  await act(async () => finish(response({ run, state: "ACTIVE" })));
  expect(host.textContent).toContain("STOPPED");
});

test("changement de parcours annule les anciennes lectures", async () => {
  await render();
  let finish;
  global.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => jest.advanceTimersByTime(3000));
  const signal = global.fetch.mock.calls.at(-1)[1].signal;
  await render({ run: { ...run, id: "different" } });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response({ run, state: "COMPLETED" })));
  expect(onRun).not.toHaveBeenCalled();
});

import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ActionInitiatives from "./ActionInitiatives";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const response = (data, ok = true) => ({ ok, json: async () => data });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
let host, root, originalFetch, data, review;
const click = (label) => act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === label).click());
const render = (props = {}) => act(async () => root.render(<StrictMode><ActionInitiatives onReview={review} {...props} /></StrictMode>));
const methods = () => global.fetch.mock.calls.map(([, options]) => options.method || "GET");
beforeEach(() => {
  jest.useFakeTimers();
  originalFetch = global.fetch;
  host = document.createElement("div");
  document.body.appendChild(host); root = createRoot(host); review = jest.fn();
  data = { settings: { enabled: false, last_error: "" }, items: [] };
  global.fetch = jest.fn(async (url, options) => {
    if (options.method === "PUT") data = { ...data, settings: { enabled: JSON.parse(options.body).enabled } };
    if (options.method === "POST") data = { ...data, items: [] };
    return response(data);
  });
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  global.fetch = originalFetch; jest.useRealTimers();
});

test("aucune action au montage ou au contrôle périodique, activation explicitement consentie", async () => {
  await render();
  expect(methods().every((method) => method === "GET")).toBe(true);
  expect(host.textContent).toContain("État : désactivé");
  expect([...host.querySelectorAll("button")].find((button) => button.textContent === "Activer les déclencheurs locaux")).toHaveProperty("disabled", true);
  await act(async () => host.querySelector("input").click());
  await click("Activer les déclencheurs locaux");
  expect(methods().filter((method) => method === "PUT")).toEqual(["PUT"]);
  expect(host.textContent).toContain("État : activé");
  await act(async () => jest.advanceTimersByTime(60000));
  expect(methods().filter((method) => method === "PUT")).toHaveLength(1);
  expect(methods()).not.toContain("POST");
  await click("Arrêter les déclencheurs locaux");
  expect(host.textContent).toContain("État : désactivé");
  expect(methods().filter((method) => method === "PUT")).toHaveLength(2);
});

test("consulter ne lance pas le parcours, masquer ne fait que masquer", async () => {
  data.items = [{ id: "proposal", run_id: "run", title: "Revoir le brouillon", current: true, reason: "Accord attendu" }];
  await render();
  await click("Consulter le parcours run");
  expect(review).toHaveBeenCalledWith("run");
  expect(methods().every((method) => method === "GET")).toBe(true);
  await click("Masquer cette proposition");
  expect(host.textContent).not.toContain("Revoir le brouillon");
  const post = global.fetch.mock.calls.find(([, options]) => options.method === "POST");
  expect(post[0]).toMatch(/\/ariane\/initiatives\/proposal\/dismiss$/);
  expect(global.fetch.mock.calls.some(([url]) => /execute|resume|confirm/.test(url))).toBe(false);
});

test("lecture seule et propositions obsolètes ne permettent aucune modification", async () => {
  data.settings.enabled = true;
  data.items = [{ id: "old", title: "Ancienne attente", run_id: "oldrun", current: false }];
  await render({ auditOnly: true });
  expect(host.textContent).toContain("Proposition devenue obsolète");
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(methods().every((method) => method === "GET")).toBe(true);
});

test("une ancienne lecture terminée après la mutation ne remplace pas le nouvel état", async () => {
  await render();
  const old = deferred();
  global.fetch.mockImplementationOnce(() => old.promise);
  await act(async () => jest.advanceTimersByTime(60000));
  await act(async () => host.querySelector("input").click());
  await click("Activer les déclencheurs locaux");
  expect(host.textContent).toContain("État : activé");
  await act(async () => old.resolve(response({ settings: { enabled: false }, items: [] })));
  expect(host.textContent).toContain("État : activé");
});

test("une erreur est explicite et aucune relance de mutation n'est cachée", async () => {
  await render();
  await act(async () => host.querySelector("input").click());
  global.fetch.mockImplementationOnce(async () => response({ detail: "Accès refusé." }, false));
  await click("Activer les déclencheurs locaux");
  expect(host.querySelector('[role="alert"]').textContent).toBe("Accès refusé.");
  expect(host.textContent).toContain("État : désactivé");
  expect(methods().filter((method) => method === "PUT")).toHaveLength(1);
  data.settings = { enabled: true, last_error: "Contrôle indisponible." };
  await act(async () => jest.advanceTimersByTime(60000));
  expect(host.textContent).toContain("Contrôle indisponible.");
  expect(methods().filter((method) => method === "PUT")).toHaveLength(1);
});

test("démontage annule les lectures et le contrôle périodique", async () => {
  await render();
  const pending = deferred();
  global.fetch.mockImplementationOnce(() => pending.promise);
  await act(async () => jest.advanceTimersByTime(60000));
  const signal = global.fetch.mock.calls.at(-1)[1].signal;
  act(() => root.unmount());
  expect(signal.aborted).toBe(true);
  const calls = global.fetch.mock.calls.length;
  await act(async () => { pending.resolve(response(data)); jest.advanceTimersByTime(120000); });
  expect(global.fetch).toHaveBeenCalledTimes(calls);
  root = createRoot(host);
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import ArianeActions, { ACTION_TEMPLATES } from "./ArianeActions";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const id = "a".repeat(32);
const fingerprint = "f".repeat(64);
const contract = { name: "finance.confirm", module: "PORTUS / CHRONOS", title: "Appliquer après accord", version: "1",
  kind: "mutation", risk: "sensitive", confirmation_required: true, reversible: false,
  timeout_seconds: 30, max_attempts: 3, input_schema: {}, output_schema: {} };
const result = {
  id, state: "WAITING_CONFIRMATION", created_at: "2026-10-17", expires_at: "2026-10-18",
  plan: { objective: "Surveiller AAPL", steps: ACTION_TEMPLATES.alert.steps },
  summary: { COMPLETED: 1, WAITING_CONFIRMATION: 1, BLOCKED: 0, SKIPPED: 0 },
  steps: [
    { id: "apercu", action: "finance.prepare", state: "COMPLETED", output: { data: { summary: "AAPL 200 USD" } }, attempts: 1, duration_ms: 1 },
    { id: "validation", action: "finance.confirm", state: "WAITING_CONFIRMATION", attempts: 0, depends_on: ["apercu"],
      prepared: { fingerprint, inputs: { preview: { summary: "Activer AAPL à 200 USD", id: "b".repeat(32) } } } },
  ], events: [{ step: "apercu", state: "COMPLETED" }], events_truncated: false,
};
let root, host, originalFetch, originalCrypto;
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent === text);
const click = (text) => act(async () => button(text).click());
const mount = (auditOnly = false) => act(async () => root.render(<ArianeActions auditOnly={auditOnly} />));
const response = (data, ok = true) => ({ ok, json: async () => data });
const posts = () => global.fetch.mock.calls.filter(([, options]) => options.method === "POST");
const missionForm = () => [...host.querySelectorAll("fieldset")].find((item) =>
  item.querySelector("legend")?.textContent.includes("délégation"));
beforeEach(() => {
  originalFetch = global.fetch; originalCrypto = global.crypto;
  global.crypto = { getRandomValues: (bytes) => require("crypto").randomFillSync(bytes) };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  global.fetch = jest.fn(async (url, options) => response(String(url).endsWith("/initiatives")
    ? { settings: { enabled: false }, items: [] } : String(url).endsWith("/actions")
    ? { actions: [contract] } : options.method || String(url).endsWith(id) ? result
      : { items: [{ id, objective: result.plan.objective }], truncated: true }));
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  global.fetch = originalFetch; global.crypto = originalCrypto;
});

test("guided plans use only registered actions, explicit dependencies and no implicit approval", async () => {
  await mount();
  await act(async () => {
    const select = host.querySelector("select");
    select.value = "alert"; select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Démarrer la préparation et les lectures");
  const body = JSON.parse(posts()[0][1].body);
  expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(body.steps).toEqual(ACTION_TEMPLATES.alert.steps);
  expect(posts()).toHaveLength(1);
  expect(host.textContent).toContain("Activer AAPL à 200 USD");
  expect(host.textContent).toContain(fingerprint);
  expect(host.textContent).toContain("Votre accord est requis");
  expect(host.textContent).toContain("Pas de compensation automatique");
  expect(host.textContent).toContain("Historique tronqué");
  await click("J'autorise uniquement l'étape validation");
  expect(posts()[1][0]).toContain(`/runs/${id}/steps/validation/confirm`);
  expect(JSON.parse(posts()[1][1].body)).toEqual({ confirm: true, fingerprint });
});

test("multi-agent form prepares the exact context without any API call or implicit approval", async () => {
  await mount();
  const mission = missionForm();
  await act(async () => {
    const input = mission.querySelector("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Organiser une réunion");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const context = mission.querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(context, "Contexte volontaire uniquement");
    context.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Préparer cette délégation sans appel IA");
  expect(posts()).toHaveLength(0);
  await click("Démarrer la préparation et les lectures");
  const body = JSON.parse(posts()[0][1].body);
  expect(body.steps).toEqual([{ id: "delegation", action: "agents.mission", inputs: {
    objective: "Organiser une réunion", context: "Contexte volontaire uniquement",
    specialists: ["documents", "messagerie", "planning"],
  } }]);
  expect(posts()).toHaveLength(1);
  expect(host.textContent).toContain("Quatre appels maximum");
});

test("lost response locks the request payload, retries same reference and prevents double clicks", async () => {
  let count = 0;
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => {
    if (options.method && ++count === 1) throw new Error("Coupure");
    return original(url, options);
  });
  await mount(); await click("Démarrer la préparation et les lectures");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Une action peut déjà être enregistrée");
  expect(missionForm().disabled).toBe(true);
  await act(async () => { button("Réessayer la même référence").click(); button("Réessayer la même référence").click(); });
  expect(posts()).toHaveLength(2);
  expect(posts()[0][1].body).toBe(posts()[1][1].body);
  expect(missionForm().disabled).toBe(false);
});

test("NEMESIS is read only even for runs waiting for approval", async () => {
  await mount(true); await click(`Consulter ${id}`);
  expect(host.textContent).toContain("Activer AAPL à 200 USD");
  expect(host.textContent).not.toContain("Démarrer la préparation");
  expect(host.textContent).not.toContain("J'autorise");
  expect(host.textContent).not.toContain("Reprendre ce parcours");
  expect(host.textContent).not.toContain("Arrêter les prochaines étapes");
  expect(posts()).toHaveLength(0);
});

test("stopping asks for a precise preview, does not claim compensation and preserves current run", async () => {
  await mount(); await click(`Consulter ${id}`);
  await click("Arrêter les prochaines étapes");
  expect(posts()).toHaveLength(0);
  expect(host.textContent).toContain("Une étape déjà engagée peut finir");
  await click("Conserver le parcours");
  expect(posts()).toHaveLength(0);
  await click("Arrêter les prochaines étapes");
  await click("Confirmer l'arrêt du parcours");
  expect(posts()[0][0]).toContain(`/runs/${id}/cancel`);
});

test("blocked steps keep their reasons and resume the same run", async () => {
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => String(url).endsWith(id)
    ? response({ ...result, state: "BLOCKED", steps: [{ ...result.steps[1], state: "BLOCKED", reason: "Source absente", attempts: 3 }] })
    : original(url, options));
  await mount(); await click(`Consulter ${id}`);
  expect(host.textContent).toContain("Source absente");
  expect(host.textContent).toContain("3 tentative(s)");
  await click("Reprendre ce parcours commun");
  expect(posts()[0][0]).toContain(`/runs/${id}/resume`);
});

test("invalid server response is surfaced rather than displayed as an empty success", async () => {
  global.fetch.mockResolvedValue(response({}));
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain("incomplet");
  expect(button("Démarrer la préparation et les lectures").disabled).toBe(true);
});

test("an old account response cannot enter the remounted workspace", async () => {
  let finish;
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => options.method
    ? new Promise((resolve) => { finish = resolve; }) : original(url, options));
  await act(async () => root.render(<ArianeActions key="first" />));
  await click("Démarrer la préparation et les lectures");
  const pendingSignal = posts()[0][1].signal;
  await act(async () => root.render(<ArianeActions key="second" />));
  expect(pendingSignal.aborted).toBe(true);
  await act(async () => finish(response(result)));
  expect(host.textContent).not.toContain("Référence " + id);
  expect(host.textContent).not.toContain("J'autorise uniquement l'étape");
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import WorkInbox from "./WorkInbox";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const id = "a".repeat(32);
const fingerprint = "f".repeat(64);
const inbox = {
  workspace_id: "shared-workspace", checked_at: "2026-10-17T12:00:00Z", continuity: "Même compte et même service.",
  notification_limits: "Pas de push natif hors application.",
  runs: [{ id, objective: "Relance de facture", state: "WAITING_CONFIRMATION", expires_at: "2026-11-01",
    steps: [{ id: "envoi", action: "work.invoice_send", state: "WAITING_CONFIRMATION", reason: null,
      prepared: { fingerprint, inputs: { to: "client@example.test", subject: "Relance F001",
        message: "Solde 100 euros", followup_at: "2026-11-02T09:00:00Z", sender: "sender@example.test" } } }] }],
  runs_truncated: false,
  reminders: [{ id: "b".repeat(32), text: "Vérifier le règlement", due_at: "2026-11-02T09:00:00Z", state: "SCHEDULED" }],
  notifications: [],
  business: { proposals: [{ id: "p1", title: "Facture échue F001", reason: "Solde positif", why_suggested: { rule: "due < today" } }],
    commitments: [], queue: [], dossiers: [{ id: "D-A", title: "Client A" }],
    missing_info: ["Paiements hors THÉMIS non connus."], truncated: false },
  metrics: { examined: 1, completed: 0, completion_rate_pct: 0, waiting: 1, blocked: 0, cancelled: 0,
    expired: 0, provider_accepted_all_time: 0, provider_unknown_all_time: 0, measured_duration_ms: 5,
    human_confirmations: 0, recovered_steps: 0, send_reuse_steps: 0,
    scope: "cent derniers parcours communs" },
};
let root, host, originalFetch, originalCrypto;
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent === text);
const click = (text) => act(async () => button(text).click());
const mount = (props = {}) => act(async () => root.render(<WorkInbox {...props} />));
const posts = () => global.fetch.mock.calls.filter(([, options]) => options.method === "POST");
async function input(selector, value) {
  await act(async () => {
    const element = host.querySelector(selector);
    const setter = Object.getOwnPropertyDescriptor(element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value").set;
    setter.call(element, value);
    element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
beforeEach(() => {
  originalFetch = global.fetch; originalCrypto = global.crypto;
  global.crypto = { getRandomValues: (bytes) => require("crypto").randomFillSync(bytes) };
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  global.fetch = jest.fn(async (_url, options) => response(options.method ? { id, steps: [] } : inbox));
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  global.fetch = originalFetch; global.crypto = originalCrypto;
});

test("inbox groups sourced business signals, exact approvals, reminders and factual metrics", async () => {
  await mount();
  expect(host.textContent).toContain("shared-workspace");
  expect(host.textContent).toContain("Facture échue F001");
  expect(host.textContent).toContain("client@example.test");
  expect(host.textContent).toContain("100 euros");
  expect(host.textContent).toContain("Temps économisé et livraison : non mesurés");
  expect(host.textContent).toContain("Pas de push natif");
  expect(posts()).toHaveLength(0);
  await click(`Valider uniquement envoi · ${id}`);
  expect(posts()).toHaveLength(1);
  expect(posts()[0][0]).toContain(`/ariane/runs/${id}/steps/envoi/confirm`);
  expect(JSON.parse(posts()[0][1].body)).toEqual({ confirm: true, fingerprint });
});

test("guided invoice preparation uses selected dossier, exact invoice and explicit future followup", async () => {
  await mount({ dossierId: "D-A", invoices: [{ id: "INV-A", label: "F001" }] });
  await input('input[type="datetime-local"]', "2099-01-02T09:00");
  await input("select", "INV-A");
  await click("Préparer la relance et son suivi");
  expect(posts()[0][0]).toContain("/work-hub/invoice-followup");
  const body = JSON.parse(posts()[0][1].body);
  expect(body.dossier_id).toBe("D-A");
  expect(body.invoice_id).toBe("INV-A");
  expect(body.followup_at).toMatch(/^2099-01-02T/);
  expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(posts().every(([url]) => !url.includes("confirm"))).toBe(true);
});

test("lost creation response locks inputs and retries identical UUID and payload without double submission", async () => {
  let count = 0;
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => {
    if (options.method && ++count === 1) throw new Error("Network lost");
    return original(url, options);
  });
  await mount();
  await input('input[type="datetime-local"]', "2099-01-02T09:00");
  await input('input[maxlength="300"]', "Vérifier le client");
  await click("Préparer ce rappel");
  expect(host.querySelector("fieldset").disabled).toBe(true);
  expect(host.querySelector('[role="alert"]').textContent).toContain("Ne recréez pas un envoi");
  await act(async () => { button("Retrouver la même demande").click(); button("Retrouver la même demande").click(); });
  expect(posts()).toHaveLength(2);
  expect(posts()[0][1].body).toBe(posts()[1][1].body);
  expect(host.querySelector("fieldset").disabled).toBe(false);
});

test("known input rejection allows correction rather than leaving the form permanently locked", async () => {
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation(async (url, options) => options.method
    ? response({ detail: "Échéance future dans les 366 jours" }, 422) : original(url, options));
  await mount();
  await input('input[type="datetime-local"]', "2099-01-02T09:00");
  await input('input[maxlength="300"]', "Rappel");
  await click("Préparer ce rappel");
  expect(host.querySelector("fieldset").disabled).toBe(false);
  expect(host.querySelector('[role="alert"]').textContent).toContain("366 jours");
});

test("cancel is explicit and does not claim to undo an accepted email", async () => {
  await mount();
  await click(`Ignorer / arrêter ${id}`);
  expect(posts()).toHaveLength(0);
  expect(host.textContent).toContain("sans annuler un message engagé");
  await click("Confirmer l'arrêt");
  expect(posts()[0][0]).toContain(`/ariane/runs/${id}/cancel`);
});

test("reminder suspension only prepares a new confirmation", async () => {
  await mount();
  await click(`Préparer la suspension ${"b".repeat(32)}`);
  expect(posts()[0][0]).toContain("/cancel-preview");
  expect(posts()[0][0]).not.toContain("/confirm");
});

test("shared inbox opens the selected dossier instead of leaving a dead-end signal", async () => {
  const onSelectDossier = jest.fn();
  await mount({ onSelectDossier });
  await click("Préparer dans Client A");
  expect(onSelectDossier).toHaveBeenCalledWith("D-A");
  expect(posts()).toHaveLength(0);
});

test("old account response is aborted and cannot populate the next account", async () => {
  let finish;
  global.fetch.mockImplementationOnce(async () => new Promise((resolve) => { finish = resolve; }));
  await act(async () => root.render(<WorkInbox key="old" />));
  const signal = global.fetch.mock.calls[0][1].signal;
  await act(async () => root.render(<WorkInbox key="new" />));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(response({ ...inbox, workspace_id: "old-private-workspace" })));
  expect(host.textContent).not.toContain("old-private-workspace");
  expect(host.textContent).toContain("shared-workspace");
});

test("invalid inbox response is explicit rather than a successful empty state", async () => {
  global.fetch.mockResolvedValue(response({}));
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Boîte de travail incomplète");
});

test("refresh begun before confirmation cannot restore an obsolete approval", async () => {
  await mount();
  let finish;
  global.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => window.dispatchEvent(new Event("focus")));
  global.fetch.mockResolvedValueOnce(response({ id, steps: [] }));
  global.fetch.mockResolvedValueOnce(response({ ...inbox, runs: [{ ...inbox.runs[0], state: "COMPLETED", steps: [] }] }));
  await click(`Valider uniquement envoi · ${id}`);
  expect(button(`Valider uniquement envoi · ${id}`)).toBeUndefined();
  await act(async () => finish(response(inbox)));
  expect(button(`Valider uniquement envoi · ${id}`)).toBeUndefined();
  await input("select", "all");
  expect(host.textContent).toContain("Terminé");
});

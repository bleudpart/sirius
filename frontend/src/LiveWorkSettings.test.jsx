import { act } from "react";
import { createRoot } from "react-dom/client";
import LiveWorkSettings, { liveWorkKeys } from "./LiveWorkSettings";
import { assertSecureKeyTransport, loadApiKeys } from "./apiKeyStorage";

jest.mock("./apiKeyStorage", () => ({
  loadApiKeys: jest.fn(() => ({})),
  assertSecureKeyTransport: jest.fn(),
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let root;
let host;
const dossier = { id: "d1", title: "Boutique" };
const latest = {
  description: "Stock modifié", analysis: { text: "À vérifier", error: "" },
  changes: [{ source: { kind: "stock", id: "item" },
    fields: [{ name: "stock", before: 2, after: 1, delta: "-1", percent: "-50.00" }] }],
};

beforeEach(() => {
  jest.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ latest }) });
  loadApiKeys.mockReturnValue({});
  assertSecureKeyTransport.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
  jest.useRealTimers();
});
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent === text);

test("suivi désactivé par défaut, consentement explicite avant toute écriture", async () => {
  const queue = jest.fn();
  await act(async () => root.render(<LiveWorkSettings dossier={dossier} queue={queue} onError={jest.fn()} />));
  expect(host.textContent).toContain("Suivi désactivé");
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => button("Autoriser le suivi avec IA").click());
  expect(global.fetch).not.toHaveBeenCalled();
  const review = queue.mock.calls[0][0];
  expect(review.text).toContain("anciennes/nouvelles valeurs");
  expect(review.text).toContain("Aucune opération métier");
  await act(async () => review.operation());
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/d1/live-settings"),
    expect.objectContaining({ method: "PUT", credentials: "include",
      body: JSON.stringify({ enabled: true, allow_ai: true }) }));
});

test("comparaison manuelle, différences visibles et anciennes analyses masquées à l'arrêt", async () => {
  const active = { ...dossier, live_settings: { enabled: true, allow_ai: false } };
  const onError = jest.fn();
  const queue = jest.fn();
  await act(async () => root.render(<LiveWorkSettings dossier={active} queue={queue} onError={onError} />));
  expect(host.textContent).toContain("-50.00 %");
  expect(host.textContent).toContain("Interprétation IA · à vérifier");
  await act(async () => button("Comparer maintenant").click());
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/live/evaluate"),
    expect.objectContaining({ body: JSON.stringify({ keys: {}, dossier_id: "d1" }) }));
  await act(async () => button("Arrêter le suivi").click());
  expect(queue.mock.calls[0][0].text).toContain("effacée");
  await act(async () => queue.mock.calls[0][0].operation());
  await act(async () => root.render(<LiveWorkSettings dossier={dossier} queue={queue} onError={onError} />));
  expect(host.textContent).not.toContain("Stock modifié");
  const count = global.fetch.mock.calls.length;
  await act(async () => jest.advanceTimersByTime(120000));
  expect(global.fetch).toHaveBeenCalledTimes(count);
});

test("erreurs du suivi signalées, sans faux succès", async () => {
  const onError = jest.fn();
  global.fetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: "Service indisponible" }) });
  await act(async () => root.render(<LiveWorkSettings
    dossier={{ ...dossier, live_settings: { enabled: true } }} queue={jest.fn()} onError={onError} />));
  expect(onError).toHaveBeenCalledWith("Suivi du dossier : Service indisponible");
});

test("seules les clés des fournisseurs autorisés partent par un transport sécurisé", () => {
  loadApiKeys.mockReturnValue({ groq_key: "groq-test", k3: "kimi-test", serp: "excluded" });
  expect(liveWorkKeys()).toEqual({ groq_key: "groq-test", k3: "kimi-test" });
  expect(assertSecureKeyTransport).toHaveBeenCalledTimes(1);
  assertSecureKeyTransport.mockImplementationOnce(() => { throw new Error("Transport non sécurisé"); });
  expect(() => liveWorkKeys()).toThrow("Transport non sécurisé");
});

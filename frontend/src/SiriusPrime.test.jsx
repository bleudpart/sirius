import { act } from "react";
import { createRoot } from "react-dom/client";
import SiriusPrime from "./SiriusPrime";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
const originalMatchMedia = window.matchMedia;
let host, root;
const overview = {
  totals: { events: 0, facts: 0, days: 0 },
  habits: { hours: Array(24).fill(0), weekdays: Array(7).fill(0), intents: [] },
  journal: [], suggestions: [], memories: [], confidence: 0,
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  window.matchMedia = jest.fn(() => ({ matches: true }));
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: jest.fn(), fillRect: jest.fn(), fillText: jest.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
});

test("an unavailable backend leaves PRIME usable with an explicit error and retry", async () => {
  const json = jest.fn();
  global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 503, json })
    .mockResolvedValueOnce({ ok: true, json: async () => overview });
  await act(async () => root.render(<SiriusPrime onClose={() => {}} />));
  expect(json).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]').textContent).toContain("HTTP 503");
  expect(host.textContent).toContain("MÉMOIRE INDISPONIBLE");
  expect(host.querySelector('[data-testid="prime-close-btn"]')).not.toBeNull();
  await act(async () => host.querySelector('[role="alert"] button').click());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("0 COMMANDES");
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("a network failure is visible instead of leaving an endless loading label", async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error("Backend injoignable."));
  await act(async () => root.render(<SiriusPrime onClose={() => {}} />));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Backend injoignable.");
  expect(host.textContent).not.toContain("CHARGEMENT...");
});

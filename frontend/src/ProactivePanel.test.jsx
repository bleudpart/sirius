import { act } from "react";
import { createRoot } from "react-dom/client";
import ProactivePanel, { ProactiveConversation } from "./ProactivePanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let root;
let host;
const suggestion = { id: "test", title: "Suggestion", description: "Test", urgency: "faible", risk_level: "faible" };

beforeEach(() => {
  jest.useFakeTimers();
  localStorage.removeItem("sirius_panel_pos");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ suggestions: [suggestion] }) });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
  localStorage.removeItem("sirius_panel_pos");
  jest.useRealTimers();
});

test("une initiative entre dans le dialogue au moment de parler sans alerte flottante", async () => {
  const onInitiative = jest.fn();
  const onSpeak = jest.fn();
  await act(async () => root.render(<ProactivePanel onSpeak={onSpeak} onInitiative={onInitiative} />));
  expect(host.innerHTML).toBe("");
  expect(onInitiative).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(45000));
  expect(onInitiative).toHaveBeenCalledWith(suggestion, "Test");
  expect(onSpeak).toHaveBeenCalledWith("Test");
  await act(async () => jest.advanceTimersByTime(300000));
  expect(onInitiative).toHaveBeenCalledTimes(1);
});

test("les actions restent disponibles sous le message sans badges d'urgence", async () => {
  await act(async () => root.render(<ProactiveConversation suggestion={suggestion} />));
  expect(host.querySelector(".sugg-badge")).toBeNull();
  const button = host.querySelector('[data-testid="sugg-later-btn"]');
  await act(async () => button.click());
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/suggestions/test/action"),
    expect.objectContaining({ body: JSON.stringify({ action: "plus_tard", token: null }) }));
});

test("les actions sensibles demandent toujours une confirmation", async () => {
  const onAction = jest.fn();
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ needs_confirmation: true, token: "confirm" }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ executed: true, proposed_action: { type: "command", text: "test" } }) });
  await act(async () => root.render(<ProactiveConversation suggestion={suggestion} onAction={onAction} />));
  await act(async () => host.querySelector('[data-testid="sugg-exec-btn"]').click());
  expect(onAction).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="sugg-confirm-msg"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid="sugg-exec-btn"]').click());
  expect(global.fetch.mock.calls[1][1].body).toBe(JSON.stringify({ action: "executer", token: "confirm" }));
  expect(onAction).toHaveBeenCalledWith({ type: "command", text: "test" });
});

test("announces during silence, never during speech, and never repeats an item", async () => {
  const onSpeak = jest.fn();
  let available = false;
  await act(async () => root.render(<ProactivePanel onSpeak={onSpeak} canSpeak={() => available} />));
  await act(async () => jest.advanceTimersByTime(45000));
  expect(onSpeak).not.toHaveBeenCalled();
  available = true;
  act(() => window.dispatchEvent(new CustomEvent("sirius-voice-phase", { detail: "speaking" })));
  await act(async () => jest.advanceTimersByTime(50000));
  expect(onSpeak).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new CustomEvent("sirius-voice-phase", { detail: "idle" })));
  await act(async () => jest.advanceTimersByTime(45000));
  expect(onSpeak).toHaveBeenCalledTimes(1);
  expect(onSpeak).toHaveBeenCalledWith("Test");
  await act(async () => jest.advanceTimersByTime(300000));
  expect(onSpeak).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/suggestions/evaluate"),
    expect.objectContaining({ credentials: "include" }));
});

test("respects user activity and the minimum gap between distinct initiatives", async () => {
  const onSpeak = jest.fn();
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({
    suggestions: [suggestion, { ...suggestion, id: "second", description: "Autre nouvelle" }],
  }) });
  await act(async () => root.render(<ProactivePanel onSpeak={onSpeak} />));
  await act(async () => jest.advanceTimersByTime(40000));
  act(() => window.dispatchEvent(new Event("keydown")));
  await act(async () => jest.advanceTimersByTime(44000));
  expect(onSpeak).not.toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(1000));
  expect(onSpeak).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTime(115000));
  expect(onSpeak).toHaveBeenCalledTimes(1);
  await act(async () => jest.advanceTimersByTime(5000));
  expect(onSpeak).toHaveBeenCalledTimes(2);
});

test("reports HTTP errors instead of silently hiding failed evaluations", async () => {
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  const onError = jest.fn();
  global.fetch.mockResolvedValue({ ok: false, status: 401 });
  try {
    await act(async () => root.render(<ProactivePanel onSpeak={jest.fn()} onError={onError} />));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("Proactivité indisponible"));
    expect(consoleError).toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

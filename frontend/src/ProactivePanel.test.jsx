import { act } from "react";
import { createRoot } from "react-dom/client";
import ProactivePanel from "./ProactivePanel";

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

function pointer(target, type, x, y, button = 0) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, button, pointerId: 1 });
  target.dispatchEvent(event);
}

test("anticipation header moves the panel and persists its position", async () => {
  await act(async () => root.render(<ProactivePanel />));
  const panel = host.querySelector(".proactive-stack");
  panel.getBoundingClientRect = () => ({
    left: parseFloat(panel.style.left) || 26,
    top: parseFloat(panel.style.top) || 120,
  });
  pointer(host.querySelector(".pro-mode-row"), "pointerdown", 30, 125);
  pointer(window, "pointermove", 104, 205);
  act(() => jest.advanceTimersByTime(20));
  expect(panel.style.left).toBe("100px");
  expect(panel.style.top).toBe("200px");
  pointer(window, "pointerup", 104, 205);
  expect(JSON.parse(localStorage.getItem("sirius_panel_pos"))["proactive-panel"]).toEqual({ x: 100, y: 200 });
  expect(panel.classList.contains("dragging")).toBe(false);
});

test("suggestion buttons do not start a drag and retain their actions", async () => {
  await act(async () => root.render(<ProactivePanel />));
  const panel = host.querySelector(".proactive-stack");
  const button = host.querySelector('[data-testid="sugg-later-btn"]');
  pointer(button, "pointerdown", 30, 125);
  pointer(window, "pointermove", 200, 250);
  expect(panel.style.left).toBe("");
  await act(async () => button.click());
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/suggestions/test/action"),
    expect.objectContaining({ body: JSON.stringify({ action: "plus_tard", token: null }) }));
});

test("saved panel position is restored and clamped to the viewport", async () => {
  localStorage.setItem("sirius_panel_pos", JSON.stringify({ "proactive-panel": { x: -30, y: 99999 } }));
  await act(async () => root.render(<ProactivePanel />));
  const panel = host.querySelector(".proactive-stack");
  expect(panel.style.left).toBe("0px");
  expect(parseFloat(panel.style.top)).toBeLessThanOrEqual(window.innerHeight);
  pointer(host.querySelector(".pro-mode-row"), "pointerdown", 0, 0, 2);
  expect(panel.classList.contains("dragging")).toBe(false);
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
  global.fetch.mockResolvedValue({ ok: false, status: 401 });
  try {
    await act(async () => root.render(<ProactivePanel onSpeak={jest.fn()} />));
    expect(host.querySelector('[role="alert"]').textContent).toContain("Proactivité indisponible");
    expect(consoleError).toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

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
  global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ suggestions: [suggestion] }) });
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

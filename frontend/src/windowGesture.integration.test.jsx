import { act } from "react";
import { createRoot } from "react-dom/client";
import WebWindows from "./WebWindows";
import HudPanel from "./hud/HudPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
let frame;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  localStorage.clear();
  window.matchMedia = jest.fn(() => ({ matches: true }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => { frame = fn; return 1; });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.querySelectorAll(".shud-floating").forEach((el) => el.remove());
  localStorage.clear();
  jest.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
});

function pointer(target, type, x, y) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { button: 0, isPrimary: true, pointerType: "touch", pointerId: 1, clientX: x, clientY: y });
  act(() => target.dispatchEvent(event));
}

test("web window follows touch, finishes on cancellation, and does not drag from buttons", () => {
  act(() => root.render(<WebWindows windows={[{ id: "test", url: "about:blank", x: 10, y: 20 }]} onClose={() => {}} />));
  const panel = host.querySelector(".web-window");
  panel.getBoundingClientRect = () => ({ left: 10, top: 20 });
  const bar = host.querySelector(".ww-bar");
  pointer(bar, "pointerdown", 15, 25);
  pointer(window, "pointermove", 45, 75);
  act(() => frame());
  expect(panel.style.left).toBe("40px");
  expect(panel.style.top).toBe("70px");
  pointer(window, "pointercancel", 45, 75);
  expect(panel.classList.contains("dragging")).toBe(false);
  pointer(bar.querySelector("button"), "pointerdown", 10, 10);
  expect(panel.classList.contains("dragging")).toBe(false);
});

test("a tap does not detach a HUD card; a drag in a scaled parent preserves screen coordinates", () => {
  act(() => root.render(<div style={{ transform: "scale(0.8)" }}><HudPanel title="Carte" panelKey="scaled">Contenu</HudPanel></div>));
  const parent = host.firstChild;
  Object.defineProperties(parent, { offsetWidth: { value: 320 }, offsetHeight: { value: 125 } });
  parent.getBoundingClientRect = () => ({ left: 30, top: 440, width: 256, height: 100 });
  const panel = host.querySelector(".shud-panel");
  panel.getBoundingClientRect = () => {
    if (panel.style.position === "fixed") {
      expect(panel.matches(".shud-dragging, .shud-floating")).toBe(true);
    }
    return {
      left: panel.style.left ? 30 + parseFloat(panel.style.left) * 0.8 : 30,
      top: panel.style.top ? 440 + parseFloat(panel.style.top) * 0.8 : 440,
      width: 256, height: 60,
    };
  };
  const header = panel.querySelector("header");
  pointer(header, "pointerdown", 50, 455);
  pointer(window, "pointerup", 50, 455);
  expect(localStorage.getItem("sirius_hud_float_scaled")).toBeNull();
  pointer(header, "pointerdown", 50, 455);
  pointer(window, "pointermove", 80, 500);
  act(() => frame());
  expect(panel.style.left).toBe("37.5px");
  expect(panel.style.top).toBe("56.25px");
  pointer(window, "pointerup", 80, 500);
  expect(JSON.parse(localStorage.getItem("sirius_hud_float_scaled"))).toEqual({ left: 60, top: 485, width: 256, height: 60 });
  expect(document.body.querySelector(".shud-floating")).not.toBeNull();
});

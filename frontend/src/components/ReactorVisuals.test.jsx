import { act } from "react";
import { createRoot } from "react-dom/client";
import { ReactorCore } from "./ReactorVisuals";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let ctx;
let frame;
let mobile;
let hidden;

beforeEach(() => {
  mobile = false;
  hidden = false;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ctx = {
    clearRect: jest.fn(), fillRect: jest.fn(), beginPath: jest.fn(),
    arc: jest.fn(), fill: jest.fn(), stroke: jest.fn(), save: jest.fn(),
    restore: jest.fn(), translate: jest.fn(), rotate: jest.fn(),
    moveTo: jest.fn(), lineTo: jest.fn(), setLineDash: jest.fn(),
    createRadialGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
  };
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  jest.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(160);
  jest.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  window.matchMedia = jest.fn(() => ({ matches: mobile }));
  global.ResizeObserver = jest.fn(() => ({ observe: jest.fn(), disconnect: jest.fn() }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.restoreAllMocks();
  delete window.matchMedia;
  delete global.ResizeObserver;
});

function render(eco = false) {
  act(() => root.render(<ReactorCore status="thinking" volume={0.35} color="#91e6f2" eco={eco} />));
  frame(1000);
}

test("mobile uses the same inexpensive drawing path as explicit economy mode", () => {
  mobile = true;
  render();
  const mobileStrokes = ctx.stroke.mock.calls.length;
  expect(ctx.lineTo).not.toHaveBeenCalled();
  act(() => root.unmount());
  root = createRoot(host);
  ctx.stroke.mockClear();
  mobile = false;
  render(true);
  expect(ctx.stroke).toHaveBeenCalledTimes(mobileStrokes);
});

test("desktop keeps the richer visuals and resize to mobile switches to light rendering", () => {
  render();
  expect(ctx.lineTo).toHaveBeenCalled();
  const desktopStrokes = ctx.stroke.mock.calls.length;
  ctx.lineTo.mockClear();
  ctx.stroke.mockClear();
  mobile = true;
  frame(2000);
  expect(ctx.lineTo).not.toHaveBeenCalled();
  expect(ctx.stroke.mock.calls.length).toBeLessThan(desktopStrokes);
});

test("does not paint while hidden or covered by a mobile module", () => {
  hidden = true;
  render();
  expect(ctx.clearRect).not.toHaveBeenCalled();
  hidden = false;
  mobile = true;
  const cover = document.createElement("div");
  cover.className = "holo-win";
  host.appendChild(cover);
  frame(2000);
  expect(ctx.clearRect).not.toHaveBeenCalled();
  cover.remove();
  frame(3000);
  expect(ctx.clearRect).toHaveBeenCalledTimes(1);
});

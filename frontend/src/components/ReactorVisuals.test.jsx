import { act } from "react";
import { createRoot } from "react-dom/client";
import { getHUDStyleVariables } from "../theme";
import { ReactorCore, Waveform } from "./ReactorVisuals";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
let ctx;
let frame;
let mobile;
let hidden;
let canvasWidth;
let resizeCanvas;
let observer;

beforeEach(() => {
  mobile = false;
  hidden = false;
  canvasWidth = 160;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  ctx = {
    clearRect: jest.fn(), fillRect: jest.fn(), beginPath: jest.fn(),
    arc: jest.fn(), fill: jest.fn(), stroke: jest.fn(), save: jest.fn(),
    restore: jest.fn(), translate: jest.fn(), rotate: jest.fn(),
    moveTo: jest.fn(), lineTo: jest.fn(), setLineDash: jest.fn(),
    createRadialGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
  };
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  jest.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(160);
  jest.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: canvasWidth, height: 12 }));
  jest.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frame = callback;
    return 1;
  });
  jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  window.matchMedia = jest.fn(() => ({ matches: mobile }));
  global.ResizeObserver = jest.fn((callback) => {
    resizeCanvas = callback;
    observer = { observe: jest.fn(), disconnect: jest.fn() };
    return observer;
  });
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

test("the speaking spectrum keeps its motion and uses only the selected cyan shades", () => {
  const theme = { cyan: "#448899", gold: "#a1773e", background: "#061321" };
  const palette = getHUDStyleVariables(theme);
  const strokes = [];
  const particles = [];
  let randomCalls = 0;
  jest.spyOn(Math, "random").mockImplementation(() => {
    randomCalls += 1;
    return randomCalls % 12 === 0 ? 0.1 : 0.5;
  });
  ctx.stroke.mockImplementation(() => strokes.push({ color: ctx.strokeStyle, shadow: ctx.shadowColor }));
  ctx.fill.mockImplementation(() => particles.push({ color: ctx.fillStyle, shadow: ctx.shadowColor }));
  act(() => root.render(<Waveform status="speaking" color="#448899" theme={theme} />));

  const gradient = ctx.createLinearGradient.mock.results[0].value;
  expect(gradient.addColorStop.mock.calls.map(([, color]) => color)).toEqual([
    palette["--workspace-cyan"], palette["--sirius-cyan-light"],
    palette["--workspace-cyan"], palette["--workspace-cyan"],
  ]);
  expect(strokes[0]).toEqual({ color: palette["--workspace-cyan"], shadow: palette["--sirius-cyan-light"] });
  expect(strokes[1]).toEqual({ color: gradient, shadow: palette["--workspace-cyan"] });
  expect(particles).toEqual(expect.arrayContaining([
    { color: palette["--sirius-cyan-light"], shadow: palette["--workspace-cyan"] },
    { color: palette["--workspace-cyan"], shadow: palette["--sirius-cyan-light"] },
  ]));
  const firstFrame = ctx.lineTo.mock.calls.slice(0, 20);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const t = 0.05;
  const nx = 3 / 160;
  const mid = 6 * dpr;
  const amp = 0.35 + 0.35 * Math.abs(Math.sin(t * 1.6)) + 0.12 * Math.sin(t * 4.3);
  const envelope = Math.pow(Math.sin(nx * Math.PI), 0.75);
  const noise = Math.sin(nx * 57 + t * 5.1) * Math.sin(nx * 23 - t * 3.7) * Math.sin(nx * 91 + t * 2.3);
  expect(firstFrame[1][0]).toBe(3 * dpr);
  expect(firstFrame[1][1]).toBeCloseTo(mid + Math.abs(noise) * mid * amp * envelope * 1.5 + 1);
  ctx.lineTo.mockClear();
  frame(1000);
  expect(ctx.lineTo.mock.calls.slice(0, 20)).not.toEqual(firstFrame);
  expect(strokes).toHaveLength(6);
});

test("the reference spectrum has rounded tapered cyan bars and remains animated", () => {
  const theme = { cyan: "#448899", gold: "#a1773e", background: "#061321" };
  const palette = getHUDStyleVariables(theme);
  const strokes = [];
  jest.spyOn(Math, "random").mockReturnValue(0.5);
  ctx.stroke.mockImplementation(() => strokes.push({
    color: ctx.strokeStyle, shadow: ctx.shadowColor, cap: ctx.lineCap, alpha: ctx.globalAlpha,
  }));
  act(() => root.render(<Waveform status="speaking" theme={theme} reference />));

  const canvas = host.querySelector('[data-testid="sirius-waveform"]');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const mid = 6 * dpr;
  const bars = ctx.lineTo.mock.calls.slice(0, 54).map(([, y]) => y - mid);
  const center = Math.max(...bars.slice(20, 34));
  const edges = Math.max(...bars.slice(0, 7), ...bars.slice(-7));
  const gradient = ctx.createLinearGradient.mock.results[0].value;
  expect(canvas.classList.contains("waveform-canvas--reference")).toBe(true);
  expect(gradient.addColorStop.mock.calls.map(([, color]) => color)).toEqual([
    palette["--workspace-cyan"], palette["--sirius-cyan-light"],
    palette["--workspace-cyan"], palette["--workspace-cyan"],
  ]);
  expect(strokes[0]).toEqual({
    color: gradient, shadow: palette["--sirius-cyan-light"], cap: "round", alpha: 0.9,
  });
  expect(center).toBeGreaterThan(edges * 2);
  expect(Math.max(...bars)).toBeLessThan(mid);
  expect(ctx.arc).toHaveBeenCalledTimes(3);
  expect(ctx.arc.mock.calls.every(([, , radius]) => radius < dpr)).toBe(true);
  ctx.lineTo.mockClear();
  frame(1000);
  expect(ctx.lineTo.mock.calls.slice(0, 54).map(([, y]) => y - mid)).not.toEqual(bars);
});

test("the reference spectrum animates while thinking and clears when idle", () => {
  act(() => root.render(<Waveform status="thinking" reference />));
  expect(ctx.stroke).toHaveBeenCalledTimes(3);
  const firstFrame = ctx.lineTo.mock.calls.slice(0, 54);
  ctx.lineTo.mockClear();
  frame(1000);
  expect(ctx.lineTo.mock.calls.slice(0, 54)).not.toEqual(firstFrame);
  act(() => root.render(<Waveform status="idle" reference />));
  ctx.stroke.mockClear();
  frame(2000);
  expect(ctx.clearRect).toHaveBeenCalled();
  expect(ctx.stroke).not.toHaveBeenCalled();
});

test("the reference spectrum responds to real microphone levels and releases the stream", async () => {
  const mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const previousAudioContext = window.AudioContext;
  const track = { stop: jest.fn() };
  const stream = { getTracks: () => [track] };
  const getUserMedia = jest.fn().mockResolvedValue(stream);
  let sample = 128;
  const analyser = { getByteTimeDomainData: jest.fn((buffer) => buffer.fill(sample)) };
  const source = { connect: jest.fn() };
  const audioContext = {
    createMediaStreamSource: jest.fn(() => source),
    createAnalyser: jest.fn(() => analyser),
    close: jest.fn(),
  };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  window.AudioContext = jest.fn(() => audioContext);
  try {
    await act(async () => {
      root.render(<Waveform status="listening" reference />);
      await Promise.resolve();
    });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(source.connect).toHaveBeenCalledWith(analyser);
    const callbacks = window.requestAnimationFrame.mock.calls.map(([callback]) => callback);
    const draw = callbacks.find((callback) => callback.name === "draw");
    const tick = callbacks.find((callback) => callback.name === "tick");
    expect(draw).toEqual(expect.any(Function));
    expect(tick).toEqual(expect.any(Function));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const peak = () => Math.max(...ctx.lineTo.mock.calls.slice(20, 34).map(([, y]) => y - 6 * dpr));
    ctx.lineTo.mockClear();
    draw(1000);
    const quiet = peak();
    sample = 168;
    tick();
    ctx.lineTo.mockClear();
    draw(2000);
    expect(peak()).toBeGreaterThan(quiet * 2);
  } finally {
    act(() => root.unmount());
    root = createRoot(host);
    if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
    else delete navigator.mediaDevices;
    if (previousAudioContext === undefined) delete window.AudioContext;
    else window.AudioContext = previousAudioContext;
  }
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(audioContext.close).toHaveBeenCalledTimes(1);
});

test("the waveform clears at rest, follows theme changes and resizes with its field", () => {
  const firstTheme = { cyan: "#448899", gold: "#a1773e", background: "#061321" };
  const nextTheme = { ...firstTheme, cyan: "#34c5ff" };
  act(() => root.render(<Waveform status="idle" color="#448899" theme={firstTheme} />));
  const canvas = host.querySelector('[data-testid="sirius-waveform"]');
  expect(ctx.createLinearGradient).not.toHaveBeenCalled();
  expect(observer.observe).toHaveBeenCalledWith(canvas);

  act(() => root.render(<Waveform status="speaking" color="#448899" theme={firstTheme} />));
  frame(1000);
  expect(ctx.createLinearGradient).toHaveBeenCalledTimes(1);
  act(() => root.render(<Waveform status="speaking" color="#448899" theme={nextTheme} />));
  const gradient = ctx.createLinearGradient.mock.results.at(-1).value;
  expect(gradient.addColorStop.mock.calls.map(([, color]) => color)).toContain("#34c5ff");

  canvasWidth = 210;
  resizeCanvas();
  expect(canvas.width).toBe(210 * Math.min(window.devicePixelRatio || 1, 2));
  ctx.stroke.mockClear();
  act(() => root.render(<Waveform status="idle" color="#448899" theme={nextTheme} />));
  frame(2000);
  expect(ctx.stroke).not.toHaveBeenCalled();
});

test("the waveform resumes when its field becomes visible after having zero width", () => {
  canvasWidth = 0;
  const theme = { cyan: "#91e6f2", gold: "#d8b875", background: "#061321" };
  act(() => root.render(<Waveform status="speaking" color="#91e6f2" theme={theme} />));
  expect(ctx.stroke).not.toHaveBeenCalled();
  canvasWidth = 120;
  resizeCanvas();
  frame(1000);
  expect(ctx.stroke).toHaveBeenCalledTimes(3);
});

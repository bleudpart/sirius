import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { BootScreen } from "./HudPanels";
import { APP_RELEASE, APP_VERSION } from "@/version";
import { speakCinematic, cancelSpeech } from "@/voice";
import { readAccountSetup } from "@/accountSetup";

jest.mock("@/accountSetup", () => ({ readAccountSetup: jest.fn() }));
jest.mock("@/voice", () => ({
  speakCinematic: jest.fn(),
  cancelSpeech: jest.fn(),
  cleanTextForDisplay: (text) => text,
}));
jest.mock("@/components/ReactorVisuals", () => ({
  CoreRings: () => null,
  ReactorCore: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container;
let root;
let originalFetch;
let originalRecognition;
const flush = async (ms = 0) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};
const render = async (element) => {
  await act(async () => root.render(element));
  await flush();
};
const voice = () => speakCinematic.mock.calls[0][1];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 0, 5, 20));
  jest.clearAllMocks();
  originalFetch = global.fetch;
  originalRecognition = window.SpeechRecognition;
  window.SpeechRecognition = jest.fn();
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  readAccountSetup.mockResolvedValue({ services: [] });
  delete window.__siriusBootSpoken;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  jest.clearAllTimers();
  jest.useRealTimers();
  global.fetch = originalFetch;
  if (originalRecognition === undefined) delete window.SpeechRecognition;
  else window.SpeechRecognition = originalRecognition;
});

test("uses the HUD heading and announces synchronised systems with one short sentence", async () => {
  await render(<BootScreen userName="daniel partel" onDone={jest.fn()} />);
  expect(container.querySelector(".boot-kicker").textContent).toBe("Je suis ΣIRIUS");
  expect(container.querySelector("h1").textContent).toBe("Bonsoir, Daniel");
  expect(container.querySelector('[data-testid="boot-phase"]').textContent)
    .toBe("Systèmes synchronisés · cœur réactif en ligne");
  expect(container.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("100");
  expect(speakCinematic).toHaveBeenCalledTimes(1);
  expect(speakCinematic.mock.calls[0][0])
    .toBe("Bonsoir Daniel. Systèmes synchronisés. Cœur réactif en ligne. Je suis prêt.");
  expect(container.querySelector('[data-testid="boot-modules"]')).toBeNull();
  const copyright = container.querySelector('[data-testid="boot-copyright"]');
  expect(copyright.querySelector(".footer-version-badge").textContent).toBe(`v${APP_VERSION}`);
  expect(copyright.querySelector(".footer-version-badge").title).toBe(APP_RELEASE);
});

test("opens the HUD as soon as the greeting ends, without cutting it", async () => {
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} />);
  act(() => voice().onstart());
  await flush(4000);
  expect(onDone).not.toHaveBeenCalled();
  act(() => voice().onend());
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(cancelSpeech).not.toHaveBeenCalled();
});

test("a voice that does not start does not hold the boot", async () => {
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} />);
  await flush(2500);
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("without voice the boot stays visible briefly, then opens the HUD", async () => {
  window.__siriusBootSpoken = true;
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} />);
  expect(speakCinematic).not.toHaveBeenCalled();
  await flush(1000);
  expect(container.querySelector('[data-testid="boot-screen"]').className).not.toContain("closing");
  await flush(200);
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("progress follows real server and service responses", async () => {
  let finishBrain;
  let finishServices;
  const brain = new Promise((resolve) => { finishBrain = resolve; });
  const services = new Promise((resolve) => { finishServices = resolve; });
  await render(<BootScreen onDone={jest.fn()} probeBrain={() => brain} probeServices={() => services} />);
  const progress = container.querySelector('[role="progressbar"]');
  expect(progress.getAttribute("aria-valuenow")).toBe("50");
  expect(container.querySelector('[data-testid="boot-phase"]').textContent).toBe("Synchronisation des systèmes…");
  await act(async () => finishBrain(true));
  expect(progress.getAttribute("aria-valuenow")).toBe("75");
  expect(speakCinematic).not.toHaveBeenCalled();
  await act(async () => finishServices({ services: [] }));
  expect(progress.getAttribute("aria-valuenow")).toBe("100");
  expect(speakCinematic).toHaveBeenCalledTimes(1);
});

test("open details hold the boot until they are closed", async () => {
  window.__siriusBootSpoken = true;
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} />);
  const details = container.querySelector(".boot-check-details");
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  await flush(5000);
  expect(onDone).not.toHaveBeenCalled();
  act(() => {
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
  });
  await flush(1200);
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("a tap opens the HUD once and stops an unfinished greeting", async () => {
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} />);
  act(() => voice().onstart());
  act(() => container.querySelector('[data-testid="boot-screen"]').click());
  act(() => container.querySelector('[data-testid="boot-screen"]').click());
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(cancelSpeech).toHaveBeenCalledTimes(1);
});

test("a failed service check is reported, never announced as ready", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    readAccountSetup.mockRejectedValue(new Error("Services HTTP 503"));
    await render(<BootScreen onDone={jest.fn()} />);
    expect(container.textContent).toContain("Services HTTP 503");
    expect(container.textContent).toContain("Revérifier les services");
    expect(container.querySelector('[data-testid="boot-phase"]').textContent).toBe("Services non vérifiés");
    expect(speakCinematic.mock.calls[0][0]).toBe("Bonsoir. La configuration des services n'a pas pu être vérifiée.");
  } finally {
    warn.mockRestore();
  }
});

test("an unreachable brain keeps the boot open until retry succeeds", async () => {
  const onDone = jest.fn();
  const probeBrain = jest.fn().mockResolvedValue(false);
  await render(<BootScreen onDone={onDone} probeBrain={probeBrain} />);
  for (let i = 0; i < 12; i += 1) await flush(2000);
  expect(probeBrain.mock.calls.length).toBeGreaterThan(5);
  expect(container.querySelector('[data-testid="boot-brain-alert"]').textContent)
    .toContain("n'arrive pas à joindre son cerveau");
  expect(speakCinematic.mock.calls[0][0]).toContain("Le serveur ne répond pas encore");
  act(() => voice().onend());
  await flush(30000);
  expect(onDone).not.toHaveBeenCalled();

  probeBrain.mockResolvedValue(true);
  await act(async () => {
    container.querySelector('[data-testid="boot-brain-retry"]').click();
    await Promise.resolve();
  });
  await flush();
  await flush();
  expect(container.querySelector('[data-testid="boot-brain-alert"]')).toBeNull();
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(speakCinematic).toHaveBeenCalledTimes(1);
});

test("the user can continue without the brain", async () => {
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} probeBrain={() => Promise.resolve(false)} />);
  for (let i = 0; i < 12; i += 1) await flush(2000);
  act(() => container.querySelector('[data-testid="boot-brain-continue"]').click());
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("unmount cancels the pending handoff", async () => {
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} />);
  act(() => container.querySelector('[data-testid="boot-screen"]').click());
  act(() => root.unmount());
  root = createRoot(container);
  await flush(500);
  expect(onDone).not.toHaveBeenCalled();
});
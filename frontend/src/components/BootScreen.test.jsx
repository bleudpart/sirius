import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { BootScreen } from "./HudPanels";
import { speakCinematic, cancelSpeech } from "@/voice";
import { generateBootPresentation } from "@/bootPresentation";
import { readAccountSetup } from "@/accountSetup";

jest.mock("@/bootPresentation", () => ({ generateBootPresentation: jest.fn() }));
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
const render = (element) => act(async () => root.render(element));
const tap = () => act(() => container.querySelector('[data-testid="boot-screen"]').click());

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true });
  readAccountSetup.mockResolvedValue({ services: [] });
  generateBootPresentation.mockResolvedValue("Je suis Sirius. Je vous aide à consulter et comprendre les informations disponibles.");
  delete window.__siriusBootSpoken;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  jest.clearAllTimers();
  jest.useRealTimers();
  global.fetch = originalFetch;
});

test("opens the HUD when loading and narration both finish", async () => {
  const onDone = jest.fn();
  await render(<BootScreen connected onDone={onDone} />);
  const { onstart, onend } = speakCinematic.mock.calls[0][1];
  act(() => onstart());
  act(() => jest.advanceTimersByTime(5000));
  expect(onDone).not.toHaveBeenCalled();
  act(() => onend());
  act(() => jest.advanceTimersByTime(500));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(cancelSpeech).toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(30000));
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("a narration that never starts reports the unavailable voice and releases the HUD", async () => {
  const onDone = jest.fn();
  await render(<BootScreen connected onDone={onDone} />);
  act(() => jest.advanceTimersByTime(5000));
  act(() => jest.advanceTimersByTime(10000));
  expect(container.textContent).toContain("voix indisponible");
  act(() => jest.advanceTimersByTime(500));
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("repeated taps while closing finish only once", async () => {
  const onDone = jest.fn();
  await render(<BootScreen connected onDone={onDone} />);
  act(() => speakCinematic.mock.calls[0][1].onstart());
  act(() => speakCinematic.mock.calls[0][1].onend());
  tap();
  tap();
  act(() => jest.advanceTimersByTime(500));
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("unmount cancels the pending handoff", async () => {
  const onDone = jest.fn();
  await render(<BootScreen connected onDone={onDone} />);
  act(() => speakCinematic.mock.calls[0][1].onstart());
  act(() => speakCinematic.mock.calls[0][1].onend());
  tap();
  act(() => root.unmount());
  root = createRoot(container);
  act(() => jest.advanceTimersByTime(500));
  expect(onDone).not.toHaveBeenCalled();
});

test("opening a module and automatic completion cannot hand off twice", async () => {
  const onDone = jest.fn();
  const onOpenModule = jest.fn();
  await render(<BootScreen connected onDone={onDone} onOpenModule={onOpenModule} />);
  act(() => jest.advanceTimersByTime(5000));
  act(() => container.querySelector('[data-testid="boot-module-argus"]').click());
  act(() => speakCinematic.mock.calls[0][1].onend());
  act(() => jest.advanceTimersByTime(500));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onOpenModule).toHaveBeenCalledWith("argus");
});

const flush = async (ms) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
};

test("presentation welcomes the user and exposes real loading progress in its dedicated frame", async () => {
  await render(<BootScreen connected userName="Daniel" onDone={jest.fn()} />);
  expect(container.querySelector("h1").textContent).toBe("Bienvenue, Daniel.");
  expect(container.querySelector('[aria-label="Initialisation de votre espace"]').className).toContain("workspace-surface");
  expect(container.querySelector('[data-testid="boot-reactor"]')).not.toBeNull();
  expect(container.querySelectorAll(".boot-signature")).toHaveLength(1);
  expect(container.querySelector(".boot-signature").textContent).toBe("ΣIRIUS — Votre intelligence au travail");
  expect(container.querySelector(".boot-tagline").textContent)
    .toBe("Parlez-lui simplement. Zirius vous répond.");
  expect(container.querySelector(".boot-signature").nextElementSibling.className).toBe("boot-tagline");
  expect(container.querySelector(".boot-welcome-sub")).toBeNull();
  expect(container.textContent).not.toContain("Votre assistant intelligent");
  expect(container.textContent).not.toContain("Votre espace prend vie");
  expect(container.textContent).not.toContain("VOTRE INTELLIGENCE · VOTRE UNIVERS");
  expect(container.textContent).not.toContain("Une intelligence à votre écoute");
  expect(container.querySelectorAll(".boot-acro-item")).toHaveLength(6);
  const catalogue = container.querySelector('[data-testid="boot-modules"]');
  expect(catalogue.querySelector("h2").textContent).toBe("L’univers de ΣIRIUS");
  expect(catalogue.querySelector(".workspace-kicker")).toBeNull();
  const progress = container.querySelector('[role="progressbar"]');
  expect(progress.getAttribute("aria-valuenow")).toBe("100");
});

test("progress waits for real server and service responses rather than elapsed time", async () => {
  let finishBrain;
  let finishServices;
  const brain = new Promise((resolve) => { finishBrain = resolve; });
  const services = new Promise((resolve) => { finishServices = resolve; });
  await render(<BootScreen connected onDone={jest.fn()} probeBrain={() => brain} probeServices={() => services} />);
  const progress = container.querySelector('[role="progressbar"]');
  const initial = progress.getAttribute("aria-valuenow");
  await flush(10000);
  expect(progress.getAttribute("aria-valuenow")).toBe(initial);
  expect(speakCinematic).not.toHaveBeenCalled();
  await act(async () => finishBrain(true));
  expect(Number(progress.getAttribute("aria-valuenow"))).toBeLessThan(100);
  await act(async () => finishServices({ services: [{ id: "chat", label: "Réponses IA", state: "not_configured" }] }));
  await flush(5000);
  expect(progress.getAttribute("aria-valuenow")).toBe("100");
  expect(container.textContent).toContain("Réponses IA : non configuré");
  expect(speakCinematic.mock.calls[0][0]).toContain("Bonjour, votre assistant Zirius est prêt à être utilisé.");
  expect(speakCinematic.mock.calls[0][0]).not.toContain("Réponses IA.");
  expect(generateBootPresentation).not.toHaveBeenCalled();
  expect(container.querySelector('[role="log"]').textContent).toContain("REÇUE");
});

test("the real welcome message appears progressively at a readable pace", async () => {
  await render(<BootScreen connected onDone={jest.fn()} />);
  const ready = container.querySelector('[data-testid="boot-ready"]');
  const fullMessage = "Bonjour, votre assistant Zirius est prêt à être utilisé.";
  expect(ready.textContent).toBe("");
  await flush(320);
  expect(ready.textContent.length).toBeGreaterThan(0);
  expect(ready.textContent.length).toBeLessThan(fullMessage.length);
  await flush(3000);
  expect(ready.textContent).toBe(fullMessage);
});

test("a failed service check is a completed failure, never a successful service", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    readAccountSetup.mockRejectedValue(new Error("Services HTTP 503"));
    await render(<BootScreen onDone={jest.fn()} />);
    expect(container.querySelector('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("100");
    expect(container.textContent).toContain("Services HTTP 503");
    expect(container.textContent).toContain("Configuration des services");
    expect(container.textContent).toContain("INDISPONIBLE");
    expect(container.textContent).toContain("Revérifier les services");
    expect(speakCinematic.mock.calls[0][0]).toContain("la configuration des services n'a pas pu être vérifiée");
    expect(speakCinematic.mock.calls[0][0]).not.toContain("prêt à être utilisé");
  } finally {
    warn.mockRestore();
  }
});

test("retries the brain, then explains the failure instead of opening a dead HUD", async () => {
  const onDone = jest.fn();
  const probeBrain = jest.fn().mockResolvedValue(false);
  await render(<BootScreen onDone={onDone} probeBrain={probeBrain} />);
  for (let i = 0; i < 12; i += 1) await flush(2000);
  expect(probeBrain.mock.calls.length).toBeGreaterThan(5);
  const alert = container.querySelector('[data-testid="boot-brain-alert"]');
  expect(alert.textContent).toContain("n'arrive pas à joindre son cerveau");
  expect(speakCinematic.mock.calls[0][0]).toContain("le serveur ne répond pas encore");
  act(() => speakCinematic.mock.calls[0][1].onend());
  await flush(31000);
  expect(onDone).not.toHaveBeenCalled();

  probeBrain.mockResolvedValue(true);
  await act(async () => {
    container.querySelector('[data-testid="boot-brain-retry"]').click();
    await Promise.resolve();
  });
  await flush(10);
  expect(container.querySelector('[data-testid="boot-brain-alert"]')).toBeNull();
  await flush(5000);
  expect(container.querySelector('[data-testid="boot-ready"]').textContent)
    .toBe("Bonjour, votre assistant Zirius est prêt à être utilisé.");
  expect(container.querySelector('[data-testid="boot-screen"]').className).toContain("closing");
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("the user can continue without the brain", async () => {
  const onDone = jest.fn();
  await render(<BootScreen onDone={onDone} probeBrain={() => Promise.resolve(false)} />);
  for (let i = 0; i < 12; i += 1) await flush(2000);
  act(() => container.querySelector('[data-testid="boot-brain-continue"]').click());
  act(() => jest.advanceTimersByTime(500));
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("a brain that answers late is announced as ready", async () => {
  const probeBrain = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  await render(<BootScreen onDone={jest.fn()} probeBrain={probeBrain} />);
  await flush(0);
  expect(speakCinematic).not.toHaveBeenCalled();
  tap();
  expect(speakCinematic).not.toHaveBeenCalled();
  await flush(2000);
  expect(speakCinematic.mock.calls[0][0]).toContain("votre assistant Zirius est prêt à être utilisé");
});

test("an offline screen does not label completed speech as a stuck reader", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await render(<BootScreen onDone={jest.fn()} probeBrain={() => Promise.resolve(false)} />);
    for (let i = 0; i < 12; i += 1) await flush(2000);
    act(() => speakCinematic.mock.calls[0][1].onend());
    await flush(150000);
    expect(warn).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("voix indisponible");
    expect(container.querySelector('[data-testid="boot-brain-alert"]')).not.toBeNull();
  } finally {
    warn.mockRestore();
  }
});

test("announces a short personalized welcome without reading every service or generating an AI introduction", async () => {
  const onDone = jest.fn();
  await render(<BootScreen connected userName="Daniel" onDone={onDone} />);
  const [message, callbacks] = speakCinematic.mock.calls[0];
  expect(message).toContain("Bonjour Daniel, votre assistant Zirius est prêt à être utilisé.");
  expect(message).not.toContain("fournisseur non testé");
  expect(message).not.toContain("Interface Sirius.");
  expect(message.split(/\s+/).length).toBeLessThanOrEqual(30);
  expect(generateBootPresentation).not.toHaveBeenCalled();
  act(() => callbacks.onstart());
  act(() => jest.advanceTimersByTime(5000));
  tap();
  expect(onDone).not.toHaveBeenCalled();
  expect(cancelSpeech).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Bienvenue, Daniel.");
  act(() => callbacks.onend());
  act(() => jest.advanceTimersByTime(500));
  expect(onDone).toHaveBeenCalledTimes(1);
});

test("details remain readable after the short welcome until they are closed", async () => {
  const onDone = jest.fn();
  await render(<BootScreen userName="Daniel" onDone={onDone} />);
  const details = container.querySelector(".boot-check-details");
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
  act(() => speakCinematic.mock.calls[0][1].onend());
  await flush(1000);
  expect(onDone).not.toHaveBeenCalled();
  expect(details.textContent).toContain("modèle et services externes non testés");
  await flush(2000);
  act(() => {
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
  });
  await flush(500);
  expect(onDone).toHaveBeenCalledTimes(1);
});

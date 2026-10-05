import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { speakFr, cancelSpeech, speakSeries } from "./voice";
import { TextDecoder } from "util";

jest.mock("./AuthGate", () => ({ useAuth: () => ({ user: { id: "voice-test", name: "Validation" } }) }));
jest.mock("./voice", () => ({
  speakFr: jest.fn(), cancelSpeech: jest.fn(), speakSeries: jest.fn(() => Promise.resolve()), speakAsCharacter: jest.fn(),
}));
jest.mock("./lazyModules", () => new Proxy({}, { get: (_, key) => key === "__esModule" ? true : () => null }));
jest.mock("./components/ReactorVisuals", () => ({ MedallionRing: () => null, ReactorCore: () => null, Waveform: () => null }));
jest.mock("./components/HudPanels", () => {
  const React = require("react");
  return {
    MemoryPanel: () => null, HoloPopups: () => null, AnalyticsPanel: () => null,
    MusicChoice: () => null, CentralCard: () => null,
    BootScreen: ({ onDone }) => { React.useEffect(onDone, [onDone]); return null; },
  };
});
jest.mock("./uiSounds", () => ({ initUiSounds: () => () => {} }));
jest.mock("./holoFx", () => ({ initHoloFx: () => () => {} }));
jest.mock("./readAloud", () => ({ initReadAloud: () => () => {} }));
jest.mock("./useTouchNav", () => () => {});
jest.mock("./hud/SiriusHudPanels", () => ({ SiriusInfoHub: () => null, SiriusInfoWheel: () => null, SiriusNextAction: () => null }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
const originalMatchMedia = window.matchMedia;
const originalTextDecoder = global.TextDecoder;
let root;
let host;
let chatSignal;
let deliverAnswer;

beforeEach(() => {
  jest.clearAllMocks();
  speakSeries.mockResolvedValue();
  jest.useFakeTimers();
  global.TextDecoder = TextDecoder;
  chatSignal = null;
  deliverAnswer = null;
  jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  window.matchMedia = jest.fn(() => ({
    matches: false, addEventListener: jest.fn(), removeEventListener: jest.fn(),
    addListener: jest.fn(), removeListener: jest.fn(),
  }));
  localStorage.setItem("sirius_profile", JSON.stringify({ name: "Validation" }));
  localStorage.setItem("sirius_installed", "1");
  localStorage.setItem("sirius_auto_mic", "0");
  sessionStorage.setItem("sirius_autodiag", "1");
  global.fetch = jest.fn((url, options) => {
    if (String(url).endsWith("/chat/stream")) return Promise.resolve({ ok: false });
    if (String(url).endsWith("/chat")) {
      chatSignal = options.signal;
      return new Promise((resolve) => {
        deliverAnswer = () => resolve({ ok: true, json: async () => ({ answer: "Réponse devenue obsolète" }) });
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ items: [], tasks: [], modules: [], ok: true }) });
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  sessionStorage.clear();
  global.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  global.TextDecoder = originalTextDecoder;
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><App /></QueryClientProvider>));
}

async function send(command) {
  const input = host.querySelector('[data-testid="sirius-cmd-form"] input[type="text"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, command);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector('[data-testid="sirius-cmd-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

function mockConversationStream(events) {
  const reader = {
    read: jest.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(Buffer.from(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""))) })
      .mockResolvedValue({ done: true }),
    cancel: jest.fn(async () => {}),
  };
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat/stream")
    ? Promise.resolve({ ok: true, headers: { get: () => "text/event-stream" }, body: { getReader: () => reader } })
    : fallback(url, options));
  return reader;
}

test("stream transport preserves incremental speech and does not send a duplicate HTTP chat", async () => {
  const reader = mockConversationStream([
    { type: "delta", text: "Bonjour. " },
    { type: "done", answer: "Bonjour." },
  ]);
  await mount();
  await send("Explique le ciel bleu");
  expect(speakSeries).toHaveBeenCalledWith("Bonjour.", expect.objectContaining({ onstart: expect.any(Function) }));
  expect(host.querySelector(".voice-session-controls").textContent).toContain("Prêt");
  expect(host.querySelector(".voice-session-controls").textContent).not.toContain("Réponse interrompue");
  expect(reader.cancel).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"))).toHaveLength(0);
});

test("an incomplete stream keeps its interruption warning and never replays a partial response", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockConversationStream([{ type: "delta", text: "Réponse partielle. " }]);
  await mount();
  await send("Explique le ciel bleu");
  expect(host.querySelector(".voice-session-controls").textContent).toContain("Réponse interrompue avant la fin");
  expect(cancelSpeech).toHaveBeenCalled();
  expect(warn).toHaveBeenCalled();
  expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"))).toHaveLength(0);
});

test("Stop cancels a live conversational request and ignores its answer after a new command", async () => {
  await mount();
  await send("Explique pourquoi le ciel est bleu");
  expect(host.querySelector(".voice-session-controls").textContent).toContain("Je traite");
  expect(chatSignal.aborted).toBe(false);
  await act(async () => host.querySelector(".voice-session-controls button").click());
  expect(chatSignal.aborted).toBe(true);
  expect(cancelSpeech).toHaveBeenCalled();
  expect(host.querySelector(".voice-session-controls").textContent).toContain("Prêt");
  await send("quelle heure est-il");
  await act(async () => deliverAnswer());
  expect(speakFr.mock.calls.some(([text]) => text === "Réponse devenue obsolète")).toBe(false);
  expect(speakFr.mock.calls.some(([text]) => text.startsWith("Il est "))).toBe(true);
  expect(host.textContent).not.toContain("Réponse devenue obsolète");
  expect(host.querySelector('[title="Activer le mode mains libres"]')).not.toBeNull();
});

test("first-use guide focuses the written chat and can be reopened from the module registry", async () => {
  await mount();
  expect(host.querySelector('[data-testid="getting-started"]')).not.toBeNull();
  const question = [...host.querySelectorAll(".getting-started-actions button")].find((button) => button.textContent.includes("Poser une question"));
  await act(async () => question.click());
  await act(async () => jest.advanceTimersByTime(1));
  expect(host.querySelector('[data-testid="getting-started"]')).toBeNull();
  expect(host.querySelector(".sirius-root").classList.contains("mobile-section-home")).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('[data-testid="sirius-cmd-input"]'));
  expect(localStorage.getItem("sirius_getting_started_v1:voice-test")).toBe("done");
  await act(async () => host.querySelector('[data-testid="sirius-modules-btn"]').click());
  await act(async () => document.querySelector('[data-testid="modules-menu-group-OUTILS"]').click());
  await act(async () => document.querySelector('[data-testid="modules-menu-item-getting-started"]').click());
  expect(host.querySelector('[data-testid="getting-started"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="modules-menu"]')).toBeNull();
});

test("pointer Stop discards the buffered phrase before the global push-to-talk release", async () => {
  const previousRecognition = window.SpeechRecognition;
  let recognition;
  window.SpeechRecognition = class {
    constructor() { recognition = this; }
    start() { this.onstart?.(); }
    stop() { this.onend?.(); }
    abort() { this.aborted = true; this.onend?.(); }
  };
  try {
    await mount();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true })));
    await act(async () => jest.advanceTimersByTime(130));
    expect(recognition).toBeDefined();
    expect(host.querySelector(".voice-microphone-dot").getAttribute("aria-label")).toBe("Microphone ouvert");
    await act(async () => {
      const result = [{ transcript: "Sirius explique pourquoi le ciel est bleu", confidence: 0.9 }];
      result.isFinal = true;
      recognition.onresult({ resultIndex: 0, results: [result] });
    });
    const button = host.querySelector(".voice-session-controls button");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      jest.advanceTimersByTime(1500);
    });
    expect(recognition.aborted).toBe(true);
    expect(host.querySelector(".voice-microphone-dot").getAttribute("aria-label")).toBe("Microphone fermé");
    expect(global.fetch.mock.calls.filter(([url]) => /\/chat(?:\/stream)?$/.test(String(url)))).toEqual([]);
    expect(host.querySelector(".voice-session-controls").textContent).toContain("Prêt");
  } finally {
    window.SpeechRecognition = previousRecognition;
  }
});

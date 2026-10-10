import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { speakFr, cancelSpeech, speakSeries } from "./voice";
import { TextDecoder } from "util";
import { Capacitor } from "@capacitor/core";
import { createNativeRecognition } from "./nativeSpeechRecognition";
import { connectStreamingStt } from "./services/streamingStt";
import { pttBeep } from "./appLogic";
import { createNativeHandsFree } from "./nativeHandsFree";

jest.mock("./nativeSpeechRecognition", () => ({ createNativeRecognition: jest.fn() }));
jest.mock("./nativeHandsFree", () => ({ createNativeHandsFree: jest.fn() }));
jest.mock("./services/streamingStt", () => ({ connectStreamingStt: jest.fn() }));
jest.mock("./appLogic", () => ({ ...jest.requireActual("./appLogic"), pttBeep: jest.fn() }));

jest.mock("./AuthGate", () => ({ useAuth: () => ({ user: { id: "voice-test", name: "Validation" } }) }));
jest.mock("./voice", () => ({
  speakFr: jest.fn(), cancelSpeech: jest.fn(), speakSeries: jest.fn(() => Promise.resolve()), speakAsCharacter: jest.fn(),
}));
jest.mock("./lazyModules", () => new Proxy({}, { get: (_, key) => {
  if (key === "__esModule") return true;
  if (key === "MediaModulesPanel") return ({ onClose }) => (
    <div data-testid="media-modules-panel"><button onClick={onClose}>Fermer le catalogue</button></div>
  );
  if (key === "SiriusDisplay") return ({ item, onRead }) => <div data-testid="sirius-display">
    <button data-testid="sirius-display-read" onClick={onRead}>Lire</button>
    <div data-testid="sirius-display-body">{item.contenu}</div>
  </div>;
  return () => null;
} }));
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
jest.mock("./readAloud", () => ({ initReadAloud: () => () => {}, parseReadPanelCommand: () => null, readPanelAloud: () => false }));
jest.mock("./useTouchNav", () => () => {});
jest.mock("./hud/SiriusHudPanels", () => ({
  SiriusInfoHub: () => null,
  SiriusInfoWheel: ({ open }) => open ? <div data-testid="info-wheel">Centre d'information ΣIRIUS</div> : null,
  SiriusNextAction: () => <button className="shud-next">Prochaines Actions</button>,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
const originalMatchMedia = window.matchMedia;
const originalTextDecoder = global.TextDecoder;
let root;
let host;
let chatSignal;
let deliverAnswer;
let native;
let nativeCalls;
let handsFree;
let handsFreeOptions;
let originalSpeechRecognition;

beforeEach(() => {
  jest.clearAllMocks();
  connectStreamingStt.mockResolvedValue(null);
  speakSeries.mockResolvedValue();
  jest.useFakeTimers();
  global.TextDecoder = TextDecoder;
  chatSignal = null;
  deliverAnswer = null;
  nativeCalls = [];
  handsFree = {
    active: false, available: jest.fn(async () => ({ available: false })),
    setBlocked: jest.fn(async () => {}), stop: jest.fn(async () => { handsFree.active = false; }),
    start: jest.fn(async () => { handsFree.active = true; handsFreeOptions.onState({ phase: "ready" }); }),
  };
  createNativeHandsFree.mockImplementation((options) => { handsFreeOptions = options; return handsFree; });
  originalSpeechRecognition = window.SpeechRecognition;
  native = {
    active: false,
    cancel: jest.fn(async () => {
      native.active = false;
      nativeCalls.at(-1)?.reject(Object.assign(new Error("Cancelled"), { code: "CANCELLED" }));
    }),
    listen: jest.fn(({ signal, onEvent }) => {
      native.active = true;
      onEvent({ phase: "listening", text: "" });
      return new Promise((resolve, reject) => {
        nativeCalls.push({ signal, onEvent, reject, resolve: (text) => { native.active = false; resolve(text); } });
      });
    }),
  };
  createNativeRecognition.mockReturnValue(native);
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
  if (originalSpeechRecognition === undefined) delete window.SpeechRecognition;
  else window.SpeechRecognition = originalSpeechRecognition;
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

test("the HUD no longer mounts the next-actions pill", async () => {
  await mount();
  expect(host.querySelector('[data-testid="sirius-title"]')).not.toBeNull();
  expect(host.querySelector(".shud-next")).toBeNull();
});

test("native hands-free is diagnostic-only, explicitly started, and stopped before manual capture", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  handsFree.available.mockResolvedValue({ available: true });
  localStorage.setItem("sirius_android_stt", "native");
  localStorage.setItem("sirius_auto_mic", "1");
  await mount();
  expect(handsFree.start).not.toHaveBeenCalled();
  const button = host.querySelector('[data-testid="sirius-native-capture-btn"]');
  expect(button).not.toBeNull();
  await act(async () => button.click());
  expect(handsFree.start).toHaveBeenCalledTimes(1);
  expect(button.textContent).toContain("Arrêter la capture native");
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  expect(handsFree.active).toBe(false);
  expect(nativeCalls).toHaveLength(1);
});

test("normal Android builds do not offer experimental native hands-free", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  await mount();
  expect(host.querySelector('[data-testid="sirius-native-capture-btn"]')).toBeNull();
});

test.each(["Bonjour Zirius", "Zirius bonjour"])(
  "native continuous capture processes the greeting %s", async (greeting) => {
    jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    handsFree.available.mockResolvedValue({ available: true });
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-native-capture-btn"]').click());
    await act(async () => handsFreeOptions.onTranscript(greeting));
    const call = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/chat/stream"));
    expect(JSON.parse(call[1].body).text.toLowerCase()).toBe("bonjour");
  },
);

test.each(["Bonjour Zirius", "Zirius bonjour"])(
  "the ordinary Android microphone processes the greeting %s", async (greeting) => {
    jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
    localStorage.setItem("sirius_android_stt", "native");
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
    await act(async () => nativeCalls[0].resolve(greeting));
    const call = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/chat/stream"));
    expect(JSON.parse(call[1].body).text.toLowerCase()).toBe("bonjour");
  },
);

test("the information centre entry opens its wheel from the modules menu", async () => {
  await mount();
  expect(host.querySelector('[data-testid="info-wheel"]')).toBeNull();
  await act(async () => host.querySelector('[data-testid="sirius-modules-btn"]').click());
  await act(async () => document.querySelector('[data-testid="modules-menu-group-OUTILS"]').click());
  const entry = document.querySelector('[data-testid="modules-menu-item-info-hub"]');
  expect(entry.textContent).toContain("ΣIRIUS");
  await act(async () => entry.click());
  expect(host.querySelector('[data-testid="info-wheel"]')).not.toBeNull();
});

test("the tasks journal opens from the module menu even without a running task", async () => {
  await mount();
  await act(async () => host.querySelector('[data-testid="sirius-modules-btn"]').click());
  await act(async () => document.querySelector('[data-testid="modules-menu-group-OUTILS"]').click());
  await act(async () => document.querySelector('[data-testid="modules-menu-item-journal"]').click());
  expect(host.querySelector('[data-testid="sirius-journal-panel"]')).not.toBeNull();
  expect(host.textContent).toContain("Aucune tâche enregistrée");
});

test("close the window targets the visible journal without asking the assistant", async () => {
  await mount();
  await act(async () => window.dispatchEvent(new Event("sirius-journal-open")));
  const journal = host.querySelector('[data-testid="sirius-journal-panel"]');
  jest.spyOn(journal, "getClientRects").mockReturnValue([{}]);
  await send("ferme la fenêtre");
  expect(host.querySelector('[data-testid="sirius-journal-panel"]')).toBeNull();
  expect(speakFr).toHaveBeenCalledWith(expect.stringContaining("Je ferme"), expect.anything());
  expect(global.fetch.mock.calls.filter(([url]) => /\/(?:intent|chat)(?:\/stream)?$/.test(String(url)))).toHaveLength(0);
});

test("Android opens and closes a dedicated media catalogue without opening Display", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  await mount();
  const display = host.querySelector('[data-testid="sirius-display"]');
  expect(display).toBeNull();
  await act(async () => host.querySelector('[data-testid="sirius-modules-btn"]').click());
  await act(async () => document.querySelector('[data-testid="modules-menu-group-MÉDIAS"]').click());
  await act(async () => document.querySelector('[data-testid="modules-menu-item-media-modules"]').click());
  expect(host.querySelector('[data-testid="media-modules-panel"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="sirius-display"]')).toBe(display);
  await act(async () => host.querySelector('[data-testid="media-modules-panel"] button').click());
  expect(host.querySelector('[data-testid="media-modules-panel"]')).toBeNull();
});

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

test("an expired trial is shown explicitly without retrying chat or inventing a local answer", async () => {
  const fallback = global.fetch.getMockImplementation();
  const message = "Essai de 7 jours terminé : configurez vos clés personnelles.";
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat/stream")
    ? Promise.resolve({ ok: false, status: 403, json: async () => ({ detail: message, trial: "expired" }) })
    : fallback(url, options));
  await mount();
  await send("Explique le ciel bleu");
  expect(host.textContent).toContain(message);
  expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"))).toHaveLength(0);
  expect(speakSeries).not.toHaveBeenCalled();
});

test("speaks the first complete sentence before the model stream finishes", async () => {
  let releaseTail;
  const reader = {
    read: jest.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new Uint8Array(Buffer.from('data: {"type":"delta","text":"Bonjour. "}\n\n')),
      })
      .mockImplementationOnce(() => new Promise((resolve) => { releaseTail = resolve; }))
      .mockResolvedValueOnce({ done: true }),
    cancel: jest.fn(async () => {}),
  };
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat/stream")
    ? Promise.resolve({ ok: true, headers: { get: () => "text/event-stream" }, body: { getReader: () => reader } })
    : fallback(url, options));

  await mount();
  await send("Explique le ciel bleu");
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  expect(speakSeries).toHaveBeenCalledWith("Bonjour.", expect.objectContaining({ onstart: expect.any(Function) }));
  expect(releaseTail).toBeInstanceOf(Function);

  await act(async () => releaseTail({
    done: false,
    value: new Uint8Array(Buffer.from('data: {"type":"done","answer":"Bonjour."}\n\n')),
  }));
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
  expect(host.querySelector('[title="Démarrer la conversation vocale"]')).not.toBeNull();
});

test("a new request replaces a busy request without needing Stop first", async () => {
  await mount();
  await send("Explique pourquoi le ciel est bleu");
  const previousSignal = chatSignal;
  const lateAnswer = deliverAnswer;
  await send("quelle heure est-il");
  expect(previousSignal.aborted).toBe(true);
  await act(async () => lateAnswer());
  expect(speakFr.mock.calls.some(([text]) => text === "Réponse devenue obsolète")).toBe(false);
  expect(speakFr.mock.calls.some(([text]) => text.startsWith("Il est "))).toBe(true);
});

test("Android native test mode replaces a pending answer with a newly spoken question", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  await mount();
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  expect(nativeCalls).toHaveLength(1);
  await act(async () => nativeCalls[0].resolve("Sirius, explique pourquoi le ciel est bleu"));
  const previousSignal = chatSignal;
  const lateAnswer = deliverAnswer;
  expect(nativeCalls).toHaveLength(1);
  expect(host.querySelector(".voice-session-controls").textContent).toContain("Je traite");
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  expect(previousSignal.aborted).toBe(true);
  expect(nativeCalls).toHaveLength(1);
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  expect(nativeCalls).toHaveLength(2);
  await act(async () => nativeCalls[1].resolve("Sirius, quelle heure est-il"));
  expect(previousSignal.aborted).toBe(true);
  await act(async () => lateAnswer());
  expect(speakFr.mock.calls.some(([text]) => text === "Réponse devenue obsolète")).toBe(false);
  expect(speakFr.mock.calls.some(([text]) => text.startsWith("Il est "))).toBe(true);
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/stt"))).toBe(false);
});

test("Android manual dictation routes the evening briefing when preceded by the wake word", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  const webSpeech = jest.fn();
  window.SpeechRecognition = webSpeech;
  await mount();

  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  expect(nativeCalls).toHaveLength(1);
  await act(async () => nativeCalls[0].resolve("Sirius, brieffing du soir"));
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/oracle/overview"))).toBe(true);
  expect(global.fetch.mock.calls.some(([url]) => /\/(?:intent|chat)(?:\/stream)?$/.test(String(url)))).toBe(false);
  expect(webSpeech).not.toHaveBeenCalled();
});

test.each([
  "afficher et lire le briefing",
  "affiche et lis le brieffing du soir",
  "lis le briefing",
  "lire et afficher mon briefing du jour",
])("%s displays and speaks the briefing rather than only opening a panel", async (command) => {
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/oracle/overview")
    ? Promise.resolve({ ok: true, json: async () => ({ briefing: "Voici les nouvelles de votre journée." }) })
    : fallback(url, options));
  await mount();
  await send(command);
  expect(host.querySelector('[data-testid="sirius-display"]')).not.toBeNull();
  expect(speakFr.mock.calls.some(([message]) => message.includes("Voici les nouvelles de votre journée."))).toBe(true);
  expect(global.fetch.mock.calls.some(([url]) => /\/(?:intent|chat)(?:\/stream)?$/.test(String(url)))).toBe(false);
});

test("Display reads the complete briefing before visual typing finishes", async () => {
  const longBriefing = `${"Une nouvelle importante pour cette journée. ".repeat(100)}Fin du briefing.`;
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/oracle/overview")
    ? Promise.resolve({ ok: true, json: async () => ({ briefing: longBriefing }) })
    : fallback(url, options));
  await mount();
  await send("afficher et lire le briefing");
  speakSeries.mockClear();
  await send("lis mon Sirius Display");
  expect(speakSeries.mock.calls.length).toBeGreaterThan(3);
  expect(speakSeries.mock.calls.map(([text]) => text).join(" ")).toContain("Fin du briefing.");
  expect(speakSeries.mock.calls.every(([text]) => text.length <= 800)).toBe(true);
});

test("Display reserves the actual microphone controls and updates on viewport resize", async () => {
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/oracle/overview")
    ? Promise.resolve({ ok: true, json: async () => ({ briefing: "Les informations du jour." }) })
    : fallback(url, options));
  await mount();
  const area = host.querySelector(".sirius-command-area");
  const header = host.querySelector(".top-bar");
  jest.spyOn(area, "getBoundingClientRect").mockReturnValue({ top: window.innerHeight - 210 });
  jest.spyOn(header, "getBoundingClientRect").mockReturnValue({ bottom: 80 });
  await send("afficher et lire le briefing");
  const hud = area.closest(".sirius-root");
  expect(hud.style.getPropertyValue("--display-command-space")).toBe("218px");
  expect(hud.style.getPropertyValue("--display-header-space")).toBe("88px");
  area.getBoundingClientRect.mockReturnValue({ top: window.innerHeight - 260 });
  await act(async () => window.dispatchEvent(new Event("resize")));
  expect(hud.style.getPropertyValue("--display-command-space")).toBe("268px");
});

test("Android conversation resumes after each answer without requiring the wake word", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  await mount();
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  await act(async () => nativeCalls[0].resolve("quelle heure est-il"));
  expect(speakFr.mock.calls.some(([text]) => text.startsWith("Il est "))).toBe(true);
  const [, options] = speakFr.mock.calls.at(-1);
  await act(async () => options.onstart?.());
  await act(async () => jest.advanceTimersByTime(1000));
  expect(nativeCalls).toHaveLength(1);
  expect(host.querySelector('[data-testid="sirius-top-mic-btn"]').getAttribute("aria-pressed")).toBe("true");
  await act(async () => options.onend?.());
  await act(async () => jest.advanceTimersByTime(500));
  expect(nativeCalls).toHaveLength(2);
  await act(async () => nativeCalls[1].resolve("quelle heure est-il"));
  const [, nextOptions] = speakFr.mock.calls.at(-1);
  await act(async () => nextOptions.onend?.());
  await act(async () => jest.advanceTimersByTime(500));
  expect(nativeCalls).toHaveLength(3);
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  await act(async () => jest.advanceTimersByTime(5000));
  expect(nativeCalls).toHaveLength(3);
  expect(host.querySelector('[data-testid="sirius-top-mic-btn"]').getAttribute("aria-pressed")).toBe("false");
  expect(global.fetch.mock.calls.some(([url]) => /\/(?:intent|chat)(?:\/stream)?$/.test(String(url)))).toBe(false);
});

test("Android conversation accepts read-aloud confirmation without the wake word", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  const readAnswer = jest.fn(() => true);
  window.__siriusReadAloudAnswer = readAnswer;
  try {
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
    await act(async () => nativeCalls[0].resolve("oui"));
    expect(readAnswer).toHaveBeenCalledWith("oui");
    await act(async () => jest.advanceTimersByTime(5000));
    expect(nativeCalls).toHaveLength(2);
  } finally {
    delete window.__siriusReadAloudAnswer;
  }
});

test("saved hands-free preference stays disabled and touching the HUD never speaks a quotation", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  localStorage.setItem("sirius_auto_mic", "1");
  await mount();
  await act(async () => jest.advanceTimersByTime(1200));
  expect(nativeCalls).toHaveLength(0);
  expect(localStorage.getItem("sirius_auto_mic")).toBe("0");
  expect(host.querySelector('[title="Activer le mode mains libres"]')).toBeNull();

  expect(host.querySelector('[data-testid="core-quote-btn"]')).toBeNull();
  expect(host.querySelector('[aria-label="Écouter une citation philosophique"]')).toBeNull();
  speakFr.mockClear();
  await act(async () => {
    host.querySelector(".core-rings").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    host.querySelector(".core-rings").click();
    host.querySelector('[data-testid="sirius-title"]').click();
  });
  await act(async () => jest.advanceTimersByTime(2000));
  expect(speakFr).not.toHaveBeenCalled();
  expect(nativeCalls).toHaveLength(0);
});

test("Android does not open a second recognizer during Sirius playback", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  const webSpeech = jest.fn();
  window.SpeechRecognition = webSpeech;
  speakFr.mockImplementation((_text, options) => options?.onstart?.());
  await mount();
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  await send("quelle heure est-il");
  expect(speakFr).toHaveBeenCalled();
  expect(webSpeech).not.toHaveBeenCalled();
});

test("Stop cancels a native microphone and a late result cannot send a request", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  await mount();
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  const capture = nativeCalls[0];
  await act(async () => host.querySelector(".voice-session-controls button").click());
  await act(async () => capture.resolve("Explique le ciel bleu"));
  expect(native.cancel).toHaveBeenCalled();
  expect(global.fetch.mock.calls.some(([url]) => /\/chat(?:\/stream)?$/.test(String(url)))).toBe(false);
});

test("an obsolete streamed response cannot overwrite a newer local answer", async () => {
  let deliver;
  let oldSignal;
  const reader = {
    read: jest.fn(() => new Promise((resolve) => { deliver = resolve; })),
    cancel: jest.fn(async () => {}),
  };
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => {
    if (!String(url).endsWith("/chat/stream")) return fallback(url, options);
    oldSignal = options.signal;
    return Promise.resolve({ ok: true, headers: { get: () => "text/event-stream" }, body: { getReader: () => reader } });
  });
  await mount();
  await send("Explique le ciel bleu");
  await send("quelle heure est-il");
  expect(oldSignal.aborted).toBe(true);
  await act(async () => deliver({ done: false, value: new Uint8Array(Buffer.from(
    'data: {"type":"delta","text":"Ancienne réponse."}\n\n'
  )) }));
  expect(host.textContent).not.toContain("Ancienne réponse.");
  expect(speakSeries).not.toHaveBeenCalled();
  expect(reader.cancel).toHaveBeenCalled();
});

test("push-to-talk immediately invalidates a pending reply", async () => {
  await mount();
  await send("Explique le ciel bleu");
  const oldSignal = chatSignal;
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true })));
  expect(oldSignal.aborted).toBe(true);
  await act(async () => host.querySelector(".voice-session-controls button").click());
});

test("holding Space prevents browser page scrolling from repeated keydown events", async () => {
  await mount();
  const initialPress = new KeyboardEvent("keydown", {
    code: "Space", bubbles: true, cancelable: true,
  });
  const repeatedPress = new KeyboardEvent("keydown", {
    code: "Space", bubbles: true, cancelable: true, repeat: true,
  });

  await act(async () => document.dispatchEvent(initialPress));
  await act(async () => document.dispatchEvent(repeatedPress));

  expect(initialPress.defaultPrevented).toBe(true);
  expect(repeatedPress.defaultPrevented).toBe(true);
  expect(host.querySelector('[data-testid="sirius-ptt-indicator"]')).not.toBeNull();

  await act(async () => document.dispatchEvent(new KeyboardEvent("keyup", {
    code: "Space", bubbles: true, cancelable: true,
  })));
});

test.each([false, true])("Android waits for microphone readiness and handles early release=%s", async (earlyRelease) => {
  const previousRecorder = window.MediaRecorder;
  const previousMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  let resolveMicrophone;
  const stopTrack = jest.fn();
  const recorders = [];
  const connection = {
    send: jest.fn(() => true),
    finish: jest.fn(async () => ({ text: "quelle heure est-il" })),
    close: jest.fn(),
  };
  connectStreamingStt.mockResolvedValue(connection);
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  const getUserMedia = jest.fn(() => new Promise((resolve) => { resolveMicrophone = resolve; }));
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: { getUserMedia },
  });
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() {
      this.mimeType = "audio/webm";
      this.state = "inactive";
      recorders.push(this);
    }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["a".repeat(1000)], { type: this.mimeType }) });
      this.onstop?.();
    }
  };
  try {
    await mount();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true })));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(pttBeep).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="sirius-ptt-btn"]').textContent).toContain("OUVERTURE");
    if (earlyRelease) {
      await act(async () => document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true })));
    }
    await act(async () => resolveMicrophone({ getTracks: () => [{ stop: stopTrack }] }));
    if (earlyRelease) {
      expect(recorders).toHaveLength(0);
      expect(stopTrack).toHaveBeenCalledTimes(1);
      expect(pttBeep).not.toHaveBeenCalled();
    } else {
      expect(recorders[0].state).toBe("recording");
      expect(host.querySelector('[data-testid="sirius-ptt-btn"]').textContent).toContain("OUVERTURE");
      expect(pttBeep).not.toHaveBeenCalled();
      await act(async () => recorders[0].onstart());
      expect(host.querySelector('[data-testid="sirius-ptt-btn"]').textContent).toContain("À VOUS");
      expect(pttBeep).toHaveBeenCalledWith(false);
      await act(async () => document.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true })));
      expect(connection.finish).toHaveBeenCalledTimes(1);
      expect(speakFr.mock.calls.some(([text]) => text.startsWith("Il est "))).toBe(true);
      expect(stopTrack).toHaveBeenCalledTimes(1);
    }
  } finally {
    window.MediaRecorder = previousRecorder;
    if (previousMediaDevices) Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
    else delete navigator.mediaDevices;
  }
});

test("native permission refusal is explicit and does not silently upload audio", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  native.listen.mockRejectedValueOnce(Object.assign(new Error("Microphone non autorisé."), { code: "PERMISSION_DENIED" }));
  await mount();
  await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
  expect(host.querySelector(".voice-session-controls").textContent).toContain("Microphone non autorisé.");
  expect(host.querySelector('[title="Démarrer la conversation vocale"]')).not.toBeNull();
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/stt"))).toBe(false);
});

test("native unavailability explicitly falls back to server capture", async () => {
  const previousRecorder = window.MediaRecorder;
  const previousMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const recorders = [];
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { recorders.push(this); this.state = "inactive"; }
    start() { this.state = "recording"; this.onstart?.(); }
    stop() { this.state = "inactive"; this.onstop?.(); }
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
  });
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  native.listen.mockRejectedValueOnce(Object.assign(new Error("French model missing"), { code: "UNAVAILABLE" }));
  try {
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
    expect(recorders).toHaveLength(1);
    expect(host.querySelector(".voice-session-controls").textContent).toContain("transcription serveur");
    await act(async () => host.querySelector(".voice-session-controls button").click());
    expect(recorders[0].state).toBe("inactive");
  } finally {
    window.MediaRecorder = previousRecorder;
    if (previousMediaDevices) Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
    else delete navigator.mediaDevices;
  }
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

test("web conversation waits for the end of the answer before reopening", async () => {
  const previousRecognition = window.SpeechRecognition;
  const recognitions = [];
  window.SpeechRecognition = class {
    constructor() { recognitions.push(this); }
    start() {}
    stop() { this.onend?.(); }
    abort() { this.onend?.(); }
  };
  try {
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
    expect(recognitions).toHaveLength(1);

    await act(async () => {
      const result = [{ transcript: "quelle heure est-il", confidence: 0.9 }];
      result.isFinal = true;
      recognitions[0].onresult({ resultIndex: 0, results: [result] });
      jest.advanceTimersByTime(1200);
      jest.advanceTimersByTime(500);
    });

    expect(recognitions).toHaveLength(1);
    expect(speakFr.mock.calls.some(([message]) => message.startsWith("Il est "))).toBe(true);
    const [, options] = speakFr.mock.calls.at(-1);
    await act(async () => options.onend?.());
    await act(async () => jest.advanceTimersByTime(600));
    expect(recognitions).toHaveLength(2);
    expect(global.fetch.mock.calls.filter(([url]) => /\/(?:intent|chat)(?:\/stream)?$/.test(String(url)))).toEqual([]);
  } finally {
    window.SpeechRecognition = previousRecognition;
  }
});

test.each([
  ["", "Aucune parole distinguée"],
  ["Sirius", "Dis ta demande complète"],
  ["Explique pourquoi le ciel est bleu", null],
  ["Zirius explique pourquoi le ciel est bleu", null],
  ["quelle heure est-il", "local-answer"],
  ["Sirius, quelle heure est-il", "local-answer"],
])("Android conversation handles transcript %s and resumes when available", async (transcript, feedback) => {
  const previousRecorder = window.MediaRecorder;
  const previousMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const recorders = [];
  const stopTrack = jest.fn();
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
  });

  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() {
      this.mimeType = "audio/webm";
      this.state = "inactive";
      recorders.push(this);
    }
    start() { this.state = "recording"; this.onstart?.(); }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["a".repeat(1000)], { type: this.mimeType }) });
      this.onstop?.();
    }
  };
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/stt")
    ? Promise.resolve({ ok: true, json: async () => ({ text: transcript }) })
    : fallback(url, options));
  try {
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
    expect(recorders).toHaveLength(1);
    await act(async () => recorders[0].stop());
    if (feedback === "local-answer") {
      const [, callbacks] = speakFr.mock.calls.find(([message]) => message.startsWith("Il est "));
      await act(async () => callbacks.onstart());
      await act(async () => jest.advanceTimersByTime(1000));
      expect(recorders).toHaveLength(1);
      await act(async () => callbacks.onend());
      await act(async () => jest.advanceTimersByTime(250));
      expect(recorders).toHaveLength(2);
      await act(async () => host.querySelector('[data-testid="sirius-voice-controls"] button').click());
      return;
    }
    if (feedback === null) {
      expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"))).toHaveLength(1);
      expect(host.querySelector('[data-testid="sirius-voice-controls"]').textContent).toContain("Je traite");
      await act(async () => jest.advanceTimersByTime(600));
      expect(recorders).toHaveLength(1);
      await act(async () => host.querySelector('[data-testid="sirius-voice-controls"] button').click());
      return;
    }
    expect(host.querySelector('[data-testid="sirius-voice-controls"]').textContent).toContain(feedback);
    await act(async () => jest.advanceTimersByTime(600));
    expect(recorders).toHaveLength(2);
    const controls = host.querySelector('[data-testid="sirius-voice-controls"]');
    expect(controls.textContent).toContain("J’écoute");
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls.filter(([url]) => /\/chat(?:\/stream)?$/.test(String(url)))).toEqual([]);
    await act(async () => controls.querySelector("button").click());
    await act(async () => jest.advanceTimersByTime(16000));
    expect(recorders).toHaveLength(2);
  } finally {
    window.MediaRecorder = previousRecorder;
    if (previousMediaDevices) Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
    else delete navigator.mediaDevices;
  }
});

test("Test micro uses the server capture and resumes after answering, not the experimental segmenter", async () => {
  const previousRecorder = window.MediaRecorder;
  const previousMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const recorders = [];
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  handsFree.available.mockResolvedValue({ available: true });
  localStorage.setItem("sirius_android_stt", "native");
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true, value: { getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop: jest.fn() }] })) },
  });
  window.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = "audio/webm"; this.state = "inactive"; recorders.push(this); }
    start() { this.state = "recording"; this.onstart?.(); }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["a".repeat(1000)], { type: this.mimeType }) });
      this.onstop?.();
    }
  };
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/stt")
    ? Promise.resolve({ ok: true, json: async () => ({ text: "quelle heure est-il" }) })
    : fallback(url, options));
  try {
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-test-mic-btn"]').click());
    expect(recorders).toHaveLength(1);
    expect(native.listen).not.toHaveBeenCalled();
    expect(handsFree.start).not.toHaveBeenCalled();
    expect(localStorage.getItem("sirius_android_stt")).toBe("server");
    await act(async () => recorders[0].stop());
    const [, callbacks] = speakFr.mock.calls.find(([text]) => text.startsWith("Il est "));
    await act(async () => callbacks.onend());
    await act(async () => jest.advanceTimersByTime(500));
    expect(recorders).toHaveLength(2);
    await act(async () => host.querySelector('[data-testid="sirius-test-mic-btn"]').click());
    await act(async () => jest.advanceTimersByTime(16000));
    expect(recorders).toHaveLength(2);
    expect(host.querySelector('[data-testid="sirius-top-mic-btn"]').getAttribute("aria-pressed")).toBe("false");
  } finally {
    window.MediaRecorder = previousRecorder;
    if (previousMediaDevices) Object.defineProperty(navigator, "mediaDevices", previousMediaDevices);
    else delete navigator.mediaDevices;
  }
});

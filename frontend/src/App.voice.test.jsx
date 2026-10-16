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
import { saveVoiceVocabulary } from "./voiceVocabulary";

jest.mock("./nativeSpeechRecognition", () => ({ createNativeRecognition: jest.fn() }));
jest.mock("./nativeHandsFree", () => ({ createNativeHandsFree: jest.fn() }));
jest.mock("./services/streamingStt", () => ({ connectStreamingStt: jest.fn() }));
jest.mock("./appLogic", () => ({ ...jest.requireActual("./appLogic"), pttBeep: jest.fn() }));

jest.mock("./AuthGate", () => ({ useAuth: () => ({ user: { id: "voice-test", name: "Validation" } }) }));
jest.mock("./ProactivePanel", () => ({ onInitiative }) => (
  <button data-testid="test-initiative" onClick={() => onInitiative(
    { id: "initiative-test" }, "Je peux préparer le briefing du jour."
  )}>Initiative de test</button>
));
jest.mock("./voice", () => ({
  speakFr: jest.fn(), cancelSpeech: jest.fn(), speakSeries: jest.fn(() => Promise.resolve()), speakAsCharacter: jest.fn(),
}));
jest.mock("./lazyModules", () => new Proxy({}, { get: (_, key) => {
  if (key === "__esModule") return true;
  if (key === "MediaModulesPanel") return ({ onClose }) => (
    <div data-testid="media-modules-panel"><button onClick={onClose}>Fermer le catalogue</button></div>
  );
  if (key === "SiriusSetup") return ({ onCancel }) => (
    <div data-testid="workspace-SiriusSetup"><button onClick={onCancel}>Fermer</button></div>
  );
  if (key === "Odysseia") return ({ open, onClose }) => open ? (
    <div data-testid="workspace-Odysseia"><button onClick={onClose}>Fermer</button></div>
  ) : null;
  if (key === "WorkDossiersPanel") return function WorkDossiersPreview({ onClose, onAsk, onConversationContext }) {
    const React = require("react");
    React.useEffect(() => {
      onConversationContext?.("screen-dossier");
      return () => onConversationContext?.(null);
    }, [onConversationContext]);
    return <div data-testid="workspace-WorkDossiersPanel">
      <button onClick={onClose}>Fermer</button>
      <button data-testid="work-preview-ask" onClick={() => onAsk("Où en est ce dossier ?")}>Résumer ce dossier</button>
    </div>;
  };
  if (key === "VoiceProfilePanel") return ({ onClose }) => (
    <div data-testid={`workspace-${key}`}><button onClick={onClose}>Fermer</button></div>
  );
  if (key === "SiriusDisplay") return ({ item, history, onSelect, onRead }) => <div data-testid="sirius-display">
    <button data-testid="sirius-display-read" onClick={onRead}>Lire</button>
    <div data-testid="sirius-display-body">{item.contenu}</div>
    <div data-testid="sirius-display-history">{history.map((entry) => (
      <button key={entry.id} onClick={() => onSelect(entry)}>{entry.question || entry.titre}</button>
    ))}</div>
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
    if (String(url).endsWith("/work-dossiers/briefing")) return Promise.resolve({
      ok: true, json: async () => ({ kind: "work", read_only: true, briefing: "Aucun dossier de travail enregistré." }),
    });
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

test("ordinary native STT reads only this account's opted-in text and drops disabled hints", async () => {
  const platform = jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  saveVoiceVocabulary("other-account", { enabled: true, terms: ["Autre compte"] });
  saveVoiceVocabulary("voice-test", { enabled: false, terms: ["Daniel Partel"] });
  await mount();
  expect(handsFreeOptions.vocabulary()).toEqual([]);
  saveVoiceVocabulary("voice-test", { enabled: true, terms: ["Daniel Partel"] });
  expect(handsFreeOptions.vocabulary()).toEqual(["Daniel Partel"]);
  saveVoiceVocabulary("voice-test", { enabled: false, terms: ["Daniel Partel"] });
  expect(handsFreeOptions.vocabulary()).toEqual([]);
  platform.mockRestore();
});

async function send(command) {
  const input = host.querySelector('[data-testid="sirius-cmd-form"] input[type="text"]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, command);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => host.querySelector('[data-testid="sirius-cmd-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

test("Chronos appointment requests bypass Outlook and confirm only the issued proposal", async () => {
  const original = global.fetch.getMockImplementation();
  let chats = 0;
  global.fetch.mockImplementation((url, options) => {
    if (String(url).endsWith("/chat/stream")) {
      return Promise.resolve({ ok: true, headers: { get: () => "application/json" } });
    }
    if (String(url).endsWith("/chat")) {
      chats += 1;
      return Promise.resolve({ ok: true, json: async () => chats === 1
        ? { answer: "CHRONOS : proposition à confirmer.", chronos_pending: "abcdef123456", chronos_state: "WAITING_CONFIRMATION" }
        : { answer: "CHRONOS : rendez-vous enregistré.", chronos_changed: true } });
    }
    return original(url, options);
  });

  const changed = jest.fn();
  window.addEventListener("sirius:chronos-changed", changed);
  try {
    await mount();
    await send("Ajoute un rendez-vous client demain de 14 h à 15 h");
    expect(chats).toBe(1);
    expect(global.fetch.mock.calls.some(([url]) => /outlook.*(?:execute|event)/.test(String(url)))).toBe(false);
    await send("Oui, je confirme !");
    const requests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"));
    expect(JSON.parse(requests[1][1].body).text).toBe("confirme agenda abcdef123456");
    expect(changed).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener("sirius:chronos-changed", changed); }
});

test("work conversation bypasses intent parsing and carries a bounded dossier context", async () => {
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => {
    if (String(url).endsWith("/chat/stream")) {
      return Promise.resolve({ ok: true, headers: { get: () => "application/json" } });
    }
    if (String(url).endsWith("/chat")) {
      const text = JSON.parse(options.body).text;
      return Promise.resolve({ ok: true, json: async () => ({
        answer: "Dossier Martin : sources vérifiées, aucune action exécutée.",
        work_state: "READ_ONLY", executed: false,
        ...(text.startsWith("Oublie") ? { work_context_cleared: true } : {
          work_context: { dossier_id: "martin", expires_at: new Date(Date.now() + 1800000).toISOString() },
        }),
      }) });
    }
    return original(url, options);
  });
  await mount();
  await send("Où en est le dossier Martin ?");
  await send("Pourquoi ces propositions pour ce dossier ?");
  let requests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"));
  expect(requests).toHaveLength(2);
  expect(JSON.parse(requests[1][1].body).environment.work_dossier_id).toBe("martin");
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/intent"))).toBe(false);
  jest.setSystemTime(Date.now() + 31 * 60 * 1000);
  await send("Résume ce dossier");
  requests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"));
  expect(JSON.parse(requests[2][1].body).environment.work_context_clear).toBe(true);
  expect(JSON.parse(requests[2][1].body).environment.work_dossier_id).toBeUndefined();
  await send("Oublie ce dossier");
  await send("Résume ce dossier");
  requests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"));
  expect(JSON.parse(requests[4][1].body).environment.work_context_clear).toBe(true);
  expect(JSON.parse(requests[4][1].body).environment.work_dossier_id).toBeUndefined();
});

test("work conversation accepts SSE context without an extra HTTP request", async () => {
  mockConversationStream([
    { type: "delta", text: "Dossier Martin vérifié." },
    { type: "done", answer: "Dossier Martin vérifié.", work_state: "READ_ONLY",
      work_context: { dossier_id: "martin", expires_at: new Date(Date.now() + 1800000).toISOString() } },
  ]);
  await mount();
  await send("Résume le dossier Martin");
  mockConversationStream([
    { type: "done", answer: "Propositions vérifiées.", work_state: "READ_ONLY" },
  ]);
  await send("Pourquoi ces propositions ?");
  const streams = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/stream"));
  expect(JSON.parse(streams[1][1].body).environment.work_dossier_id).toBe("martin");
  expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"))).toHaveLength(0);
});

test("an unavailable work service is reported aloud without a local success fallback", async () => {
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat/stream")
    ? Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
    : original(url, options));
  await mount();
  await send("Où en est ce dossier ?");
  expect(speakFr).toHaveBeenCalledWith(expect.stringContaining("Service indisponible"), expect.anything());
  expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"))).toHaveLength(0);
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/intent"))).toBe(false);
});

test("an invoice preview is shown and spoken as a preparation, never as an external action", async () => {
  const answer = "Prévisualisation de relance FAC-42. Solde enregistré : 100.00 €. Brouillon temporaire non enregistré. Aucun message envoyé.";
  mockConversationStream([
    { type: "delta", text: answer },
    { type: "done", answer, work_state: "PREPARED", persisted: false, executed: false,
      work_preview: { source: { kind: "facture", id: "invoice-42" }, content: { to: "martin@example.test" } } },
  ]);
  await mount();
  await send("Prépare la relance FAC-42");
  for (let i = 0; i < 10; i += 1) await act(async () => jest.advanceTimersByTime(5000));
  const streams = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/stream"));
  expect(streams).toHaveLength(1);
  expect(JSON.parse(streams[0][1].body).text).toBe("Prépare la relance FAC-42");
  expect(speakSeries.mock.calls.map(([text]) => text).join(" ")).toContain("Aucun message envoyé");
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toContain("Brouillon temporaire non enregistré");
  expect(global.fetch.mock.calls.some(([url]) => /\/intent$|\/drafts$|\/send$|outlook.*execute/.test(String(url)))).toBe(false);
  mockConversationStream([{ type: "done", answer: "Cette prévisualisation n'autorise aucun envoi.", work_state: "NOT_EXECUTED" }]);
  await send("Oui, je confirme !");
  const after = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/stream"));
  expect(JSON.parse(after[1][1].body).text).toBe("Confirme la prévisualisation de relance");
  expect(global.fetch.mock.calls.some(([url]) => /\/intent$|\/drafts$|\/send$|outlook.*execute/.test(String(url)))).toBe(false);
});

test("a dossier question opens the visible conversation and transfers its screen context", async () => {
  mockConversationStream([{ type: "done", answer: "Dossier vérifié.", work_context: {
    dossier_id: "server-dossier", expires_at: new Date(Date.now() + 1800000).toISOString(),
  } }]);
  await mount();
  const button = [...host.querySelector('[data-testid="workspace-navigation"]').querySelectorAll("button")]
    .find((item) => item.textContent === "Mes dossiers");
  await act(async () => button.click());
  await act(async () => host.querySelector('[data-testid="work-preview-ask"]').click());
  expect(host.querySelector('[data-testid="workspace-WorkDossiersPanel"]')).toBeNull();
  expect(host.querySelector('[data-testid="sirius-display"]')).not.toBeNull();
  let requests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/stream"));
  expect(JSON.parse(requests[0][1].body).environment.work_dossier_id).toBe("screen-dossier");
  mockConversationStream([{ type: "done", answer: "Suivi vérifié." }]);
  await send("Résume ce dossier");
  requests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/stream"));
  expect(JSON.parse(requests[1][1].body).environment.work_dossier_id).toBe("server-dossier");
});

test("closing the dossier screen without a conversation clears its selection", async () => {
  mockConversationStream([{ type: "done", answer: "Précisez le dossier." }]);
  await mount();
  const button = [...host.querySelector('[data-testid="workspace-navigation"]').querySelectorAll("button")]
    .find((item) => item.textContent === "Mes dossiers");
  await act(async () => button.click());
  await act(async () => host.querySelector('[data-testid="workspace-WorkDossiersPanel"] button').click());
  await send("Résume ce dossier");
  const requests = global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat/stream"));
  expect(JSON.parse(requests[0][1].body).environment.work_context_clear).toBe(true);
});

test("the HUD no longer mounts the next-actions pill", async () => {
  await mount();
  expect(host.querySelector('[data-testid="sirius-title"]')).not.toBeNull();
  expect(host.querySelector(".shud-next")).toBeNull();
});

test("the HUD places the colleague subtitle before the Sigma-branded tagline", async () => {
  await mount();
  const welcome = host.querySelector(".workspace-welcome");
  const colleague = host.querySelector(".sirius-colleague");
  const tagline = host.querySelector(".sirius-tagline");
  expect(welcome.nextElementSibling).toBe(colleague);
  expect(colleague.textContent).toBe("LE COLLÈGUE SUR QUI VOUS POUVEZ COMPTER");
  expect(colleague.nextElementSibling).toBe(tagline);
  expect(tagline.textContent).toBe("Parlez-lui simplement. ΣIRIUS vous répond.");
});

test("the desktop workspace connects to existing wheels, settings, dossiers and personal voice", async () => {
  await mount();
  const nav = host.querySelector('[data-testid="workspace-navigation"]');
  const clickEntry = async (label) => {
    const button = [...nav.querySelectorAll("button")].find((entry) => entry.textContent === label);
    await act(async () => button.click());
  };
  await clickEntry("Modules");
  expect(document.querySelector('[data-testid="modules-menu"]')).not.toBeNull();
  await act(async () => document.querySelector('[data-testid="modules-menu-close"]').click());
  await clickEntry("Informations");
  expect(host.querySelector('[data-testid="info-wheel"]')).not.toBeNull();
  for (const [label, panel] of [
    ["Configuration", "SiriusSetup"], ["ODYSSEIA", "Odysseia"],
    ["Mes dossiers", "WorkDossiersPanel"], ["Ma voix et ma diction", "VoiceProfilePanel"],
  ]) {
    await clickEntry(label);
    const window = host.querySelector(`[data-testid="workspace-${panel}"]`);
    expect(window).not.toBeNull();
    await act(async () => window.querySelector("button").click());
    expect(host.querySelector(`[data-testid="workspace-${panel}"]`)).toBeNull();
  }
  await clickEntry("Assistant");
  await act(async () => jest.advanceTimersByTime(0));
  expect(document.activeElement).toBe(host.querySelector('[data-testid="sirius-cmd-input"]'));
});

test("une initiative rejoint le Display et le contexte de la reponse suivante", async () => {
  await mount();
  await act(async () => host.querySelector('[data-testid="test-initiative"]').click());
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent)
    .toContain("Je peux préparer le briefing du jour.");
  expect(host.querySelector(".proactive-stack")).toBeNull();
  await send("Explique ce que tu proposes");
  const request = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/chat/stream"));
  expect(JSON.parse(request[1].body).environment.proactive_message)
    .toBe("Je peux préparer le briefing du jour.");
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

test("display keeps separate named exchanges when a new answer interrupts progressive rendering", async () => {
  mockConversationStream([
    { type: "delta", text: "Première réponse complète." },
    { type: "done", answer: "Première réponse complète." },
  ]);
  await mount();
  await send("Explique le ciel bleu");
  await act(async () => jest.advanceTimersByTime(160));

  mockConversationStream([
    { type: "delta", text: "Deuxième réponse complète." },
    { type: "done", answer: "Deuxième réponse complète." },
  ]);
  await send("Explique la couleur de la mer");
  await act(async () => jest.advanceTimersByTime(3000));

  const chips = host.querySelectorAll('[data-testid="sirius-display-history"] button');
  expect([...chips].map((chip) => chip.textContent)).toEqual([
    "Explique la couleur de la mer", "Explique le ciel bleu",
  ]);
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toBe("Deuxième réponse complète.");
  await act(async () => chips[1].click());
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toBe("Première réponse complète.");
});

test("display finalizes a slow stream in a single history entry", async () => {
  let finishStream;
  const reader = {
    read: jest.fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array(Buffer.from('data: {"type":"delta","text":"Bonjour."}\n\n')) })
      .mockImplementationOnce(() => new Promise((resolve) => { finishStream = resolve; }))
      .mockResolvedValue({ done: true }),
    cancel: jest.fn(async () => {}),
  };
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat/stream")
    ? Promise.resolve({ ok: true, headers: { get: () => "text/event-stream" }, body: { getReader: () => reader } })
    : fallback(url, options));
  await mount();
  await send("Explique le ciel bleu");
  await act(async () => jest.advanceTimersByTime(1000));
  await act(async () => finishStream({
    done: false, value: new Uint8Array(Buffer.from('data: {"type":"done","answer":"Bonjour."}\n\n')),
  }));
  await act(async () => jest.advanceTimersByTime(1000));
  expect(host.querySelectorAll('[data-testid="sirius-display-history"] button')).toHaveLength(1);
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toBe("Bonjour.");
});

test("background noise judged off-topic by the server stays silent and shows nothing", async () => {
  mockConversationStream([{ type: "done", ignored: true, answer: "" }]);
  await mount();
  await send("et la suite du film ce soir sur la deux");
  expect(speakSeries).not.toHaveBeenCalled();
  expect(speakFr).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="sirius-display-body"]')).toBeNull();
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

test("an incomplete stream recovers the full answer in the same display instead of leaving a short fragment", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockConversationStream([{ type: "delta", text: "Réponse partielle. " }]);
  const streamFetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat")
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ answer: "Réponse complète récupérée." }) })
    : streamFetch(url, options));
  await mount();
  await send("Explique le ciel bleu");
  await act(async () => jest.advanceTimersByTime(2500));
  expect(host.querySelectorAll('[data-testid="sirius-display"]')).toHaveLength(1);
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toContain("Réponse complète récupérée.");
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).not.toContain("Réponse partielle");
  expect(host.querySelector(".voice-session-controls").textContent).not.toContain("Réponse interrompue");
  expect(cancelSpeech).toHaveBeenCalled();
  expect(warn).toHaveBeenCalled();
  expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/chat"))).toHaveLength(1);
});

test("a deep stream timeout uses fast HTTP fallback without changing the saved mode", async () => {
  localStorage.setItem("sirius_ia_mode", "profond");
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const original = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => {
    if (String(url).endsWith("/chat/stream")) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Délai dépassé", "AbortError")));
      });
    }
    if (String(url).endsWith("/chat")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ answer: "Réponse rapide de secours." }) });
    }
    return original(url, options);
  });
  await mount();
  await send("Explique le ciel bleu");
  await act(async () => jest.advanceTimersByTime(60000));
  const stream = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/chat/stream"));
  const fallback = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/chat"));
  expect(JSON.parse(stream[1].body).ia_mode).toBe("profond");
  expect(JSON.parse(fallback[1].body)).toEqual(expect.objectContaining({ mode: "normal", ia_mode: "jarvis" }));
  expect(localStorage.getItem("sirius_ia_mode")).toBe("profond");
  expect(warn).toHaveBeenCalled();
  await act(async () => jest.advanceTimersByTime(2500));
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toContain("Réponse rapide de secours.");
});

test("a truncated deep answer is replaced by a complete fast answer in the same display", async () => {
  localStorage.setItem("sirius_ia_mode", "profond");
  jest.spyOn(console, "warn").mockImplementation(() => {});
  mockConversationStream([
    { type: "delta", text: "Selon les données par fr" },
    { type: "error", code: "model_output_limit", message: "Limite de génération" },
  ]);
  const streamFetch = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat")
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ answer: "Réponse complète de secours." }) })
    : streamFetch(url, options));
  await mount();
  await send("Explique le ciel bleu");
  await act(async () => jest.advanceTimersByTime(3000));
  const fallback = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/chat"));
  expect(JSON.parse(fallback[1].body)).toEqual(expect.objectContaining({ mode: "normal", ia_mode: "jarvis" }));
  expect(host.querySelectorAll('[data-testid="sirius-display"]')).toHaveLength(1);
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toBe("Réponse complète de secours.");
  expect(cancelSpeech).toHaveBeenCalled();
});

test("SSE accepts CRLF and a final done event without a trailing blank line", async () => {
  const reader = {
    read: jest.fn()
      .mockResolvedValueOnce({
        done: false,
        value: new Uint8Array(Buffer.from(
          'data: {"type":"delta","text":"Réponse."}\r\n\r\ndata: {"type":"done","answer":"Réponse complète."}',
        )),
      })
      .mockResolvedValueOnce({ done: true }),
    cancel: jest.fn(async () => {}),
  };
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/chat/stream")
    ? Promise.resolve({ ok: true, headers: { get: () => "text/event-stream" }, body: { getReader: () => reader } })
    : fallback(url, options));
  await mount();
  await send("Explique le ciel bleu");
  await act(async () => jest.advanceTimersByTime(5000));
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toContain("Réponse complète.");
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
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/work-dossiers/briefing"))).toBe(true);
  const [, briefingOptions] = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/work-dossiers/briefing"));
  expect(briefingOptions.credentials).toBe("include");
  expect(briefingOptions.body).toBeUndefined();
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/oracle/overview"))).toBe(false);
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
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/work-dossiers/briefing")
    ? Promise.resolve({ ok: true, json: async () => ({ kind: "work", read_only: true, briefing: "Dossier Boutique : terminer le devis." }) })
    : fallback(url, options));
  await mount();
  await send(command);
  expect(host.querySelector('[data-testid="sirius-display"]')).not.toBeNull();
  expect(speakFr.mock.calls.some(([message]) => message.includes("Dossier Boutique : terminer le devis."))).toBe(true);
  expect(global.fetch.mock.calls.some(([url]) => /\/(?:oracle\/overview|news\/briefing|weather\/current|nummarius\/market|microsoft\/mail\/action-plans)/.test(String(url)))).toBe(false);
  expect(global.fetch.mock.calls.some(([url]) => /\/(?:intent|chat)(?:\/stream)?$/.test(String(url)))).toBe(false);
});

test("work briefing ignores the old mixed cache and refreshes after each request", async () => {
  localStorage.setItem("sirius_daily_briefing_cache", JSON.stringify({
    version: 2, date: new Date().toISOString().slice(0, 10), saved_at: Date.now(), msg: "Ancien journal météo.",
  }));
  const fallback = global.fetch.getMockImplementation();
  let calls = 0;
  global.fetch.mockImplementation((url, options) => {
    if (String(url).endsWith("/work-dossiers/briefing")) {
      calls += 1;
      return Promise.resolve({ ok: true, json: async () => ({
        kind: "work", read_only: true, briefing: `Dossier Boutique : ${calls === 1 ? "terminer le devis" : "aucun engagement restant"}.`,
      }) });
    }
    return fallback(url, options);
  });
  await mount();
  await send("mon briefing");
  await send("refais-moi le briefing");
  expect(calls).toBe(2);
  expect(speakFr.mock.calls.some(([message]) => message.includes("aucun engagement restant"))).toBe(true);
  expect(speakFr.mock.calls.some(([message]) => message.includes("Ancien journal météo"))).toBe(false);
  expect(global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/work-dossiers/briefing"))
    .every(([, options]) => !options.method || options.method === "GET")).toBe(true);
});

test.each([
  { ok: false, json: async () => ({ detail: "indisponible" }) },
  { ok: true, json: async () => ({ briefing: "Un faux succès sans rapport de travail." }) },
])("work briefing failure is explicit and does not fall back to news", async (response) => {
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/work-dossiers/briefing")
    ? Promise.resolve(response) : fallback(url, options));
  await mount();
  await send("mon briefing");
  expect(speakFr.mock.calls.some(([message]) => /pas accessibles|incomplet/.test(message))).toBe(true);
  expect(global.fetch.mock.calls.some(([url]) => /\/(?:oracle\/overview|news\/briefing)/.test(String(url)))).toBe(false);
});

test("a new briefing is not blocked by the previous interrupted request", async () => {
  const fallback = global.fetch.getMockImplementation();
  let finishPrevious;
  let calls = 0;
  global.fetch.mockImplementation((url, options) => {
    if (!String(url).endsWith("/work-dossiers/briefing")) return fallback(url, options);
    calls += 1;
    if (calls === 1) return new Promise((resolve) => { finishPrevious = resolve; });
    return Promise.resolve({ ok: true, json: async () => ({
      kind: "work", read_only: true, briefing: "Rapport actualisé : reprendre le dossier Boutique.",
    }) });
  });
  await mount();
  await send("mon briefing");
  await send("refais-moi le briefing");
  expect(calls).toBe(2);
  await act(async () => finishPrevious({ ok: true, json: async () => ({
    kind: "work", read_only: true, briefing: "Ancien rapport interrompu.",
  }) }));
  expect(speakFr.mock.calls.some(([message]) => message.includes("Rapport actualisé"))).toBe(true);
  expect(speakFr.mock.calls.some(([message]) => message.includes("Ancien rapport interrompu"))).toBe(false);
});

test.each(["les infos", "les actualités", "Donne-moi toutes les infos du jour"])("%s uses dated France and international sources without a model call", async (command) => {
  const fallback = global.fetch.getMockImplementation();
  const date = new Date().toISOString();
  const sections = [
    { id: "france", label: "France", status: "ok", articles: [{ titre: "Information française", source: "Franceinfo", date, url: "https://www.franceinfo.fr/france/article.html", description: "Les faits établis. Une phrase coup" }] },
    { id: "monde", label: "International", status: "ok", articles: [{ titre: "Information internationale", source: "Franceinfo", date, url: "https://www.franceinfo.fr/monde/article.html" }] },
    { id: "sport", label: "Sport", status: "ok", articles: [{ titre: "Résultat sportif", source: "Franceinfo", date, url: "https://www.franceinfo.fr/sport/article.html" }] },
    { id: "sante", label: "Santé", status: "unavailable", articles: [] },
  ];
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/news/briefing")
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ sections }) })
    : fallback(url, options));
  await mount();
  await send(command);
  expect(global.fetch.mock.calls.some(([url]) => String(url).endsWith("/news/briefing"))).toBe(true);
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/news/headlines"))).toBe(false);
  expect(global.fetch.mock.calls.some(([url]) => /\/(?:intent|chat|oracle\/overview)(?:\/stream)?$/.test(String(url)))).toBe(false);
  expect(host.querySelector('[data-testid="sirius-display"]')).not.toBeNull();
  const message = speakSeries.mock.calls.map(([text]) => text).join(" ");
  expect(message).toContain("Information française");
  expect(message).toContain("Information internationale");
  expect(message).toContain("Résultat sportif");
  expect(message).toContain("Santé : source temporairement indisponible.");
  expect(message).toContain("Publié aujourd'hui à");
  expect(message).not.toContain("Une phrase coup");
  expect(localStorage.getItem("sirius_last_briefing_context")).toContain("Information internationale");
});

test.each([
  ["Donne-moi les infos du jour en France.", "france", "Information internationale"],
  ["les actualités internationales", "monde", "Information française"],
])("%s preserves the requested news scope and rejects stale facts", async (command, id, excluded) => {
  const fallback = global.fetch.getMockImplementation();
  const recent = { source: "Franceinfo", date: new Date().toISOString(), description: "Faits datés." };
  const sections = [
    { id: "france", label: "France", status: "ok", articles: [{ ...recent, titre: "Information française", url: "https://www.franceinfo.fr/france/one" }] },
    { id: "monde", label: "International", status: "ok", articles: [{ ...recent, titre: "Information internationale", url: "https://www.franceinfo.fr/monde/two" }] },
  ];
  sections.find((section) => section.id === id).articles.push({ ...recent, titre: "Titre périmé", url: "https://www.franceinfo.fr/old", date: new Date(Date.now() - 72 * 3600000).toISOString() });
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/news/briefing")
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ sections }) })
    : fallback(url, options));
  await mount();
  await send(command);
  const message = speakSeries.mock.calls.map(([text]) => text).join(" ");
  expect(message).not.toContain(excluded);
  expect(message).not.toContain("Titre périmé");
  expect(global.fetch.mock.calls.some(([url]) => /\/chat(?:\/stream)?$/.test(String(url)))).toBe(false);
});

function parisWeather() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  const today = `${get("year")}-${get("month")}-${get("day")}`;
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return {
    city: "Lyon", country: "France", source: "Open-Meteo", url: "https://open-meteo.com/", timezone: "Europe/Paris",
    current: { time: `${today}T${get("hour")}:${get("minute")}`, temperature_2m: 18, apparent_temperature: 17, weather_code: 61, wind_speed_10m: 12 },
    days: [
      { date: today, weather_code: 61, temperature_2m_min: 12, temperature_2m_max: 19, precipitation_probability_max: 80, wind_speed_10m_max: 22 },
      { date: tomorrow, weather_code: 0, temperature_2m_min: 10, temperature_2m_max: 20, precipitation_probability_max: 10, wind_speed_10m_max: 15 },
    ],
  };
}

function mockBulletinBackend({ weather = parisWeather() } = {}) {
  const fallback = global.fetch.getMockImplementation();
  const date = new Date().toISOString();
  const sections = [
    { id: "france", label: "France", status: "ok", articles: [{ titre: "Le maire annonce une décision", source: "Franceinfo", date, url: "https://www.franceinfo.fr/france/maire.html" }] },
    { id: "monde", label: "International", status: "ok", articles: [{ titre: "Le parlement adopte le texte", source: "Franceinfo", date, url: "https://www.franceinfo.fr/monde/parlement.html" }] },
  ];
  const chatBodies = [];
  global.fetch.mockImplementation((url, options) => {
    if (String(url).endsWith("/news/briefing")) return Promise.resolve({ ok: true, status: 200, json: async () => ({ sections }) });
    if (String(url).includes("/weather/bulletin")) return Promise.resolve({ ok: true, status: 200, json: async () => weather });
    if (String(url).endsWith("/chat/stream")) return Promise.resolve({ ok: false });
    if (String(url).endsWith("/chat")) {
      chatBodies.push(JSON.parse(options.body).text);
      return Promise.resolve({ ok: true, json: async () => ({ answer: "Réponse contextuelle." }) });
    }
    return fallback(url, options);
  });
  return chatBodies;
}

const lastSpoken = () => speakFr.mock.calls.at(-1)?.[0] || "";
const newsFetches = () => global.fetch.mock.calls.filter(([url]) => String(url).endsWith("/news/briefing")).length;

test("the bulletin dialogue recalls what was really announced, resumes, and contextualises questions", async () => {
  localStorage.setItem("sirius_profile", JSON.stringify({ name: "Validation", city: "Lyon" }));
  const chatBodies = mockBulletinBackend();
  speakSeries.mockImplementation((text, options) => {
    options?.onstart?.();
    return text.includes("Le parlement") ? new Promise(() => {}) : Promise.resolve();
  });
  await mount();
  await send("les infos");
  expect(global.fetch.mock.calls.find(([url]) => String(url).includes("/weather/bulletin"))[0]).toContain("city=Lyon");
  const read = speakSeries.mock.calls.map(([text]) => text).join(" ");
  expect(read).toContain("Météo à Lyon, France.");
  expect(read).toContain("probabilité maximale de précipitations 80 pour cent");
  expect(read).toContain("International : Le parlement adopte le texte.");
  for (let i = 0; i < 30; i += 1) await act(async () => { jest.advanceTimersByTime(5000); });
  expect(host.querySelector('[data-testid="sirius-display-body"]').textContent).toContain("Météo (Open-Meteo) : https://open-meteo.com/");

  await send("qui a fait quoi ?");
  expect(lastSpoken()).toContain("Voici ce que j'ai annoncé : International : Le parlement adopte le texte.");
  expect(lastSpoken()).not.toContain("maire");
  expect(cancelSpeech).toHaveBeenCalled();

  await send("quel temps tu a dis ?");
  expect(lastSpoken()).toContain("Météo à Lyon, France.");

  speakSeries.mockClear();
  await send("reprends");
  expect(speakSeries.mock.calls[0][0]).toContain("International : Le parlement adopte le texte.");

  await send("Pourquoi le parlement a adopté ce texte ?");
  expect(chatBodies.at(-1)).toContain("Passage en cours : International : Le parlement adopte le texte.");
  expect(chatBodies.at(-1)).toContain("N'invente aucun fait");

  await send("répète");
  expect(chatBodies.at(-1)).toBe("répète");
  expect(newsFetches()).toBe(1);
});

test("a late callback from an interrupted bulletin cannot move the announced position", async () => {
  mockBulletinBackend();
  let staleStart;
  speakSeries.mockImplementation((text, options) => {
    if (text.includes("Le maire")) {
      options.onstart();
      return new Promise(() => {});
    }
    if (text.includes("Le parlement")) staleStart = options.onstart;
    options?.onstart?.();
    return Promise.resolve();
  });
  await mount();
  await send("les infos");
  await send("qui a fait quoi");
  expect(lastSpoken()).toContain("France : Le maire annonce une décision.");
  expect(staleStart).toBeUndefined();
  speakSeries.mockClear();
  await send("continue");
  expect(speakSeries.mock.calls[0][0]).toContain("France : Le maire annonce une décision.");
  expect(speakSeries.mock.calls.some(([text]) => text.includes("Le parlement"))).toBe(false);
});

test("an invalid weather payload is announced as unavailable instead of read", async () => {
  localStorage.setItem("sirius_profile", JSON.stringify({ name: "Validation", city: "Lyon" }));
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const weather = parisWeather();
  weather.days[0].precipitation_probability_max = 180;
  mockBulletinBackend({ weather });
  await mount();
  await send("les infos");
  const read = speakSeries.mock.calls.map(([text]) => text).join(" ");
  expect(read).toContain("Météo à Lyon : prévisions indisponibles ou non vérifiables pour le moment.");
  expect(read).not.toContain("180");
  expect(read).toContain("Le parlement adopte le texte.");
  expect(warn).toHaveBeenCalledWith("Météo du bulletin :", expect.any(Error));
});

test("when the server is rate limited, weather is fetched directly from the device", async () => {
  localStorage.setItem("sirius_profile", JSON.stringify({ name: "Validation", city: "Lyon" }));
  mockBulletinBackend();
  const weather = parisWeather();
  const raw = {
    timezone: weather.timezone,
    current_units: { time: "iso8601", temperature_2m: "°C", apparent_temperature: "°C", weather_code: "wmo code", wind_speed_10m: "km/h" },
    daily_units: {
      time: "iso8601", weather_code: "wmo code", temperature_2m_min: "°C", temperature_2m_max: "°C",
      precipitation_probability_max: "%", wind_speed_10m_max: "km/h",
    },
    current: weather.current,
    daily: Object.fromEntries(["date", "weather_code", "temperature_2m_min", "temperature_2m_max", "precipitation_probability_max", "wind_speed_10m_max"]
      .map((field) => [field === "date" ? "time" : field, weather.days.map((day) => day[field])])),
  };
  const backend = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => {
    if (String(url).includes("/weather/bulletin")) return Promise.resolve({ ok: false, status: 503, json: async () => ({ detail: "limite" }) });
    if (String(url).startsWith("https://geocoding-api.open-meteo.com/")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ results: [{ name: "Lyon", country: "France", latitude: 45.75, longitude: 4.85 }] }) });
    }
    if (String(url).startsWith("https://api.open-meteo.com/")) return Promise.resolve({ ok: true, status: 200, json: async () => raw });
    return backend(url, options);
  });
  await mount();
  await send("les infos");
  const read = speakSeries.mock.calls.map(([text]) => text).join(" ");
  expect(read).toContain("Météo à Lyon, France.");
  expect(read).toContain("18 degrés");
  expect(read).not.toContain("indisponibles");
});

test("without a bulletin, repeat and continue stay with the ongoing conversation", async () => {
  const chatBodies = mockBulletinBackend();
  await mount();
  await send("répète");
  await send("continue");
  expect(chatBodies).toEqual(["répète", "continue"]);
  expect(speakFr.mock.calls.some(([text]) => text.includes("pas de bulletin récent"))).toBe(false);
  await send("qui a fait quoi ?");
  expect(lastSpoken()).toContain("pas de bulletin récent");
  expect(newsFetches()).toBe(0);
});

test("unavailable news does not invent facts or call an ungrounded model", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/news/briefing")
    ? Promise.resolve({ ok: false, status: 503, json: async () => ({ detail: "Source indisponible" }) })
    : fallback(url, options));
  await mount();
  await send("les infos");
  expect(speakFr.mock.calls.at(-1)[0]).toContain("ne peuvent pas être vérifiées");
  expect(warn).toHaveBeenCalled();
  expect(global.fetch.mock.calls.some(([url]) => /\/chat(?:\/stream)?$/.test(String(url)))).toBe(false);
});

test("a topic-specific news request uses deep research instead of headlines", async () => {
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => {
    if (String(url).endsWith("/chat/stream")) return Promise.resolve({ ok: false });
    if (String(url).endsWith("/chat")) {
      return Promise.resolve({ ok: true, json: async () => ({ answer: "Analyse approfondie terminée." }) });
    }
    return fallback(url, options);
  });

  await mount();
  await send("les infos sur l'économie");

  const chatRequest = global.fetch.mock.calls.find(([url]) => String(url).endsWith("/chat"));
  expect(chatRequest).toBeDefined();
  expect(JSON.parse(chatRequest[1].body)).toEqual(expect.objectContaining({
    text: "Recherche approfondie sur les actualités récentes concernant l'économie.",
    mode: "profond",
  }));
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/news/headlines"))).toBe(false);
  expect(speakFr.mock.calls.some(([message]) => message.includes("Analyse approfondie terminée."))).toBe(true);
});

test("Display reads the complete work briefing before visual typing finishes", async () => {
  const longBriefing = `${"Un engagement de travail confirmé. ".repeat(100)}Fin du briefing.`;
  const fallback = global.fetch.getMockImplementation();
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/work-dossiers/briefing")
    ? Promise.resolve({ ok: true, json: async () => ({ kind: "work", read_only: true, briefing: longBriefing }) })
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
  global.fetch.mockImplementation((url, options) => String(url).endsWith("/work-dossiers/briefing")
    ? Promise.resolve({ ok: true, json: async () => ({ kind: "work", read_only: true, briefing: "Le point sur vos dossiers." }) })
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

test("Android conversation no longer consumes old read-aloud pill confirmations", async () => {
  jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  localStorage.setItem("sirius_android_stt", "native");
  const readAnswer = jest.fn(() => true);
  window.__siriusReadAloudAnswer = readAnswer;
  try {
    await mount();
    await act(async () => host.querySelector('[data-testid="sirius-top-mic-btn"]').click());
    await act(async () => nativeCalls[0].resolve("oui"));
    expect(readAnswer).not.toHaveBeenCalled();
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
  saveVoiceVocabulary("voice-test", { enabled: true, terms: ["Daniel Partel"] });
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
      expect(connectStreamingStt).toHaveBeenCalledWith(expect.objectContaining({ vocabulary: ["Daniel Partel"] }));
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

import { Capacitor } from "@capacitor/core";
import { speakCinematic, speakFr, speakAsCharacter, cancelSpeech } from "./voice";
import { speakNative, stopNativeSpeech } from "./nativeVoice";

jest.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: jest.fn(() => "android") },
}));
jest.mock("./nativeVoice", () => ({
  speakNative: jest.fn(),
  stopNativeSpeech: jest.fn(),
}));

const originalFetch = global.fetch;
const originalAudio = global.Audio;
let clock = Date.now();
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  Capacitor.getPlatform.mockReturnValue("android");
  localStorage.clear();
  clock += 600001;
  jest.spyOn(Date, "now").mockReturnValue(clock);
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
});

afterEach(() => {
  cancelSpeech();
  global.fetch = originalFetch;
  global.Audio = originalAudio;
  jest.restoreAllMocks();
});

test("Android narration requests Gemini and falls back explicitly when unconfigured", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
  const onstart = jest.fn();
  const onend = jest.fn();
  const fallback = new Promise((resolve) => speakNative.mockImplementationOnce(resolve));
  try {
    speakCinematic("Bonjour", { onstart, onend });
    await fallback;
    expect(speakNative).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      onstart: expect.any(Function), onend: expect.any(Function), rate: 1.05, pitch: 1,
    }));
    const callbacks = speakNative.mock.calls[0][1];
    callbacks.onstart();
    callbacks.onend();
    expect(onstart).toHaveBeenCalledTimes(1);
    expect(onend).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
      body: JSON.stringify({ text: "Bonjour" }), credentials: "include",
    }));
    cancelSpeech();
    expect(stopNativeSpeech).toHaveBeenCalled();
  } finally {
    global.fetch = originalFetch;
  }
});

test("Android answers and character voices share the native fallback", async () => {
  speakFr("Bonjour");
  await flush();
  expect(speakNative).toHaveBeenCalled();
  speakNative.mockClear();
  speakAsCharacter("Bonjour", { module: "ARGUS#" });
  await flush();
  expect(speakNative).toHaveBeenCalled();
});

test("Gemini WAV plays once and ends once without native fallback", async () => {
  const audio = { play: jest.fn().mockResolvedValue(), pause: jest.fn() };
  global.Audio = jest.fn(() => audio);
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ audio_base64: "wav-data" }) });
  const onstart = jest.fn();
  const onend = jest.fn();
  const onpending = jest.fn();
  speakFr("Bonjour", { onpending, onstart, onend });
  expect(onpending).toHaveBeenCalledTimes(1);
  await flush();
  expect(global.Audio).toHaveBeenCalledWith("data:audio/wav;base64,wav-data");
  audio.onplay();
  audio.onended();
  await flush();
  expect(onstart).toHaveBeenCalledTimes(1);
  expect(onend).toHaveBeenCalledTimes(1);
  expect(speakNative).not.toHaveBeenCalled();
});

test("cancellation aborts generation and rejects a late response", async () => {
  let complete;
  global.fetch.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  global.Audio = jest.fn();
  const onstart = jest.fn();
  speakFr("Bonjour", { onstart });
  const { signal } = global.fetch.mock.calls[0][1];
  cancelSpeech();
  expect(signal.aborted).toBe(true);
  complete({ ok: true, json: async () => ({ audio_base64: "stale" }) });
  await flush();
  expect(global.Audio).not.toHaveBeenCalled();
  expect(speakNative).not.toHaveBeenCalled();
  expect(onstart).not.toHaveBeenCalled();
});

test("replacing speech pauses existing audio immediately during generation", async () => {
  const audio = { play: jest.fn().mockResolvedValue(), pause: jest.fn() };
  global.Audio = jest.fn(() => audio);
  global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ audio_base64: "wav" }) });
  speakFr("Premiere phrase");
  await flush();
  global.fetch.mockImplementationOnce(() => new Promise(() => {}));
  speakFr("Deuxieme phrase");
  expect(audio.pause).toHaveBeenCalled();
  expect(audio.onended).toBeNull();
});

test("playback rejection reports degradation before native fallback", async () => {
  const audio = { play: jest.fn().mockRejectedValue(new Error("playback")), pause: jest.fn() };
  global.Audio = jest.fn(() => audio);
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ audio_base64: "wav" }) });
  const degraded = jest.fn();
  window.addEventListener("sirius-voice-degraded", degraded);
  try {
    speakFr("Bonjour");
    await flush();
    expect(degraded).toHaveBeenCalledTimes(1);
    expect(speakNative).toHaveBeenCalled();
  } finally {
    window.removeEventListener("sirius-voice-degraded", degraded);
  }
});

test("the web keeps its browser synthesis instead of calling the native plugin", () => {
  Capacitor.getPlatform.mockReturnValue("web");
  const previous = window.speechSynthesis;
  const previousUtterance = window.SpeechSynthesisUtterance;
  window.speechSynthesis = {
    cancel: jest.fn(), resume: jest.fn(),
    getVoices: () => [{ lang: "fr-FR", name: "Amelie" }],
    speak: jest.fn(),
  };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  try {
    speakFr("Bonjour");
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
    expect(speakNative).not.toHaveBeenCalled();
    expect(stopNativeSpeech).not.toHaveBeenCalled();
  } finally {
    window.speechSynthesis = previous;
    window.SpeechSynthesisUtterance = previousUtterance;
  }
});

test("canceling before browser voices load prevents delayed speech and stale callbacks", () => {
  jest.useFakeTimers();
  Capacitor.getPlatform.mockReturnValue("web");
  const previous = window.speechSynthesis;
  const previousUtterance = window.SpeechSynthesisUtterance;
  const synth = { cancel: jest.fn(), resume: jest.fn(), getVoices: () => [], speak: jest.fn() };
  window.speechSynthesis = synth;
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  const start = jest.fn();
  const end = jest.fn();
  try {
    speakFr("Ancienne réponse", { onstart: start, onend: end });
    cancelSpeech();
    jest.advanceTimersByTime(200);
    expect(synth.speak).not.toHaveBeenCalled();
    synth.getVoices = () => [{ lang: "fr-FR", name: "Amelie" }];
    speakFr("Nouvelle réponse", { onstart: start, onend: end });
    const utterance = synth.speak.mock.calls[0][0];
    cancelSpeech();
    utterance.onstart();
    utterance.onend();
    expect(start).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  } finally {
    window.speechSynthesis = previous;
    window.SpeechSynthesisUtterance = previousUtterance;
    jest.useRealTimers();
  }
});

test("voice phases reflect playback events, not just the response being requested", async () => {
  const audio = { play: jest.fn().mockResolvedValue(), pause: jest.fn() };
  global.Audio = jest.fn(() => audio);
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ audio_base64: "wav" }) });
  const phases = [];
  const listener = (event) => phases.push(event.detail);
  window.addEventListener("sirius-voice-phase", listener);
  try {
    speakFr("Bonjour");
    await flush();
    expect(phases).toEqual(["preparing"]);
    audio.onplay();
    expect(phases).toEqual(["preparing", "speaking"]);
    audio.onended();
    expect(phases).toEqual(["preparing", "speaking", "idle"]);
  } finally {
    window.removeEventListener("sirius-voice-phase", listener);
  }
});

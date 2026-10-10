import { Capacitor } from "@capacitor/core";
import { speakCinematic, speakFr, speakAsCharacter, cancelSpeech, cleanTextForDisplay } from "./voice";
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
      body: JSON.stringify({ text: "Bonjour", keys: {} }), credentials: "include",
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

test("Android reads the assistant name without pronouncing the Greek sigma", async () => {
  speakFr("ΣIRIUS a ouvert Panthéon.");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
    body: JSON.stringify({ text: "Siriusse a ouvert Panthéon.", keys: {} }),
  }));
});

test.each(["ton ΣIRIUS Display", "ton Sirius Display", "ton Zirius Display", "le ΣIRIUS DISPLAY", "le Sirius Display", "le Zirius Display"])(
  "Sirius refers to %s as its own screen without changing other possessives",
  async (screen) => {
    speakFr(`J'affiche ton briefing dans ${screen}.`);
    await flush();
    const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
    const text = JSON.parse(request[1].body).text;
    expect(text).toContain("ton briefing");
    expect(text).toContain("dans mon Ziriusse displé");
    expect(text).not.toMatch(/dans ton /);
  }
);

test("Android Gemini TTS receives French letter names for HUD", async () => {
  speakFr("Le HUD est prêt.");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
    body: JSON.stringify({ text: "Le ache u dé est prêt.", keys: {} }),
  }));
});

test("joins French elisions separated by stray spaces before speech synthesis", async () => {
  speakFr("Je l 'ai déjà fait et c ’ est prêt.");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
    body: JSON.stringify({ text: "Je l'ai déjà fait et c'est prêt.", keys: {} }),
  }));
});

test.each(["l 'effet", "l ’ effet", "l ‘effet", "l ʼ effet", "l\u00a0’\u00a0effet", "l' effet"])(
  "keeps %s as one elision in the text sent to TTS",
  async (elision) => {
    speakFr(`Voici ${elision} attendu.`);
    await flush();
    const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
    expect(JSON.parse(request[1].body).text).toBe("Voici l'effet attendu.");
  }
);

test("joins an elision before a silent h without changing a named letter", async () => {
  speakFr("L ’ histoire de la lettre L.");
  await flush();
  const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
  expect(JSON.parse(request[1].body).text).toBe("l'histoire de la lettre L.");
});

test("planning and an uppercase elision remain words on remote and native speech paths", async () => {
  speakFr("Voici le PLANNING. L ’ effet est visible dans le ΣIRIUS DISPLAY.");
  await flush();
  const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
  const expected = "Voici le planingue. l'effet est visible dans mon Ziriusse displé.";
  expect(JSON.parse(request[1].body).text).toBe(expected);
  expect(speakNative.mock.calls[0][0]).toBe(expected);
});

test.each([
  ["2026-11-14", "14 novembre 2026"],
  ["2026-11-01", "premier novembre 2026"],
  ["2028-02-29", "29 février 2028"],
])("reads %s as a French date, preserving numeric ranges", async (date, spoken) => {
  speakFr(`Le ${date}, prévoir 10-15 minutes.`);
  await flush();
  const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
  const expected = `Le ${spoken}, prévoir 10 à 15 minutes.`;
  expect(JSON.parse(request[1].body).text).toBe(expected);
  expect(speakNative.mock.calls[0][0]).toBe(expected);
});

test.each(["answer", "character", "presentation"])("%s speech keeps Plutos and invisible elisions pronounceable", async (kind) => {
  const text = "PLUTOS explique l\u200b’\u200beffet et l＇ histoire.";
  if (kind === "character") speakAsCharacter(text, { module: "PLUTOS" });
  else if (kind === "presentation") speakCinematic(text);
  else speakFr(text);
  await flush();
  const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
  expect(JSON.parse(request[1].body).text).toBe("Ploutoss explique l'effet et l'histoire.");
  expect(speakNative.mock.calls[0][0]).toBe("Ploutoss explique l'effet et l'histoire.");
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
    speakFr("Vos e-mails sont prêts.");
    expect(window.speechSynthesis.speak).toHaveBeenCalled();
    expect(window.speechSynthesis.speak.mock.calls[0][0].text).toBe("Vos courriels sont prêts.");
    expect(cleanTextForDisplay("Vos e-mails sont prêts.")).toBe("Vos e-mails sont prêts.");
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

import { Capacitor } from "@capacitor/core";
import {
  AEDES_VOICE, speakCinematic, speakFr, speakAsCharacter, cancelSpeech, cleanTextForDisplay,
  speakSequence, speakSeries, GEMINI_TTS_TIMEOUT_MS, SEQUENCE_START_TIMEOUT_MS, SERIES_START_GUARD_MS,
} from "./voice";
import { speakNative, stopNativeSpeech } from "./nativeVoice";
import { KEY_STORAGE_EVENT } from "./apiKeyStorage";
import { hasNativeRemoteVoice, playNativeRemoteVoice, stopNativeRemoteVoice } from "./nativeRemoteVoice";

jest.mock("./nativeRemoteVoice", () => ({
  hasNativeRemoteVoice: jest.fn(() => false),
  playNativeRemoteVoice: jest.fn(),
  stopNativeRemoteVoice: jest.fn(),
}));

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
  // Requête puis lecture distantes partagées : quelques micro-tâches de plus avant le secours local.
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};

beforeEach(() => {
  jest.clearAllMocks();
  Capacitor.getPlatform.mockReturnValue("android");
  hasNativeRemoteVoice.mockReturnValue(false);
  localStorage.clear();
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "fr-FR-Neural2-G", rate: 1, pitch: -3 }));
  clock += 600001;
  jest.spyOn(Date, "now").mockReturnValue(clock);
  global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });
});

test("Android transfers the whole bulletin to native playback without WebView audio or watchdogs", async () => {
  hasNativeRemoteVoice.mockReturnValue(true);
  let callbacks;
  let finish;
  playNativeRemoteVoice.mockImplementationOnce(options => {
    callbacks = options;
    return new Promise(resolve => { finish = resolve; });
  });
  const onitemstart = jest.fn();
  const onitemend = jest.fn();
  const sequence = speakSequence(["Premier titre.", "Deuxième titre."], { onitemstart, onitemend });
  expect(callbacks.endpoint).toEqual(expect.stringContaining("/api/tts/gemini"));
  expect(callbacks.items).toEqual([
    expect.objectContaining({ body: expect.objectContaining({ text: "Premier titre." }) }),
    expect.objectContaining({ body: expect.objectContaining({ text: "Deuxième titre." }) }),
  ]);
  callbacks.onitemstart(0);
  callbacks.onitemend(0);
  callbacks.onitemstart(1);
  expect(onitemend.mock.calls).toEqual([[0]]);
  callbacks.onitemend(1);
  finish();
  await sequence.done;
  expect(onitemstart.mock.calls).toEqual([[0], [1]]);
  expect(onitemend.mock.calls).toEqual([[0], [1]]);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(speakNative).not.toHaveBeenCalled();
});

test("a native bulletin failure stops explicitly without changing to the local voice", async () => {
  hasNativeRemoteVoice.mockReturnValue(true);
  playNativeRemoteVoice.mockRejectedValueOnce(Object.assign(new Error("Lecture bloquée"), {
    code: "playback-timeout", index: 1,
  }));
  const onitemend = jest.fn();
  const sequence = speakSequence(["Premier titre.", "Deuxième titre."], { onitemend });
  await expect(sequence.done).rejects.toMatchObject({ code: "playback-timeout", index: 1 });
  expect(speakNative).not.toHaveBeenCalled();
  expect(onitemend).not.toHaveBeenCalled();
  expect(stopNativeRemoteVoice).toHaveBeenCalled();
});

test("the native bulletin ignores an old WebView cooldown and owns no browser playback timer", async () => {
  speakFr("Ancienne requête.");
  await flush();
  speakNative.mockClear();
  hasNativeRemoteVoice.mockReturnValue(true);
  let callbacks;
  playNativeRemoteVoice.mockImplementationOnce(options => {
    callbacks = options;
    return new Promise(() => {});
  });
  const onitemend = jest.fn();
  const timer = jest.spyOn(window, "setTimeout");
  const sequence = speakSequence(["Titre Gemini."], { onitemend });
  const rejected = expect(sequence.done).rejects.toMatchObject({ code: "cancelled" });
  expect(sequence.provider).toBe("remote");
  expect(timer).not.toHaveBeenCalled();
  sequence.cancel();
  callbacks.onitemend(0);
  await rejected;
  expect(onitemend).not.toHaveBeenCalled();
  expect(speakNative).not.toHaveBeenCalled();
});

afterEach(() => {
  cancelSpeech();
  global.fetch = originalFetch;
  global.Audio = originalAudio;
  jest.restoreAllMocks();
});

test("le profil AÈDES utilise un conteur français local sur Android sans requête distante", async () => {
  localStorage.setItem("sirius_voice", JSON.stringify(AEDES_VOICE));
  speakFr("Dis-moi l'histoire d'Odysseia.");
  await flush();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(speakNative).toHaveBeenCalledWith(expect.stringContaining("Dis-moi"),
    expect.objectContaining({ gender: "male", rate: expect.any(Number), pitch: expect.any(Number) }));
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
      onstart: expect.any(Function), onend: expect.any(Function), rate: 0.85, pitch: 0.95,
    }));
    const callbacks = speakNative.mock.calls[0][1];
    callbacks.onstart();
    callbacks.onend();
    expect(onstart).toHaveBeenCalledTimes(1);
    expect(onend).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
      body: JSON.stringify({ text: "Bonjour", keys: {}, voice: "Charon" }), credentials: "include",
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

test.each(["answer", "boot"])("desktop Gemini %s uses the same endpoint as Android", async kind => {
  Capacitor.getPlatform.mockReturnValue("web");
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "gemini", rate: 1, pitch: 0 }));
  if (kind === "boot") speakCinematic("Bonjour Daniel.");
  else speakFr("Bonjour Daniel.");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
    body: JSON.stringify({ text: "Bonjour Daniel.", keys: {}, voice: "Aoede" }),
  }));
  expect(global.fetch.mock.calls.some(([url]) => String(url).includes("/tts/google"))).toBe(false);
});

test("Android reads the assistant name without pronouncing the Greek sigma", async () => {
  speakFr("ΣIRIUS a ouvert Panthéon.");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
    body: JSON.stringify({ text: "Siriusse a ouvert pantéon.", keys: {}, voice: "Charon" }),
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
    expect(text).toContain("dans mon Siriusse displé");
    expect(text).not.toMatch(/dans ton /);
  }
);

test("Android Gemini TTS receives French letter names for HUD", async () => {
  speakFr("Le HUD est prêt.");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
    body: JSON.stringify({ text: "Le ache u dé est prêt.", keys: {}, voice: "Charon" }),
  }));
});

test("joins French elisions separated by stray spaces before speech synthesis", async () => {
  speakFr("Je l 'ai déjà fait et c ’ est prêt.");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/gemini"), expect.objectContaining({
    body: JSON.stringify({ text: "Je l'ai déjà fait et c'est prêt.", keys: {}, voice: "Charon" }),
  }));
});

test.each(["jusqu'à", "jusqu’à", "jusqu ’ à"])(
  "weather pronunciation %s reaches Gemini and the local fallback without a broken liaison", async (expression) => {
    speakFr(`Vent ${expression} 30 kilomètres heure.`);
    await flush();
    const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
    expect(JSON.parse(request[1].body).text).toBe("Vent juska 30 kilomètres heure.");
    expect(speakNative.mock.calls[0][0]).toBe("Vent juska 30 kilomètres heure.");
  },
);

test("the native bulletin receives the same jusqu'à pronunciation guide", async () => {
  hasNativeRemoteVoice.mockReturnValue(true);
  playNativeRemoteVoice.mockResolvedValueOnce();
  await speakSequence(["Vent jusqu’à 30 kilomètres heure."]).done;
  expect(playNativeRemoteVoice).toHaveBeenCalledWith(expect.objectContaining({
    items: [expect.objectContaining({ body: expect.objectContaining({ text: "Vent juska 30 kilomètres heure." }) })],
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

test.each(["L'oiseau", "L ’ oiseau", "l\u200b’\u200boiseau"])(
  "keeps %s attached on remote and native speech paths", async (text) => {
    speakFr(`${text} chante. La lettre L.`);
    await flush();
    const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
    expect(JSON.parse(request[1].body).text).toBe("l'oiseau chante. La lettre L.");
    expect(speakNative.mock.calls[0][0]).toBe("l'oiseau chante. La lettre L.");
  },
);

test("planning and an uppercase elision remain words on remote and native speech paths", async () => {
  speakFr("Voici le PLANNING. L ’ effet est visible dans le ΣIRIUS DISPLAY.");
  await flush();
  const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
  const expected = "Voici le planigne. l'effet est visible dans mon Siriusse displé.";
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

test.each(["answer", "character", "presentation"])("%s speech removes decorative signs and narrates units", async (kind) => {
  const text = "★ Actualités • France → Sport ✅. Budget : 12 € ; progression : 50 %.";
  if (kind === "character") speakAsCharacter(text, { module: "ARGUS" });
  else if (kind === "presentation") speakCinematic(text);
  else speakFr(text);
  await flush();
  const request = global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"));
  const spoken = JSON.parse(request[1].body).text;
  expect(spoken).not.toMatch(/[★•→✅€%]/u);
  expect(spoken).toContain("12 euros");
  expect(spoken).toContain("50 pour cent");
  expect(cleanTextForDisplay(text)).toContain("★");
});

test.each(["android", "web"])("%s Gemini WAV plays once and ends once without native fallback", async platform => {
  Capacitor.getPlatform.mockReturnValue(platform);
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "gemini", rate: 1, pitch: 0 }));
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

test("desktop Google and character profiles remain distinct from Gemini", async () => {
  Capacitor.getPlatform.mockReturnValue("web");
  speakFr("Bonjour");
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/google"), expect.any(Object));
  global.fetch.mockClear();
  window.dispatchEvent(new Event(KEY_STORAGE_EVENT));
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "gemini", rate: 1, pitch: 0 }));
  speakAsCharacter("Bonjour", { module: "ARGUS#" });
  await flush();
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/tts/google"), expect.objectContaining({
    body: expect.stringContaining('"voice":"fr-FR-Neural2-G"'),
  }));
});

test("boot narration reports real audio progress only during current playback", async () => {
  const audio = {
    play: jest.fn().mockResolvedValue(), pause: jest.fn(), duration: 8, currentTime: 2,
  };
  global.Audio = jest.fn(() => audio);
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ audio_base64: "wav-data" }) });
  const onprogress = jest.fn();
  speakCinematic("Je suis ΣIRIUS. Je suis prêt à vous accompagner.", { onprogress });
  await flush();
  expect(JSON.parse(global.fetch.mock.calls[0][1].body).text).toContain("Je suis Siriusse.");
  audio.ontimeupdate();
  expect(onprogress).not.toHaveBeenCalled();
  audio.onplay();
  expect(onprogress).toHaveBeenLastCalledWith(0);
  audio.ontimeupdate();
  expect(onprogress).toHaveBeenLastCalledWith(0.25);
  const staleProgress = audio.ontimeupdate;
  cancelSpeech();
  staleProgress();
  expect(onprogress).toHaveBeenCalledTimes(2);
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
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser-female", rate: 1, pitch: 1.08 }));
  const previous = window.speechSynthesis;
  const previousUtterance = window.SpeechSynthesisUtterance;
  window.speechSynthesis = {
    cancel: jest.fn(), resume: jest.fn(),
    getVoices: () => [{ lang: "fr-FR", name: "Amelie", localService: true }],
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

test.each(["web", "android"])("%s local configuration preserves French text and preferences", async (platform) => {
  Capacitor.getPlatform.mockReturnValue(platform);
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser", rate: 0.9, pitch: 0.85 }));
  const previous = window.speechSynthesis;
  const previousUtterance = window.SpeechSynthesisUtterance;
  window.speechSynthesis = {
    cancel: jest.fn(), resume: jest.fn(), speak: jest.fn(),
    getVoices: () => [{ lang: "fr-FR", name: "French female", localService: true }, { lang: "fr-FR", name: "Paul", localService: true }],
  };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  try {
    speakFr("Dis\u2011moi l\u200b’\u200beffet. Dis moi la suite.");
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
    if (platform === "android") {
      expect(speakNative).toHaveBeenCalledWith("Dis-moi l'effet. Dis moi la suite.", expect.objectContaining({
        gender: "male", pitch: expect.any(Number), rate: expect.any(Number),
      }));
      expect(speakNative.mock.calls[0][1].pitch).toBeLessThanOrEqual(0.85);
    } else {
      const utterance = window.speechSynthesis.speak.mock.calls[0][0];
      expect(utterance.text).toBe("Dis-moi l'effet. Dis moi la suite.");
      expect(utterance.voice.name).toBe("Paul");
      expect(utterance.lang).toBe("fr-FR");
    }
  } finally {
    window.speechSynthesis = previous;
    window.SpeechSynthesisUtterance = previousUtterance;
  }
});

test("Android local narration and characters bypass remote TTS and keep their profiles", () => {
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser-female" }));
  localStorage.setItem("sirius_char_voices", JSON.stringify({ "ARGUS#": { rate: 0.8, gPitch: -3 } }));
  speakCinematic("Dis-moi la suite.");
  expect(speakNative).toHaveBeenLastCalledWith("Dis-moi la suite.", expect.objectContaining({ rate: 0.85, pitch: 0.95 }));
  speakAsCharacter("Dis moi la suite.", { module: "ARGUS#" });
  expect(speakNative).toHaveBeenLastCalledWith("Dis moi la suite.", expect.objectContaining({ rate: 0.8, pitch: 0.8, gender: "male" }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test("natural boot narration slightly increases local pace without artificially lowering pitch", () => {
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser-female" }));
  speakCinematic("Initialisation de votre espace. Bonjour.", { natural: true });
  expect(speakNative).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
    rate: 0.96, pitch: 1, gender: "female",
  }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test("natural Android boot audio is six percent faster while preserving pitch", async () => {
  const previousAudio = global.Audio;
  const audio = { play: jest.fn().mockResolvedValue(), pause: jest.fn() };
  global.Audio = jest.fn(() => audio);
  global.fetch.mockResolvedValue({ ok: true, json: async () => ({ audio_base64: "wav-data" }) });
  try {
    speakCinematic("Initialisation de votre espace. Bonjour.", { natural: true });
    await flush();
    expect(audio.playbackRate).toBe(1.06);
    expect(audio.preservesPitch).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(1);
  } finally {
    cancelSpeech();
    global.Audio = previousAudio;
  }
});

test.each(["web", "android"])("%s pronounces time zones without spelling their letters", async (platform) => {
  Capacitor.getPlatform.mockReturnValue(platform);
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser" }));
  const previous = window.speechSynthesis;
  const previousUtterance = window.SpeechSynthesisUtterance;
  window.speechSynthesis = {
    cancel: jest.fn(), resume: jest.fn(), speak: jest.fn(),
    getVoices: () => [{ lang: "fr-FR", name: "Paul", localService: true }],
  };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  const original = "Début 20:45 (CET), 21:00 (CEST), cet horaire et cette rencontre.";
  try {
    speakFr(original);
    await flush();
    const spoken = platform === "android"
      ? speakNative.mock.calls[0][0]
      : window.speechSynthesis.speak.mock.calls[0][0].text;
    expect(spoken).toContain("20:45 heure d'Europe centrale");
    expect(spoken).toContain("21:00 heure d'été d'Europe centrale");
    expect(spoken).toContain("cet horaire et cette rencontre");
    expect(spoken).not.toMatch(/\bCEST?\b/);
    expect(cleanTextForDisplay(original)).toBe(original);
  } finally {
    window.speechSynthesis = previous;
    window.SpeechSynthesisUtterance = previousUtterance;
  }
});

test("sports opponents are spoken with contre, without changing VS Code or the Display", async () => {
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser" }));
  const text = "Knicks vs Raptors. Ruud versus Jodar. A VS. B. VS Code.";
  speakFr(text);
  await flush();
  expect(speakNative).toHaveBeenCalledWith(
    "Knicks contre Raptors. Ruud contre Jodar. A contre B. VS Code.",
    expect.any(Object),
  );
  expect(cleanTextForDisplay(text)).toBe(text);
});

test("browser waits for French voices, uses their language, and bounds discovery", () => {
  jest.useFakeTimers();
  Capacitor.getPlatform.mockReturnValue("web");
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser-female" }));
  const previous = window.speechSynthesis;
  const previousUtterance = window.SpeechSynthesisUtterance;
  const synth = new EventTarget();
  let voices = [{ lang: "en-US", name: "English" }];
  Object.assign(synth, { cancel: jest.fn(), resume: jest.fn(), speak: jest.fn(), getVoices: () => voices });
  window.speechSynthesis = synth;
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  const ended = jest.fn();
  const error = jest.fn();
  window.addEventListener("sirius-voice-error", error);
  try {
    speakFr("Dis-moi.", { onend: ended });
    expect(synth.speak).not.toHaveBeenCalled();
    voices.push({ lang: "fr-CA", name: "Julie", localService: true });
    synth.dispatchEvent(new Event("voiceschanged"));
    expect(synth.speak.mock.calls[0][0].lang).toBe("fr-CA");
    cancelSpeech();
    synth.speak.mockClear();
    voices = [{ lang: "en-US", name: "English" }, { lang: "fr-FR", name: "French network", localService: false }];
    speakFr("Bonjour.", { onend: ended });
    jest.advanceTimersByTime(1500);
    expect(synth.speak).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
    synth.dispatchEvent(new Event("voiceschanged"));
    expect(ended).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("sirius-voice-error", error);
    window.speechSynthesis = previous;
    window.SpeechSynthesisUtterance = previousUtterance;
    jest.useRealTimers();
  }
});

test("canceling before browser voices load prevents delayed speech and stale callbacks", () => {
  jest.useFakeTimers();
  Capacitor.getPlatform.mockReturnValue("web");
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser-female", rate: 1, pitch: 1.08 }));
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
    synth.getVoices = () => [{ lang: "fr-FR", name: "Amelie", localService: true }];
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

test.each(["web", "android", "remote"])("%s cancellation publishes idle and ignores stale completion", async (path) => {
  Capacitor.getPlatform.mockReturnValue(path === "remote" ? "android" : path);
  if (path !== "remote") localStorage.setItem("sirius_voice", JSON.stringify({ name: "browser-female", rate: 1, pitch: 1.08 }));
  const previous = window.speechSynthesis;
  const previousUtterance = window.SpeechSynthesisUtterance;
  const audio = { play: jest.fn().mockResolvedValue(), pause: jest.fn() };
  global.Audio = jest.fn(() => audio);
  if (path === "remote") global.fetch.mockResolvedValue({ ok: true, json: async () => ({ audio_base64: "wav" }) });
  window.speechSynthesis = {
    cancel: jest.fn(), resume: jest.fn(), speak: jest.fn(),
    getVoices: () => [{ lang: "fr-FR", name: "Amelie", localService: true }],
  };
  window.SpeechSynthesisUtterance = function (text) { this.text = text; };
  const phases = [];
  const listener = (event) => phases.push(event.detail);
  const ended = jest.fn();
  window.addEventListener("sirius-voice-phase", listener);
  try {
    speakFr("Bonjour.", { onend: ended });
    await flush();
    const callbacks = path === "web" ? window.speechSynthesis.speak.mock.calls[0][0]
      : path === "android" ? speakNative.mock.calls[0][1] : { onstart: audio.onplay, onend: audio.onended };
    callbacks.onstart();
    cancelSpeech();
    callbacks.onend();
    if (path === "web") callbacks.onerror();
    await flush();
    expect(phases).toEqual(["preparing", "speaking", "idle"]);
    expect(ended).not.toHaveBeenCalled();
    if (path === "remote") expect(audio.pause).toHaveBeenCalled();
    if (path === "android") expect(stopNativeSpeech).toHaveBeenCalled();
  } finally {
    window.removeEventListener("sirius-voice-phase", listener);
    window.speechSynthesis = previous;
    window.SpeechSynthesisUtterance = previousUtterance;
  }
});

const geminiBody = () => JSON.parse(global.fetch.mock.calls.find(([url]) => String(url).includes("/tts/gemini"))[1].body);

test.each([
  [{ name: "fr-FR-Neural2-G", rate: 1, pitch: -3 }, "Charon"],
  [{ name: "fr-FR-Neural2-F", rate: 1, pitch: 2 }, "Aoede"],
  [{ name: "gemini", rate: 1, pitch: 0, geminiVoice: "Orus" }, "Orus"],
  [{ name: "gemini", rate: 1, pitch: 0, geminiVoice: "Kore" }, "Kore"],
])("Android envoie le timbre Gemini correspondant à la voix choisie %#", async (cfg, expected) => {
  localStorage.setItem("sirius_voice", JSON.stringify(cfg));
  speakFr("Bonjour.");
  await flush();
  expect(geminiBody().voice).toBe(expected);
});

test("un timbre Gemini mémorisé n'écrase pas une voix Google choisie ensuite", async () => {
  localStorage.setItem("sirius_voice", JSON.stringify({ name: "fr-FR-Neural2-F", rate: 1, pitch: 2, geminiVoice: "Charon" }));
  speakFr("Bonjour.");
  await flush();
  expect(geminiBody().voice).toBe("Aoede");
});

test("les personnages masculins gardent une voix masculine sur Android", async () => {
  speakAsCharacter("Bonjour.", { module: "ARGUS#" });
  await flush();
  expect(geminiBody().voice).toBe("Charon");
  global.fetch.mockClear();
  clock += 600001;
  Date.now.mockReturnValue(clock);
  speakAsCharacter("Bonjour.", { module: "ORACLE#" });
  await flush();
  expect(geminiBody().voice).toBe("Aoede");
});

describe("speakSequence (bulletin) sur réseau lent", () => {
  let requests;
  let audios;
  const settle = async () => { await flush(); await flush(); };
  const okAudio = (audio = "wav") => ({ ok: true, json: async () => ({ audio_base64: audio }) });
  const respond = async (index, response) => { requests[index].resolve(response); await settle(); };
  const nativeCall = (n) => speakNative.mock.calls[n][1];
  const run = (phrases, extra = {}) => {
    const events = [];
    const playback = speakSequence(phrases, {
      onitemstart: (i) => events.push(`start:${i}`),
      onitemend: (i) => events.push(`end:${i}`),
      onprovider: (provider, reason) => events.push(`provider:${provider}${reason ? `:${reason.code}` : ""}`),
      ...extra,
    });
    const outcome = playback.done.then(() => "ok", (error) => error);
    return { playback, events, outcome };
  };

  beforeEach(() => {
    jest.useFakeTimers("legacy");
    requests = [];
    audios = [];
    global.fetch = jest.fn((url, { signal, body }) => new Promise((resolve, reject) => {
      const request = { url, body: JSON.parse(body), signal, resolve, reject };
      requests.push(request);
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    global.Audio = jest.fn(() => {
      const audio = { pause: jest.fn() };
      audio.play = jest.fn(() => { Promise.resolve().then(() => audio.onplay?.()); return Promise.resolve(); });
      audios.push(audio);
      return audio;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("une synthèse lente juste sous 28 s reste distante, avec préchargement borné de la phrase suivante", async () => {
    const { playback, events, outcome } = run(["Première rubrique.", "Deuxième rubrique.", "Troisième rubrique."]);
    await settle();
    expect(requests).toHaveLength(1);
    jest.advanceTimersByTime(GEMINI_TTS_TIMEOUT_MS - 1000);
    await respond(0, okAudio("a0"));
    expect(events).toEqual(["provider:remote", "start:0"]);
    expect(requests).toHaveLength(2); // une seule requête d'avance
    await respond(1, okAudio("a1"));
    expect(requests).toHaveLength(2);
    audios[0].onended();
    await settle();
    expect(events).toEqual(["provider:remote", "start:0", "end:0", "start:1"]);
    expect(requests).toHaveLength(3);
    await respond(2, okAudio("a2"));
    audios[1].onended();
    await settle();
    audios[2].onended();
    await settle();
    expect(await outcome).toBe("ok");
    expect(events).toEqual(["provider:remote", "start:0", "end:0", "start:1", "end:1", "start:2", "end:2"]);
    expect(playback.provider).toBe("remote");
    expect(speakNative).not.toHaveBeenCalled();
  });

  test("le délai de 28 s bascule une seule fois sur la voix locale jusqu'à la fin, sans nouvel appel distant", async () => {
    const degraded = jest.fn();
    window.addEventListener("sirius-voice-degraded", degraded);
    try {
      const { playback, events, outcome } = run(["Un.", "Deux.", "Trois."]);
      await settle();
      jest.advanceTimersByTime(GEMINI_TTS_TIMEOUT_MS - 1);
      await settle();
      expect(speakNative).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await settle();
      expect(events).toEqual(["provider:remote", "provider:local:timeout"]);
      expect(playback.provider).toBe("local");
      for (let i = 0; i < 3; i += 1) {
        expect(speakNative).toHaveBeenCalledTimes(i + 1);
        nativeCall(i).onstart();
        nativeCall(i).onend();
        await settle();
      }
      expect(await outcome).toBe("ok");
      expect(requests).toHaveLength(1);
      expect(degraded).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.startsWith("end:"))).toEqual(["end:0", "end:1", "end:2"]);
    } finally {
      window.removeEventListener("sirius-voice-degraded", degraded);
    }
  });

  test.each([
    ["transport", (request) => request.reject(new TypeError("Failed to fetch"))],
    ["empty", (request) => request.resolve({ ok: true, json: async () => ({}) })],
    ["http", (request) => request.resolve({ ok: false, status: 502 })],
  ])("un échec %s bascule la série sur la voix locale sans réessayer", async (code, fail) => {
    const { events, outcome } = run(["Un.", "Deux."]);
    await settle();
    fail(requests[0]);
    await settle();
    expect(events).toEqual(["provider:remote", `provider:local:${code}`]);
    nativeCall(0).onstart(); nativeCall(0).onend(); await settle();
    nativeCall(1).onstart(); nativeCall(1).onend(); await settle();
    expect(await outcome).toBe("ok");
    expect(requests).toHaveLength(1);
  });

  test("l'échec de la voix locale de secours rejette sans marquer la phrase comme lue", async () => {
    const phases = [];
    const onPhase = (event) => phases.push(event.detail);
    window.addEventListener("sirius-voice-phase", onPhase);
    try {
      const { events, outcome } = run(["Un.", "Deux."]);
      await settle();
      requests[0].reject(new TypeError("Failed to fetch"));
      await settle();
      nativeCall(0).onerror(new Error("TTS natif"));
      nativeCall(0).onend();
      const error = await outcome;
      expect(error).toMatchObject({ name: "SpeechSequenceError", code: "local-error", index: 0 });
      expect(events.some((e) => e.startsWith("end:"))).toBe(false);
      expect(speakNative).toHaveBeenCalledTimes(1);
      expect(phases.at(-1)).toBe("idle");
    } finally {
      window.removeEventListener("sirius-voice-phase", onPhase);
    }
  });

  test("une voix locale qui se termine sans avoir parlé est une erreur, pas une fin", async () => {
    localStorage.setItem("sirius_voice", JSON.stringify(AEDES_VOICE));
    const { events, outcome } = run(["Un."]);
    await settle();
    expect(requests).toHaveLength(0);
    nativeCall(0).onend();
    expect(await outcome).toMatchObject({ code: "local-error", index: 0 });
    expect(events).toEqual(["provider:local"]);
  });

  test("une voix locale muette expire en erreur explicite, jamais en succès simulé après le garde", async () => {
    localStorage.setItem("sirius_voice", JSON.stringify(AEDES_VOICE));
    const { events, outcome } = run(["Un.", "Deux."]);
    await settle();
    jest.advanceTimersByTime(SEQUENCE_START_TIMEOUT_MS);
    expect(await outcome).toMatchObject({ code: "local-timeout", index: 0 });
    jest.advanceTimersByTime(SERIES_START_GUARD_MS);
    await settle();
    expect(events).toEqual(["provider:local"]);
    expect(speakNative).toHaveBeenCalledTimes(1);
  });

  test("une coupure en cours de lecture relit la même phrase en local, sans doublon de fin", async () => {
    const { events, outcome } = run(["Un.", "Deux."]);
    await settle();
    await respond(0, okAudio());
    expect(requests).toHaveLength(2);
    audios[0].onerror();
    await settle();
    expect(requests[1].signal.aborted).toBe(true);
    expect(events).toEqual(["provider:remote", "start:0", "provider:local:playback-cut"]);
    expect(speakNative.mock.calls[0][0]).toBe("Un.");
    nativeCall(0).onstart(); nativeCall(0).onend(); await settle();
    nativeCall(1).onstart(); nativeCall(1).onend(); await settle();
    expect(await outcome).toBe("ok");
    expect(events.filter((e) => e.startsWith("end:"))).toEqual(["end:0", "end:1"]);
    expect(global.Audio).toHaveBeenCalledTimes(1);
  });

  test("un audio distant qui ne démarre jamais bascule après le délai de démarrage", async () => {
    global.Audio = jest.fn(() => ({ pause: jest.fn(), play: jest.fn(() => Promise.resolve()) }));
    const { events, outcome } = run(["Un."]);
    await settle();
    await respond(0, okAudio());
    jest.advanceTimersByTime(SEQUENCE_START_TIMEOUT_MS);
    await settle();
    expect(events).toEqual(["provider:remote", "provider:local:start-timeout"]);
    nativeCall(0).onstart(); nativeCall(0).onend();
    expect(await outcome).toBe("ok");
  });

  test.each([
    ["cancelSpeech", () => cancelSpeech(), false],
    ["une nouvelle réponse", () => speakFr("Autre chose"), true],
  ])("%s pendant le préchargement coupe la lecture et ignore les réponses tardives", async (_, interrupt, replaced) => {
    const { events, outcome } = run(["Un.", "Deux."]);
    await settle();
    await respond(0, okAudio());
    const prefetch = requests[1];
    interrupt();
    const error = await outcome;
    expect(error).toMatchObject({ code: "cancelled", index: 0, replaced });
    expect(prefetch.signal.aborted).toBe(true);
    expect(audios[0].pause).toHaveBeenCalled();
    audios[0].onended?.();
    prefetch.resolve(okAudio());
    await settle();
    expect(events).toEqual(["provider:remote", "start:0"]);
    expect(global.Audio).toHaveBeenCalledTimes(1);
  });

  test("cancel() pendant une synthèse lente annule la requête sans bascule ni voix locale", async () => {
    const { playback, events, outcome } = run(["Un.", "Deux."]);
    await settle();
    playback.cancel();
    expect(await outcome).toMatchObject({ code: "cancelled" });
    expect(requests[0].signal.aborted).toBe(true);
    jest.advanceTimersByTime(GEMINI_TTS_TIMEOUT_MS);
    await settle();
    expect(events).toEqual(["provider:remote"]);
    expect(speakNative).not.toHaveBeenCalled();
    expect(global.Audio).not.toHaveBeenCalled();
  });

  test("relancer une série coupe l'ancienne : aucune ancienne phrase ne reprend", async () => {
    const first = run(["Ancien un.", "Ancien deux."]);
    await settle();
    const second = run(["Nouveau."]);
    expect(await first.outcome).toMatchObject({ code: "cancelled", replaced: true });
    expect(requests[0].signal.aborted).toBe(true);
    await settle();
    await respond(1, okAudio());
    audios[0].onended();
    await settle();
    expect(await second.outcome).toBe("ok");
    expect(first.events).toEqual(["provider:remote"]);
    expect(requests.map((r) => r.body.text)).toEqual(["Ancien un.", "Nouveau."]);
  });

  test("la série garde le timbre et le genre choisis, en distant comme en secours", async () => {
    speakFr("Référence");
    await settle();
    const reference = requests[0].body.voice;
    requests[0].reject(new TypeError("Failed to fetch"));
    await settle();
    const referenceGender = nativeCall(0).gender;
    const { outcome } = run(["Bulletin."]);
    await settle();
    expect(requests[1].body.voice).toBe(reference);
    requests[1].reject(new TypeError("Failed to fetch"));
    await settle();
    expect(nativeCall(1).gender).toBe(referenceGender);
    nativeCall(1).onstart(); nativeCall(1).onend();
    expect(await outcome).toBe("ok");
  });

  test("speakSeries conserve son contrat historique : résolution après le garde de 30 s", async () => {
    let resolved = false;
    speakSeries("Phrase du Display.").then(() => { resolved = true; });
    await settle();
    jest.advanceTimersByTime(SERIES_START_GUARD_MS);
    await settle();
    expect(resolved).toBe(true);
  });
});

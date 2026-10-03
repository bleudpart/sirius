import { speakNative, stopNativeSpeech } from "./nativeVoice";
import { TextToSpeech } from "@capacitor-community/text-to-speech";

jest.mock("@capacitor-community/text-to-speech", () => ({
  TextToSpeech: {
    getSupportedVoices: jest.fn(),
    speak: jest.fn(),
    stop: jest.fn(),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  TextToSpeech.stop.mockResolvedValue();
  TextToSpeech.getSupportedVoices.mockResolvedValue({ voices: [
    { lang: "en-US", localService: true },
    { lang: "fr-FR", localService: false },
    { lang: "fr-FR", localService: true },
  ] });
  TextToSpeech.speak.mockResolvedValue();
});

test("uses a local French voice and finishes callbacks", async () => {
  const onstart = jest.fn();
  const onend = jest.fn();
  await speakNative("Bonjour", { rate: 0.85, pitch: 0.72, onstart, onend });
  expect(TextToSpeech.speak).toHaveBeenCalledWith(expect.objectContaining({
    text: "Bonjour", lang: "fr-FR", voice: 2, rate: 0.85, pitch: 0.72,
  }));
  expect(onstart).toHaveBeenCalledTimes(1);
  expect(onend).toHaveBeenCalledTimes(1);
});

test("prefers French from France over the first Canadian voice", async () => {
  TextToSpeech.getSupportedVoices.mockResolvedValueOnce({ voices: [
    { lang: "fr-CA", localService: true },
    { lang: "fr-FR", localService: true },
  ] });
  await speakNative("Bonjour");
  expect(TextToSpeech.speak).toHaveBeenCalledWith(expect.objectContaining({ voice: 1, lang: "fr-FR" }));
});

test("cancellation during voice discovery cannot speak later", async () => {
  let resolve;
  TextToSpeech.getSupportedVoices.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const onstart = jest.fn();
  const onend = jest.fn();
  const pending = speakNative("Bonjour", { onstart, onend });
  await Promise.resolve();
  stopNativeSpeech();
  resolve({ voices: [{ lang: "fr-FR", localService: true }] });
  await pending;
  expect(TextToSpeech.speak).not.toHaveBeenCalled();
  expect(onstart).not.toHaveBeenCalled();
  expect(onend).not.toHaveBeenCalled();
});

test("missing local French voice is reported and ends the speaking state", async () => {
  TextToSpeech.getSupportedVoices.mockResolvedValueOnce({ voices: [] });
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const listener = jest.fn();
  window.addEventListener("sirius-voice-error", listener);
  const onend = jest.fn();
  try {
    await speakNative("Bonjour", { onend });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(TextToSpeech.speak).not.toHaveBeenCalled();
    expect(onend).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("sirius-voice-error", listener);
    error.mockRestore();
  }
});

test("stopping active speech calls the native engine and suppresses its late completion", async () => {
  let finish;
  let signalStart;
  const started = new Promise((resolve) => { signalStart = resolve; });
  TextToSpeech.speak.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const onend = jest.fn();
  const pending = speakNative("Bonjour", { onstart: signalStart, onend });
  await started;
  stopNativeSpeech();
  await Promise.resolve();
  expect(TextToSpeech.stop).toHaveBeenCalledTimes(1);
  finish();
  await pending;
  expect(onend).not.toHaveBeenCalled();
});

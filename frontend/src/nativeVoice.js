import { TextToSpeech } from "@capacitor-community/text-to-speech";

let session = 0;
let active = false;
let stopChain = Promise.resolve();

const reportError = (error) => {
  console.error("Synthèse vocale Android indisponible :", error);
  window.dispatchEvent(new CustomEvent("sirius-voice-error", {
    detail: "Voix Android indisponible. Vérifiez qu'une voix française est installée dans les paramètres de synthèse vocale du téléphone.",
  }));
};

export function stopNativeSpeech() {
  session += 1;
  if (!active) return;
  active = false;
  stopChain = stopChain.then(() => TextToSpeech.stop()).catch(reportError);
}

export async function speakNative(message, { rate = 1, pitch = 1, volume = 1, onstart, onend } = {}) {
  stopNativeSpeech();
  const current = session;
  try {
    await stopChain;
    if (current !== session) return;
    const { voices } = await TextToSpeech.getSupportedVoices();
    if (current !== session) return;
    let voice = voices.findIndex((item) => item.lang === "fr-FR" && item.localService);
    if (voice < 0) voice = voices.findIndex((item) => /^fr(?:-|$)/i.test(item.lang) && item.localService);
    if (voice < 0) throw new Error("Aucune voix française locale installée.");
    active = true;
    if (onstart) onstart();
    await TextToSpeech.speak({
      text: message,
      lang: voices[voice].lang,
      voice,
      rate: Math.max(0.5, Math.min(2, rate)),
      pitch: Math.max(0.5, Math.min(2, pitch)),
      volume: Math.max(0.2, Math.min(1, volume)),
      queueStrategy: 0,
    });
  } catch (error) {
    if (current === session) reportError(error);
  } finally {
    if (current === session) {
      active = false;
      if (onend) onend();
    }
  }
}

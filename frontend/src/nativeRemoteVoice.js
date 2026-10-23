import { Capacitor, registerPlugin } from "@capacitor/core";
import { getSessionToken } from "./lib/sessionToken";
import { loadVoiceEqualizer } from "./voiceEqualizer";

const Playback = registerPlugin("SiriusPlayback");
let generation = 0;
let active = null;
let stopChain = Promise.resolve();

export const hasNativeRemoteVoice = () => Capacitor.getPlatform() === "android"
  && Capacitor.isPluginAvailable("SiriusPlayback");

export function stopNativeRemoteVoice() {
  generation += 1;
  if (!active) return;
  const current = active;
  active = null;
  current.reject(Object.assign(new Error("Lecture interrompue."), { code: "cancelled" }));
  stopChain = stopChain.then(() => Playback.stop({ id: current.id })).catch((error) => {
    console.error("Arrêt de la lecture Android impossible :", error);
    window.dispatchEvent(new CustomEvent("sirius-voice-error", {
      detail: "Impossible de confirmer l'arrêt du lecteur Android. Utilisez Arrêter dans sa notification.",
    }));
    throw error;
  });
  // Garder le rejet pour empêcher une nouvelle lecture de masquer un arrêt échoué.
  stopChain.catch(() => {});
}

export async function playNativeRemoteVoice({ endpoint, items, onitemstart, onitemend }) {
  stopNativeRemoteVoice();
  const current = generation;
  const id = `voice-${current}`;
  let listener;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    rejectDone = reject;
    active = { id, reject };
    active.resolve = resolve;
  });
  done.catch(() => {});
  try {
    await stopChain;
    if (current !== generation) return await done;
    listener = await Playback.addListener("playback", (event) => {
      if (current !== generation || event.id !== id || active?.id !== id) return;
      if (event.phase === "started") onitemstart?.(event.index);
      else if (event.phase === "ended") onitemend?.(event.index);
      else if (event.phase === "finished") active.resolve();
      else if (event.phase === "cancelled" || event.phase === "error") {
        rejectDone(Object.assign(new Error(event.message || "Lecture Android interrompue."), {
          code: event.phase === "cancelled" ? "cancelled" : event.code,
          index: event.index,
        }));
      }
    });
    if (current !== generation) return await done;
    await Playback.start({
      id, endpoint, items, accessToken: getSessionToken(), equalizer: loadVoiceEqualizer(),
    });
    return await done;
  } finally {
    if (active?.id === id) active = null;
    if (listener) await listener.remove();
  }
}

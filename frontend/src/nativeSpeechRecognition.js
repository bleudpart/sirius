import { registerPlugin } from "@capacitor/core";
import { chooseBestVoiceTranscript } from "./voiceCorrections";

const speech = registerPlugin("SiriusSpeech");

export function createNativeRecognition(plugin = speech) {
  let current = null;
  let cancellation = Promise.resolve();
  let nextId = 0;

  const cancel = () => {
    if (!current) return cancellation;
    const previous = current;
    current = null;
    previous.controller.abort();
    cancellation = cancellation.then(() => plugin.cancel()).catch((error) => {
      console.warn("Annulation du microphone Android impossible :", error);
      throw error;
    });
    return cancellation;
  };

  return {
    get active() { return current !== null; },
    cancel,
    async finish() {
      if (current) await plugin.finish();
    },
    async listen({ signal, onEvent }) {
      await cancel();
      if (signal.aborted) throw new DOMException("Reconnaissance annulée.", "AbortError");
      const request = { id: String(++nextId), controller: new AbortController() };
      current = request;
      let listener;
      const abort = () => { void cancel().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const available = await plugin.available();
        if (signal.aborted || request.controller.signal.aborted) {
          throw new DOMException("Reconnaissance annulée.", "AbortError");
        }
        if (!available.available) {
          const error = new Error("Reconnaissance française locale indisponible.");
          error.code = "UNAVAILABLE";
          throw error;
        }
        listener = await plugin.addListener("recognition", (event) => {
          if (current === request && !signal.aborted && event.id === request.id) onEvent(event);
        });
        if (signal.aborted || request.controller.signal.aborted) {
          throw new DOMException("Reconnaissance annulée.", "AbortError");
        }
        const result = await plugin.start({ id: request.id });
        if (signal.aborted || request.controller.signal.aborted) {
          throw new DOMException("Reconnaissance annulée.", "AbortError");
        }
        return result.alternatives?.length
          ? chooseBestVoiceTranscript(result.alternatives) : result.text || "";
      } finally {
        signal.removeEventListener("abort", abort);
        if (current === request) current = null;
        if (listener) await listener.remove();
      }
    },
  };
}

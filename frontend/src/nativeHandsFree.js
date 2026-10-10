import { registerPlugin } from "@capacitor/core";
import { requestTranscription } from "./services/assistantApi";
import { isWhisperHallucination } from "./microphoneCapture";

const audio = registerPlugin("SiriusAudio");

export function createNativeHandsFree({
  plugin = audio, transcribe = requestTranscription, onState, onTranscript, groqKey = () => "",
}) {
  let session = null;
  let blocked = true;
  let stopping = Promise.resolve();

  const report = (phase, message = "") => onState({ phase, message });
  const stop = () => {
    const previous = session;
    session = null;
    if (previous) previous.controller.abort();
    stopping = stopping.catch((error) => console.error("Arrêt précédent du micro natif :", error)).then(async () => {
      try {
        await plugin.stop();
      } finally {
        if (previous) await Promise.all(previous.listeners.map((listener) => listener.remove()));
        if (!session) report("stopped");
      }
    });
    return stopping;
  };
  const fail = async (error) => {
    try { await stop(); } catch (stopError) { console.error("Arrêt capture native :", stopError); }
    report("error", error.message || "Capture native indisponible.");
  };
  const suppress = (current, value) => {
    if (current.requestedSuppression === value) return current.operations;
    current.requestedSuppression = value;
    current.operations = current.operations.then(async () => {
      if (session === current && !current.controller.signal.aborted) {
        await plugin.setSuppressed({ suppressed: value });
      }
    });
    return current.operations;
  };
  const receive = async (current, event) => {
    if (session !== current || blocked || current.processing || current.controller.signal.aborted) return;
    current.processing = true;
    report("transcribing");
    try {
      await suppress(current, true);
      if (session !== current) return;
      const binary = atob(event.audio);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "audio/wav" }), "sirius-native.wav");
      const key = groqKey();
      if (key) form.append("groq_key", key);
      const response = await transcribe(form, { signal: current.controller.signal });
      if (session !== current || current.controller.signal.aborted) return;
      if (!response.ok) throw new Error(response.data?.detail || "Transcription native impossible.");
      const raw = String(response.data?.text || response.data?.transcript || "").trim();
      const text = isWhisperHallucination(raw) ? "" : raw;
      if (text) {
        blocked = true;
        report("processing");
        onTranscript(text);
      } else {
        report("paused", "Aucune parole distinguée ; vous pouvez réessayer.");
      }
    } catch (error) {
      if (session === current && !current.controller.signal.aborted) await fail(error);
    } finally {
      current.processing = false;
      if (session === current && !blocked) {
        try { await suppress(current, false); } catch (error) { await fail(error); }
      }
    }
  };

  return {
    available: () => plugin.available(),
    deleteDiagnostics: () => plugin.deleteDiagnostics(),
    get active() { return session !== null; },
    stop,
    async setBlocked(value) {
      blocked = value;
      const current = session;
      if (!current || !current.started || current.processing) return;
      try { await suppress(current, value); } catch (error) { if (session === current) await fail(error); }
    },
    async start({ diagnosticCapture = false } = {}) {
      if (session) return;
      const current = { controller: new AbortController(), listeners: [], processing: false, operations: Promise.resolve(), requestedSuppression: null };
      session = current;
      report("opening");
      try {
        await stopping;
        if (session !== current) return;
        for (const [name, callback] of [
          ["state", (event) => {
            if (session !== current) return;
            if (event.phase === "error") { void fail(new Error(event.message || "Erreur du microphone natif.")); return; }
            if (event.phase === "stopped") { void stop().catch((error) => report("error", error.message)); return; }
            if (event.phase === "diagnostic-error") { report(event.phase, event.message); return; }
            if (!current.processing && !blocked && !event.suppressed) report(event.phase, event.message);
          }],
          ["utterance", (event) => { void receive(current, event); }],
        ]) {
          const listener = await plugin.addListener(name, callback);
          if (session !== current) { await listener.remove(); return; }
          current.listeners.push(listener);
        }
        await plugin.start({ diagnosticCapture });
        if (session !== current) return;
        current.started = true;
        await suppress(current, blocked);
        if (blocked) report("paused");
      } catch (error) {
        if (session === current) await fail(error);
      }
    },
  };
}

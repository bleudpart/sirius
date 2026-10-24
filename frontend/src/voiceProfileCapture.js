import { microphoneConstraints, requestMicrophoneStream } from "./microphoneCapture";
import { VOICE_SAMPLE_MAX_BYTES, VOICE_SAMPLE_MAX_SECONDS } from "./voiceProfileStore";

export async function recordVoiceSample({ platform, isCurrent, onReady, onError, onStart,
  mediaDevices = navigator.mediaDevices, Recorder = globalThis.MediaRecorder }) {
  if (!mediaDevices?.getUserMedia || !Recorder) throw new Error("Enregistrement local indisponible. Aucun extrait ne sera envoyé au serveur.");
  let stream;
  let recorder;
  let timer;
  let cancelled = false;
  let parts = [];
  let bytes = 0;
  const release = () => { clearTimeout(timer); stream?.getTracks().forEach((track) => track.stop()); };
  const cancel = () => {
    cancelled = true;
    parts = [];
    if (recorder?.state === "recording") recorder.stop();
    release();
  };
  try {
    stream = await requestMicrophoneStream(mediaDevices, isCurrent, microphoneConstraints(platform));
    if (!stream) return { cancel, stop: cancel };
    const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
      .find((type) => Recorder.isTypeSupported(type));
    recorder = new Recorder(stream, mimeType ? { mimeType } : undefined);
    let began;
    recorder.onstart = () => {
      if (cancelled || !isCurrent()) { cancel(); return; }
      began = Date.now();
      onStart?.();
      timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, VOICE_SAMPLE_MAX_SECONDS * 1000);
    };
    recorder.ondataavailable = (event) => {
      if (cancelled || !isCurrent() || !event.data.size) return;
      bytes += event.data.size;
      if (bytes > VOICE_SAMPLE_MAX_BYTES) {
        cancel();
        onError(new Error("Extrait trop volumineux (2 Mo maximum)."));
        return;
      }
      parts.push(event.data);
    };
    recorder.onerror = () => { cancel(); if (isCurrent()) onError(new Error("Enregistrement audio impossible.")); };
    recorder.onstop = () => {
      release();
      if (cancelled || !isCurrent()) return;
      const audio = new Blob(parts, { type: recorder.mimeType || mimeType || "audio/webm" });
      parts = [];
      if (!audio.size) { onError(new Error("Aucun son enregistré.")); return; }
      onReady({ audio, duration: Math.min(VOICE_SAMPLE_MAX_SECONDS, Math.max(0.001, (Date.now() - began) / 1000)) });
    };
    recorder.start(250);
    return { cancel, stop: () => { if (recorder.state === "recording") recorder.stop(); } };
  } catch (error) {
    release();
    throw error;
  }
}

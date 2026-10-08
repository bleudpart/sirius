export function useServerTranscription(platform) {
  return platform === "android";
}

// Sur Android (Samsung notamment), l'anti-écho et l'anti-bruit de la WebView basculent le
// micro en mode « communication » et peuvent livrer un flux totalement muet : Whisper
// invente alors du texte (« Sous-titrage… »). La capture brute reste fiable.
export function microphoneConstraints(platform) {
  return platform === "android"
    ? { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }
    : { audio: true };
}

export async function requestMicrophoneStream(mediaDevices, isCurrent, constraints = { audio: true }) {
  const stream = await mediaDevices.getUserMedia(constraints);
  if (!isCurrent()) {
    stream.getTracks().forEach((track) => track.stop());
    return null;
  }
  return stream;
}

// Whisper invente des phrases types quand l'audio est muet ou ne contient que du souffle.
const WHISPER_HALLUCINATION = /^(?:[\s.…,!?'-]*|.*sous[- ]titr.*|.*amara\.org.*|merci d'avoir regard[ée].*|abonnez[- ]vous.*|.*soustitreur.*)$/i;

export function isWhisperHallucination(text) {
  return WHISPER_HALLUCINATION.test(String(text || "").trim());
}

export function scheduleHandsFreeRetry(isReady, startListening) {
  return setTimeout(() => {
    if (isReady()) startListening();
  }, 250);
}

// Le seuil suit le bruit de fond : en capture brute, le souffle ambiant dépasse un seuil
// fixe et la phrase ne se terminerait jamais avant la limite de 15 secondes.
export function createSilenceDetector({ threshold = 0.02, silenceMs = 2000, minimumSpeechMs = 200, noiseRatio = 2.2 } = {}) {
  let speechMs = 0;
  let previousTime = null;
  let lastSound = null;
  let noiseFloor = null;
  let initialLevels = [];
  const detect = (samples, now) => {
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    const elapsed = previousTime === null ? 0 : Math.max(0, Math.min(100, now - previousTime));
    previousTime = now;
    if (noiseFloor === null || rms < noiseFloor) noiseFloor = rms;
    else noiseFloor += (rms - noiseFloor) * 0.005;
    const speechThreshold = Math.max(threshold, noiseFloor * noiseRatio);
    if (speechMs < minimumSpeechMs) {
      // La première mesure peut être de la parole : la réévaluer quand le bruit baisse.
      initialLevels.push({ rms, elapsed, now });
      if (initialLevels.length > 400) initialLevels.shift();
      const speechLevels = initialLevels.filter((level) => level.rms >= speechThreshold);
      speechMs = speechLevels.reduce((total, level) => total + level.elapsed, 0);
      lastSound = speechLevels.length ? speechLevels[speechLevels.length - 1].now : null;
      if (speechMs >= minimumSpeechMs) initialLevels = [];
    } else if (rms >= speechThreshold) {
      speechMs += elapsed;
      lastSound = now;
    }
    return speechMs >= minimumSpeechMs && lastSound !== null && now - lastSound >= silenceMs;
  };
  detect.heardSpeech = () => speechMs >= minimumSpeechMs;
  return detect;
}

export function stopRecorderAfterSilence(stream, recorder, AudioContextClass) {
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  void context.resume().catch((error) => console.warn("Analyse audio suspendue ; capture limitée à 15 secondes.", error));
  const samples = new Float32Array(analyser.fftSize);
  // 1,2 s de silence suffit à clore une commande vocale ; au-delà, chaque réponse attend d'autant.
  const detect = createSilenceDetector({ silenceMs: 1200 });
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    if (recorder.state === "recording" && detect(samples, performance.now())) recorder.stop();
  }, 50);
  const cleanup = () => {
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    void context.close().catch((error) => console.warn("Fermeture de l'analyse audio impossible.", error));
  };
  // Permet de ne pas envoyer (ni décompter du quota) une écoute mains libres restée muette.
  cleanup.heardSpeech = detect.heardSpeech;
  return cleanup;
}

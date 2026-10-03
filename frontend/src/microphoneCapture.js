export function useServerTranscription(platform) {
  return platform === "android";
}

export async function requestMicrophoneStream(mediaDevices, isCurrent) {
  const stream = await mediaDevices.getUserMedia({ audio: true });
  if (!isCurrent()) {
    stream.getTracks().forEach((track) => track.stop());
    return null;
  }
  return stream;
}

export function scheduleHandsFreeRetry(isReady, startListening) {
  return setTimeout(() => {
    if (isReady()) startListening();
  }, 600);
}

export function createSilenceDetector({ threshold = 0.02, silenceMs = 1000, minimumSpeechMs = 200 } = {}) {
  let speechMs = 0;
  let previousTime = null;
  let lastSound = null;
  return (samples, now) => {
    const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    const elapsed = previousTime === null ? 0 : Math.max(0, Math.min(100, now - previousTime));
    previousTime = now;
    if (rms >= threshold) {
      speechMs += elapsed;
      lastSound = now;
    }
    return speechMs >= minimumSpeechMs && lastSound !== null && now - lastSound >= silenceMs;
  };
}

export function stopRecorderAfterSilence(stream, recorder, AudioContextClass) {
  const context = new AudioContextClass();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  void context.resume().catch((error) => console.warn("Analyse audio suspendue ; capture limitée à 15 secondes.", error));
  const samples = new Float32Array(analyser.fftSize);
  const detect = createSilenceDetector();
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    if (recorder.state === "recording" && detect(samples, performance.now())) recorder.stop();
  }, 50);
  return () => {
    clearInterval(timer);
    source.disconnect();
    analyser.disconnect();
    void context.close().catch((error) => console.warn("Fermeture de l'analyse audio impossible.", error));
  };
}

import { createSilenceDetector, isWhisperHallucination, microphoneConstraints, requestMicrophoneStream, scheduleHandsFreeRetry, useServerTranscription } from "./microphoneCapture";

test("Android uses server transcription while browsers and iOS keep browser recognition", () => {
  expect(useServerTranscription("android")).toBe(true);
  expect(useServerTranscription("web")).toBe(false);
  expect(useServerTranscription("ios")).toBe(false);
});

test("a released or cancelled press stops a stream arriving after permission approval", async () => {
  let resolve;
  let current = true;
  const stop = jest.fn();
  const stream = { getTracks: () => [{ stop }] };
  const mediaDevices = { getUserMedia: jest.fn(() => new Promise((done) => { resolve = done; })) };
  const pending = requestMicrophoneStream(mediaDevices, () => current);
  current = false;
  resolve(stream);
  expect(await pending).toBeNull();
  expect(stop).toHaveBeenCalledTimes(1);
});

test("an active press keeps its stream and permission failures remain explicit", async () => {
  const stop = jest.fn();
  const stream = { getTracks: () => [{ stop }] };
  expect(await requestMicrophoneStream({ getUserMedia: async () => stream }, () => true)).toBe(stream);
  expect(stop).not.toHaveBeenCalled();
  const error = new Error("Microphone refused");
  await expect(requestMicrophoneStream({ getUserMedia: async () => { throw error; } }, () => true)).rejects.toBe(error);
});

test("hands-free capture stops after two seconds of silence, not before speech", () => {
  const detect = createSilenceDetector();
  const quiet = new Float32Array([0, 0]);
  const speech = new Float32Array([0.1, -0.1]);
  for (let now = 0; now <= 1000; now += 50) expect(detect(quiet, now)).toBe(false);
  for (let now = 1050; now <= 1300; now += 50) expect(detect(speech, now)).toBe(false);
  expect(detect(quiet, 3250)).toBe(false);
  expect(detect(quiet, 3300)).toBe(true);
});

test("a pause after Sirius keeps the recording open for the rest of the request", () => {
  const detect = createSilenceDetector();
  const quiet = new Float32Array([0, 0]);
  const speech = new Float32Array([0.1, -0.1]);
  detect(quiet, 0);
  for (let now = 50; now <= 350; now += 50) expect(detect(speech, now)).toBe(false);
  for (let now = 400; now <= 1850; now += 50) expect(detect(quiet, now)).toBe(false);
  for (let now = 1900; now <= 3500; now += 50) expect(detect(speech, now)).toBe(false);
  expect(detect(quiet, 5450)).toBe(false);
  expect(detect(quiet, 5500)).toBe(true);
});

test("a short click or a new spoken segment does not end a sentence", () => {
  const detect = createSilenceDetector();
  const quiet = new Float32Array([0, 0]);
  const speech = new Float32Array([0.1, -0.1]);
  detect(quiet, 0);
  detect(speech, 50);
  expect(detect(quiet, 1200)).toBe(false);
  for (let now = 1250; now <= 1500; now += 50) detect(speech, now);
  expect(detect(quiet, 2400)).toBe(false);
  detect(speech, 2450);
  expect(detect(quiet, 2500)).toBe(false);
});

test("Android captures raw audio because device voice processing can return a silent stream", () => {
  expect(microphoneConstraints("android")).toEqual({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  expect(microphoneConstraints("web")).toEqual({ audio: true });
});

test("the silence threshold follows background noise so raw capture still ends a sentence", () => {
  const detect = createSilenceDetector();
  const ambient = new Float32Array([0.034, -0.034]);
  const speech = new Float32Array([0.2, -0.2]);
  for (let now = 0; now <= 1000; now += 50) expect(detect(ambient, now)).toBe(false);
  for (let now = 1050; now <= 1500; now += 50) expect(detect(speech, now)).toBe(false);
  let stopped = false;
  for (let now = 1550; now <= 3600 && !stopped; now += 50) stopped = detect(ambient, now);
  expect(stopped).toBe(true);
});

test("a silent hands-free capture reports no speech so it is not sent to the server", () => {
  const detect = createSilenceDetector();
  const ambient = new Float32Array([0.034, -0.034]);
  for (let now = 0; now <= 15000; now += 50) detect(ambient, now);
  expect(detect.heardSpeech()).toBe(false);
  for (let now = 15050; now <= 15400; now += 50) detect(new Float32Array([0.2, -0.2]), now);
  expect(detect.heardSpeech()).toBe(true);
});

test("speech starting immediately is not mistaken for the background noise floor", () => {
  const detect = createSilenceDetector({ silenceMs: 1200 });
  const speech = new Float32Array([0.1, -0.1]);
  const quiet = new Float32Array([0.005, -0.005]);
  for (let now = 0; now <= 600; now += 50) detect(speech, now);
  detect(quiet, 650);
  expect(detect.heardSpeech()).toBe(true);
  expect(detect(quiet, 1750)).toBe(false);
  expect(detect(quiet, 1800)).toBe(true);
});

test("Whisper silence hallucinations are not treated as requests", () => {
  for (const text of ["...", "", "Sous-titrage ST' 501", "Sous-titres réalisés par la communauté d'Amara.org", "Merci d'avoir regardé cette vidéo !"]) {
    expect(isWhisperHallucination(text)).toBe(true);
  }
  expect(isWhisperHallucination("Sirius, ouvre Zeus Cortex")).toBe(false);
  expect(isWhisperHallucination("Sirius, quelle heure est-il ?")).toBe(false);
});

test("hands-free retries after an ignored capture and rechecks readiness at execution", () => {
  jest.useFakeTimers();
  try {
    let ready = true;
    const start = jest.fn();
    scheduleHandsFreeRetry(() => ready, start);
    jest.advanceTimersByTime(249);
    expect(start).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    scheduleHandsFreeRetry(() => ready, start);
    ready = false;
    jest.advanceTimersByTime(600);
    expect(start).toHaveBeenCalledTimes(1);
    ready = true;
    const timer = scheduleHandsFreeRetry(() => ready, start);
    clearTimeout(timer);
    jest.advanceTimersByTime(600);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

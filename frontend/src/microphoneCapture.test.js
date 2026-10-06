import { createSilenceDetector, requestMicrophoneStream, scheduleHandsFreeRetry, useServerTranscription } from "./microphoneCapture";

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

test("hands-free retries after an ignored capture and rechecks readiness at execution", () => {
  jest.useFakeTimers();
  try {
    let ready = true;
    const start = jest.fn();
    scheduleHandsFreeRetry(() => ready, start);
    jest.advanceTimersByTime(599);
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

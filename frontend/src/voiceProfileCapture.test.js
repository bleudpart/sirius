import { recordVoiceSample } from "./voiceProfileCapture";

class Recorder {
  static isTypeSupported = () => true;
  constructor() { this.state = "inactive"; this.mimeType = "audio/webm"; Recorder.last = this; }
  start() { this.state = "recording"; this.onstart?.(); }
  stop() {
    this.state = "inactive";
    this.ondataavailable({ data: new Blob(["audio"], { type: this.mimeType }) });
    this.onstop();
  }
}

test("explicit local capture yields preview only, stops tracks and respects duration bound", async () => {
  jest.useFakeTimers();
  const track = { stop: jest.fn() };
  const devices = { getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [track] }) };
  const ready = jest.fn();
  const started = jest.fn();
  try {
    await recordVoiceSample({ platform: "android", isCurrent: () => true, onReady: ready, onStart: started, onError: jest.fn(), mediaDevices: devices, Recorder });
    expect(started).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    expect(devices.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    jest.advanceTimersByTime(15000);
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.any(Blob), duration: 15 }));
    expect(track.stop).toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test("cancelled preview is never delivered and permission errors have no network fallback", async () => {
  const track = { stop: jest.fn() };
  const ready = jest.fn();
  const session = await recordVoiceSample({ platform: "web", isCurrent: () => true, onReady: ready, onError: jest.fn(),
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) }, Recorder });
  session.cancel();
  expect(ready).not.toHaveBeenCalled();
  expect(track.stop).toHaveBeenCalled();
  await expect(recordVoiceSample({ mediaDevices: { getUserMedia: async () => { throw new Error("denied"); } },
    Recorder, isCurrent: () => true })).rejects.toThrow("denied");
});

test("recording readiness and automatic stop follow the real recorder start event", async () => {
  jest.useFakeTimers();
  class DelayedRecorder extends Recorder {
    start() { this.state = "recording"; }
  }
  const ready = jest.fn();
  const started = jest.fn();
  const stop = jest.fn();
  try {
    await recordVoiceSample({ platform: "web", isCurrent: () => true, onReady: ready, onStart: started, onError: jest.fn(),
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) }, Recorder: DelayedRecorder });
    jest.advanceTimersByTime(5000);
    expect(started).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    Recorder.last.onstart();
    expect(started).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(14999);
    expect(ready).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(ready).toHaveBeenCalledWith(expect.objectContaining({ duration: 15 }));
    expect(stop).toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

test("permission resolving after closure stops tracks without starting recording", async () => {
  const stop = jest.fn();
  const ready = jest.fn();
  await recordVoiceSample({ isCurrent: () => false, onReady: ready, mediaDevices: {
    getUserMedia: async () => ({ getTracks: () => [{ stop }] }),
  }, Recorder });
  expect(stop).toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
});

test("oversized capture is discarded locally", async () => {
  const ready = jest.fn();
  const error = jest.fn();
  const stop = jest.fn();
  const session = await recordVoiceSample({ isCurrent: () => true, onReady: ready, onError: error,
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) }, Recorder });
  Recorder.last.ondataavailable({ data: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "audio/webm" }) });
  expect(error).toHaveBeenCalledWith(expect.any(Error));
  expect(ready).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalled();
  session.cancel();
});

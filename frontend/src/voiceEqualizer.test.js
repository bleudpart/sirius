import { connectVoiceEqualizer, loadVoiceEqualizer, saveVoiceEqualizer } from "./voiceEqualizer";

let graphs;
let resumes;
const param = () => ({ value: 0, setTargetAtTime: jest.fn() });
const node = () => ({ gain: param(), frequency: param(), Q: param(), connect: jest.fn(), disconnect: jest.fn() });
const originalContext = window.AudioContext;
beforeEach(() => {
  graphs = [];
  resumes = jest.fn().mockResolvedValue();
  window.AudioContext = jest.fn(() => ({
    currentTime: 0, destination: {}, resume: resumes,
    createMediaElementSource: () => { const source = node(); graphs.push(source); return source; },
    createGain: () => { const gain = node(); graphs.push(gain); return gain; },
    createBiquadFilter: () => { const filter = node(); graphs.push(filter); return filter; },
  }));
});
beforeEach(() => { localStorage.clear(); });
afterAll(() => { window.AudioContext = originalContext; });

test("persists bounded finite gains and restores a flat response", () => {
  expect(saveVoiceEqualizer({ bass: 99, mid: NaN, treble: -99 })).toEqual({ bass: 12, mid: 0, treble: -12 });
  expect(loadVoiceEqualizer()).toEqual({ bass: 12, mid: 0, treble: -12 });
  expect(saveVoiceEqualizer({ bass: 0, mid: 0, treble: 0 })).toEqual({ bass: 0, mid: 0, treble: 0 });
});

test("routes audio through three actual filters with headroom, live updates and cleanup", async () => {
  saveVoiceEqualizer({ bass: 6, mid: -3, treble: 2 });
  const disconnect = await connectVoiceEqualizer({});
  const [source, gain, bass, mid, treble] = graphs;
  expect(source.connect).toHaveBeenCalledWith(gain);
  expect(gain.connect).toHaveBeenCalledWith(bass);
  expect(bass.connect).toHaveBeenCalledWith(mid);
  expect(mid.connect).toHaveBeenCalledWith(treble);
  expect([bass.type, mid.type, treble.type]).toEqual(["lowshelf", "peaking", "highshelf"]);
  expect([bass.frequency.value, mid.frequency.value, treble.frequency.value]).toEqual([250, 1200, 4000]);
  expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(10 ** (-8 / 20), 0, 0.02);
  saveVoiceEqualizer({ bass: -4, mid: 0, treble: 0 });
  expect(bass.gain.setTargetAtTime).toHaveBeenLastCalledWith(-4, 0, 0.02);
  expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.02);
  disconnect();
  graphs.forEach(n => expect(n.disconnect).toHaveBeenCalledTimes(1));
});

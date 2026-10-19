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

const FLAT = { sub: 0, bass: 0, lowMid: 0, mid: 0, treble: 0, air: 0 };

test("persists bounded finite gains, keeps legacy settings and restores a flat response", () => {
  expect(saveVoiceEqualizer({ bass: 99, mid: NaN, treble: -99 })).toEqual({ ...FLAT, bass: 12, treble: -12 });
  expect(loadVoiceEqualizer()).toEqual({ ...FLAT, bass: 12, treble: -12 });
  expect(saveVoiceEqualizer(FLAT)).toEqual(FLAT);
});

test("routes audio through six actual filters with headroom, live updates and cleanup", async () => {
  saveVoiceEqualizer({ sub: 0, bass: 6, lowMid: 0, mid: -3, treble: 2, air: 4 });
  const disconnect = await connectVoiceEqualizer({});
  const [source, gain, ...filters] = graphs;
  expect(filters).toHaveLength(6);
  expect(source.connect).toHaveBeenCalledWith(gain);
  expect(gain.connect).toHaveBeenCalledWith(filters[0]);
  filters.slice(0, -1).forEach((filter, index) => expect(filter.connect).toHaveBeenCalledWith(filters[index + 1]));
  expect(filters[5].connect).toHaveBeenCalledWith(expect.any(Object));
  expect(filters.map(f => f.type)).toEqual(["lowshelf", "peaking", "peaking", "peaking", "peaking", "highshelf"]);
  expect(filters.map(f => f.frequency.value)).toEqual([80, 250, 500, 1200, 4000, 10000]);
  expect(filters[5].gain.setTargetAtTime).toHaveBeenLastCalledWith(4, 0, 0.02);
  expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(10 ** (-6 / 20), 0, 0.02);
  saveVoiceEqualizer({ ...FLAT, sub: 6, bass: 6 });
  expect(filters[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(6, 0, 0.02);
  expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(10 ** (-9 / 20), 0, 0.02);
  saveVoiceEqualizer({ ...FLAT, bass: -4 });
  expect(filters[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(-4, 0, 0.02);
  expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.02);
  disconnect();
  graphs.forEach(n => expect(n.disconnect).toHaveBeenCalledTimes(1));
});

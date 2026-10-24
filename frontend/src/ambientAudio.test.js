import { AmbientEngine } from "./ambientAudio";
import fs from "fs";
import path from "path";

let OriginalAudio;
let instances;
beforeEach(() => {
  OriginalAudio = global.Audio;
  instances = [];
  global.Audio = jest.fn().mockImplementation((src) => {
    const audio = { src, play: jest.fn().mockResolvedValue(), pause: jest.fn() };
    instances.push(audio);
    return audio;
  });
});
afterEach(() => { global.Audio = OriginalAudio; });

test("the default and saved epic preset use the Zirius theme in a loop", async () => {
  for (const engine of [new AmbientEngine(), new AmbientEngine("epique")]) {
    engine.volume = 0.2;
    await engine.play();
    const audio = instances[instances.length - 1];
    expect(audio.src).toBe("/audio/zirius-loop.wav?revision=2");
    expect(audio.loop).toBe(true);
    expect(audio.volume).toBe(0.2);
    engine.setMood("speaking");
    expect(audio.volume).toBe(0.12);
    engine.pause();
    expect(audio.pause).toHaveBeenCalled();
    await engine.play();
    expect(audio.play).toHaveBeenCalledTimes(2);
    engine.src = "";
    expect(audio.src).toBe("");
  }
  expect(global.Audio).toHaveBeenCalledTimes(2);
});

test("Gregorian ambience remains available without replacement", async () => {
  const engine = new AmbientEngine("gregorien");
  await engine.play();
  expect(instances[0].src).toBe("/audio/gregorien.mp3");
  expect(instances[0].loop).toBe(true);
});

test("the loop asset is stereo PCM with no silent window around its circular splice", () => {
  const wav = fs.readFileSync(path.join(process.cwd(), "public", "audio", "zirius-loop.wav"));
  let offset = 12;
  let pcm;
  while (offset + 8 <= wav.length) {
    const tag = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (tag === "fmt ") {
      expect(wav.readUInt16LE(offset + 8)).toBe(1);
      expect(wav.readUInt16LE(offset + 10)).toBe(2);
      expect(wav.readUInt32LE(offset + 12)).toBe(44100);
      expect(wav.readUInt16LE(offset + 22)).toBe(16);
    }
    if (tag === "data") pcm = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  const frames = pcm.length / 4;
  expect(frames).toBe(823200);
  expect(frames / 29400).toBe(28);
  expect((frames / 29400) % 4).toBe(0);
  const windowBytes = 441 * 4;
  for (const segment of [pcm.subarray(0, windowBytes), pcm.subarray(pcm.length - windowBytes)]) {
    let energy = 0;
    for (let i = 0; i < segment.length; i += 2) energy += (segment.readInt16LE(i) / 32768) ** 2;
    expect(Math.sqrt(energy / (segment.length / 2))).toBeGreaterThan(0.01);
  }
  for (let channel = 0; channel < 2; channel += 1) {
    const delta = Math.abs(pcm.readInt16LE(channel * 2) - pcm.readInt16LE(pcm.length - 4 + channel * 2));
    expect(delta / 32768).toBeLessThan(0.03);
  }
});

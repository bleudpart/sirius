import { AmbientEngine } from "./ambientAudio";

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
    expect(audio.src).toBe("/audio/ambiance.mp3?theme=zirius-1");
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

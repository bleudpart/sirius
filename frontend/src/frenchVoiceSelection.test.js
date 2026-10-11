import { selectFrenchVoice } from "./frenchVoiceSelection";

test("never selects a non-French voice", () => {
  expect(selectFrenchVoice([{ lang: "en-US" }, { lang: "af-ZA" }])).toBeNull();
});

test("prefers France, then gender, without treating female as male", () => {
  const voices = [
    { lang: "fr-CA", name: "Julie", localService: true },
    { lang: "fr-FR", name: "French female", localService: true },
    { lang: "fr-FR", name: "Paul", localService: true },
  ];
  expect(selectFrenchVoice(voices, { gender: "male" })).toBe(voices[2]);
  expect(selectFrenchVoice(voices)).toBe(voices[1]);
});

test("local Android selection excludes network voices and accepts French variants", () => {
  const voices = [{ lang: "fr-FR", localService: false }, { lang: "fr-CA", localService: true }];
  expect(selectFrenchVoice(voices, { localOnly: true })).toBe(voices[1]);
});

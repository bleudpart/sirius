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

test("Android Google voices without first names are matched by their code", () => {
  const voices = ["fr-fr-x-fra-local", "fr-fr-x-frb-local", "fr-fr-x-vlf-local", "fr-fr-x-frd-local"]
    .map((name) => ({ lang: "fr-FR", name, localService: true }));
  expect(selectFrenchVoice(voices, { localOnly: true, gender: "male" }).name).toBe("fr-fr-x-frb-local");
  expect(selectFrenchVoice(voices, { localOnly: true, gender: "female" }).name).toBe("fr-fr-x-fra-local");
});

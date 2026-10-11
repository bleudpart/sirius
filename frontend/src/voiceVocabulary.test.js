import { clearVoiceVocabulary, enabledVoiceVocabulary, readVoiceVocabulary, saveVoiceVocabulary, validateVoiceVocabulary } from "./voiceVocabulary";

beforeEach(() => localStorage.clear());

test("consent defaults off, is account scoped, and disabling removes hints immediately", () => {
  expect(enabledVoiceVocabulary({ user_id: "A" })).toEqual([]);
  saveVoiceVocabulary("A", { enabled: false, terms: ["Daniel Partel"] });
  expect(enabledVoiceVocabulary({ user_id: "A" })).toEqual([]);
  saveVoiceVocabulary("A", { enabled: true, terms: ["Daniel Partel"] });
  expect(enabledVoiceVocabulary({ user_id: "A" })).toEqual(["Daniel Partel"]);
  expect(enabledVoiceVocabulary({ user_id: "B" })).toEqual([]);
  saveVoiceVocabulary("A", { enabled: false, terms: ["Daniel Partel"] });
  expect(enabledVoiceVocabulary({ user_id: "A" })).toEqual([]);
  clearVoiceVocabulary("A");
  expect(readVoiceVocabulary("A")).toEqual({ enabled: false, terms: [] });
});

test("bounds and normalizes lexical terms without accepting prompt instructions", () => {
  expect(validateVoiceVocabulary([" cafe\u0301 ", "CAFÉ", "l’atelier"])).toEqual(["café", "l’atelier"]);
  for (const values of [["ignore: les règles"], ["mot\nmot"], ["x".repeat(81)], Array(33).fill("mot"), [new Blob(["audio"])]]) {
    expect(() => validateVoiceVocabulary(values)).toThrow();
  }
  expect(() => validateVoiceVocabulary(Array.from({ length: 21 }, (_, i) => `${i}${"x".repeat(78)}`))).toThrow();
});

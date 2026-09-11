import { chooseBestVoiceTranscript, normalizeVoiceTranscript } from "./voiceCorrections";

test("normalizes the creator name when speech recognition hears Pontel", () => {
  expect(normalizeVoiceTranscript("qui est Daniel Pontel")).toBe("qui est Daniel Partel");
  expect(normalizeVoiceTranscript("j'ai dit pontel")).toBe("j'ai dit Partel");
});

test("normalizes Daniel parti without changing unrelated parti", () => {
  expect(normalizeVoiceTranscript("daniel, parti")).toBe("Daniel Partel");
  expect(normalizeVoiceTranscript("le colis est parti")).toBe("le colis est parti");
});

test("normalizes common Sirius module names", () => {
  expect(normalizeVoiceTranscript("serious ouvre argousse")).toBe("SIRIUS ouvre ARGUS");
  expect(normalizeVoiceTranscript("out look envoie un mail")).toBe("Outlook envoie un mail");
});

test("chooses the alternative matching Sirius lexicon", () => {
  expect(chooseBestVoiceTranscript([
    { transcript: "daniel parti", confidence: 0.71 },
    { transcript: "daniel partel", confidence: 0.66 },
  ])).toBe("Daniel Partel");
});

import { chooseBestVoiceTranscript, extractVoiceCommand, hasVoiceWakeWord, normalizeVoiceTranscript, removeVoiceWakeWord, startsWithVoiceWakeWord } from "./voiceCorrections";

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

test("corrects the common transcription typo for briefing", () => {
  expect(normalizeVoiceTranscript("brieffing du soir")).toBe("briefing du soir");
});

test("chooses the alternative matching Sirius lexicon", () => {
  expect(chooseBestVoiceTranscript([
    { transcript: "daniel parti", confidence: 0.71 },
    { transcript: "daniel partel", confidence: 0.66 },
  ])).toBe("Daniel Partel");
});

test("requires an actionable command after the Sirius wake word", () => {
  expect(extractVoiceCommand("Sirius", { requireWakeWord: true })).toBe("");
  expect(extractVoiceCommand("bruit ambiant", { requireWakeWord: true })).toBe("");
  expect(extractVoiceCommand("Sirius ouvre les actualités", { requireWakeWord: true })).toBe("ouvre les actualités");
  expect(extractVoiceCommand("ouvre les actualités, Sirius", { requireWakeWord: true })).toBe("");
});

test("extracts complete natural commands without requiring a wake word", () => {
  expect(extractVoiceCommand("explique-moi le mot bal")).toBe("explique-moi le mot bal");
  expect(extractVoiceCommand("brieffing du soir")).toBe("briefing du soir");
});

test.each(["Zirius", "zirius", "Ziriusse", "Ziryus"])("accepts the wake-word transcription %s", (wakeWord) => {
  expect(hasVoiceWakeWord(wakeWord)).toBe(true);
  expect(extractVoiceCommand(`${wakeWord} quelle heure est-il`, { requireWakeWord: true })).toBe("quelle heure est-il");
});

test("allows concise commands through push-to-talk", () => {
  expect(extractVoiceCommand("briefing")).toBe("briefing");
  expect(extractVoiceCommand("heu")).toBe("");
});

test.each(["bonjour Zirius", "Bonjour Sirius", "salut Zirius", "bonsoir Zirius"])(
  "accepts the short greeting %s instead of discarding it after removing the name", (text) => {
    expect(extractVoiceCommand(text)).toBe(text.split(" ")[0]);
  },
);

test("short greetings do not bypass the leading wake word requirement", () => {
  expect(extractVoiceCommand("Zirius bonjour", { requireWakeWord: true })).toBe("bonjour");
  expect(extractVoiceCommand("Bonjour Zirius", { requireWakeWord: true })).toBe("Bonjour");
  expect(extractVoiceCommand("bonjour", { requireWakeWord: true })).toBe("");
  expect(extractVoiceCommand("ouvre la porte Zirius", { requireWakeWord: true })).toBe("");
});

test("detects a wake word spoken alone so the next phrase can be accepted", () => {
  expect(hasVoiceWakeWord("Sirius.")).toBe(true);
  expect(hasVoiceWakeWord("Serious")).toBe(true);
  expect(extractVoiceCommand("Sirius.", { requireWakeWord: true })).toBe("");
  expect(hasVoiceWakeWord("quelle heure est-il")).toBe(false);
});

test("recognizes and removes a leading wake word for short voice confirmations", () => {
  expect(startsWithVoiceWakeWord("Sirius, oui")).toBe(true);
  expect(startsWithVoiceWakeWord("oui, Sirius")).toBe(false);
  expect(removeVoiceWakeWord("Sirius, oui")).toBe("oui");
});

import { detectMailProvider, extractEmailRecipientQuery, isVoiceNo, isVoiceYes, voiceNumberChoice } from "./emailComposeVoice";

test("extracts recipient name from a send email command", () => {
  expect(extractEmailRecipientQuery("envoie un email à Daniel Partel")).toBe("Daniel Partel");
  expect(extractEmailRecipientQuery("envoie un mail avec gmail à daniel partel objet test")).toBe("daniel partel");
});

test("detects voice confirmations", () => {
  expect(isVoiceYes("oui confirme")).toBe(true);
  expect(isVoiceNo("non annule")).toBe(true);
});

test("detects provider and numbered choices", () => {
  expect(detectMailProvider("avec Outlook")).toBe("outlook");
  expect(detectMailProvider("gmail")).toBe("gmail");
  expect(voiceNumberChoice("le deuxième", 3)).toBe(1);
});

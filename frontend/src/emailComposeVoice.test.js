import { detectMailProvider, extractContactQuery, extractEmailRecipientQuery, isContactCommand, isSendEmailCommand, isVoiceNo, isVoiceYes, voiceNumberChoice } from "./emailComposeVoice";

test("extracts recipient name from a send email command", () => {
  expect(extractEmailRecipientQuery("envoie un email à Daniel Partel")).toBe("Daniel Partel");
  expect(extractEmailRecipientQuery("envoie un mail avec gmail à daniel partel objet test")).toBe("daniel partel");
  expect(extractEmailRecipientQuery("envoyer un courriel pour Missy")).toBe("Missy");
  expect(extractEmailRecipientQuery("écris un message à Hélène Dupont")).toBe("Hélène Dupont");
});

test("recognises a send-email intent even without a recipient", () => {
  expect(isSendEmailCommand("envoie un mail")).toBe(true);
  expect(isSendEmailCommand("je voudrais envoyer un courriel")).toBe(true);
  expect(isSendEmailCommand("rédige un message pour Daniel")).toBe(true);
  expect(isSendEmailCommand("lis mes mails")).toBe(false);
  expect(isSendEmailCommand("montre mes contacts")).toBe(false);
});

test("never mistakes the mail provider for a contact name", () => {
  expect(extractContactQuery("montre mes contacts outlook.")).toBe("");
  expect(extractContactQuery("ouvre mes contacts Outlook")).toBe("");
  expect(extractContactQuery("cherche dans mes contacts outlook, daniel partel")).toBe("daniel partel");
  expect(extractContactQuery("affiche les contacts de Daniel")).toBe("Daniel");
  expect(extractContactQuery("montre-moi mes contacts")).toBe("");
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

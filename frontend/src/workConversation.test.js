import { isOperationalCommand, isWorkConversationCommand } from "./workConversation";

test.each([
  "Qu'ai-je à traiter aujourd'hui ?", "Qu'est-ce que je dois traiter aujourd'hui ?",
  "Où en est ce dossier ?", "Résume le dossier Martin", "Pourquoi ces propositions ?",
  "Prépare une relance de facture", "Liste mes dossiers", "Oublie ce dossier",
  "Compare les dossiers Martin et Dupont", "Résume mes dossiers",
  "Qu'est-ce qui a changé depuis ma dernière visite ?",
  "Envoie la facture du dossier Martin", "Surveille le dossier Martin",
])("route directement la conversation métier : %s", (text) => {
  expect(isWorkConversationCommand(text)).toBe(true);
  expect(isOperationalCommand(text)).toBe(true);
});

test.each(["Ouvre mes dossiers", "Ferme ce dossier", "La météo demain", "Les résultats sportifs"])(
  "préserve les autres parcours : %s", (text) => expect(isWorkConversationCommand(text)).toBe(false),
);

test("préserve les commandes agenda dans le parcours opérationnel", () => {
  expect(isWorkConversationCommand("Ajoute un rendez-vous demain de 14 h à 15 h")).toBe(false);
  expect(isOperationalCommand("Ajoute un rendez-vous demain de 14 h à 15 h")).toBe(true);
});

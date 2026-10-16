import { isOperationalCommand, isWorkConversationCommand, workPreviewFollowup } from "./workConversation";

test.each([
  "Qu'ai-je à traiter aujourd'hui ?", "Qu'est-ce que je dois traiter aujourd'hui ?",
  "Où en est ce dossier ?", "Résume le dossier Martin", "Pourquoi ces propositions ?",
  "Prépare une relance de facture", "Liste mes dossiers", "Oublie ce dossier",
  "Compare les dossiers Martin et Dupont", "Résume mes dossiers",
  "Qu'est-ce qui a changé depuis ma dernière visite ?",
  "Envoie la facture du dossier Martin", "Surveille le dossier Martin",
  "Prépare la relance FAC-42",
  "Prépare les relances de mes factures en retard de plus de 15 jours",
  "Préparer toutes les relances de toutes les factures ayant plus de 30 jours de retard",
  "Prépare les relances de mes factures en retard de plus de 15 jours sauf le client Martin",
  "Confirme la prévisualisation de relance", "Annule la prévisualisation de relance",
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

test("une réponse à la prévisualisation n'autorise jamais un envoi implicite", () => {
  expect(workPreviewFollowup("Oui, je confirme !", true)).toBe("Confirme la prévisualisation de relance");
  expect(workPreviewFollowup("envoie-la", true)).toBe("Confirme la prévisualisation de relance");
  expect(workPreviewFollowup("envoie-les", true)).toBe("Confirme la prévisualisation de relance");
  expect(workPreviewFollowup("envoie tout", true)).toBe("Confirme la prévisualisation de relance");
  expect(workPreviewFollowup("envoie les relances", true)).toBe("Confirme la prévisualisation de relance");
  expect(workPreviewFollowup("Non.", true)).toBe("Annule la prévisualisation de relance");
  expect(workPreviewFollowup("Oui", false)).toBeNull();
  expect(workPreviewFollowup("La météo demain", true)).toBeNull();
});

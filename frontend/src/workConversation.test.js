import { haccpActivityFollowup, isFinanceConversationCommand, isHaccpActivityCommand, isHaccpClosingCommand, isOperationalCommand, isWorkConversationCommand, workPreviewFollowup } from "./workConversation";

test.each([
  "hier", "aujourd’hui", "pour cette semaine", "la semaine dernière", "le mois dernier",
  "les 7 derniers jours", "sur les trente derniers jours", "le 03/11/2026",
  "du 01/11/2026 au 03/11/2026", "hier s'il te plaît",
])("complète la demande HACCP avec une réponse de période, y compris les protections hors ligne : %s", (text) => {
  const pending = "Nombre d'étiquettes par jour";
  const result = haccpActivityFollowup(text, pending);
  expect(result).toBe(`${pending} ${text}`);
  expect(isHaccpActivityCommand(result)).toBe(true);
  expect(isOperationalCommand(result)).toBe(true);
});

test.each(["Ouvre HACCP", "Imprime une étiquette aujourd'hui", "Quel temps demain ?", "hier pour le restaurant A"])(
  "ne traite pas un nouveau sujet comme une simple précision de période : %s", (text) => {
    expect(haccpActivityFollowup(text, "Nombre d'étiquettes par jour")).toBeNull();
  },
);

test("ne réinterprète pas les périodes sans demande HACCP en attente", () => {
  expect(haccpActivityFollowup("hier", null)).toBeNull();
});

test.each([
  "ΣIRIUS, fais le point avant la fermeture",
  "Bilan de fin de service",
  "Rapport de clôture HACCP aujourd’hui",
  "Bilan HACCP du jour",
])("route le bilan de clôture aux données HACCP, sans ouverture forcée : %s", (text) => {
  expect(isHaccpClosingCommand(text)).toBe(true);
  expect(isOperationalCommand(text)).toBe(true);
});

test.each(["Ouvre le module HACCP", "Bilan financier du mois", "Combien d'étiquettes aujourd'hui ?"])(
  "ne confond pas une commande sans rapport avec le bilan de clôture : %s", (text) => {
    expect(isHaccpClosingCommand(text)).toBe(false);
  },
);

test.each([
  "ΣIRIUS, combien d’étiquettes ont été éditées aujourd’hui ?",
  "Combien d'etiquettes on a imprime hier ?",
  "Donne-moi le nombre d'étiquettes avant-hier",
  "Affiche les statistiques HACCP des étiquettes par jour cette semaine",
  "Bilan des étiquettes de la semaine dernière",
  "Nombre d'étiquettes ce mois-ci",
  "Nombre d'étiquettes le mois dernier",
  "Nombre d'étiquettes sur les sept derniers jours",
  "Compte toutes les étiquettes sur les 30 derniers jours",
  "Nombre d'étiquettes le 01/11/2026",
  "Bilan des étiquettes du 1/11/2026 au 3/11/2026",
  "Bilan des étiquettes du 2026-11-01 au 2026-11-03",
  "Combien avons-nous imprimé d'étiquettes aujourd'hui",
  "Nombre d'étiquettes par jour",
])("envoie les compteurs HACCP vers les données autorisées, pas un raccourci de fenêtre : %s", (text) => {
  expect(isHaccpActivityCommand(text)).toBe(true);
  expect(isOperationalCommand(text)).toBe(true);
});

test.each([
  "Ouvre HACCP", "Imprime une étiquette", "Crée une étiquette de préparation",
  "Combien de jours peut-on conserver le produit de cette étiquette ?",
  "Combien coûte une imprimante à étiquettes ?", "Nombre de calories sur cette étiquette",
  "Quels allergènes sur cette étiquette ?", "Combien de factures aujourd'hui ?",
])("ne détourne pas les autres demandes en comptage HACCP : %s", (text) => {
  expect(isHaccpActivityCommand(text)).toBe(false);
});

test.each(["Compare Apple et Microsoft sur cinq ans", "Quels sont les risques de mon portefeuille ?",
  "Alerte-moi si AAPL dépasse 200 dollars", "Chaque matin à 9 h analyse AAPL",
  "Confirme finance 1234567890abcdef1234567890abcdef", "Suivi financier 1234567890abcdef1234567890abcdef",
  "Reprends analyse 1234567890abcdef1234567890abcdef",
  "Pourquoi cette action a-t-elle baissé ?", "Montre mes alertes financières", "Quels dividendes pour Apple ?"])("raccorde la finance à la conversation sans raccourci local : %s", (text) => {
  expect(isFinanceConversationCommand(text)).toBe(true);
  expect(isOperationalCommand(text)).toBe(true);
});

test.each(["Ouvre Portus", "Connecte Microsoft", "Quelles actions dans ce dossier client", "Oui", "Supprime ce rendez-vous"])(
  "ne détourne pas une autre commande en finance : %s", (text) => expect(isFinanceConversationCommand(text)).toBe(false),
);

test.each([
  "Qu'ai-je à traiter aujourd'hui ?", "Qu'est-ce que je dois traiter aujourd'hui ?",
  "Où en est ce dossier ?", "Résume le dossier Martin", "Pourquoi ces propositions ?",
  "Prépare une relance de facture", "Liste mes dossiers", "Oublie ce dossier",
  "Compare les dossiers Martin et Dupont", "Résume mes dossiers",
  "Qu'est-ce qui a changé depuis ma dernière visite ?",
  "Envoie la facture du dossier Martin", "Surveille le dossier Martin",
  "Prépare la relance FAC-42",
  "Enregistre ce brouillon",
  "Enregistre ces préparations dans le dossier Client Martin",
  "Confirme l'enregistrement des brouillons",
  "Confirme l'enregistrement 1234567890abcdef1234567890abcdef",
  "Reprends l'enregistrement 1234567890abcdef1234567890abcdef",
  "Suivi de l'enregistrement 1234567890abcdef1234567890abcdef",
  "Liste mes enregistrements de brouillons",
  "Prépare les relances de mes factures en retard de plus de 15 jours",
  "Préparer toutes les relances de toutes les factures ayant plus de 30 jours de retard",
  "Prépare les relances de mes factures en retard de plus de 15 jours sauf le client Martin",
  "Confirme la prévisualisation de relance", "Annule la prévisualisation de relance",
  "Prépare le parcours de relance de la facture INV-A suivi le 2026-11-02T09:00:00+01:00",
  "Suivi parcours 1234567890abcdef1234567890abcdef",
  "Reprends parcours 1234567890abcdef1234567890abcdef",
  "Arrête parcours 1234567890abcdef1234567890abcdef",
  "Montre mes résultats de travail", "Mes rappels Sirius",
  "Rappelle-moi dans 3 jours de vérifier ce dossier",
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

import { isResumeWorkCommand, isWorkBriefingCommand } from "./workBriefing";
import { newsBulletinScope } from "./newsCommandRouting";

test.each([
  "mon briefing", "brieffing du soir", "afficher et lire le briefing",
  "affiche et lis le brieffing du soir", "lire et afficher mon briefing du jour",
  "donne-moi mon briefing", "refais-moi le briefing", "fais-moi le point",
  "mon rapport de travail", "mes priorités du jour", "on reprend le travail",
  "continue le travail", "résumé de ma journée",
])("%s requests work, not news", (text) => {
  expect(isWorkBriefingCommand(text)).toBe(true);
  expect(newsBulletinScope(text)).toBeNull();
});

test.each(["les actualités", "les infos", "quoi de neuf aujourd'hui", "les brèves internationales"])(
  "%s remains news", (text) => {
    expect(isWorkBriefingCommand(text)).toBe(false);
    expect(newsBulletinScope(text)).not.toBeNull();
  },
);

test.each(["explique ce briefing", "termine la facture", "continue", "fais-moi le point sur la bourse"])(
  "%s is not an instruction to run or complete work", (text) => {
    expect(isWorkBriefingCommand(text)).toBe(false);
    expect(isResumeWorkCommand(text)).toBe(false);
  },
);

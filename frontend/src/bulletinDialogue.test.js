import {
  BULLETIN_CONTEXT_TTL_MS, bulletinFollowUp, createBulletinContext, markSegmentCompleted, markSegmentStarted, releaseBulletinFocus,
} from "./bulletinDialogue";
import newsExamples from "./__fixtures__/newsCommands.json";

const segments = () => [
  { kind: "intro", text: "Voici le bulletin d'actualités France et international." },
  { kind: "weather", text: "Météo à Lyon. 18 degrés. Source : Open-Meteo." },
  { kind: "news", text: "France : le maire a annoncé une décision. Source : Franceinfo, publié aujourd'hui à 9 h." },
  { kind: "news", text: "International : le parlement a adopté le texte. Source : Franceinfo, publié aujourd'hui à 8 h." },
  { kind: "status", text: "Santé : source temporairement indisponible." },
];

// Simule une lecture interrompue pendant le segment `interruptedAt`.
function heard(interruptedAt) {
  const bulletin = createBulletinContext({ segments: segments() });
  for (let index = 0; index <= interruptedAt; index += 1) {
    markSegmentStarted(bulletin, index);
    if (index < interruptedAt) markSegmentCompleted(bulletin, index);
  }
  return bulletin;
}

test.each(newsExamples.followups.filter(([, , scope]) => scope))(
  "restarts a fresh focused bulletin with the requested scope: %s", (command, previousScope, scope) => {
    const bulletin = heard(3);
    bulletin.scope = previousScope;
    expect(bulletinFollowUp(command, bulletin)).toEqual({ restartScope: scope });
    releaseBulletinFocus(bulletin);
    expect(bulletinFollowUp(command, bulletin)).toBeNull();
    bulletin.focused = true;
    bulletin.savedAt = Date.now() - BULLETIN_CONTEXT_TTL_MS - 1000;
    expect(bulletinFollowUp(command, bulletin)).toBeNull();
  },
);

test.each(["quel temps tu a dis ?", "quel temps tu as dit ?", "Répète la météo", "Sirius, c'était quoi la météo ?", "la météo que tu as annoncée"])(
  "recalls the weather actually announced: %s", (command) => {
    const result = bulletinFollowUp(command, heard(3));
    expect(result.text).toContain("Météo à Lyon. 18 degrés.");
    expect(result.text).toContain("reprends");
  },
);

test("does not claim a weather report that was not yet spoken", () => {
  expect(bulletinFollowUp("quel temps tu as dit ?", heard(0)).text).toContain("pas encore annoncé de météo");
});

test.each(["répète qui a fait quoi", "qui a fait quoi ?", "redis la dernière actu", "Sirius répète cette info"])(
  "recalls the news item being announced: %s", (command) => {
    const result = bulletinFollowUp(command, heard(3));
    expect(result.text).toContain("le parlement");
    expect(result.text).not.toContain("le maire");
  },
);

test("recalls the last news item when interrupted on a status line, and none before any news", () => {
  expect(bulletinFollowUp("qui a fait quoi", heard(4)).text).toContain("le parlement");
  expect(bulletinFollowUp("qui a fait quoi", heard(1)).text).toContain("pas encore annoncé d'actualité");
});

test("a generic repeat returns the segment actually being spoken", () => {
  expect(bulletinFollowUp("répète", heard(1)).text).toContain("Météo à Lyon");
  expect(bulletinFollowUp("tu peux répéter ?", heard(2)).text).toContain("le maire");
});

test("resumption restarts an interrupted item and continues after a completed one", () => {
  expect(bulletinFollowUp("reprends", heard(2))).toEqual({ resumeAt: 2 });
  const completed = heard(2);
  markSegmentCompleted(completed, 2);
  expect(bulletinFollowUp("continue les infos", completed)).toEqual({ resumeAt: 3 });
  expect(bulletinFollowUp("la suite", completed)).toEqual({ resumeAt: 3 });
});

test("a stale completion for another segment does not move the resume position", () => {
  const bulletin = heard(3);
  markSegmentCompleted(bulletin, 2);
  expect(bulletinFollowUp("reprends", bulletin)).toEqual({ resumeAt: 3 });
});

test("an analytic question is contextualised with the announced passage only", () => {
  const result = bulletinFollowUp("Pourquoi le parlement a adopté ce texte ?", heard(3));
  expect(result.analysis).toContain("Pourquoi le parlement a adopté ce texte ?");
  expect(result.analysis).toContain("Passage en cours : International : le parlement");
  expect(result.analysis).toContain("France : le maire");
  expect(result.analysis).not.toContain("Santé");
  expect(result.analysis).toContain("N'invente aucun fait");
  expect(result.analysis).toContain("sans relire ni relancer le bulletin");
});

test("an analytic question before any spoken news is not contextualised", () => {
  expect(bulletinFollowUp("Pourquoi il a fait ça ?", createBulletinContext({ segments: segments() }))).toBeNull();
});

test.each(["affiche le résultat du sport en France ?", "Quels sont les résultats sportifs aujourd'hui ?",
  "Donne-moi les scores du tennis"])("sports results do not inherit the weather bulletin: %s", (command) => {
  expect(bulletinFollowUp(command, heard(1))).toBeNull();
  expect(bulletinFollowUp(command, heard(3))).toBeNull();
});

test.each(["quel temps fait-il à Bordeaux", "quelle heure est-il ?", "ouvre la galerie", "explique la photosynthèse"])(
  "does not capture unrelated requests while a bulletin is focused: %s", (command) => {
    expect(bulletinFollowUp(command, heard(3))).toBeNull();
  },
);

test("missing or expired context is explicit for bulletin references only", () => {
  const expired = { ...heard(3), savedAt: Date.now() - BULLETIN_CONTEXT_TTL_MS - 1 };
  for (const bulletin of [null, expired]) {
    expect(bulletinFollowUp("répète la météo", bulletin).text).toContain("pas de bulletin récent");
    expect(bulletinFollowUp("qui a fait quoi ?", bulletin).text).toContain("pas de bulletin récent");
    expect(bulletinFollowUp("reprends les infos", bulletin).text).toContain("pas de bulletin récent");
    expect(bulletinFollowUp("répète", bulletin)).toBeNull();
    expect(bulletinFollowUp("continue", bulletin)).toBeNull();
    expect(bulletinFollowUp("Pourquoi il a fait ça ?", bulletin)).toBeNull();
  }
});

test("another conversation releases generic repeat and resume, but explicit references still work", () => {
  const bulletin = heard(3);
  releaseBulletinFocus(bulletin);
  expect(bulletinFollowUp("répète", bulletin)).toBeNull();
  expect(bulletinFollowUp("continue", bulletin)).toBeNull();
  expect(bulletinFollowUp("Pourquoi il a fait ça ?", bulletin)).toBeNull();
  expect(bulletinFollowUp("reprends le bulletin", bulletin)).toEqual({ resumeAt: 3 });
  expect(bulletinFollowUp("qui a fait quoi", bulletin).text).toContain("le parlement");
});

test("after an analytic answer, resume stays available but a bare repeat no longer targets the bulletin", () => {
  const bulletin = heard(3);
  bulletin.focused = false;
  expect(bulletinFollowUp("répète", bulletin)).toBeNull();
  expect(bulletinFollowUp("reprends", bulletin)).toEqual({ resumeAt: 3 });
});

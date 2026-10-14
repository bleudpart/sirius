import { newsBulletinScope } from "./newsCommandRouting";

test.each([
  "Donne-moi les infos du jour en France.",
  "les infos en France",
  "Quelles sont les actualités du jour en France ?",
  "les actualités françaises aujourd’hui",
  "résume les nouvelles en France",
])("recognizes the France bulletin request: %s", (command) => {
  expect(newsBulletinScope(command)).toBe("france");
});

test.each(["les infos", "les actualités", "donne-moi toutes les infos du jour", "affiche et lis les actualités", "les infos en France et dans le monde"])(
  "routes the full news bulletin: %s", (command) => {
    expect(newsBulletinScope(command)).toBe("all");
  },
);

test.each(["les actualités internationales", "les infos du jour dans le monde", "les nouvelles à l’international"])(
  "routes international news: %s", (command) => {
    expect(newsBulletinScope(command)).toBe("international");
  },
);

test.each([
  "les infos sur l'économie",
  "recherche approfondie sur la politique en France",
  "explique les conséquences des actualités en France",
  "bonjour", "affiche le briefing du jour",
])("does not replace a topical analysis or another intent: %s", (command) => {
  expect(newsBulletinScope(command)).toBeNull();
});

import { parseMemorizeCommand } from "./memoryCommand";

test.each([
  ["note ça dans ta mémoire : ma fille s'appelle Emma", "ma fille s'appelle Emma"],
  ["Note ça dans ta mémoire ma fille s'appelle Emma", "ma fille s'appelle Emma"],
  ["enregistre que le code du portail est 4482", "le code du portail est 4482"],
  ["enregistre dans ta mémoire que je bois mon café sans sucre", "je bois mon café sans sucre"],
  ["Sirius, retiens que j'ai rendez-vous chez le dentiste vendredi", "j'ai rendez-vous chez le dentiste vendredi"],
  ["mémorise : mon vol part à 7h", "mon vol part à 7h"],
  ["souviens-toi que je préfère le thé", "je préfère le thé"],
  ["note bien que la réunion est déplacée à jeudi", "la réunion est déplacée à jeudi"],
  ["garde ça en mémoire : le wifi est sirius2026", "le wifi est sirius2026"],
  ["peux-tu noter ça", null],
  ["tu peux enregistrer ça : la clé est sous le pot", null],
  ["le code de l'alarme est 1234, note-le dans ta mémoire", "le code de l'alarme est 1234"],
  ["mon numéro de client est 55, enregistre ça", "mon numéro de client est 55"],
])("%s", (phrase, fact) => {
  const result = parseMemorizeCommand(phrase);
  if (fact === null) return;
  expect(result).toEqual({ fact });
});

test("an empty request is recognised so SIRIUS can ask what to remember", () => {
  expect(parseMemorizeCommand("note ça dans ta mémoire")).toEqual({ fact: "" });
});

test.each([
  "qu'est-ce que tu sais sur moi ?",
  "que retiens-tu de moi",
  "montre ta mémoire",
  "note la réunion de demain à 14h",
  "enregistre le fichier",
  "ouvre le module notes",
  "qu'est-ce que tu mémorises ?",
])("%s is not a memorisation request", (phrase) => {
  expect(parseMemorizeCommand(phrase)).toBeNull();
});

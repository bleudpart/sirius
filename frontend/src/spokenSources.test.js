import { stripSpokenSources } from "./spokenSources";

test("retire la phrase de source d'un passage du bulletin en gardant l'heure", () => {
  expect(stripSpokenSources("France : Le maire annonce une décision. Publié aujourd'hui à 9 h 05. Source : Franceinfo."))
    .toBe("France : Le maire annonce une décision. Publié aujourd'hui à 9 h 05.");
});

test("retire la source météo", () => {
  expect(stripSpokenSources("Météo à Lyon. Demain : pluie. Source : Open-Meteo, prévisions modélisées et non alerte officielle."))
    .toBe("Météo à Lyon. Demain : pluie.");
});

test("retire le bloc final de liens", () => {
  const text = "Voici le bulletin.\n\nSources :\n- France — Décision (Franceinfo) : https://www.franceinfo.fr/a\n- Météo (Open-Meteo) : https://open-meteo.com/";
  expect(stripSpokenSources(text)).toBe("Voici le bulletin.");
});

test("retire les blocs Markdown, les URL et les sources entre parenthèses d'une recherche web", () => {
  const text = "Le prix moyen est de 25 euros (source : Le Monde.fr). Selon Franceinfo (https://www.franceinfo.fr/x), la hausse continue.\n\n**Sources :**\n1. [Le Monde](https://www.lemonde.fr/a)\n2. https://www.franceinfo.fr/x";
  expect(stripSpokenSources(text)).toBe("Le prix moyen est de 25 euros. Selon Franceinfo, la hausse continue.");
});

test("garde une rubrique indisponible et les mots ordinaires", () => {
  expect(stripSpokenSources("Santé : source temporairement indisponible.")).toBe("Santé : source temporairement indisponible.");
  expect(stripSpokenSources("La source du fleuve est en Suisse.")).toBe("La source du fleuve est en Suisse.");
});

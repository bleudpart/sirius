import { suggestPreparationRule } from "./haccpShelfLife";

test.each([
  ["Sauce mayonnaise", 24, "ANSES"],
  ["Tartare de cabillaud à l'aneth", 24, "cru sensible"],
  ["Cube pommes charlotte Tataki de bœuf", 24, "cru sensible"],
  ["Herbes fraîches hachées tartare japonais", 48, "Végétaux"],
  ["Soupe à l'oignon", 72, "cuite"],
  ["Brick de lait entier", 48, "après ouverture"],
  ["Produit inconnu", 48, "0 et +3 °C"],
])("%s gets the shortest prudent rule", (name, hours, text) => {
  const rule = suggestPreparationRule(name);
  expect(rule.hours).toBe(hours);
  expect(rule.conditions).toContain(text);
});

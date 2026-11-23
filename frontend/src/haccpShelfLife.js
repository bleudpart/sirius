const COLD = "Entre 0 et +3 °C, en bac fermé et étiqueté";

// Durées prudentes (ANSES, GBPH restaurateur) à faire valider par le responsable dans son PMS.
const CATEGORIES = [
  {
    hours: 24, conditions: `${COLD}. Préparation à base d’œuf cru : consommer dans les 24 h (ANSES).`,
    pattern: /oeufs? crus?|mayo|aioli|sauce.*cesar|tiramisu|mousse au chocolat|bearnaise|hollandaise|chantilly|creme patissiere/,
  },
  {
    hours: 24, conditions: `${COLD}. Produit cru sensible (poisson, fruits de mer, viande hachée ou peu cuite).`,
    pattern: /tartare|carpaccio|ceviche|tataki|sushi|poisson|cabillaud|saumon|thon|\bbar\b|gambas|crevette|calamar|moule|saint-jacques|fruits de mer|viande hachee|steak hache/,
    unless: /^herbes?/,
  },
  { hours: 24, conditions: `${COLD}. Fromage frais entamé.`, pattern: /burrata|mozzarella fraiche|ricotta/ },
  { hours: 48, conditions: `${COLD}. Riz cuit refroidi rapidement.`, pattern: /\briz\b/ },
  { hours: 48, conditions: `${COLD}. Œufs cuits.`, pattern: /\boeufs?\b/ },
  { hours: 48, conditions: `${COLD}. Volaille.`, pattern: /poulet|chicken|volaille|dinde|canard/, unless: /^sauce/ },
  {
    hours: 48, conditions: `${COLD}. Viande.`,
    pattern: /entrecote|rumsteak|faux-filet|boeuf|bavette|filet mignon|porc|agneau|veau/,
  },
  { hours: 48, conditions: `${COLD}. Dessert lacté cuit.`, pattern: /creme anglaise|creme brulee|panna cotta|pana cota|flan/ },
  {
    hours: 48, conditions: `${COLD}. Végétaux crus lavés et taillés.`,
    pattern: /salade|romaine|roquette|emince|tomate|radis|persil|herbe|betterave|groseille|fruit|oignon|concombre|carotte/,
    unless: /soupe|saute|roti|cuit|coulis|crouton|sauce|oeuf/,
  },
  {
    hours: 48, conditions: `${COLD}, refermé. Si l’emballage indique une durée après ouverture plus courte, la suivre.`,
    pattern: /brick|brique|bouteille|paquet|ouvert|litre|boite|conserve|creme liquide|\blait\b/,
  },
  {
    hours: 72, conditions: `${COLD}. Préparation cuite ou produit stable, refroidi rapidement.`,
    pattern: /sauce|soupe|lasagne|ravioles|ecrasee|puree|roti|cuit|saute|caramel|brownie|crepe|fromage|emmental|charcuterie|poitrine|jambon|pickles|cornichon|condiment|frit|beignet|sticks|wings|haricot|patate|pommes|crouton|pain/,
  },
];

export const DEFAULT_RULE = { hours: 48, conditions: `${COLD}.` };

function normalize(name) {
  return name.toLowerCase().replace(/œ/g, "oe").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function suggestPreparationRule(name) {
  const text = normalize(name);
  const matches = CATEGORIES.filter(({ pattern, unless }) => pattern.test(text) && !unless?.test(text));
  if (!matches.length) return { ...DEFAULT_RULE };
  const shortest = matches.reduce((best, item) => (item.hours < best.hours ? item : best));
  return { hours: shortest.hours, conditions: shortest.conditions };
}

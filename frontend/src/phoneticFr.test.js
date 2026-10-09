import { applyFrenchPhonetics } from "./phoneticFr";

beforeEach(() => localStorage.clear());

test("épelle les sigles que le moteur lirait comme un mot", () => {
  expect(applyFrenchPhonetics("Le plan HACCP est prêt")).toBe("Le plan ache a cé cé pé est prêt");
  expect(applyFrenchPhonetics("Export PDF")).toBe("Export pé dé èf");
  expect(applyFrenchPhonetics("ouvre le HUD")).toBe("ouvre le ache u dé");
});

test("francise les anglicismes sous toutes leurs formes", () => {
  expect(applyFrenchPhonetics("Lance un scan")).toBe("Lance un skane");
  expect(applyFrenchPhonetics("Je scanne le document")).toBe("Je skane le document");
  expect(applyFrenchPhonetics("deux scans")).toBe("deux skane");
});

test("corrige les noms propres mal prononcés", () => {
  expect(applyFrenchPhonetics("Roger Partel")).toBe("Rojé Partel");
  expect(applyFrenchPhonetics("Sirius est prêt")).toBe("Siriusse est prêt");
});

test.each(["Face ID", "FaceID", "Face-ID"])("prononce %s comme les lettres anglaises attendues", (name) => {
  expect(applyFrenchPhonetics(`Déverrouillage ${name}`)).toBe("Déverrouillage feïss aï di");
});

test("ne touche pas aux mots qui contiennent une entrée du lexique", () => {
  expect(applyFrenchPhonetics("le scanner du bureau")).toBe("le scanner du bureau");
  expect(applyFrenchPhonetics("un scandale")).toBe("un scandale");
});

test("le dictionnaire utilisateur est prioritaire sur le lexique intégré", () => {
  localStorage.setItem("sirius_phonetic", JSON.stringify([{ mot: "Roger", dit: "Rodgeur" }]));
  expect(applyFrenchPhonetics("Roger arrive")).toBe("Rodgeur arrive");
});

test("un dictionnaire utilisateur corrompu n'interrompt pas la synthèse", () => {
  localStorage.setItem("sirius_phonetic", "{pas du json");
  expect(applyFrenchPhonetics("Lance un scan")).toBe("Lance un skane");
});

import { applyFrenchPhonetics, normalizeFrenchElisions } from "./phoneticFr";

beforeEach(() => localStorage.clear());

test("an invisible separator between words does not concatenate them", () => {
  expect(normalizeFrenchElisions("deux\u200bmots")).toBe("deux mots");
});

test.each(["Dis-moi.", "Dis moi.", "Dis\u2011moi.", "Dis-\u200bmoi."])(
  "normalizes typography without phonetic aliases: %s", (text) => {
    const normalized = normalizeFrenchElisions(text);
    expect(normalized).toBe(text === "Dis moi." ? "Dis moi." : "Dis-moi.");
    expect(applyFrenchPhonetics(normalized)).toBe(normalized);
  },
);

test.each(["emails", "e-mails", "e mails", "EMAILS", "mails", "e\u2011mails"])(
  "lit %s comme courriels sans épeler",
  (word) => expect(applyFrenchPhonetics(`Vos ${word} sont prêts.`)).toBe("Vos courriels sont prêts."),
);

test.each(["email", "e-mail", "mail"])("lit %s au singulier", (word) => {
  expect(applyFrenchPhonetics(`Un ${word}.`)).toBe("Un courriel.");
});

test("préserve les adresses et les mots contenant mail", () => {
  const text = "email@example.test prénom.mail@example.test https://mail.example.test emailing";
  expect(applyFrenchPhonetics(text)).toBe(text);
});

test("épelle les sigles que le moteur lirait comme un mot", () => {
  expect(applyFrenchPhonetics("Le plan HACCP est prêt")).toBe("Le plan ache a cé cé pé est prêt");
  expect(applyFrenchPhonetics("Export PDF")).toBe("Export pé dé èf");
  expect(applyFrenchPhonetics("ouvre le HUD")).toBe("ouvre le ache u dé");
});

test("francise les anglicismes sous toutes leurs formes", () => {
  expect(applyFrenchPhonetics("Lance un scan")).toBe("Lance un skane");
  expect(applyFrenchPhonetics("Je scanne le document")).toBe("Je skane le document");
  expect(applyFrenchPhonetics("deux scans")).toBe("deux skane");
  expect(applyFrenchPhonetics("PLANNING et planning")).toBe("planigne et planigne");
});

test("corrige les noms propres mal prononcés", () => {
  expect(applyFrenchPhonetics("Roger Partel")).toBe("Rojé Partel");
  expect(applyFrenchPhonetics("Sirius est prêt")).toBe("Siriusse est prêt");
  expect(applyFrenchPhonetics("Sirius Display")).toBe("Siriusse displé");
  expect(applyFrenchPhonetics("Zirius Display")).toBe("Siriusse displé");
});

test.each(["PLUTOS", "Plutos", "plutos"])("prononce le nom %s comme un mot, pas un sigle", (name) => {
  expect(applyFrenchPhonetics(`J'ouvre ${name}.`)).toBe("J'ouvre Ploutoss.");
});

test.each(["l\u200b’\u200beffet", "l＇ effet", "l\u2060'\u2060effet", "l ’\nhistoire"])(
  "normalise les élisions avec séparateurs invisibles : %s", (text) => {
    expect(normalizeFrenchElisions(text)).toMatch(/^l'(?:effet|histoire)$/);
  },
);

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

test("l'adjectif content se prononce « contan », le verbe conter reste intact", () => {
  expect(applyFrenchPhonetics("Je suis content de te voir.")).toBe("Je suis contant de te voir.");
  expect(applyFrenchPhonetics("Content de t'entendre ! Ils sont contents.")).toBe("Contant de t'entendre ! Ils sont contants.");
  expect(applyFrenchPhonetics("Il est mécontent.")).toBe("Il est mécontant.");
  expect(applyFrenchPhonetics("Ils content une histoire, elles nous content la suite.")).toBe("Ils content une histoire, elles nous content la suite.");
  expect(applyFrenchPhonetics("Je suis contente et ravie.")).toBe("Je suis contente et ravie.");
  expect(applyFrenchPhonetics("le contentement")).toBe("le contentement");
});

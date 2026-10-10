import { displayReadingText, splitDisplayReading, isDisplayReadCommand } from "./displayReading";

test("reads text, contacts, mails and editable drafts without interface buttons", () => {
  const body = document.createElement("div");
  body.innerHTML = '<h2>Infos du jour</h2><p>Une information.</p><button>Voter</button><div>Alice</div><div>Objet du courrier</div><input value="Sujet modifié"><textarea>Texte du brouillon</textarea>';
  const text = displayReadingText(body);
  expect(text).toContain("Une information.");
  expect(text).toContain("Alice");
  expect(text).toContain("Objet du courrier");
  expect(text).toContain("Sujet modifié");
  expect(text).toContain("Texte du brouillon");
  expect(text).not.toContain("Voter");
});

test("splits long readings without dropping the end or exceeding request size", () => {
  const text = `${"Une longue information à lire. ".repeat(160)}Dernier point important.`;
  const chunks = splitDisplayReading(text);
  expect(chunks.length).toBeGreaterThan(3);
  expect(chunks.every((chunk) => chunk.length <= 800)).toBe(true);
  expect(chunks.join(" ")).toBe(text.trim());
});

test("does not separate an elision at the boundary between speech chunks", () => {
  const chunks = splitDisplayReading(`${"mot ".repeat(198)}l ’ effet attendu.`);
  expect(chunks.join(" ")).toContain("l'effet attendu.");
  expect(chunks.every((chunk) => !/\bl\s*['’]?$/.test(chunk))).toBe(true);
});

test.each(["l\u200b’\u200beffet", "l＇ effet", "l\u2060'\u2060effet"])(
  "keeps invisible or full-width elisions together before splitting: %s", (elision) => {
    const chunks = splitDisplayReading(`${"mot ".repeat(198)}${elision} attendu.`);
    expect(chunks.join(" ")).toContain("l'effet attendu.");
    expect(chunks.every((chunk) => chunk.length <= 800 && !/\bl\s*['’]?$/.test(chunk))).toBe(true);
  },
);

test.each(["lis mon Sirius Display", "lis ton Zirius Display", "lis tout ce que tu affiches", "lire le display"])(
  "recognizes %s", (command) => expect(isDisplayReadCommand(command)).toBe(true)
);

import { getDisplayAutoCloseDelay } from "./displayTiming";

test("une initiative reste visible pour permettre de repondre", () => {
  expect(getDisplayAutoCloseDelay({ type: "message", contenu: "Suggestion", suggestion: { id: "one" } })).toBeNull();
});

test("keeps short display responses open for at least two minutes", () => {
  expect(getDisplayAutoCloseDelay({ type: "message", contenu: "Réponse courte." })).toBe(120000);
});

test("extends the display timeout for long responses", () => {
  const contenu = Array.from({ length: 400 }, () => "mot").join(" ");

  expect(getDisplayAutoCloseDelay({ type: "message", contenu })).toBe(210000);
});

test("keeps persistent display content open", () => {
  expect(getDisplayAutoCloseDelay({ type: "web" })).toBeNull();
  expect(getDisplayAutoCloseDelay({ type: "video" })).toBeNull();
});

import { getLanguage, setLanguage, translateString } from "@/i18n/domTranslator";

jest.mock("@/i18n/locales/en.json", () => ({ Enregistrer: "Save", "Mot de passe": "Password" }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  await setLanguage("fr");
  document.body.innerHTML = "";
});

test("translateString conserve les espaces et le deux-points final", () => {
  const dict = { "Mot de passe": "Password" };
  expect(translateString("  Mot de passe :", dict)).toBe("  Password :");
  expect(translateString("Inconnu", dict)).toBeNull();
});

test("traduit le DOM, suit les mises Ã  jour puis restaure le franÃ§ais", async () => {
  document.body.innerHTML = '<button title="Enregistrer">Enregistrer</button><p translate="no">Enregistrer</p>';
  const button = document.querySelector("button");
  await setLanguage("en");
  expect(getLanguage()).toBe("en");
  expect(button.textContent).toBe("Save");
  expect(button.getAttribute("title")).toBe("Save");
  expect(document.querySelector("p").textContent).toBe("Enregistrer");

  button.firstChild.nodeValue = "Mot de passe";
  await flush();
  expect(button.textContent).toBe("Password");

  await setLanguage("fr");
  expect(button.textContent).toBe("Mot de passe");
  expect(button.getAttribute("title")).toBe("Enregistrer");
});

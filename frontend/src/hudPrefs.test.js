import { HUD_DEFAULTS, loadHud, saveHud, applyHud } from "./hudPrefs";

describe("hudPrefs", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.cssText = "";
    document.body.className = "";
  });

  test("loadHud renvoie les valeurs par défaut sans stockage", () => {
    expect(loadHud()).toEqual(HUD_DEFAULTS);
  });

  test("loadHud survit à un JSON corrompu (retour aux défauts)", () => {
    localStorage.setItem("sirius_hud", "{pas-du-json");
    expect(loadHud()).toEqual(HUD_DEFAULTS);
  });

  test("saveHud persiste puis loadHud restitue (aller-retour)", () => {
    saveHud({ alpha: 0.6, zoom: 1.2, minimal: true });
    expect(loadHud()).toEqual({ alpha: 0.6, zoom: 1.2, minimal: true });
  });

  test("les préférences partielles sont fusionnées avec les défauts", () => {
    localStorage.setItem("sirius_hud", JSON.stringify({ alpha: 0.4 }));
    expect(loadHud()).toEqual({ ...HUD_DEFAULTS, alpha: 0.4 });
  });

  test("applyHud pose les variables CSS et la classe minimal", () => {
    applyHud({ alpha: 0.5, zoom: 1.3, minimal: true });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--hud-panel-alpha")).toBe("0.5");
    expect(root.style.getPropertyValue("--hud-zoom")).toBe("1.3");
    expect(document.body.classList.contains("hud-minimal")).toBe(true);

    applyHud({ alpha: 1, zoom: 1, minimal: false });
    expect(document.body.classList.contains("hud-minimal")).toBe(false);
  });

  test("applyHud tolère les valeurs manquantes (repli sur 1)", () => {
    applyHud({});
    expect(document.documentElement.style.getPropertyValue("--hud-panel-alpha")).toBe("1");
    expect(document.documentElement.style.getPropertyValue("--hud-zoom")).toBe("1");
  });
});

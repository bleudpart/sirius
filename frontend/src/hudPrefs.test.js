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
    expect(loadHud()).toEqual({ ...HUD_DEFAULTS, alpha: 0.6, zoom: 1.2, minimal: true });
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

  test("les préférences accessibles persistent et informent le HUD actif", () => {
    const changed = jest.fn();
    window.addEventListener("sirius-hud-preferences", changed);
    try {
      saveHud({ ...HUD_DEFAULTS, reducedMotion: true, highContrast: true, zoom: 1.25 });
      expect(document.body.classList.contains("hud-reduced-motion")).toBe(true);
      expect(document.body.classList.contains("hud-high-contrast")).toBe(true);
      expect(loadHud().reducedMotion).toBe(true);
      expect(changed).toHaveBeenCalledTimes(1);
      applyHud(HUD_DEFAULTS);
      expect(document.body.classList.contains("hud-reduced-motion")).toBe(false);
    } finally { window.removeEventListener("sirius-hud-preferences", changed); }
  });

  test("un échec de stockage n'applique pas un réglage non enregistré", () => {
    const before = document.body.className;
    const write = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    try {
      expect(() => saveHud({ ...HUD_DEFAULTS, highContrast: true })).toThrow("quota");
      expect(document.body.className).toBe(before);
    } finally { write.mockRestore(); }
  });
});

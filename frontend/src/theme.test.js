import {
  applyVisualTheme,
  getHUDStyleVariables,
  loadVisualTheme,
  renderHUD,
  saveVisualTheme,
  VISUAL_THEME_DEFAULTS,
} from "./theme";

describe("visual theme preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.cssText = "";
  });

  test("loads the default palette and ignores malformed saved colors", () => {
    expect(loadVisualTheme()).toEqual(VISUAL_THEME_DEFAULTS);
    localStorage.setItem("sirius_visual_theme", JSON.stringify({ cyan: "red", gold: "#123456" }));
    expect(loadVisualTheme()).toEqual({ ...VISUAL_THEME_DEFAULTS, gold: "#123456" });
  });

  test("saves custom palette and applies it to the shared HUD variables immediately", () => {
    const changed = jest.fn();
    window.addEventListener("sirius-visual-theme-changed", changed);
    try {
      saveVisualTheme({ cyan: "#ff8800", gold: "#8a2be2", background: "#101010" });
      expect(loadVisualTheme()).toEqual({ cyan: "#ff8800", gold: "#8a2be2", background: "#101010" });
      expect(document.documentElement.style.getPropertyValue("--sirius-cyan")).toBe("#ff8800");
      expect(document.documentElement.style.getPropertyValue("--workspace-gold")).toBe("#8a2be2");
      expect(getHUDStyleVariables(loadVisualTheme())["--sirius-background"]).toBe("#101010");
      expect(renderHUD({ coreActive: true, guardianActive: false }, loadVisualTheme()).core.color).toBe("#ff8800");
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("sirius-visual-theme-changed", changed);
    }
  });

  test("rejects invalid colors instead of persisting unsafe CSS values", () => {
    expect(() => saveVisualTheme({ cyan: "red; background:url(https://invalid)" })).toThrow("couleur");
    expect(localStorage.getItem("sirius_visual_theme")).toBeNull();
  });

  test("can restore and reapply the default palette", () => {
    saveVisualTheme({ cyan: "#ff8800" });
    saveVisualTheme({ ...VISUAL_THEME_DEFAULTS });
    expect(loadVisualTheme()).toEqual(VISUAL_THEME_DEFAULTS);
    applyVisualTheme();
    expect(document.documentElement.style.getPropertyValue("--sirius-cyan")).toBe(VISUAL_THEME_DEFAULTS.cyan);
  });
});

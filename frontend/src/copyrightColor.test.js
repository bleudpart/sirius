import fs from "fs";
import path from "path";
import postcss from "postcss";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import AboutPanel from "./AboutPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const readCss = (name) => postcss.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
const declaration = (root, selector, property) => {
  let value;
  root.walkRules(selector, (rule) => {
    rule.walkDecls(property, (node) => { value = node.value; });
  });
  return value;
};

test("copyright footers share the HUD gold and retain the high-contrast override", () => {
  const index = readCss("index.css");
  const app = readCss("App.css");
  const theme = readCss("siriusVisualTheme.css");
  const store = readCss("PublicStore.css");
  const about = readCss("About.css");
  const color = "var(--sirius-copyright-color)";

  expect(declaration(index, ":root", "--sirius-copyright-color")).toBe("#e8c979");
  expect(declaration(theme, "body.hud-high-contrast", "--sirius-copyright-color")).toBe("#fff");
  expect(declaration(app, ".auth-powered", "color")).toBe("rgba(255, 255, 255, 0.66)");
  for (const selector of [".auth-powered.auth-copyright", ".boot-copyright", "footer.sirius-footer"]) {
    expect(declaration(app, selector, "color")).toBe(color);
  }
  expect(declaration(theme, 'html[data-sirius-visual-theme="classic"] .boot-screen .boot-copyright', "color")).toBe(color);
  expect(declaration(store, ".public-copyright", "color")).toBe(color);
  expect(declaration(about, ".about-copyright", "color")).toBe(color);
  for (const selector of [
    ".boot-copyright .footer-version-badge",
    ".sirius-footer .sirius-footer-mark",
    ".sirius-footer .footer-version-badge",
  ]) {
    expect(declaration(app, selector, "color")).toBe("inherit");
  }
});

test("the About panel highlights only the copyright mention", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<AboutPanel onClose={() => {}} />));
    expect(container.querySelector(".about-copyright").textContent).toBe("COPYRIGHT © 2026 – Tous droits réservés.");
    expect(container.querySelector(".about-text").textContent).toContain("logiciel propriétaire développé par Daniel Partel.");
  } finally {
    act(() => root.unmount());
  }
});

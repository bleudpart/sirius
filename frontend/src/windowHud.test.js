import fs from "fs";
import path from "path";
import postcss from "postcss";

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const css = read("windowHud.css");
const root = postcss.parse(css);
const rules = [];
root.walkRules((rule) => rules.push(rule));
const ruleWith = (...parts) => rules.find((rule) => parts.every((part) => rule.selector.includes(part)));
const value = (rule, prop) => {
  const decl = rule.nodes.find((node) => node.prop === prop);
  return decl && `${decl.value}${decl.important ? " !important" : ""}`;
};

test("the window skin is loaded last so every module shares the validated home design", () => {
  const index = read("index.js");
  expect(index.indexOf('import "./windowHud.css"')).toBeGreaterThan(index.indexOf('import "./electronHud.css"'));
  expect(css).not.toContain("@import");
});

test("windows use cyan lines, golden corners and Cinzel titles from the home reference", () => {
  const theme = rules.find((rule) => rule.nodes.some((node) => node.prop === "--pantheon-heading"));
  expect(theme.selector).toContain(".sirius-display");
  expect(theme.selector).toContain(".sirius-module-window");
  for (const home of [".sirius-root", ".sirius-center", ".pantheon-composer", ".workspace-surface", ".top-bar"]) {
    expect(theme.selector).not.toContain(home);
  }
  expect(rules.some((rule) => rule.selector.trim() === 'html[data-sirius-visual-theme="classic"][data-sirius-platform]')).toBe(false);
  expect(value(theme, "--workspace-line")).toBe("rgba(145, 230, 242, 0.26)");
  expect(value(theme, "--pantheon-heading")).toMatch(/^"Cinzel"/);
  expect(value(theme, "--pantheon-corners")).toContain("#d8b875");
  expect(value(theme, "--workspace-shadow")).toContain("var(--sirius-glow-frame)");
  const titles = ruleWith(".sirius-window-title", ".sd-name", ".sd-msg-title");
  expect(value(titles, "color")).toBe("var(--window-hud-title) !important");
  expect(value(titles, "text-shadow")).toBe("var(--sirius-glow-gold) !important");
});

test("the final window skin uses near-black module and card backgrounds", () => {
  const theme = rules.find((rule) => rule.nodes.some((node) => node.prop === "--workspace-surface"));
  expect(value(theme, "--workspace-surface")).toBe("linear-gradient(160deg, #040506, #010101)");
  expect(value(theme, "--window-hud-card")).toBe("rgba(5, 6, 7, 0.94)");
  expect(value(theme, "--window-hud-control")).toBe("rgba(3, 4, 5, 0.85)");
});

test("window controls become round cyan buttons without changing their 44 px geometry", () => {
  const controls = ruleWith(".sirius-window-close", ".holo-win-min", ".sd-bar > button");
  expect(value(controls, "border-radius")).toBe("999px !important");
  expect(value(controls, "border")).toContain("rgba(145, 230, 242, 0.28)");
  expect(value(controls, "box-shadow")).toBe("var(--sirius-glow-control) !important");
  for (const close of [".sp-close", ".zeus-close", ".keys-close", ".atlas-bar", ".fv-bar"]) expect(controls.selector).toContain(close);
  for (const prop of ["width", "height", "min-width", "min-height", "position", "top", "right", "display"]) {
    expect(value(controls, prop)).toBeUndefined();
  }
});

test("Display chips become capsules while brand and alert colours stay local", () => {
  const chips = ruleWith(".sd-badge", ".sd-social-btn", ".sd-email-badge");
  expect(value(chips, "border-radius")).toBe("999px !important");
  expect(value(chips, "color")).toBeUndefined();
  expect(value(chips, "border-color")).toBeUndefined();
  const cards = ruleWith(".sd-email-card:not(.urgent)", ".sd-contact-card");
  expect(cards.selector).not.toMatch(/\.urgent(?!\))/);
  const restingGlow = ruleWith(".modmenu-item:not(.active)", ".sd-email-card:not(.urgent)", ".sd-contact-card");
  expect(restingGlow.selector).toContain(":not(:hover):not(:focus-visible)");
  expect(value(restingGlow, "box-shadow")).toBe("inset 0 1px 0 rgba(145, 230, 242, 0.04), var(--sirius-glow-control) !important");
  expect(css).not.toMatch(/\.(crit|urgent)\s*\{/);
});

test("the skin never changes window positions or sizes", () => {
  const geometry = ["position", "z-index", "top", "left", "right", "bottom", "width", "height", "transform", "display", "inset"];
  root.walkDecls((decl) => expect(geometry).not.toContain(decl.prop));
  expect(ruleWith(".sirius-display:not(.fullscreen)").parent.params).toBe("(min-width: 600px)");
});

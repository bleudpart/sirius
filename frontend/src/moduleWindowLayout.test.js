import fs from "fs";
import path from "path";
import postcss from "postcss";

const css = fs.readFileSync(path.join(__dirname, "moduleWindowLayout.css"), "utf8");
const root = postcss.parse(css);

test("window layout is loaded after the visual theme", () => {
  const index = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  expect(index.indexOf('import "./moduleWindowLayout.css"')).toBeGreaterThan(index.indexOf('import "./siriusVisualTheme.css"'));
});

test("window controls reserve distinct positions and 44px targets", () => {
  const controls = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(":is(.sirius-window-close, .holo-win-min, .sirius-window-max)")) controls.push(rule);
  });
  const buttons = controls.find(rule => rule.nodes.some(node => node.prop === "min-width"));
  expect(buttons.nodes.find(node => node.prop === "min-width").value).toBe("44px");
  expect(buttons.nodes.find(node => node.prop === "min-height").value).toBe("44px");
  expect(css).toContain("padding: 16px 172px 16px 24px");
  expect(css).toContain("right: 12px");
  expect(css).toContain("right: 64px");
  expect(css).toContain("right: 116px");
});

test("portrait no longer reserves a content column and the layout stacks on mobile", () => {
  expect(css).toContain(".sirius-module-window.prime-screen:has(> .mythos-avatar)");
  expect(css).toContain("width: 64px !important");
  expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
  expect(css).toContain("padding: 12px 112px 12px 14px");
  expect(css).not.toContain("100vw");
  expect(css).toContain(".sirius-window-max { display: none !important; }");
});

test("shared form fields remain legible on the dark surface without restyling special inputs", () => {
  expect(css).toContain('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"])');
  expect(css).toContain("color-scheme: dark");
  expect(css).toContain("color: var(--workspace-text)");
  expect(css).toContain("background-color: #061621");
});

test("specialized tools have a separate wrapping row without shrinking the header", () => {
  expect(css).toContain(".sirius-window-header:has(> .sirius-window-tools)");
  expect(css).toContain("grid-template-columns: 20px minmax(0, 1fr)");
  expect(css).toContain("padding-right: 96px");
  expect(css).toContain("flex-shrink: 0");
  expect(css).toContain("max-height: calc(100dvh - 88px)");
});

test("mobile specialized content stays above navigation and uses the available width", () => {
  const mobile = root.nodes.find(node => node.type === "atrule" && node.params === "(max-width: 1023px)");
  const rules = mobile.toString();
  expect(rules).toContain("z-index: 1200");
  expect(rules).toContain(".kr-character");
  expect(rules).toContain("display: none !important");
  expect(rules).toContain(".dz-inner");
  expect(rules).toContain("flex-wrap: wrap");
  expect(rules).toContain(".kr-slider");
  expect(rules).toContain("grid-column: 2 / -1");
});

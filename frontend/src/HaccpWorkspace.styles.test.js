import fs from "fs";
import path from "path";
import postcss from "postcss";

const css = postcss.parse(fs.readFileSync(path.join(__dirname, "HaccpWorkspace.css"), "utf8"));
const rule = (selector) => css.nodes.find((node) => node.type === "rule" && node.selector === selector);
const value = (selector, property) => rule(selector).nodes.find((node) => node.prop === property)?.value;

test("workspace and cards use the module surface and a fine gold frame", () => {
  for (const selector of [".haccp-workspace", ".haccp-card"]) {
    expect(value(selector, "border")).toBe("1px solid var(--haccp-border)");
    expect(value(selector, "border-radius")).toBe("8px");
    expect(value(selector, "background")).toContain("var(--pantheon-surface,");
    expect(value(selector, "box-shadow")).toContain("var(--workspace-shadow,");
  }
});

test("scanner is a dark module control with a fine gold outline, not a solid gold tile", () => {
  expect(value(".haccp-ui button.haccp-primary", "border")).toBe("1px solid var(--haccp-border)");
  expect(value(".haccp-ui button.haccp-primary", "background")).toBe("linear-gradient(145deg, #102637, #081522)");
  expect(value(".haccp-ui button.haccp-scan", "border-radius")).toBe("8px");
  expect(value(".haccp-ui button.haccp-scan", "min-height")).toBe("86px");
});

test("page uses the actual shared window class and palette instead of a separate theme", () => {
  const capture = fs.readFileSync(path.join(__dirname, "HaccpLabelCapture.jsx"), "utf8");
  const workspace = fs.readFileSync(path.join(__dirname, "HaccpWorkspace.jsx"), "utf8");
  expect(capture).toContain("workspace-surface haccp-card");
  expect(workspace.match(/workspace-surface haccp-card/g)).toHaveLength(2);
  expect(value(".haccp-ui", "--haccp-border")).toContain("var(--workspace-line,");
  expect(value(".haccp-ui", "--haccp-text")).toContain("var(--workspace-text,");
  expect(value(".haccp-ui button > svg", "color")).toContain("var(--workspace-cyan,");
});

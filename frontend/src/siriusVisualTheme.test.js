import fs from "fs";
import path from "path";
import postcss from "postcss";

const css = fs.readFileSync(path.join(__dirname, "siriusVisualTheme.css"), "utf8");
const root = postcss.parse(css);

test("the shared window skin changes surfaces without overriding saved geometry or alert colours", () => {
  const surfaceRules = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(".prime-screen") && rule.selector.includes(".auth-card")) surfaceRules.push(rule);
  });
  const surfaceRule = surfaceRules.find((rule) => rule.nodes.some((node) => node.prop === "background"));
  expect(surfaceRule).toBeDefined();
  const props = surfaceRule.nodes.map((node) => node.prop);
  expect(props).toEqual(expect.arrayContaining(["background", "border-radius", "box-shadow"]));
  expect(props).not.toEqual(expect.arrayContaining(["position"]));
  for (const prop of ["top", "left", "right", "bottom", "width", "height", "transform", "display", "color"]) {
    expect(props).not.toContain(prop);
  }
  expect(css).not.toMatch(/\.sev-critical|\.sev-severe|\.public-error|\.heph-row\.fail/);
});

test("the real reactor is reduced by 25 percent on desktop and tablet with a compact landscape size", () => {
  const rules = [];
  root.walkRules((rule) => {
    if (rule.selector.endsWith(".sirius-stage .reactor-wrap")) rules.push(rule);
  });
  expect(rules).toHaveLength(4);
  expect(rules[0].nodes.find(({ prop }) => prop === "width").value).toBe(`min(${27.54 * .75}vh, ${243 * .75}px)`);
  expect(rules[1].nodes.find(({ prop }) => prop === "width").value).toBe(`min(${24.3 * .75}vh, ${194.4 * .75}px)`);
  expect(rules[2].nodes.find(({ prop }) => prop === "width").value).toBe("min(14.58vh, 106.3125px)");
  expect(rules[3].nodes.find(({ prop }) => prop === "width").value).toBe("74px");
});

test("original palette and white subtitles are shared with lazy modules, wheels and Store", () => {
  expect(css).toContain("--workspace-cyan: #91e6f2");
  expect(css).toContain("--workspace-gold: #d8b875");
  for (const subtitle of [".sirius-tagline", ".prime-sub", ".auth-sub", ".modmenu-label small", ".public-plan-tagline"]) {
    const matches = [];
    root.walkRules((rule) => {
      if (rule.selector.includes(subtitle) && rule.nodes.some((node) => node.prop === "color" && node.value === "#ffffff")) matches.push(rule);
    });

    expect(matches.length).toBeGreaterThan(0);
  }
  const index = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  expect(index).toContain('import "./siriusVisualTheme.css"');
  expect(index).toContain('dataset.siriusVisualTheme = "classic"');
});

test("Greek letters rotate around the real core instead of translating its orbit off centre", () => {
  const keyframes = root.nodes.find((node) => node.name === "keyframes" && node.params === "workspaceOrbit");
  expect(keyframes).toBeDefined();
  keyframes.walkDecls("transform", (decl) => {
    expect(decl.value).toBe("rotate(360deg)");
  });
  expect(css).toContain("workspaceLetterCounter");
});

test("the command field stays on one line and the greeting keeps its original casing", () => {
  const declarationsFor = (selector) => {
    const declarations = {};
    root.walkRules((rule) => {
      if (rule.selector === selector && rule.parent.type === "root") {
        rule.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
      }
    });
    return declarations;
  };
  expect(declarationsFor('html[data-sirius-visual-theme="classic"] .sirius-root .cmd-bar')["flex-wrap"]).toBe("nowrap");
  expect(declarationsFor('html[data-sirius-visual-theme="classic"] .sirius-root .cmd-input')).toMatchObject({
    order: "0", flex: "1 1 0", "min-width": "0",
  });
  expect(declarationsFor('html[data-sirius-visual-theme="classic"] .sirius-center .sirius-wordmark')["text-transform"]).toBe("none");
});

test("original scenery remains visible and frames retain animated gold and RGB accents", () => {
  expect(css).not.toContain(".grid-bg");
  expect(css).not.toContain(".city-backdrop");
  expect(css).not.toContain(".vignette");
  expect(css).toContain("--workspace-frame: conic-gradient");
  expect(css).toContain("--workspace-rgb: linear-gradient");
  expect(css).toContain("animation: sirFrameSpin 14s steps(360) infinite");
  expect(css).toContain("animation: sirSpectrum 10s linear infinite");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  root.walkDecls("--workspace-frame", (decl) => {
    expect(decl.parent.selector).toContain(".holo-win");
    expect(decl.parent.selector).not.toBe('html[data-sirius-visual-theme="classic"]');
  });

  expect(css).toContain("var(--workspace-frame-colours)");
  expect(css).toContain("#00e5ff 36%");
});

test("presentation layout is enabled without requiring reduced motion", () => {
  const layouts = [];
  root.walkRules((rule) => {
    if (rule.selector === 'html[data-sirius-visual-theme="classic"] .boot-screen') layouts.push(rule);
  });

  expect(layouts.some((rule) => rule.parent.type === "root" &&
    rule.nodes.some((decl) => decl.prop === "display" && decl.value === "grid"))).toBe(true);
  for (const rule of layouts) {
    let parent = rule.parent;
    while (parent) {
      expect(parent.params || "").not.toContain("prefers-reduced-motion");
      parent = parent.parent;
    }
  }
  const modules = [];
  const titles = [];
  root.walkRules((rule) => {
    if (rule.selector === 'html[data-sirius-visual-theme="classic"] .boot-screen .boot-modules') modules.push(rule);
    if (rule.selector === 'html[data-sirius-visual-theme="classic"] .boot-screen .boot-modules-title') titles.push(rule);
  });
  expect(modules.some((rule) => rule.nodes.some((decl) => decl.prop === "transform" && decl.value === "none"))).toBe(true);
  expect(titles.some((rule) => rule.nodes.some((decl) => decl.prop === "opacity" && decl.value === "1"))).toBe(true);
});

test("startup phone layout drops secondary panels to keep the circle and status on one screen", () => {
  const phone = {};
  root.walkAtRules("media", (media) => {
    if (media.params !== "(max-width: 599px)") return;
    media.walkRules((rule) => rule.walkDecls((decl) => { phone[`${rule.selector}|${decl.prop}`] = decl.value; }));
  });
  const p = 'html[data-sirius-visual-theme="classic"]';
  expect(phone[`${p} .boot-screen .boot-modules|display`]).toBe("none");
  expect(phone[`${p} .boot-status :is(.workspace-kicker, .boot-check-details)|display`]).toBe("none");
});

test("startup acronym has larger responsive letters and extra spacing below the reactor", () => {
  const declarations = (selector) => {
    const result = {};
    root.walkRules(selector, (rule) => rule.walkDecls((decl) => { result[decl.prop] = decl.value; }));
    return result;
  };
  expect(declarations('html[data-sirius-visual-theme="classic"] .boot-acro-item b')["font-size"])
    .toBe("clamp(30px, 2.8vw, 42px)");
  expect(declarations('html[data-sirius-visual-theme="classic"] .boot-acronym').margin)
    .toBe("20px 0 0");
});

test("startup circle shrinks uniformly without changing its reserved layout space", () => {
  const rules = [];
  root.walkRules('html[data-sirius-visual-theme="classic"] .boot-screen .boot-reactor', (rule) => rules.push(rule));
  const declarations = Object.fromEntries(rules.find((rule) => rule.parent.type === "root").nodes
    .filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
  expect(declarations.transform).toBe("scale(.9)");
  expect(declarations["transform-origin"]).toBe("center");
  expect(declarations.width).toBe(declarations.height);
  expect(declarations.margin).toBe("28px 0");
});

import fs from "fs";
import path from "path";
import postcss from "postcss";

const css = fs.readFileSync(path.join(__dirname, "siriusVisualTheme.css"), "utf8");
const root = postcss.parse(css);
const appCss = fs.readFileSync(path.join(__dirname, "App.css"), "utf8");
const appRoot = postcss.parse(appCss);

test("accessible preferences reduce motion and the enlarged guide uses its zoomed containing width", () => {
  const guide = fs.readFileSync(path.join(__dirname, "components", "GettingStarted.css"), "utf8");
  const search = fs.readFileSync(path.join(__dirname, "WorkspaceSearch.css"), "utf8");
  expect(guide).toContain("width: min(680px, calc(100% - 24px))");
  expect(search).toContain("width: min(760px, calc(100% - 24px))");
  expect(css).toContain("body.hud-reduced-motion");
  expect(css).toContain("body.hud-high-contrast :focus-visible");
  expect(css).toContain("animation-iteration-count: 1 !important");
  const luminance = (hex) => {
    const linear = hex.match(/\w\w/g).map((pair) => parseInt(pair, 16) / 255)
      .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  expect((luminance("ffffff") + .05) / (luminance("071725") + .05)).toBeGreaterThanOrEqual(7);
});

test("the shared window skin changes surfaces without overriding saved geometry or alert colours", () => {
  const surfaceRules = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(".prime-screen") && rule.selector.includes(".auth-card")) surfaceRules.push(rule);
  });
  const surfaceRule = surfaceRules.find((rule) => rule.nodes.some((node) => node.prop === "background"));
  expect(surfaceRule).toBeDefined();
  const props = surfaceRule.nodes.map((node) => node.prop);
  expect(props).toEqual(expect.arrayContaining(["background", "border", "border-radius", "box-shadow"]));
  expect(surfaceRule.nodes.find((node) => node.prop === "border").value).toBe("1px solid transparent");
  expect(surfaceRule.nodes.find((node) => node.prop === "border").important).toBe(true);
  expect(surfaceRule.nodes.find((node) => node.prop === "border-radius").value).toBe("16px");
  expect(surfaceRule.nodes.find((node) => node.prop === "border-radius").important).toBe(true);
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

test("original scenery remains visible and frames retain restrained animated gold and cyan accents", () => {
  expect(css).not.toContain(".grid-bg");
  expect(css).not.toContain(".city-backdrop");
  expect(css).not.toContain(".vignette");
  expect(css).toContain("--workspace-frame: conic-gradient");
  expect(css).toContain("--workspace-rgb: linear-gradient");
  expect(css).toContain("animation: sirFrameSpin 14s steps(360) infinite");
  expect(css).toContain("animation: sirSpectrum 10s linear infinite");
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain("--workspace-rgb: linear-gradient(90deg, #c9a24d, #91e6f2 35%, #86a8ff 65%, #c9a24d)");
  root.walkDecls("--workspace-frame", (decl) => {
    expect(decl.parent.selector).toContain(".holo-win");
    expect(decl.parent.selector).not.toBe('html[data-sirius-visual-theme="classic"]');
  });

  expect(css).toContain("var(--workspace-frame-colours)");
  expect(css).toContain("#91e6f2 38%");
});

test("startup frames stay static on touch screens and in reduced-motion mode", () => {
  const rules = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(".boot-screen") && rule.selector.includes(".boot-status")) rules.push(rule);
  });
  expect(rules.some((rule) =>
    rule.parent.params === "(max-width: 1023px) and (pointer: coarse)" &&
    rule.nodes.some((node) => node.prop === "animation" && node.value === "none" && node.important)
  )).toBe(true);
  expect(rules.some((rule) =>
    rule.parent.params === "(prefers-reduced-motion: reduce)" &&
    rule.nodes.some((node) => node.prop === "animation" && node.value === "none" && node.important)
  )).toBe(true);
});

test("the fixed account pill has its own reserved space in the top bar", () => {
  const topBar = appRoot.nodes
    .filter((node) => node.type === "rule" && node.selector === ".top-bar")
    .find((rule) => rule.nodes.some((node) => node.prop === "padding"));
  expect(topBar.nodes.find((node) => node.prop === "padding").value).toBe("0 300px 0 32px");
  expect(appCss).toContain("max-width: 260px");
});

test("desktop account space survives theme overrides and narrow window layouts", () => {
  const desktopRules = {};
  appRoot.walkAtRules("media", (media) => {
    if (media.params !== "(min-width: 1024px)") return;
    media.walkRules((rule) => rule.walkDecls((decl) => {
      desktopRules[`${rule.selector.replace(/\s+/g, " ")}|${decl.prop}`] = decl.value;
    }));
  });
  expect(desktopRules['.top-bar, html[data-sirius-visual-theme="classic"] .sirius-root .top-bar|margin-right'])
    .toBe("300px");
  expect(desktopRules[".top-bar .conn-status|flex-wrap"]).toBe("nowrap");
  expect(desktopRules['.top-bar, html[data-sirius-visual-theme="classic"] .sirius-root .top-bar|overflow-x']).toBe("auto");
  expect(desktopRules[".top-bar .profile-btn|height"]).toBe("44px");
  expect(desktopRules[".top-bar .profile-btn|min-width"]).toBe("44px");
  expect(desktopRules[".top-bar .profile-btn|margin"]).toBe("0");
  expect(desktopRules[".top-bar .top-settings|gap"]).toBe("8px");
  expect(desktopRules[".top-bar .conn-status|min-width"]).toBe("0");
  expect(desktopRules[".sirius-root|grid-template-rows"]).toBe("minmax(56px, auto) minmax(0, 1fr) auto");
  const themePadding = [];
  root.walkRules('html[data-sirius-visual-theme="classic"] .sirius-root .top-bar', (rule) => {
    rule.walkDecls("padding-inline", (decl) => themePadding.push(decl.value));
  });
  expect(themePadding).toEqual(["clamp(20px, 3vw, 44px) 300px"]);
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

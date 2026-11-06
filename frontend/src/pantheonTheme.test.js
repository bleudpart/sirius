import fs from "fs";
import path from "path";
import postcss from "postcss";

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const css = read("pantheonTheme.css");
const root = postcss.parse(css);
const androidRoot = postcss.parse(read("androidHud.css"));
const electronCss = read("electronHud.css");
const electronRoot = postcss.parse(electronCss);
const surface = root.nodes.find((node) => node.type === "rule" && node.selector.includes(".sirius-module-window")
  && node.nodes.some(({ prop }) => prop === "background"));

test("the final skin is loaded after both legacy skin and window geometry", () => {
  const index = read("index.js");
  expect(index.indexOf('import "./pantheonTheme.css"')).toBeGreaterThan(index.indexOf('import "./moduleWindowLayout.css"'));
  expect(index.indexOf('import "./pantheonTheme.css"')).toBeGreaterThan(index.indexOf('import "./siriusVisualTheme.css"'));
  expect(index.indexOf('import "./androidHud.css"')).toBeGreaterThan(index.indexOf('import "./pantheonTheme.css"'));
  expect(index.indexOf('import "./electronHud.css"')).toBeGreaterThan(index.indexOf('import "./androidHud.css"'));
  expect(css).not.toContain("@import");
});

test("the Electron home keeps the Android reference composition on desktop", () => {
  const desktop = electronRoot.nodes.find((node) => node.type === "atrule" && node.params === "(min-width: 600px)");
  expect(desktop.nodes.some((node) => node.selector?.includes(".electron-home-reference .workspace-shortcuts"))).toBe(true);
  const composer = desktop.nodes.find((node) => node.selector?.includes(".electron-home-reference .pantheon-composer"));
  for (const [prop, value] of [
    ["border-radius", "999px"],
    ["background", "rgba(34, 52, 62, 0.82)"],
  ]) {
    const declaration = composer.nodes.find((node) => node.prop === prop);
    expect(declaration.value).toBe(value);
    expect(declaration.important).toBe(true);
  }
  const voiceControls = desktop.nodes.find((node) => node.selector?.includes(".electron-home-reference .pantheon-composer .voice-session-controls"));
  expect(voiceControls.selector).toContain('html[data-sirius-visual-theme="classic"][data-sirius-platform="web"]');
  expect(voiceControls.nodes.find(({ prop }) => prop === "display").value).toBe("contents");
  const topBar = desktop.nodes.find((node) => node.selector?.includes(".electron-home-reference .top-bar"));
  expect(topBar.nodes.filter((node) => node.type === "decl").map(({ prop, value }) => [prop, value]))
    .toContainEqual(["margin-right", "0"]);
  expect(topBar.nodes.filter((node) => node.type === "decl").map(({ prop, value }) => [prop, value]))
    .toContainEqual(["align-self", "center"]);
  expect(topBar.nodes.filter((node) => node.type === "decl").map(({ prop, value }) => [prop, value]))
    .toContainEqual(["padding", "1px 8px"]);
  const accountChip = desktop.nodes.find((node) => node.selector === "body:has(.sirius-root.electron-home-reference) .auth-chip");
  expect(accountChip.nodes.find(({ prop }) => prop === "right").value).toBe("56px");
  const footer = desktop.nodes.find((node) => node.selector === ".sirius-root.electron-home-reference .sirius-footer");
  expect(footer.nodes.map(({ prop, value }) => [prop, value]))
    .toEqual([["display", "block"], ["position", "static"]]);
  expect(desktop.nodes.some((node) => node.selector?.includes(".sirius-footer")
    && node.nodes.some(({ prop, value }) => prop === "display" && value === "none"))).toBe(false);
  expect(electronCss).toContain(".sirius-root.electron-home-reference .sirius-stage");
  expect(electronCss).toContain(".sirius-root.electron-home-reference .corner");
  const reactorPosition = desktop.nodes.find((node) => node.selector?.includes(".sirius-stage .reactor-wrap")
    && node.nodes.some(({ prop }) => prop === "top"));
  expect(reactorPosition.selector).toContain(".sirius-stage::before");
  expect(reactorPosition.nodes.filter((node) => node.type === "decl").map(({ prop, value }) => [prop, value]))
    .toEqual([["top", "42%"]]);
  const androidMobile = androidRoot.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 599px)");
  const androidFooter = androidMobile.nodes.find((node) => node.selector?.endsWith(".android-home-reference .sirius-footer"));
  expect(androidFooter.nodes.filter((node) => node.type === "decl").map(({ prop, value }) => [prop, value]))
    .toContainEqual(["display", "block"]);
  expect(androidFooter.nodes.filter((node) => node.type === "decl").map(({ prop, value }) => [prop, value]))
    .toContainEqual(["white-space", "normal"]);
  const baseMobile = postcss.parse(read("App.css")).nodes.find((node) => node.type === "atrule"
    && node.params === "(max-width: 599px)" && node.nodes.some(({ selector }) => selector === ".sirius-footer"));
  const webMobileFooter = baseMobile.nodes.find((node) => node.selector === ".sirius-footer");
  expect(webMobileFooter.nodes.map(({ prop, value }) => [prop, value])).toContainEqual(["display", "block"]);
  expect(webMobileFooter.nodes.map(({ prop, value }) => [prop, value])).toContainEqual(["white-space", "normal"]);
});

test("the Electron home keeps the lower controls reachable when the HUD is scaled", () => {
  const desktop = electronRoot.nodes.find((node) => node.type === "atrule" && node.params === "(min-width: 600px)");
  const rule = (suffix) => desktop.nodes.find((node) => node.selector?.endsWith(suffix));
  const value = (node, prop) => node.nodes.find((declaration) => declaration.prop === prop).value;
  const dashboard = rule(".electron-home-reference:not(.mobile-section-info) .sirius-dashboard--hub");
  const center = rule(".electron-home-reference .sirius-center");
  const spacer = rule(".electron-home-reference:not(.mobile-section-info) .sirius-center::after");
  const command = rule(".electron-home-reference .sirius-command-area");

  expect(value(dashboard, "height")).toBe("var(--hud-layout-height, 100%)");
  expect(value(center, "overflow-y")).toBe("auto");
  expect(value(spacer, "order")).toBe("1");
  expect(value(spacer, "flex")).toBe("0 0 max(0px, var(--hud-spacer-compensation, 0%))");
  expect(value(command, "order")).toBe("2");
  expect(value(command, "max-width")).toBe("min(100%, var(--hud-layout-height, 100%))");
});

test("the Electron home keeps the lower controls reachable in narrow windows", () => {
  const narrow = electronRoot.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 599px)");
  const compact = electronRoot.nodes.find((node) => node.type === "atrule"
    && node.params === "(max-width: 599px) and (max-height: 500px)");
  const rule = (container, suffix) => container.nodes.find((node) => node.selector?.endsWith(suffix)
    && !node.selector.includes(","));
  const value = (node, prop) => node.nodes.find((declaration) => declaration.prop === prop).value;
  const dashboard = rule(narrow, ".electron-home-reference:not(.mobile-section-info) .sirius-dashboard--hub");
  const center = rule(narrow, ".electron-home-reference:not(.mobile-section-info) .sirius-center");
  const spacers = narrow.nodes.find((node) => node.selector?.includes(".sirius-center::before,"));
  const before = rule(narrow, ".electron-home-reference:not(.mobile-section-info) .sirius-center::before");
  const after = rule(narrow, ".electron-home-reference:not(.mobile-section-info) .sirius-center::after");
  const command = rule(narrow, ".electron-home-reference:not(.mobile-section-info) .sirius-command-area");

  expect(value(dashboard, "height")).toBe("var(--hud-layout-height, 100%)");
  expect(value(center, "justify-content")).toBe("flex-start");
  expect(value(center, "overflow-y")).toBe("auto");
  expect(value(spacers, "content")).toBe('""');
  expect(value(before, "order")).toBe("-2");
  expect(value(before, "flex")).toBe("1 1 0");
  expect(value(after, "order")).toBe("1");
  expect(value(after, "flex")).toBe("1 1 max(0px, var(--hud-spacer-compensation, 0%))");
  expect(value(command, "order")).toBe("2");
  expect(value(command, "max-width")).toBe("min(100%, var(--hud-layout-height, 100%))");
  expect(value(command, "margin-inline")).toBe("auto");
  expect(value(rule(compact, ".sirius-identity"), "margin-bottom")).toBe("4px");
  expect(value(rule(compact, ".sirius-command-area"), "margin-top")).toBe("4px");
});

test("the Android toolbar stays inside the frame without overlapping the welcome", () => {
  const mobile = androidRoot.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 599px)");
  const layout = mobile.nodes.find((node) => node.selector === ".sirius-root.android-home-reference");
  const toolbar = mobile.nodes.find((node) => node.selector === ".sirius-root.android-home-reference .top-bar");
  const center = mobile.nodes.find((node) => node.selector === ".sirius-root.android-home-reference .sirius-center");
  const identity = mobile.nodes.find((node) => node.selector === ".sirius-root.android-home-reference .sirius-identity");
  const corner = postcss.parse(read("App.css")).nodes.find((node) => node.selector === ".corner.tl");
  const value = (rule, prop) => rule.nodes.find((node) => node.prop === prop).value;

  expect(value(toolbar, "position")).toBe("relative");
  expect(value(toolbar, "justify-self")).toBe("center");
  expect(value(center, "overflow-x")).toBe("hidden");
  expect(value(center, "overflow-y")).toBe("auto");
  expect(value(identity, "position")).toBe("sticky");

  const toolbarTop = parseFloat(value(toolbar, "top"));
  const toolbarHeight = parseFloat(value(toolbar, "height"));
  const topRowHeight = parseFloat(value(layout, "grid-template-rows"));
  const welcomeInset = parseFloat(value(identity, "top"));
  expect(toolbarTop - parseFloat(value(corner, "top"))).toBeGreaterThanOrEqual(4);
  expect(topRowHeight + welcomeInset - toolbarTop - toolbarHeight).toBeGreaterThanOrEqual(8);
  expect(parseFloat(value(identity, "margin-top")) + parseFloat(value(identity, "margin-bottom"))).toBe(0);
});

test("the Android lower block follows the scaled dashboard and remains reachable on short screens", () => {
  const mobile = androidRoot.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 599px)");
  const rule = (selector) => mobile.nodes.find((node) => node.selector === selector);
  const value = (node, prop) => node.nodes.find((declaration) => declaration.prop === prop).value;
  const dashboard = rule(".sirius-root.android-home-reference .sirius-dashboard");
  const infoDashboard = rule(".sirius-root.android-home-reference.mobile-section-info .sirius-dashboard");
  const command = rule(".sirius-root.android-home-reference .sirius-command-area");
  const spacer = rule(".sirius-root.android-home-reference .sirius-center::after");
  const compact = mobile.nodes.find((node) => node.type === "atrule" && node.params === "android-hud (max-height: 500px)");
  const compactRule = (suffix) => compact.nodes.find((node) => node.selector?.endsWith(suffix));

  expect(value(dashboard, "height")).toBe("var(--hud-layout-height, 100%)");
  expect(value(dashboard, "container")).toBe("android-hud / size");
  expect(value(infoDashboard, "height")).toBe("100%");
  expect(value(command, "padding")).toBe("4px 7px 8px");
  expect(value(command, "max-width")).toBe("min(100%, var(--hud-layout-height, 100%))");
  expect(value(command, "margin-inline")).toBe("auto");
  expect(value(spacer, "flex")).toBe("1 1 max(0px, calc(28px + var(--hud-spacer-compensation, 0%)))");
  expect(value(compactRule(".sirius-center"), "margin-top")).toBe("24px");
  expect(value(rule(".sirius-root.android-home-reference .sirius-center"), "overflow-y")).toBe("auto");
  expect(value(compactRule(".sirius-identity"), "position")).toBe("static");
  expect(value(compactRule(".sirius-stage"), "min-height")).toBe("48px");
  expect(value(compactRule(".reactor-wrap"), "height")).toBe("min(119px, 70%)");
  expect(value(compactRule(".reactor-wrap::before"), "inset")).toBe("-14%");
});

test("the Android cyan pulse has no inherited gold outline", () => {
  const mobile = androidRoot.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 599px)");
  const pulse = mobile.nodes.find((node) => node.selector === ".sirius-root.android-home-reference .sirius-stage .reactor-wrap::after");
  const value = (prop) => pulse.nodes.find((node) => node.prop === prop).value;
  expect(value("border")).toBe("0");
  expect(value("background")).toContain("circle closest-side");
  expect(value("background")).toContain("transparent 100%");
  expect(value("box-shadow")).toBe("none");
  expect(value("mix-blend-mode")).toBe("screen");
  expect(value("animation")).toBe("android-core-breathe 2.8s ease-in-out infinite");
});

test("the Android capsule keeps the quit icon visible and aligned with the other controls", () => {
  const mobile = androidRoot.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 599px)");
  const hidden = mobile.nodes.find((node) => node.selector?.includes(".conn-status > :not"));
  expect(hidden.selector).toContain(":not(.sirius-mobile-exit)");
  const controls = mobile.nodes.find((node) => node.selector?.includes(".sirius-mobile-exit,"));
  const value = (rule, prop) => rule.nodes.find((node) => node.prop === prop).value;
  expect(value(controls, "display")).toBe("inline-flex");
  expect(value(controls, "width")).toBe("34px");
  expect(value(controls, "height")).toBe("34px");
  expect(value(controls, "border-radius")).toBe("50%");
  const quit = mobile.nodes.find((node) => node.selector?.endsWith(".sirius-mobile-exit"));
  expect(value(quit, "order")).toBe("5");
});

test("the Android composer keeps its rounded cyan surface over the shared theme", () => {
  const mobile = androidRoot.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 599px)");
  const composer = mobile.nodes.find((node) => node.selector?.endsWith(".pantheon-composer"));
  for (const [prop, value] of [
    ["border", "1px solid rgba(145, 230, 242, 0.34)"],
    ["border-radius", "999px"],
    ["background", "rgba(34, 52, 62, 0.82)"],
    ["box-shadow", "inset 0 1px 0 rgba(214, 248, 255, 0.06), 0 8px 20px rgba(0, 0, 0, 0.18), var(--sirius-glow-frame, 0 0 transparent)"],
  ]) {
    const declaration = composer.nodes.find((node) => node.prop === prop);
    expect(declaration.value).toBe(value);
    expect(declaration.important).toBe(true);
  }
  expect(composer.nodes.find(({ prop }) => prop === "grid-template-columns").value).toBe("minmax(0, 1fr) 30px");
  const emblem = mobile.nodes.find((node) => node.selector?.endsWith(".voice-session-controls .voice-session-emblem"));
  expect(emblem.nodes.find(({ prop }) => prop === "display").value).toBe("none");
  const command = mobile.nodes.find((node) => node.selector?.endsWith(".pantheon-composer .cmd-bar"));
  const stop = mobile.nodes.find((node) => node.selector?.endsWith(".voice-session-controls button"));
  expect(command.nodes.find(({ prop }) => prop === "grid-column").value).toBe("1");
  expect(stop.nodes.find(({ prop }) => prop === "grid-column").value).toBe("2");
});

test("the chat waveform stays inside its flexible field without intercepting input", () => {
  const app = postcss.parse(read("App.css"));
  const wrapper = app.nodes.find((node) => node.selector === ".cmd-input-wrap");
  const canvas = app.nodes.find((node) => node.selector === ".cmd-input-wrap .waveform-canvas");
  expect(wrapper.nodes.map(({ prop, value }) => [prop, value])).toEqual(expect.arrayContaining([
    ["position", "relative"], ["min-width", "0"], ["flex", "1 1 0"],
  ]));
  expect(canvas.nodes.map(({ prop, value }) => [prop, value])).toEqual(expect.arrayContaining([
    ["position", "absolute"], ["width", "min(100%, 300px)"], ["height", "12px"], ["pointer-events", "none"],
    ["opacity", "1"], ["filter", "saturate(1.4) brightness(1.1)"],
  ]));
  const reference = app.nodes.find((node) => node.selector === ".cmd-input-wrap .waveform-canvas--reference");
  expect(reference.nodes.map(({ prop, value }) => [prop, value])).toEqual(expect.arrayContaining([
    ["width", "min(100%, 260px)"], ["height", "16px"], ["bottom", "1px"],
  ]));
  const activeReference = app.nodes.find((node) => node.selector?.includes(".android-home-reference, .electron-home-reference")
    && node.selector.includes(".cmd-input-wrap.is-active .cmd-input"));
  expect(activeReference.nodes.find(({ prop }) => prop === "padding-bottom").value).toBe("18px");
});

test("all existing shared surfaces and specialised dialogs use the skin without geometry changes", () => {
  const legacy = postcss.parse(read("siriusVisualTheme.css"));
  const oldSurface = legacy.nodes.find((node) => node.type === "rule" && node.selector.includes(".prime-screen") && node.selector.includes(".auth-card"));
  for (const name of oldSurface.selector.match(/\.[\w-]+/g)) expect(surface.selector).toContain(name);
  for (const name of [".sirius-module-window", ".workspace-search", ".document-scanner", ".th-modal",
    ".atlas-keyscreen", ".media-hud-standalone", '[role="dialog"]']) expect(surface.selector).toContain(name);
  for (const name of [".spectator-view", ".spectator-head", ".spectator-title"]) expect(css).toContain(name);
  for (const prop of ["position", "z-index", "top", "left", "width", "height", "transform", "display", "color"]) {
    expect(surface.nodes.map(({ prop }) => prop)).not.toContain(prop);
  }
});

test("afterglow lasts nine seconds and has a continuous 6.3 second fade with matching shadow shapes", () => {
  expect(css).toContain("pantheonAfterglow 9s cubic-bezier(.4, 0, .2, 1) infinite");
  const keyframes = root.nodes.find((node) => node.name === "keyframes" && node.params === "pantheonAfterglow");
  expect(keyframes.nodes.map(({ selector }) => selector)).toEqual(["0%, 100%", "30%"]);
  const shadows = keyframes.nodes.map((node) => node.nodes.find(({ prop }) => prop === "box-shadow").value);
  expect(shadows.map((value) => value.split(",").length)).toEqual([4, 4]);
  expect(shadows[0]).toContain("var(--sirius-glow-frame)");
  expect(css).toContain('body:has(.sirius-root[data-pantheon-active="true"])');
  expect(read("App.js")).toContain('data-pantheon-active={booting || status !== "idle" || voicePhase !== "idle"}');
});

test("the shared glow reaches both home layouts and themed surfaces without changing their geometry", () => {
  const theme = root.nodes.find((node) => node.type === "rule"
    && node.selector === 'html[data-sirius-visual-theme="classic"][data-sirius-platform]');
  const value = (rule, prop) => rule.nodes.find((node) => node.prop === prop)?.value;
  expect(value(theme, "--sirius-glow-frame")).toBe("0 0 18px rgba(145, 230, 242, 0.16)");
  expect(value(theme, "--sirius-glow-control")).toBe("0 0 9px rgba(145, 230, 242, 0.14)");
  expect(value(theme, "--sirius-glow-gold")).toBe("0 0 14px rgba(216, 184, 117, 0.28)");
  expect(value(theme, "--workspace-shadow")).toContain("var(--sirius-glow-frame)");
  expect(value(surface, "box-shadow")).toBe("var(--workspace-shadow)");
  const titles = root.nodes.find((node) => node.selector?.includes(".oracle-title")
    && node.nodes.some(({ prop }) => prop === "text-shadow"));
  expect(value(titles, "text-shadow")).toBe("var(--sirius-glow-gold)");
  for (const [platform, selector] of [
    [androidRoot, ".android-home-reference"],
    [electronRoot, ".electron-home-reference"],
  ]) {
    const rules = [];
    platform.walkRules((rule) => {
      if (rule.selector.includes(selector)) rules.push(rule);
    });
    for (const target of [".top-bar", ".pantheon-composer"]) {
      expect(rules.some((rule) => rule.selector.endsWith(target)
        && value(rule, "box-shadow")?.includes("var(--sirius-glow-frame"))).toBe(true);
    }
    expect(rules.some((rule) => rule.selector.includes(".workspace-shortcuts")
      && value(rule, "box-shadow")?.includes("var(--sirius-glow-control"))).toBe(true);
    expect(rules.some((rule) => rule.selector.endsWith(".cmd-send")
      && value(rule, "box-shadow")?.includes("var(--sirius-glow-gold-control"))).toBe(true);
  }
});

test("reduced motion, eco, background and Android stop frame illumination", () => {
  for (const value of ["prefers-reduced-motion", "pointer: coarse", "body.hud-reduced-motion",
    ".sirius-root.eco", ".sirius-root.backgrounded", 'data-sirius-platform="android"']) expect(css).toContain(value);
  expect(css).not.toMatch(/\.sev-critical|\.public-error|\.heph-row\.fail/);
});

test("composer retains voice interruption and suggestions never submit commands", () => {
  const app = read("App.js");
  expect(app).toContain('className="pantheon-composer"');
  expect(app).toContain("onStop={stopVoice}");
  expect(app).toContain("setCmd(command); commandInputRef.current?.focus();");
  expect(css).toContain(".cmd-bar .cmd-send { color: #0b131f; background: var(--workspace-gold); }");
  expect(css).toContain(".boot-screen .boot-bar { height: 2px; }");
  expect(css).toContain("grid-template-rows: repeat(4, max-content)");
});

test("welcome and send share honey and top buttons use the settings dimensions", () => {
  const buttons = root.nodes.find((node) => node.type === "rule" && node.selector.endsWith(".top-bar .profile-btn"));
  for (const prop of ["width", "height", "min-width", "min-height"]) {
    expect(buttons.nodes.find((node) => node.prop === prop).value).toBe("44px");
  }
  const welcome = root.nodes.find((node) => node.type === "rule" && node.selector.endsWith(".sirius-center .sirius-wordmark"));
  expect(welcome.nodes.find(({ prop }) => prop === "color").value).toBe("var(--workspace-gold)");
  expect(welcome.nodes.find(({ prop }) => prop === "text-shadow").value).toBe("var(--sirius-glow-gold)");
  expect(welcome.nodes.find(({ prop }) => prop === "text-transform").value).toBe("none");
  expect(welcome.nodes.find(({ prop }) => prop === "letter-spacing").value).toBe("normal");
  expect(welcome.nodes.find(({ prop }) => prop === "word-spacing").value).toBe("normal");
});

test("mobile header keeps compact controls on a single line", () => {
  const mobile = root.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 1023px)"
    && node.nodes.some((rule) => rule.selector?.endsWith(".top-bar .conn-status")));
  const header = mobile.nodes.find((node) => node.selector?.endsWith(".top-bar"));
  expect(header.nodes.find(({ prop }) => prop === "flex-direction").value).toBe("row");
  expect(header.nodes.find(({ prop }) => prop === "justify-content").value).toBe("center");
  const connections = mobile.nodes.find((node) => node.selector?.endsWith(".top-bar .conn-status"));
  expect(connections.nodes.find(({ prop }) => prop === "flex-wrap").value).toBe("nowrap");
  expect(connections.nodes.find(({ prop }) => prop === "margin-left").value).toBe("0");
  expect(connections.nodes.find(({ prop }) => prop === "justify-content").value).toBe("flex-start");
  const buttons = mobile.nodes.find((node) => node.selector?.endsWith(".top-bar .profile-btn"));
  expect(buttons.nodes.find(({ prop }) => prop === "width").value).toBe("32px");
  const microphone = mobile.nodes.find((node) => node.selector?.endsWith(".top-bar .mic-status-pill"));
  expect(microphone.nodes.find(({ prop }) => prop === "display").value).toBe("inline-flex");
  const landscape = mobile.nodes.find((node) => node.type === "atrule"
    && node.params === "(max-width: 1023px) and (orientation: landscape)");
  expect(landscape.nodes[0].nodes.find(({ prop }) => prop === "padding-inline").value).toBe("32px");
  const app = read("App.js");
  expect(app).toContain('aria-label="Test micro : conversation continue avec transcription serveur"');
  expect(app).not.toContain("<Radio size={15} /> Test micro");
  expect(app).toContain('<span className="sirius-mobile-introduction">Je suis ΣIRIUS</span>');
  expect(app.indexOf('className="sirius-mobile-introduction"')).toBeLessThan(app.indexOf('className="sirius-wordmark workspace-welcome"'));
});

test("mobile microphone panel keeps status, engine and stop on one compact row", () => {
  const mobile = root.nodes.find((node) => node.type === "atrule" && node.params === "(max-width: 1023px)"
    && node.nodes.some((rule) => rule.selector?.endsWith(".pantheon-composer .voice-session-controls")));
  const controls = mobile.nodes.find((node) => node.selector?.endsWith(".pantheon-composer .voice-session-controls"));
  const composer = mobile.nodes.find((node) => node.selector?.endsWith(".pantheon-composer"));
  expect(composer.nodes.find(({ prop }) => prop === "display").value).toBe("grid");
  expect(composer.nodes.find(({ prop }) => prop === "gap").value).toBe("6px");
  expect(composer.nodes.find(({ prop }) => prop === "padding").value).toBe("7px 8px");
  expect(controls.nodes.find(({ prop }) => prop === "grid-template-columns").value).toBe("24px minmax(0, 1fr) minmax(0, 96px) 32px");
  const withoutEngine = mobile.nodes.find((node) => node.selector?.endsWith(".pantheon-composer .voice-session-controls:not(:has(select))"));
  expect(withoutEngine.nodes.find(({ prop }) => prop === "grid-template-columns").value).toBe("24px minmax(0, 1fr) 32px");
  const stop = mobile.nodes.find((node) => node.selector?.endsWith(".voice-session-controls button"));
  expect(stop.nodes.find(({ prop }) => prop === "height").value).toBe("32px");
  expect(stop.nodes.find(({ prop }) => prop === "grid-column").value).toBe("-2");
  const engine = mobile.nodes.find((node) => node.selector?.endsWith(".voice-session-controls label"));
  expect(engine.nodes.find(({ prop }) => prop === "grid-column").value).toBe("3");
  const chat = mobile.nodes.find((node) => node.selector?.endsWith(".cmd-bar :is(.ptt-btn, .cmd-send)"));
  for (const prop of ["width", "height", "min-width", "min-height"]) {
    expect(chat.nodes.find((node) => node.prop === prop).value).toBe("32px");
  }
  expect(read("components/VoiceSessionControls.jsx")).toContain('aria-label="Arrêter le microphone et la réponse"');
});

test("portrait chat insets its controls away from the decorative frame", () => {
  const portrait = root.nodes.find((node) => node.type === "atrule"
    && node.params === "(max-width: 1023px) and (orientation: portrait)");
  const composer = portrait.nodes.find((node) => node.selector?.endsWith(".pantheon-composer"));
  expect(composer.nodes.find(({ prop }) => prop === "padding-inline").value).toBe("20px");
  expect(read("App.js")).not.toContain('              placeholder="Écrivez à ΣIRIUS…"');
  expect(read("App.js")).toContain('aria-label="Votre demande à ΣIRIUS"');
});

test("portrait reactor is fifteen percent smaller without changing landscape or boot", () => {
  const portrait = root.nodes.find((node) => node.type === "atrule"
    && node.params === "(max-width: 1023px) and (orientation: portrait)");
  const reactor = portrait.nodes.find((node) => node.selector?.endsWith(".sirius-stage .reactor-wrap"));
  for (const prop of ["width", "height"]) {
    expect(reactor.nodes.find((node) => node.prop === prop).value).toBe("clamp(119px, 14.96vh, 160px)");
  }
  expect(reactor.selector).not.toContain(".boot-reactor");
});

test("boot keeps the existing orbiting Greek letters visible on mobile", () => {
  const orbit = root.nodes.find((node) => node.type === "rule"
    && node.selector.endsWith(".boot-screen .boot-reactor .core-orbit"));
  expect(orbit.nodes.find(({ prop }) => prop === "display").value).toBe("block");
  expect(read("components/ReactorVisuals.jsx")).toContain('className="core-orbit"');
});

test("information centre clock uses honey in both inline and detached panels", () => {
  const clock = root.nodes.find((node) => node.type === "rule" && node.selector.endsWith(":is(.infowheel, .shud-hub, .shud-clock) .hud-time"));
  for (const prop of ["color", "-webkit-text-fill-color"]) {
    expect(clock.nodes.find((node) => node.prop === prop).value).toBe("var(--workspace-gold)");
  }
});

test("orbital windows retain full-sized separated close and minimise controls", () => {
  const controls = root.nodes.find((node) => node.type === "rule" && node.selector.includes(".modwheel :is(.modwheel-close, .modwheel-min)"));
  for (const prop of ["width", "height", "min-width", "min-height"]) {
    expect(controls.nodes.find((node) => node.prop === prop).value).toBe("44px");
  }
  expect(css).toContain(".modwheel .modwheel-min { right: 64px; }");
  expect(css).toContain(".modwheel .modwheel-search { margin-right: 104px; }");
  expect(css).toContain(".workspace-search > header > button");
  expect(css).toContain(".sirius-display .sd-bar > button");
});

test("labelled module actions do not inherit the compact composer arrow width", () => {
  const buttons = root.nodes.find((node) => node.type === "rule" && node.selector.includes(".sirius-module-window .cmd-send:not(.cmd-bar > .cmd-send)"));
  expect(buttons.nodes.find(({ prop }) => prop === "width").value).toBe("auto");
  expect(buttons.nodes.find(({ prop }) => prop === "min-height").value).toBe("44px");
  expect(buttons.nodes.find(({ prop }) => prop === "display").value).toBe("inline-flex");
});

test("inline calendar navigation stays inside its section instead of overlapping window controls", () => {
  const nav = root.nodes.find((node) => node.type === "rule" && node.selector.endsWith(".infowheel .shud-cal-nav"));
  expect(nav.nodes.find(({ prop }) => prop === "position").value).toBe("static");
  const buttons = root.nodes.find((node) => node.type === "rule" && node.selector.endsWith(".infowheel .shud-cal-nav > button"));
  for (const prop of ["width", "height"]) expect(buttons.nodes.find((node) => node.prop === prop).value).toBe("44px");
});

test("decorative spectrum becomes a one pixel honey line without changing alert colours", () => {
  const dial = root.nodes.find((node) => node.type === "rule" && node.selector.endsWith(".modwheel-dial::before"));
  expect(dial.nodes.find(({ prop }) => prop === "background").value).toBe("var(--workspace-gold)");
  expect(dial.nodes.find(({ prop }) => prop === "animation").value).toBe("none");
  const line = root.nodes.find((node) => node.type === "rule" && node.selector.endsWith(".shud-panel::before"));
  expect(line.nodes.find(({ prop }) => prop === "height").value).toBe("1px");
  const header = root.nodes.find((node) => node.type === "rule" && node.selector.includes(".spectator-head") && node.selector.includes(".sd-bar"));
  expect(header.nodes.find(({ prop }) => prop === "border-image").value).toBe("none");
  expect(header.nodes.find(({ prop }) => prop === "border-bottom-width").value).toBe("1px");
  expect(css).not.toMatch(/#[0-9a-f]{6}.*hue-rotate|grayscale\(/i);
});

test("module portraits share responsive four-to-five frames without cropping", () => {
  expect(css).toContain("--pantheon-portrait-width: 128px");
  expect(css).toContain("--pantheon-portrait-height: 160px");
  expect(css).toContain("--pantheon-portrait-width: 96px");
  expect(css).toContain("--pantheon-portrait-height: 120px");
  const portrait = root.nodes.find((node) => node.type === "rule" && node.selector.includes("img.numm-avatar"));
  expect(portrait.nodes.find(({ prop }) => prop === "object-fit").value).toBe("contain");
  for (const name of ["img.mythos-avatar", ".consult-portrait > img", ".work-portrait > img", ".kr-character > img"]) {
    expect(portrait.selector).toContain(name);
  }
});

test("boot reference keeps diagnostics expandable without changing the animated circle", () => {
  const referenceRules = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(".boot-screen.boot-reference")) referenceRules.push(rule);
  });
  expect(referenceRules.length).toBeGreaterThan(0);
  expect(referenceRules.some((rule) => rule.selector.includes(".boot-reactor"))).toBe(false);
  expect(css).toContain("grid-template-rows: minmax(min-content, 1fr) auto");
  const center = referenceRules.find((rule) => rule.selector.includes(".boot-reference .boot-center"));
  expect(center.nodes.find(({ prop }) => prop === "row-gap").value).toBe("clamp(8px, 2.4vh, 20px)");
  const status = referenceRules.find((rule) => rule.selector.includes(".boot-reference .boot-status")
    && rule.nodes.some(({ prop }) => prop === "margin"));
  expect(status.nodes.find(({ prop }) => prop === "margin").value).toBe("0 0 12px");
  const copyright = referenceRules.find((rule) => rule.selector.includes(".boot-reference .boot-copyright"));
  expect(copyright.nodes.some(({ prop, value }) => prop === "display" && value === "none")).toBe(false);
  expect(copyright.nodes.find(({ prop }) => prop === "align-self").value).toBe("end");
  const shortScreen = referenceRules.find((rule) => rule.parent.params === "(max-height: 560px)"
    && rule.selector.includes(".boot-reference .boot-status"));
  expect(shortScreen.nodes.find(({ prop }) => prop === "margin-bottom").value).toBe("0");
  expect(css).toContain(".boot-check-details:not([open]) .boot-display");
  expect(css).toContain("font: 400 clamp(21px, 5vw, 28px)/1.35 Georgia, serif");
  const screen = read("components/HudPanels.jsx");
  expect(screen).toContain("<CoreRings />");
  expect(screen).toContain('<ReactorCore status="thinking" volume={0.35} color="#91e6f2" eco={false} />');
});

test("boot reference inherits the original heading, progress and diagnostic colours", () => {
  const referenceRules = [];
  root.walkRules((rule) => {
    if (rule.selector.includes(".boot-screen.boot-reference")) referenceRules.push(rule);
  });
  for (const rule of referenceRules) {
    if (/\.boot-welcome|\.boot-status h2|\.boot-pct|\.boot-check-details|\.boot-modules-title/.test(rule.selector)) {
      expect(rule.nodes.some(({ prop }) => prop === "color")).toBe(false);
    }
    if (/\.boot-bar(?:,|\s|$)/.test(rule.selector)) {
      expect(rule.nodes.some(({ prop }) => prop === "background")).toBe(false);
    }
  }
  expect(referenceRules.some((rule) => rule.selector.includes(".boot-bar-fill"))).toBe(false);
  const originalProgress = root.nodes.find((node) => node.type === "rule"
    && node.selector === 'html[data-sirius-visual-theme="classic"][data-sirius-platform] .boot-screen .boot-bar-fill');
  expect(originalProgress.nodes.find(({ prop }) => prop === "background").value)
    .toBe("linear-gradient(90deg, #c5a059, #91d9db)");
  const originalHeadings = root.nodes.find((node) => node.type === "rule"
    && node.selector.includes(".boot-welcome") && node.selector.includes(".boot-status h2"));
  expect(originalHeadings.nodes.find(({ prop }) => prop === "color").value).toBe("#e2c78f");
});

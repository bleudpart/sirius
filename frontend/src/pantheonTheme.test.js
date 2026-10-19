import fs from "fs";
import path from "path";
import postcss from "postcss";

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const css = read("pantheonTheme.css");
const root = postcss.parse(css);
const surface = root.nodes.find((node) => node.type === "rule" && node.selector.includes(".sirius-module-window")
  && node.nodes.some(({ prop }) => prop === "background"));

test("the final skin is loaded after both legacy skin and window geometry", () => {
  const index = read("index.js");
  expect(index.indexOf('import "./pantheonTheme.css"')).toBeGreaterThan(index.indexOf('import "./moduleWindowLayout.css"'));
  expect(index.indexOf('import "./pantheonTheme.css"')).toBeGreaterThan(index.indexOf('import "./siriusVisualTheme.css"'));
  expect(css).not.toContain("@import");
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
  expect(css).toContain('body:has(.sirius-root[data-pantheon-active="true"])');
  expect(read("App.js")).toContain('data-pantheon-active={booting || status !== "idle" || voicePhase !== "idle"}');
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
  expect(app).toContain("setCmd(suggestion); commandInputRef.current?.focus();");
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
  expect(read("App.js")).toContain('placeholder="Écrivez à ΣIRIUS…"');
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

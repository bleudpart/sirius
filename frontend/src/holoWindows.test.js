import { initHoloWindows, resetHoloWindowLayout } from "./holoWindows";

let observer;
const originalMatchMedia = window.matchMedia;
const originalObserver = global.MutationObserver;

beforeEach(() => {
  window.matchMedia = jest.fn(() => ({ matches: true }));
  global.MutationObserver = class {
    constructor(callback) { observer = callback; }
    observe() {}
  };
  delete window.__holoWinInit;
});

afterEach(() => {
  document.body.innerHTML = "";
  delete window.__holoWinInit;
  window.matchMedia = originalMatchMedia;
  global.MutationObserver = originalObserver;
});

test.each(["prime-screen", "fp-overlay", "p3d-overlay", "vision-card", "keys-panel", "sp-journal", "getting-started", "media-hud-window", "productivity-screen", "archive-gallery"])(
  "%s has matching controls and restores its content from the dock", (className) => {
    const panel = document.createElement("section");
    panel.className = className;
    panel.innerHTML = '<header><h2>Fenêtre de test</h2><button aria-label="Fermer"><svg class="lucide-x"></svg></button></header><input value="contenu conservé">';
    document.body.appendChild(panel);
    initHoloWindows();
    expect(panel.querySelectorAll(".mobile-window-min")).toHaveLength(1);
    expect(panel.querySelector(".mobile-window-close")).not.toBeNull();
    panel.querySelector(".mobile-window-min").click();
    expect(panel.classList.contains("holo-minimized")).toBe(true);
    const pill = document.querySelector(".holo-dock-pill");
    expect(pill.textContent).toBe("FENÊTRE DE TEST");
    pill.querySelector(".hdp-restore").click();
    expect(panel.classList.contains("holo-minimized")).toBe(false);
    expect(document.querySelector(".holo-dock-pill")).toBeNull();
    expect(panel.querySelector("input").value).toBe("contenu conservé");
    panel.querySelector(".mobile-window-min").click();
    panel.remove();
    observer([{ addedNodes: [], removedNodes: [panel] }]);
    expect(document.querySelector(".holo-dock-pill")).toBeNull();
  }
);

test("an explicit module minimize button is reused without a duplicate handler or icon replacement", () => {
  document.body.innerHTML = '<section class="prime-screen"><header><h2>Ma voix</h2><button class="holo-win-min" aria-label="Réduire la fenêtre"><svg data-native-icon="true"></svg></button><button aria-label="Fermer">×</button></header></section>';
  const button = document.querySelector(".holo-win-min");
  const click = jest.fn();
  button.addEventListener("click", click);
  initHoloWindows();
  expect(document.querySelectorAll(".holo-win-min")).toHaveLength(1);
  expect(button.querySelector("[data-native-icon]")).not.toBeNull();
  button.click();
  expect(click).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".holo-dock-pill")).toBeNull();
});

test.each([true, false])("la croix ferme le module réduit sans le restaurer (mobile=%s)", (mobile) => {
  window.matchMedia.mockReturnValue({ matches: mobile });
  const panel = document.createElement("section");
  panel.className = "prime-screen";
  panel.innerHTML = '<header><h2>Module réduit</h2><button aria-label="Fermer"><svg class="lucide-x"></svg></button></header><input value="état">';
  const close = jest.fn(() => panel.remove());
  panel.querySelector('[aria-label="Fermer"]').addEventListener("click", close);
  document.body.appendChild(panel);
  initHoloWindows();
  panel.querySelector(".holo-win-min").click();
  const restore = jest.fn();
  document.querySelector(".hdp-restore").addEventListener("click", restore);
  const button = document.querySelector(".minimized-pill-close");
  expect(button.getAttribute("aria-label")).toBe("Fermer MODULE RÉDUIT");
  button.click();
  expect(close).toHaveBeenCalledTimes(1);
  expect(restore).not.toHaveBeenCalled();
  expect(document.body.contains(panel)).toBe(false);
  expect(document.querySelector(".holo-dock-pill")).toBeNull();
});

test("extra panels share desktop controls without taking over their geometry", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  document.body.innerHTML = '<section class="keys-panel"><header><button aria-label="Fermer">×</button></header></section>';
  initHoloWindows();
  expect(document.querySelector(".mobile-window-min")).not.toBeNull();
  expect(document.querySelector(".sirius-window-header")).not.toBeNull();
  expect(document.querySelector(".keys-panel").style.width).toBe("");
  expect(document.querySelector(".sirius-window-max")).toBeNull();
});

test("a panel without a header gets a separate toolbar without moving React content", () => {
  document.body.innerHTML = '<section class="about-panel"><button aria-label="Fermer">×</button><h2>À propos de ΣIRIUS</h2><p>Version installée</p></section>';
  const panel = document.querySelector(".about-panel");
  const title = panel.querySelector("h2");
  const content = panel.querySelector("p");
  initHoloWindows();
  const header = panel.querySelector(".sirius-window-header");
  expect(header.parentElement).toBe(panel);
  expect(header.textContent).toContain("À propos de ΣIRIUS");
  expect(title.parentElement).toBe(panel);
  expect(content.parentElement).toBe(panel);
  expect(header.contains(content)).toBe(false);
  expect(panel.querySelectorAll(".sirius-window-close")).toHaveLength(1);
});

test("the dock uses the visible oracle title rather than the internal test identifier", () => {
  document.body.innerHTML = '<section class="prime-screen" data-testid="themis-panel"><header><div class="oracle-title">THÉMIS — Gestion</div><button aria-label="Fermer">×</button></header></section>';
  initHoloWindows();
  document.querySelector(".holo-win-min").click();
  expect(document.querySelector(".hdp-restore").getAttribute("aria-label")).toBe("Rouvrir THÉMIS — GESTION");
});

test("journal window controls never reuse the destructive clear action", () => {
  document.body.innerHTML = '<section class="sp-journal"><div class="sp-bar"><span class="sp-title">Journal</span><div class="sirius-window-tools"><button class="sp-close" title="Vider le journal">Vider</button></div><button class="sp-close" aria-label="Fermer le journal"><svg class="lucide-x"></svg></button></div></section>';
  const clear = jest.fn();
  const close = jest.fn();
  document.querySelector('[title="Vider le journal"]').addEventListener("click", clear);
  document.querySelector('[aria-label="Fermer le journal"]').addEventListener("click", close);
  initHoloWindows();
  expect(document.querySelector(".sirius-window-close").getAttribute("aria-label")).toBe("Fermer le journal");
  document.querySelector(".holo-win-min").click();
  document.querySelector(".minimized-pill-close").click();
  expect(close).toHaveBeenCalledTimes(1);
  expect(clear).not.toHaveBeenCalled();
});

test.each([true, false])("window actions have one labelled close and minimize control (mobile=%s)", (mobile) => {
  window.matchMedia.mockReturnValue({ matches: mobile });
  document.body.innerHTML = '<section class="prime-screen"><header class="zeus-head"><h2>ΣIRIUS · Gestion</h2><button aria-label="Fermer la gestion"><svg class="lucide-x"></svg></button></header></section>';
  initHoloWindows();
  const panel = document.querySelector(".prime-screen");
  expect(panel.querySelectorAll(".sirius-window-close")).toHaveLength(1);
  expect(panel.querySelector(".sirius-window-close").getAttribute("aria-label")).toBe("Fermer la gestion");
  expect(panel.querySelectorAll(".holo-win-min")).toHaveLength(1);
  expect(panel.querySelector(".holo-win-min").getAttribute("aria-label")).toBe("Réduire la fenêtre");
  expect(panel.querySelectorAll(".sirius-window-max")).toHaveLength(1);
  expect(panel.querySelector("h2").textContent).toBe("ΣIRIUS · Gestion");
});

test("maximize and restore preserve saved geometry, input values and minimized state", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  document.body.innerHTML = '<section class="prime-screen"><header><h2>Gestion</h2><button aria-label="Fermer">×</button></header><input value="brouillon conservé"></section>';
  initHoloWindows();
  const panel = document.querySelector(".prime-screen");
  const initialStyle = panel.getAttribute("style");
  const maximize = panel.querySelector(".sirius-window-max");
  maximize.click();
  expect(panel.classList.contains("sirius-window-expanded")).toBe(true);
  expect(maximize.getAttribute("aria-pressed")).toBe("true");
  expect(maximize.getAttribute("aria-label")).toBe("Restaurer la taille de la fenêtre");
  expect(panel.getAttribute("style")).toBe(initialStyle);
  panel.querySelector(".holo-win-min").click();
  expect(panel.classList.contains("holo-minimized")).toBe(true);
  document.querySelector(".hdp-restore").click();
  expect(panel.classList.contains("sirius-window-expanded")).toBe(true);
  maximize.click();
  expect(panel.classList.contains("sirius-window-expanded")).toBe(false);
  expect(maximize.getAttribute("aria-pressed")).toBe("false");
  expect(panel.getAttribute("style")).toContain("width:");
  expect(panel.querySelector("input").value).toBe("brouillon conservé");
});

test("settings use their real header instead of a second empty drag strip", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  document.body.innerHTML = '<section class="setup-screen"><form><button type="button" class="setup-close" aria-label="Fermer">×</button><div class="setup-head"><h1>CONFIGURATION DE ΣIRIUS</h1></div><input value="Camille"></form></section>';
  const panel = document.querySelector(".setup-screen");
  const close = panel.querySelector(".setup-close");
  const handler = jest.fn();
  close.addEventListener("click", handler);
  initHoloWindows();
  expect(panel.querySelector(".holo-win-bar")).toBeNull();
  expect(panel.querySelector(".setup-head").classList.contains("sirius-window-header")).toBe(true);
  expect(close.classList.contains("sirius-window-native-close")).toBe(true);
  const proxy = panel.querySelector(".sirius-window-close-proxy");
  proxy.click();
  expect(handler).toHaveBeenCalledTimes(1);
  close.disabled = true;
  proxy.click();
  expect(handler).toHaveBeenCalledTimes(1);
  expect(panel.querySelector("input").value).toBe("Camille");
});

test("a nested dialog close is not mistaken for the module close", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  document.body.innerHTML = '<section class="prime-screen"><header><h2>Parent</h2><button aria-label="Fermer le parent">×</button></header><section class="keys-panel"><header><h2>Enfant</h2><button aria-label="Fermer les clés">×</button></header></section></section>';
  initHoloWindows();
  expect(document.querySelector(".prime-screen > header .sirius-window-close").getAttribute("aria-label")).toBe("Fermer le parent");
  expect(document.querySelector(".keys-panel .sirius-window-close").getAttribute("aria-label")).toBe("Fermer les clés");
});

test("new cascaded desktop modules remain fully inside the viewport", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  resetHoloWindowLayout();
  initHoloWindows();
  for (let i = 0; i < 6; i += 1) {
    const panel = document.createElement("section");
    panel.className = "prime-screen";
    panel.dataset.testid = `cascade-fixture-${i}`;
    panel.innerHTML = '<header class="zeus-head"><button aria-label="Fermer">×</button></header>';
    document.body.appendChild(panel);
    observer([{ addedNodes: [panel], removedNodes: [] }]);
    const left = parseFloat(panel.style.left), top = parseFloat(panel.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left + parseFloat(panel.style.width)).toBeLessThanOrEqual(window.innerWidth - 8);
    expect(top + parseFloat(panel.style.height)).toBeLessThanOrEqual(window.innerHeight - 8);
  }
});

test("viewport changes keep all desktop window controls reachable", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1920 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 1080 });
  try {
    document.body.innerHTML = '<section class="prime-screen"><header><button aria-label="Fermer">×</button></header></section>';
    initHoloWindows();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    window.dispatchEvent(new Event("resize"));
    const panel = document.querySelector(".prime-screen");
    expect(parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(8);
    expect(parseFloat(panel.style.left) + parseFloat(panel.style.width)).toBeLessThanOrEqual(1016);
    expect(parseFloat(panel.style.top) + parseFloat(panel.style.height)).toBeLessThanOrEqual(760);
  } finally {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
  }
});

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

test("an extra mobile panel is left unchanged on desktop", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  document.body.innerHTML = '<section class="keys-panel"><header><button aria-label="Fermer">×</button></header></section>';
  initHoloWindows();
  expect(document.querySelector(".mobile-window-min")).toBeNull();
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

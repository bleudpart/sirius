import { initHoloWindows } from "./holoWindows";

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

test.each(["prime-screen", "fp-overlay", "p3d-overlay", "vision-card", "keys-panel", "sp-journal", "getting-started", "media-hud-window", "productivity-screen"])(
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
    pill.click();
    expect(panel.classList.contains("holo-minimized")).toBe(false);
    expect(document.querySelector(".holo-dock-pill")).toBeNull();
    expect(panel.querySelector("input").value).toBe("contenu conservé");
    panel.querySelector(".mobile-window-min").click();
    panel.remove();
    observer([{ addedNodes: [], removedNodes: [panel] }]);
    expect(document.querySelector(".holo-dock-pill")).toBeNull();
  }
);

test("an extra mobile panel is left unchanged on desktop", () => {
  window.matchMedia.mockReturnValue({ matches: false });
  document.body.innerHTML = '<section class="keys-panel"><header><button aria-label="Fermer">×</button></header></section>';
  initHoloWindows();
  expect(document.querySelector(".mobile-window-min")).toBeNull();
});

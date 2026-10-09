import { closeForegroundWindow } from "./windowController";

afterEach(() => {
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

function windowPanel(name, z, className = "prime-screen") {
  const panel = document.createElement("section");
  panel.className = className;
  panel.style.zIndex = z;
  panel.innerHTML = `<header><h2>${name}</h2><button aria-label="Fermer ${name}">Fermer</button></header>`;
  jest.spyOn(panel, "getClientRects").mockReturnValue([{}]);
  const close = jest.fn(() => panel.remove());
  panel.querySelector("button").addEventListener("click", close);
  document.body.appendChild(panel);
  return { panel, close };
}

test("closes the foreground window rather than the last mounted window", () => {
  const front = windowPanel("Caméra", "1250", "vision-card");
  const behind = windowPanel("Actualités", "1100");
  expect(closeForegroundWindow()).toBe("Caméra");
  expect(front.close).toHaveBeenCalledTimes(1);
  expect(behind.close).not.toHaveBeenCalled();
});

test("ignores minimized and hidden windows", () => {
  const hidden = windowPanel("Clés", "1400", "keys-panel holo-minimized");
  const background = windowPanel("Autre", "1500");
  background.panel.style.display = "none";
  const visible = windowPanel("Plans", "1200", "fp-overlay");
  expect(closeForegroundWindow()).toBe("Plans");
  expect(visible.close).toHaveBeenCalledTimes(1);
  expect(hidden.close).not.toHaveBeenCalled();
  expect(background.close).not.toHaveBeenCalled();
});

test("returns no target when no window is open", () => {
  expect(closeForegroundWindow()).toBeNull();
});

test("returns the full visible module title when closing a panel", () => {
  const { panel } = windowPanel("Sous-section", "1200");
  panel.setAttribute("aria-label", "Pantheon panel");
  panel.insertAdjacentHTML("afterbegin", '<div class="oracle-title font-divine">PANTHEON SYSTEM — MODULE CENTRAL</div>');
  expect(closeForegroundWindow()).toBe("Pantheon System — Module Central");
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import Odysseia from "./Odysseia";
import { ODYSSEIA_HUD_QUOTES, ODYSSEIA_HUD_INSPIRATIONS } from "./odysseiaData";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
let onClose;
const originalFetch = global.fetch;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  onClose = jest.fn();
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    text: () => Promise.resolve("# L’ÈRE MYTHOLOGIQUE GRECQUE\n\n## Des origines du Cosmos à la fin de l’Âge des Héros\n\nTexte de présentation.\n\n# I. LE COMMENCEMENT DU COSMOS\n\nLa narration commence ici."),
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
});

async function render(open = true) {
  await act(async () => root.render(<Odysseia open={open} onClose={onClose} />));
}

test("ODYSSEIA exposes the contemporary quote disclaimer and the supplied illustration", async () => {
  await render();
  const dialog = document.querySelector('[data-testid="odysseia"]');
  expect(document.querySelector(".odysseia-window").getAttribute("aria-label")).toContain("ODYSSEIA");
  expect(dialog.textContent).toContain("BIBLIOTHÈQUE DES MYTHES ANCIENS");
  expect(dialog.querySelector('img[src="/Designer%20(16).png"]')).not.toBeNull();
  expect(dialog.querySelectorAll('[data-testid^="odysseia-quote-"]').length).toBeGreaterThan(40);
});

test("history and bibliography are navigable and Escape closes the window", async () => {
  await render();
  expect(document.querySelectorAll('[data-testid^="odysseia-wheel-section-"]')).toHaveLength(3);
  expect(document.querySelectorAll(".odysseia-window .modwheel-seg")).toHaveLength(3);
  await act(async () => document.querySelector('[data-testid="odysseia-wheel-section-ere"]').click());
  expect(await document.querySelector('[data-testid="odysseia-era"]').textContent).toContain("L’ÈRE MYTHOLOGIQUE GRECQUE");
  expect(document.querySelector('[data-testid="odysseia-era"]').textContent).toContain("Pourquoi ΣIRIUS ?");
  expect(document.querySelectorAll(".odysseia-chapters option")).toHaveLength(3);
  expect(global.fetch.mock.calls[0][0]).toContain("odysseia-ere-mythologique-grecque.md");
  expect(global.fetch.mock.calls[0][1].signal).toBeDefined();
  await act(async () => document.querySelector('[data-testid="odysseia-wheel-section-sources"]').click());
  expect(document.querySelectorAll(".odysseia-sources a")).toHaveLength(4);
  await act(async () => document.querySelector('[data-testid="odysseia"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("citations can be moved up and down through controls and keyboard navigation", async () => {
  await render();
  expect(document.querySelector('[data-testid="odysseia-quote-0"]').classList.contains("active")).toBe(true);
  await act(async () => document.querySelector('[data-testid="odysseia-quote-next"]').click());
  expect(document.querySelector('[data-testid="odysseia-quote-1"]').classList.contains("active")).toBe(true);
  expect(document.querySelector(".odysseia-quote-nav").textContent).toContain("2 /");
  await act(async () => document.querySelector('[data-testid="odysseia"]').dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  expect(document.querySelector('[data-testid="odysseia-quote-0"]').classList.contains("active")).toBe(true);
});

test("ODYSSEIA stays closed until requested", async () => {
  await render(false);
  expect(document.querySelector('[data-testid="odysseia"]')).toBeNull();
});

test("all 43 former HUD quotations are preserved and navigable without automatic speech", async () => {
  await render();
  expect(ODYSSEIA_HUD_QUOTES).toHaveLength(15);
  expect(ODYSSEIA_HUD_INSPIRATIONS).toHaveLength(28);
  for (const quote of [...ODYSSEIA_HUD_QUOTES, ...ODYSSEIA_HUD_INSPIRATIONS]) {
    expect(document.querySelector('[data-testid="odysseia-citation-list"]').textContent).toContain(quote.text);
  }
  const filter = document.querySelector('[aria-label="Filtrer par figure"]');
  await act(async () => {
    filter.value = "Socrate";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(document.querySelectorAll(".odysseia-citation")).toHaveLength(2);
  expect(document.querySelector(".odysseia-featured").textContent).toContain("L'attribution et la formulation historique n'ont pas été vérifiées.");
});

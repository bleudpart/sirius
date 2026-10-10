import React, { act } from "react";
import { createRoot } from "react-dom/client";
import OracleDivin from "./OracleDivin";

jest.mock("./MythosBackdrop", () => () => null);
jest.mock("./Analysis3D", () => () => null);
jest.mock("./useDraggableCards", () => () => null);

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("Oracle presents categorized dated news and the complete radio briefing without NewsAPI", async () => {
  const originalFetch = global.fetch;
  const originalMatchMedia = window.matchMedia;
  const canvas = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({});
  window.matchMedia = () => ({ matches: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const sections = [
    { id: "sport", label: "Sport", status: "ok", articles: [{
      titre: "Un résultat confirmé", description: "Le contexte du résultat.",
      source: "Franceinfo", date: "2026-10-10T16:00:00+02:00",
      url: "https://www.franceinfo.fr/sports/test",
    }] },
    { id: "sante", label: "Santé", status: "unavailable", articles: [] },
  ];
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    json: async () => String(url).includes("/oracle/overview")
      ? { briefing: "Le journal complet de toutes les rubriques.", news_sections: sections,
        date: "2026-10-10", crypto: [], stocks: [], personal: {}, moon: {}, astro: [] }
      : String(url).endsWith("/news/briefing") ? { sections }
      : String(url).includes("/characters") ? { characters: [] } : {},
  }));
  try {
    await act(async () => root.render(<OracleDivin onClose={jest.fn()} />));
    expect(container.querySelector(".oracle-briefing-text").textContent).toBe("Le journal complet de toutes les rubriques.");
    const sport = container.querySelector('[data-testid="oracle-news-sport"]');
    expect(sport.textContent).toContain("Le contexte du résultat.");
    expect(sport.textContent).toContain("2026-10-10T16:00:00+02:00");
    expect(sport.querySelector("a").href).toBe("https://www.franceinfo.fr/sports/test");
    expect(container.querySelector('[data-testid="oracle-news-sante"]').textContent).toContain("Source temporairement indisponible");
    const urls = global.fetch.mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.endsWith("/news/briefing"))).toHaveLength(1);
    expect(urls.some((url) => /news\/headlines|sport\/results/.test(url))).toBe(false);
  } finally {
    act(() => root.unmount());
    canvas.mockRestore();
    global.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
  }
});

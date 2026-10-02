import { act } from "react";
import { createRoot } from "react-dom/client";

import FdeErrorBoundary from "./FdeErrorBoundary";
import { reportFdeCrash } from "@/fdeOmega";

jest.mock("@/fdeOmega", () => ({ reportFdeCrash: jest.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Bomb() {
  throw new Error("explosion contrôlée");
}

function MissingChunk() {
  const error = new Error("Loading CSS chunk 6376 failed");
  error.name = "ChunkLoadError";
  throw error;
}

describe("FdeErrorBoundary", () => {
  let container;
  let consoleSpy;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    // React log l'erreur capturée : silence attendu pour un test de crash volontaire.
    consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    reportFdeCrash.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    consoleSpy.mockRestore();
    container.remove();
  });

  test("rend les enfants quand tout va bien", () => {
    act(() => {
      createRoot(container).render(
        <FdeErrorBoundary>
          <p>contenu sain</p>
        </FdeErrorBoundary>
      );
    });
    expect(container.textContent).toContain("contenu sain");
    expect(reportFdeCrash).not.toHaveBeenCalled();
  });

  test("isole un crash enfant et affiche l'écran de secours global", () => {
    act(() => {
      createRoot(container).render(
        <FdeErrorBoundary>
          <Bomb />
        </FdeErrorBoundary>
      );
    });
    const fallback = container.querySelector('[data-testid="fde-crash-boundary"]');
    expect(fallback).not.toBeNull();
    expect(fallback.textContent).toContain("ΣIRIUS — INTERFACE PROTÉGÉE");
    expect(reportFdeCrash).toHaveBeenCalledTimes(1);
    expect(reportFdeCrash.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test("mode module : bandeau d'isolation compact avec bouton réessayer", () => {
    act(() => {
      createRoot(container).render(
        <FdeErrorBoundary module="oracle">
          <Bomb />
        </FdeErrorBoundary>
      );
    });
    const fallback = container.querySelector(".fde-module-error");
    expect(fallback).not.toBeNull();
    expect(fallback.textContent).toContain("MODULE ISOLÉ PAR FDE_OMEGA");
    expect(fallback.querySelector("button")).not.toBeNull();
  });

  test("a missing chunk waits for the local server rather than retrying against a stopped backend", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const root = createRoot(container);
    act(() => root.render(<FdeErrorBoundary module="oracle"><MissingChunk /></FdeErrorBoundary>));
    await act(async () => {
      container.querySelector(".fde-module-error button").click();
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/health$/), expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.querySelector('[role="status"]').textContent).toContain("Le serveur local ne répond pas encore");
    expect(container.querySelector(".fde-module-error button").disabled).toBe(false);
    act(() => root.unmount());
  });

  test("a degraded backend does not count as a successful recovery", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ status: "degraded", checks: { mongo: "down" } }),
    });
    const root = createRoot(container);
    act(() => root.render(<FdeErrorBoundary module="oracle"><MissingChunk /></FdeErrorBoundary>));
    await act(async () => { container.querySelector(".fde-module-error button").click(); });
    expect(container.querySelector('[role="status"]').textContent).toContain("dégradé");
    expect(container.querySelector(".fde-module-error button").disabled).toBe(false);
    act(() => root.unmount());
  });
});

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import AccessLock, { accessLabel, fetchAccessStatus, trialDaysLeft } from "./AccessLock";
import AuthGate from "./AuthGate";

jest.mock("./components/ReactorVisuals", () => ({
  CoreRings: () => null,
  ReactorCore: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function render(element) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test("accessLabel décrit chaque état d'accès", () => {
  expect(accessLabel({ state: "admin" })).toBe("ADMINISTRATEUR");
  expect(accessLabel({ state: "licensed", license: { tier: "pro" } })).toBe("LICENCE PRO");
  expect(accessLabel({ state: "trial", trial: { remaining_seconds: 86400 * 3 - 10 } })).toBe("ESSAI — 3 JOURS RESTANTS");
  expect(accessLabel({ state: "trial", trial: { remaining_seconds: 3600 } })).toBe("ESSAI — 1 JOUR RESTANT");
  expect(accessLabel({ state: "expired" })).toBe("ESSAI TERMINÉ");
  expect(trialDaysLeft({ state: "expired" })).toBeNull();
});

test("fetchAccessStatus ne bloque pas si le serveur ne connaît pas le contrôle", async () => {
  expect(await fetchAccessStatus(false, jest.fn().mockResolvedValue({ ok: false, status: 404 }))).toEqual({ state: "unknown", allowed: true });
  expect(await fetchAccessStatus(false, jest.fn().mockRejectedValue(new Error("offline")))).toEqual({ state: "unknown", allowed: true });
  const ok = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "expired", allowed: false }) });
  expect(await fetchAccessStatus(true, ok)).toEqual({ state: "expired", allowed: false });
  expect(ok.mock.calls[0][0]).toMatch(/\/access\/status\?refresh=true$/);
});

test("un essai terminé propose les formules et la vérification d'achat", async () => {
  const onRefresh = jest.fn().mockResolvedValue({ state: "expired", allowed: false });
  const { container, cleanup } = await render(
    <AccessLock status={{ state: "expired", allowed: false }} accountEmail="client@example.test" onRefresh={onRefresh} onProfile={() => {}} />,
  );
  try {
    expect(container.querySelector("#access-lock-title").textContent).toBe("Votre essai de 15 jours est terminé");
    expect(container.querySelector('[data-testid="access-store-link"]').getAttribute("href")).toBe("https://sirius-assistant.fr/");
    expect(container.textContent).toContain("client@example.test");
    await act(async () => container.querySelector('[data-testid="access-refresh"]').click());
    expect(onRefresh).toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]').textContent).toBe("Aucune licence active trouvée pour ce compte.");
    expect(container.querySelector('[data-testid="access-profile"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="access-logout"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

test("un PC non relié affiche le formulaire de liaison au compte", async () => {
  const { container, cleanup } = await render(<AccessLock status={{ state: "unlinked", allowed: false }} onRefresh={jest.fn()} />);
  try {
    expect(container.querySelector('[data-testid="access-link-form"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="access-store-link"]')).toBeNull();
  } finally {
    await cleanup();
  }
});

test("hors ligne, seul le bouton réessayer est proposé", async () => {
  const { container, cleanup } = await render(<AccessLock status={{ state: "offline", allowed: false }} onRefresh={jest.fn()} />);
  try {
    expect(container.querySelector('[data-testid="access-store-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="access-refresh"]').textContent).toContain("RÉESSAYER");
  } finally {
    await cleanup();
  }
});

test("AuthGate remplace le HUD par le verrou quand l'accès est refusé", async () => {
  const originalFetch = global.fetch;
  const originalWindowFetch = window.fetch;
  const fetch = jest.fn(async (url) => {
    if (String(url).includes("/access/status")) return { ok: true, status: 200, json: async () => ({ state: "expired", allowed: false }) };
    return { ok: true, status: 200, json: async () => ({ user_id: "u1", email: "client@example.test", name: "Client", role: "user" }) };
  });
  global.fetch = fetch;
  window.fetch = fetch;
  const { container, cleanup } = await render(<AuthGate><div data-testid="hud">HUD</div></AuthGate>);
  try {
    expect(container.querySelector('[data-testid="access-lock"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hud"]')).toBeNull();
  } finally {
    await cleanup();
    global.fetch = originalFetch;
    window.fetch = originalWindowFetch;
  }
});

import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import AuthGate, { useAuth } from "./AuthGate";
import SiriusSetup from "./SiriusSetup";
import { loadApiKeys, setKeyAccount } from "./apiKeyStorage";

jest.mock("./components/ReactorVisuals", () => ({
  CoreRings: () => null,
  ReactorCore: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function SettingsHarness() {
  const { openProfile } = useAuth();
  const [showSetup, setShowSetup] = useState(true);
  return showSetup ? (
    <SiriusSetup
      initialProfile={{ name: "Test Google Play" }}
      onCancel={() => setShowSetup(false)}
      onComplete={jest.fn()}
      onOpenAccount={() => {
        setShowSetup(false);
        openProfile();
      }}
    />
  ) : <div>HUD</div>;
}

test("settings opens the authenticated account and logout returns to login without deleting data", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const user = {
    email: "reviewer@example.test",
    name: "Test Google Play",
    role: "user",
    preferences: {},
  };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => user });
  try {
    await act(async () => root.render(<AuthGate><SettingsHarness /></AuthGate>));
    const button = container.querySelector('[data-testid="setup-account-btn"]');
    expect(button.type).toBe("button");
    expect(container.querySelector('[data-testid="setup-name"]').value).toBe(user.name);
    act(() => button.click());
    expect(container.querySelector('[data-testid="sirius-setup"]')).toBeNull();
    expect(container.textContent).toContain(user.email);
    expect(container.querySelector('[data-testid="profile-delete-btn"]')).not.toBeNull();
    const logout = container.querySelector('[data-testid="profile-logout-btn"]');
    expect(logout).not.toBeNull();
    await act(async () => logout.click());
    expect(container.querySelector('[data-testid="profile-logout-btn"]')).toBeNull();
    expect(container.textContent).toContain("SE CONNECTER");
    const requestedUrls = global.fetch.mock.calls.map(([url]) => url);
    expect(requestedUrls.some((url) => url.endsWith("/api/auth/logout"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("deletion"))).toBe(false);
  } finally {
    act(() => root.unmount());
    global.fetch = originalFetch;
  }
});

test("update check follows the download until the installer is ready", async () => {
  jest.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const states = [
    { phase: "downloading", version: "1.0.32", percent: 40 },
    { phase: "ready", version: "1.0.32", percent: 100 },
  ];
  window.siriusUpdates = {
    check: jest.fn().mockResolvedValue({ ok: true, available: true, phase: "downloading", version: "1.0.32", percent: 5 }),
    status: jest.fn().mockImplementation(async () => states.shift()),
  };
  try {
    act(() => root.render(<SiriusSetup initialProfile={{ name: "Local" }} onComplete={jest.fn()} onCancel={jest.fn()} />));
    await act(async () => container.querySelector('[data-testid="setup-check-update"]').click());
    const status = () => container.querySelector('[data-testid="setup-update-status"]').textContent;
    expect(status()).toBe("Nouvelle version 1.0.32 en téléchargement… 5 %");
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(status()).toBe("Nouvelle version 1.0.32 en téléchargement… 40 %");
    const bar = () => container.querySelector('[data-testid="setup-update-progress"]');
    expect(bar().getAttribute("aria-valuenow")).toBe("40");
    expect(bar().firstChild.style.width).toBe("40%");
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(status()).toBe("Mise à jour 1.0.32 prête — fermez SIRIUS pour l'installer.");
    expect(bar().className).toContain("is-ready");
    expect(bar().firstChild.style.width).toBe("100%");
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(window.siriusUpdates.status).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    delete window.siriusUpdates;
    jest.useRealTimers();
  }
});

test("settings without account access preserves preferences and does not offer a dead account button", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<SiriusSetup initialProfile={{ name: "Local" }} onComplete={jest.fn()} onCancel={jest.fn()} />));
    expect(container.querySelector('[data-testid="setup-account-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="setup-name"]').value).toBe("Local");
    act(() => container.querySelector('[data-testid="setup-tab-voix"]').click());
    expect(container.querySelector('[data-testid="setup-tab-voix"]').className).toContain("active");
  } finally {
    act(() => root.unmount());
  }
});

test("services tab distinguishes the trial from a personal encrypted vault", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: async () => ({
      mode: "trial_then_personal", role: "user",
      trial: { state: "active", expires_at: "2026-10-17T00:00:00Z" },
      services: [{ id: "chat", label: "Réponses IA", state: "configured", scope: "Présence, pas test du modèle." }],
      quotas: { enabled: true, limits: { chat: 150 }, usage: { chat: 2 } },
    }),
  }));
  try {
    await act(async () => root.render(
      <SiriusSetup initialProfile={{ name: "Daniel" }} onCancel={jest.fn()} onComplete={jest.fn()} />,
    ));
    const apiTab = container.querySelector('[data-testid="setup-tab-api"]');
    expect(apiTab.textContent).toContain("CLÉS API ET SERVICES");
    const apiButton = container.querySelector('[data-testid="setup-api-btn"]');
    expect(apiButton.type).toBe("button");
    expect(apiButton.textContent).toContain("GÉRER MES CLÉS API");
    await act(async () => apiButton.click());
    expect(apiTab.className).toContain("active");
    expect(container.querySelector('[data-testid="setup-trial"]').textContent).toContain("Essai actif");
    expect(container.querySelector('[data-testid="vault-controls"]').textContent).toContain("Mes clés personnelles");
    expect(container.querySelector('[data-testid="setup-account-quotas"]').textContent).toContain("2 / 150");
    expect(container.textContent).not.toContain("Voix : opérationnelle");
    await act(async () => container.querySelector('[data-testid="setup-tab-profil"]').click());
    await act(async () => apiTab.click());
    expect(container.querySelector('[data-testid="vault-controls"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    global.fetch = originalFetch;
  }
});

test.each(["unverifiable", "refused"])("saving a %s fal key never declares it validated", async (status) => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  setKeyAccount("fal-check");
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: async () => String(url).endsWith("/keys/validate")
      ? { ok: false, status, message: status === "unverifiable" ? "Clé fal.ai non vérifiable." : "Clé refusée." }
      : { mode: "trial_then_personal", services: [], trial: { state: "expired" }, quotas: { enabled: false } },
  }));
  try {
    await act(async () => root.render(
      <SiriusSetup initialProfile={{ name: "Test" }} initialKeys={{ fal: "personal-fal-test" }}
        initialTab="api" onComplete={jest.fn()} onCancel={jest.fn()} />,
    ));
    for (const id of ["vault-password", "vault-confirm"]) {
      const field = container.querySelector(`[data-testid="${id}"]`);
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(field, "a-long-test-password");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => container.querySelector('[data-testid="vault-save"]').click());
    expect(loadApiKeys()).toEqual({});
    if (status === "unverifiable") {
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Clé fal.ai"));
      expect(container.textContent).toContain("Enregistrement annulé");
    } else {
      expect(confirm).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]').textContent).toContain("vérification non réussie");
    }
  } finally {
    act(() => root.unmount()); setKeyAccount(""); confirm.mockRestore(); global.fetch = originalFetch;
  }
});

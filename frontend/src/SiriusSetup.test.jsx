import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import AuthGate, { useAuth } from "./AuthGate";
import SiriusSetup from "./SiriusSetup";

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

test("API tab explains that the server provides the brain when it has its own key", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: async () => (String(url).endsWith("/chat/status") ? { groq_env: true } : { linked: false }),
  }));
  try {
    await act(async () => root.render(
      <SiriusSetup initialProfile={{ name: "Daniel" }} onCancel={jest.fn()} onComplete={jest.fn()} />,
    ));
    const apiTab = [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === "API");
    await act(async () => apiTab.click());
    expect(container.querySelector('[data-testid="setup-server-keys"]').textContent)
      .toContain("Aucune clé n'est nécessaire");
    expect(container.querySelector('[data-testid="setup-warn-nogroq"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    global.fetch = originalFetch;
  }
});

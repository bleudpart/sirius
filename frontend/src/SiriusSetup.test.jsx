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

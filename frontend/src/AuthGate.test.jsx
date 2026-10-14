import React, { act } from "react";
import { createRoot } from "react-dom/client";
import AuthGate, { ProfilePanel } from "./AuthGate";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("the owner admin chip shows the complete name", async () => {
  const originalFetch = global.fetch;
  const originalWindowFetch = window.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const fetch = jest.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ user_id: "admin", email: "daniel@example.test", name: "Daniel", role: "admin" }),
  });
  global.fetch = fetch;
  window.fetch = fetch;
  try {
    await act(async () => root.render(<AuthGate><div>HUD</div></AuthGate>));
    expect(container.querySelector('[data-testid="auth-user-chip"] > span').textContent).toBe("Daniel Partel");
    expect(container.querySelector('[data-testid="auth-admin-badge"]').textContent).toBe("ADMIN");
  } finally {
    await act(async () => root.unmount());
    global.fetch = originalFetch;
    window.fetch = originalWindowFetch;
    container.remove();
  }
});

test("a queued deletion request does not log out or claim account erasure", async () => {
  const originalFetch = global.fetch;
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  const alert = jest.spyOn(window, "alert").mockImplementation(() => {});
  const onLogout = jest.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const message = "Demande enregistrée. Le compte n’est pas supprimé.";
  global.fetch = jest.fn().mockResolvedValue({
    ok: true, status: 202,
    json: async () => ({ status: "pending_review", account_deleted: false, message }),
  });
  try {
    act(() => root.render(<ProfilePanel user={{ email: "client@example.test", role: "user", preferences: {} }} onClose={() => {}} onUpdate={() => {}} onLogout={onLogout} />));
    await act(async () => container.querySelector('[data-testid="profile-delete-btn"]').click());
    expect(alert).toHaveBeenCalledWith(message);
    expect(onLogout).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    global.fetch.mockRejectedValueOnce(new Error("Connexion impossible"));
    await act(async () => container.querySelector('[data-testid="profile-delete-btn"]').click());
    expect(container.querySelector('[role="alert"]').textContent).toContain("Connexion impossible");
    expect(onLogout).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    confirm.mockRestore();
    alert.mockRestore();
    global.fetch = originalFetch;
  }
});

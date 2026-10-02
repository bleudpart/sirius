import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ProfilePanel } from "./AuthGate";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

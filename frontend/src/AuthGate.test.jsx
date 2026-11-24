import React, { act } from "react";
import { createRoot } from "react-dom/client";
import AuthGate, { ProfilePanel } from "./AuthGate";

jest.mock("./components/ReactorVisuals", () => ({
  CoreRings: () => null,
  ReactorCore: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("the login shows the requested tagline without the colleague slogan", async () => {
  const originalFetch = global.fetch;
  const originalWindowFetch = window.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
  global.fetch = fetch;
  window.fetch = fetch;
  try {
    await act(async () => root.render(<AuthGate><div>HUD</div></AuthGate>));
    expect(container.querySelector(".auth-title").textContent).toBe("ΣIRIUS");
    expect(container.querySelector(".auth-tagline").textContent).toBe("Parlez-lui, il vous répond.");
    expect(container.querySelector(".sirius-colleague")).toBeNull();
    expect(container.querySelector(".auth-powered.auth-copyright").textContent).toContain("© 2026");
  } finally {
    await act(async () => root.unmount());
    global.fetch = originalFetch;
    window.fetch = originalWindowFetch;
    container.remove();
  }
});

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

test("private portal requests omit the ΣIRIUS session and never bootstrap it on rejection", async () => {
  const originalFetch = window.fetch;
  const originalFlag = window.__siriusApiFetchPatched;
  const nativeFetch = jest.fn()
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "account-token" }) })
    .mockResolvedValueOnce({ ok: true, status: 200 })
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: false, status: 401 });
  window.fetch = nativeFetch;
  delete window.__siriusApiFetchPatched;
  try {
    jest.isolateModules(() => { require("./AuthGate"); });
    await window.fetch("http://127.0.0.1:8001/api/protected");
    expect(nativeFetch).toHaveBeenCalledTimes(3);
    expect(nativeFetch.mock.calls[2][1].headers.get("Authorization")).toBe("Bearer account-token");
    await window.fetch("http://127.0.0.1:8001/api/supplier-orders", {
      credentials: "omit", headers: { "X-Order-Manager": "private-link-token" },
    });
    expect(nativeFetch).toHaveBeenCalledTimes(4);
    expect(nativeFetch.mock.calls[3][1]).toEqual({
      credentials: "omit", headers: { "X-Order-Manager": "private-link-token" },
    });
    const request = new Request("http://127.0.0.1:8001/api/supplier-orders", {
      credentials: "omit", headers: { "X-Order-Manager": "private-link-token" },
    });
    await window.fetch(request);
    expect(nativeFetch).toHaveBeenCalledTimes(5);
    expect(nativeFetch.mock.calls[4][0].credentials).toBe("omit");
    expect(nativeFetch.mock.calls[4][0].headers.get("Authorization")).toBeNull();
    expect(nativeFetch.mock.calls[4][1]).toEqual({});
  } finally {
    window.fetch = originalFetch;
    if (originalFlag === undefined) delete window.__siriusApiFetchPatched;
    else window.__siriusApiFetchPatched = originalFlag;
  }
});

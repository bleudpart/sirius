import React, { act } from "react";
import { createRoot } from "react-dom/client";
import AdminPanel from "./AdminPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("filters inactivity reviews without triggering deletion", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const activity = { last_activity: 1790935200, messages: 0, facts: 0, deals: 0, transactions: 0, themis_docs: 0 };
  const users = [
    { user_id: "old", email: "old@example.test", role: "user", activity, inactivity_review: { status: "review_required" } },
    { user_id: "recent", email: "recent@example.test", role: "user", activity, deletion_request: { status: "pending_review" }, inactivity_review: { status: "observing", review_after: "2027-10-02T10:00:00Z" } },
    { user_id: "admin", email: "admin@example.test", role: "admin", activity, inactivity_review: { status: "excluded" } },
    { user_id: "unknown", email: "unknown@example.test", role: "user", activity, inactivity_review: { status: "unknown", reason: "Date invalide" } },
  ];
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ users }) });
  try {
    await act(async () => root.render(<AdminPanel onClose={() => {}} />));
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(container.textContent).toContain("Comptes à examiner : 3");
    expect(container.textContent).toContain("Demande de suppression à traiter");
    expect(container.textContent).toContain("Date invalide");
    expect(container.textContent).not.toContain("1970");
    act(() => container.querySelector('input[type="checkbox"]').click());
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(container.querySelector('[data-testid="admin-user-row-recent"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="admin-user-row-admin"]')).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Aucun compte n’est supprimé automatiquement");
  } finally {
    act(() => root.unmount());
    global.fetch = originalFetch;
  }
});

test("final server erasure requires plan review, matching identity and both acknowledgements", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const user = {
    user_id: "client", email: "client@example.test", role: "user", disabled: true,
    activity: { last_activity: 1790935200, messages: 0 },
    deletion_request: { status: "pending_review" },
    inactivity_review: { status: "observing" },
  };
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [user] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({
      user_id: "client", blockers: [], collections: { sirius_chats: 1 },
      file_paths: ["personal.txt"], external_review: "Vérifier les copies externes",
    }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({
      account_deleted: true, message: "Périmètre serveur effacé",
    }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ users: [] }) });
  try {
    await act(async () => root.render(<AdminPanel onClose={() => {}} />));
    await act(async () => container.querySelector('[data-testid="admin-review-btn-client"]').click());
    const section = container.querySelector('[aria-label="Examen de suppression"]');
    const submit = section.querySelector("button");
    expect(submit.disabled).toBe(true);
    const input = section.querySelector('input:not([type="checkbox"])');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "client");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const checks = section.querySelectorAll('input[type="checkbox"]');
    act(() => checks[0].click());
    expect(submit.disabled).toBe(true);
    act(() => checks[1].click());
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    const [url, options] = global.fetch.mock.calls[2];
    expect(url).toContain("/users/client/finalize-deletion");
    expect(JSON.parse(options.body)).toEqual({
      confirm_user_id: "client", external_review_complete: true, activity_stopped: true,
    });
    expect(container.textContent).toContain("Périmètre serveur effacé");
    expect(container.querySelector('[aria-label="Examen de suppression"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    global.fetch = originalFetch;
  }
});

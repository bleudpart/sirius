import { act } from "react";
import { createRoot } from "react-dom/client";
import ChronosAgenda from "./ChronosAgenda";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const appointment = { id: "e1", title: "Client Martin", start: "2026-10-17T12:00:00Z",
  end: "2026-10-17T13:00:00Z", timezone: "Europe/Paris", notes: "Devis", revision: 1 };
let host, root, originalFetch, originalCrypto;
beforeEach(() => {
  originalCrypto = global.crypto;
  global.crypto = { getRandomValues: (bytes) => require("crypto").randomFillSync(bytes) };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({
    events: [appointment], truncated: false, date: "2026-10-17", timezone: "UTC",
  }) }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
  global.crypto = originalCrypto;
});
const click = async (node) => act(async () => node.click());
const button = (text) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent === text);
const render = async () => act(async () => root.render(<ChronosAgenda />));

test("loads daily agenda and refreshes after assistant changes", async () => {
  await render();
  expect(host.textContent).toContain("Client Martin");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await act(async () => window.dispatchEvent(new Event("sirius:chronos-changed")));
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("deletion requires confirmation and sends current revision", async () => {
  await render();
  await click(host.querySelector('[aria-label="Supprimer le rendez-vous Client Martin"]'));
  expect(global.fetch).toHaveBeenCalledTimes(1);
  await click(button("Conserver le rendez-vous"));
  expect(host.querySelector('[aria-label="Confirmer la suppression du rendez-vous"]')).toBeNull();
  await click(host.querySelector('[aria-label="Supprimer le rendez-vous Client Martin"]'));
  await click(button("Confirmer la suppression du rendez-vous"));
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/events/e1?revision=1"),
    expect.objectContaining({ method: "DELETE" }));
});

test("editing fills existing event, PUT uses optimistic revision", async () => {
  await render();
  await click(host.querySelector('[aria-label="Modifier Client Martin"]'));
  expect(host.querySelector('form input').value).toBe("Client Martin");
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const mutation = global.fetch.mock.calls.find(([, options]) => options.method === "PUT");
  expect(mutation[0]).toContain("/events/e1");
  expect(JSON.parse(mutation[1].body)).toMatchObject({ title: "Client Martin", revision: 1, allow_conflicts: false });
});

test("backend failure is explicit and never displayed as an empty successful agenda", async () => {
  global.fetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: "Stockage indisponible" }) });
  await render();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Stockage indisponible");
  expect(host.textContent).not.toContain("Aucun rendez-vous pour cette journée");
});

test("conflict preserves form and requires explicit acceptance", async () => {
  await render();
  await click(host.querySelector('[aria-label="Modifier Client Martin"]'));
  global.fetch.mockResolvedValueOnce({ ok: false, status: 409,
    json: async () => ({ detail: { message: "Chevauchement", conflicts: [{ title: "Autre client" }] } }) });
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Autre client");
  expect(host.querySelector('form input').value).toBe("Client Martin");
  expect(host.querySelector('input[type="checkbox"]').checked).toBe(false);
});

test("an uncertain creation retry retains the same idempotency key", async () => {
  await render();
  const set = async (node, value) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await set(host.querySelector('form input[maxlength="160"]'), "Nouveau client");
  const dates = host.querySelectorAll('form input[type="datetime-local"]');
  await set(dates[0], "2026-10-17T14:00");
  await set(dates[1], "2026-10-17T15:00");
  global.fetch.mockRejectedValueOnce(new TypeError("Network disconnected"));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const requests = global.fetch.mock.calls.filter(([, options]) => options.method === "POST");
  expect(requests).toHaveLength(2);
  expect(requests[0][1].headers["Idempotency-Key"]).toMatch(/^[a-f0-9-]{36}$/);
  expect(requests[1][1].headers["Idempotency-Key"]).toBe(requests[0][1].headers["Idempotency-Key"]);
});

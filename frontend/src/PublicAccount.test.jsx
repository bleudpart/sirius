import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PublicAccount from "./PublicAccount";

jest.mock("./components/ReactorVisuals", () => ({
  CoreRings: () => null,
  ReactorCore: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let container;
let root;

function fill(testId, value) {
  const input = container.querySelector(`[data-testid="${testId}"]`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  global.fetch = jest.fn();
  act(() => root.render(<PublicAccount />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  global.fetch = originalFetch;
});

test("account page requires an email and does not bootstrap the HUD or local session", () => {
  expect(container.querySelector('[data-testid="auth-email-input"]').required).toBe(true);
  expect(container.textContent).not.toContain("SE CONNECTER AU PC");
  expect(container.textContent).toContain("aucun paiement");
  expect(global.fetch).not.toHaveBeenCalled();
});

test("registration validates confirmation and consent then uses the existing account API", async () => {
  act(() => container.querySelector('[data-testid="auth-register-toggle"]').click());
  fill("auth-name-input", "Test Google");
  fill("auth-email-input", "review@example.test");
  fill("auth-password-input", "Example-test-123");
  fill("auth-confirm-password-input", "Different-123");
  await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector('[data-testid="auth-error"]').textContent).toContain("ne correspondent pas");
  expect(global.fetch).not.toHaveBeenCalled();
  fill("auth-confirm-password-input", "Example-test-123");
  await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector('[data-testid="auth-error"]').textContent).toContain("accepter les conditions");
  act(() => container.querySelector('[data-testid="auth-terms-checkbox"]').click());
  global.fetch.mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify({ name: "Test Google", email: "review@example.test" }),
  });
  await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(global.fetch).toHaveBeenCalledTimes(1);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toMatch(/\/api\/auth\/register$/);
  expect(JSON.parse(options.body)).toEqual({ name: "Test Google", email: "review@example.test", password: "Example-test-123" });
  expect(container.querySelector('[role="status"]').textContent).toContain("Connexion réussie");
  expect(container.querySelector("form")).toBeNull();
  expect(container.textContent).toContain("Aucun achat ni abonnement");
});

test("login failures remain visible and never claim account success", async () => {
  fill("auth-email-input", "review@example.test");
  fill("auth-password-input", "Example-test-123");
  global.fetch.mockResolvedValue({ ok: false, text: async () => JSON.stringify({ detail: "Identifiants invalides" }) });
  await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/auth\/login$/);
  expect(container.querySelector('[data-testid="auth-error"]').textContent).toBe("Identifiants invalides");
  expect(container.querySelector(".public-account-success")).toBeNull();
});

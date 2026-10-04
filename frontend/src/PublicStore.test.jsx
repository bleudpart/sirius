import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PublicStore from "./PublicStore";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container;
let root;
const originalFetch = global.fetch;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    json: async () => ({ detail: "Paiement indisponible pour le test" }),
  });
  act(() => root.render(<PublicStore />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  global.fetch = originalFetch;
});

test("offer selection updates the accessible state and checkout summary", () => {
  const plans = container.querySelectorAll(".public-plan");
  expect(plans).toHaveLength(3);
  expect(plans[1].getAttribute("aria-pressed")).toBe("true");
  act(() => plans[2].click());
  expect(plans[1].getAttribute("aria-pressed")).toBe("false");
  expect(plans[2].getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector(".public-order-summary").textContent).toContain("Lifetime299 €");
});

test("the core rotates transparent rings rather than the square emblem", () => {
  const rings = container.querySelectorAll(".public-core-ring");
  expect(rings).toHaveLength(2);
  rings.forEach((ring) => expect(ring.getAttribute("src")).toBe("/holo/ring-gold.png"));
  expect(container.querySelector('a[href="#offres"]')).not.toBeNull();
  expect(container.querySelector("#offres")).not.toBeNull();
});

test("store describes real prerequisites without fabricated evidence or empty video", () => {
  expect(container.querySelector("video")).toBeNull();
  expect(container.querySelector("blockquote")).toBeNull();
  expect(container.querySelector(".public-metrics")).toBeNull();
  for (const claim of ["+12 000", "24h/24", "Instantané", "Ils utilisent", "256 bits", "Voir une démo", "aucun débit réel"]) {
    expect(container.textContent).not.toContain(claim);
  }
  expect(container.querySelector(".hud-preview img").getAttribute("src")).toBe("/hud-preview.png");
  expect(container.querySelectorAll(".public-matrix-actions li")).toHaveLength(4);
  expect(container.textContent).toContain("pas une démonstration en direct");
  expect(container.textContent).toContain("équipements compatibles");
  expect(container.textContent).toContain("leur délai de réponse peut varier");
  expect(container.textContent).toContain("ne garantit pas que le prestataire est en mode test");
  expect(container.querySelector(".public-demo-link").textContent).toContain("Voir les fonctions");
});

test("checkout preserves the selected tier and exposes payment failures", async () => {
  act(() => container.querySelector(".public-plan-standard").click());
  const email = container.querySelector("#public-email");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(email, "client@example.com");
    email.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await act(async () => {
    container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/public/license-checkout"), expect.objectContaining({
    method: "POST",
    body: JSON.stringify({ email: "client@example.com", phone: "", tier: "standard", origin_url: window.location.origin }),
  }));
  expect(container.querySelector('[role="alert"]').textContent).toBe("Paiement indisponible pour le test");
});

test("situation screenshots are labeled as fictional and open the full images", () => {
  const section = container.querySelector(".public-situations");
  expect(section.textContent).toContain("données fictives de démonstration");
  expect(section.querySelectorAll("figure")).toHaveLength(2);
  for (const name of ["dossiers", "planning"]) {
    const image = section.querySelector(`img[src="/demo/sirius-${name}.png"]`);
    expect(image.getAttribute("alt")).toContain("fictif");
    expect(image.closest("a").getAttribute("href")).toBe(image.getAttribute("src"));
    expect(image.closest("a").getAttribute("rel")).toBe("noopener noreferrer");
  }
  expect(global.fetch).not.toHaveBeenCalled();
});

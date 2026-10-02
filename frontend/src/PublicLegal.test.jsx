import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PublicLegal from "./PublicLegal";
import policy from "./privacyPolicy.json";
import deletionPage from "./accountDeletionPage.json";

const { escapeHtml, renderPrivacyPage } = require("../scripts/generate-privacy-page");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => window.history.replaceState({}, "", "/"));

test("exposes the same privacy policy in the legal view and standalone HTML", () => {
  window.history.replaceState({}, "", "/confidentialite");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<PublicLegal />));
    expect(container.querySelector("h1").textContent).toBe(policy.title);
    const html = renderPrivacyPage(policy);
    for (const [heading, text] of policy.sections) {
      expect(Array.from(container.querySelectorAll("h2"), (element) => element.textContent)).toContain(heading);
      expect(html).toContain(escapeHtml(text));
    }
    expect(html).toContain("DANIEL PARTEL");
    expect(html).toContain("danielsirius.pro2026@gmail.com");
    expect(html).not.toMatch(/<script|<iframe|<link/i);
    expect(container.textContent).toContain(`Dernière mise à jour : ${policy.updated}.`);
  } finally {
    act(() => root.unmount());
  }
});

test("escapes text instead of injecting HTML into the public policy", () => {
  const html = renderPrivacyPage({
    title: "<script>test</script>",
    updated: "test",
    sections: [['A & B', '"<img src=x>"']],
  });

  expect(html).toContain("&lt;script&gt;test&lt;/script&gt;");
  expect(html).toContain("A &amp; B");
  expect(html).toContain("&quot;&lt;img src=x&gt;&quot;");
  expect(html).not.toContain("<img");
});

test("account deletion page provides public email instructions without promising immediate erasure", () => {
  const html = renderPrivacyPage(deletionPage);
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.querySelector("h1").textContent).toBe(deletionPage.title);
  expect(container.textContent).toContain("sans vous connecter");
  expect(container.textContent).toContain("DANIEL PARTEL");
  expect(container.textContent).toContain("ne sont pas encore arrêtées");
  expect(container.textContent).toContain("ne résilie pas automatiquement");
  expect(html).not.toMatch(/<script|<iframe|<form|<link/i);
  const link = container.querySelector('a[href^="mailto:"]');
  expect(link.getAttribute("href")).toBe(
    `mailto:danielsirius.pro2026@gmail.com?subject=${encodeURIComponent(deletionPage.requestSubject)}`
  );
  for (const [, text] of deletionPage.sections) {
    expect(html).toContain(escapeHtml(text));
  }
});

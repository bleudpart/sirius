import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PublicLegal from "./PublicLegal";
import policy from "./privacyPolicy.json";

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

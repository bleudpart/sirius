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
  expect(plans).toHaveLength(4);
  expect(plans[2].getAttribute("aria-pressed")).toBe("true");
  act(() => plans[3].click());
  expect(plans[2].getAttribute("aria-pressed")).toBe("false");
  expect(plans[3].getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector(".public-order-summary").textContent).toContain("Lifetime269 €");
});

test.each([["standard", "69"], ["pro", "135"], ["lifetime", "269"]])(
  "the %s card and checkout summary display the same reduced price", (tier, price) => {
    const card = container.querySelector(`.public-plan-${tier}`);
    expect(card.querySelector(".public-price").textContent).toContain(`${price} €`);
    act(() => card.click());
    expect(container.querySelector(".public-order-summary strong").textContent).toBe(`${price} €`);
  },
);

test("store displays the requested headline and description while preserving the footer slogan", () => {
  expect(container.querySelector(".public-hero .public-eyebrow").textContent).toBe("ΣIRIUS, conçue pour vous");
  expect(container.querySelector(".public-hero h1").textContent).toBe("Zirius, sans prompts compliqués : parlez-lui, Il s'occupe de vos tâches.");
  expect(container.querySelector(".public-value").textContent).toBe("Conçu pour tous ceux qui ne sont pas à l'aise avec l'IA, Zirius vous aide : vous écoute, vous répond, exécute vos demandes et surveille vos tâches. Parlez-lui naturellement, sans avoir à rédiger de prompts compliqués.");
  expect(container.querySelector(".public-slogan").textContent).toBe("ZIRIUS travaille pour vous.");
});

test("store explains why Sirius was designed with the requested text", () => {
  const section = container.querySelector(".public-why");
  expect(section.getAttribute("aria-labelledby")).toBe("public-why-title");
  expect(section.querySelector(".public-why-grid")).toBeNull();
  expect(section.querySelectorAll("article")).toHaveLength(0);
  expect(section.querySelector("h2").textContent).toBe("Pourquoi ΣIRIUS a-t-il été conçu ?");
  expect(section.querySelector(":scope > p").textContent).toBe("ΣIRIUS a été conçu pour aider les particuliers, les commerçants, les artisans, les indépendants et les entreprises à mieux organiser leur activité au quotidien. Il permet de centraliser les documents, notes, factures, informations comptables, tâches, rendez-vous et projets dans un espace unique. Grâce à ses capacités de classement, de recherche et de synthèse, ΣIRIUS facilite le suivi administratif, l'organisation du travail et la prise de décision.");
});

test("business context and workflow precede functions and offers without removing existing sections", () => {
  const sections = [...container.querySelectorAll("main > section")].map((section) => section.className);
  const workflow = container.querySelector("#public-workflow-title").parentElement;
  const workflowIndex = [...container.querySelectorAll("main > section")].indexOf(workflow);
  expect(sections.indexOf("public-why")).toBeLessThan(workflowIndex);
  expect(workflowIndex).toBeLessThan(sections.indexOf("public-situations"));
  expect(sections.indexOf("public-situations")).toBeLessThan(sections.indexOf("public-matrix"));
  expect(sections.indexOf("public-matrix")).toBeLessThan(sections.indexOf("public-plans"));
  expect(sections.indexOf("public-plans")).toBeLessThan(sections.indexOf("public-odysseia-card"));
  const steps = workflow.querySelectorAll(".public-workflow-steps li");
  expect(steps).toHaveLength(3);
  expect(steps[1].textContent).toContain("Relisez les champs");
  expect(steps[2].textContent).toContain("brouillon de facture non émis");
  expect(workflow.textContent).toContain("Du document reçu au résultat conservé");
  expect(container.querySelector(".public-matrix-actions li strong").textContent).toBe("Organiser ses dossiers");
});
test("store leads with accessible assistance, speed and continuity without promising unlimited autonomy", () => {
  expect(container.querySelector(".public-eyebrow").textContent).toBe("ΣIRIUS, conçue pour vous");
  expect(container.querySelector(".public-hero").textContent).toContain("Parlez-lui naturellement");
  const advantages = container.querySelector("#public-advantage-title").parentElement;
  expect(advantages.querySelectorAll("li")).toHaveLength(3);
  expect(advantages.textContent).toContain("rappels configurés");
  expect(advantages.querySelector("p > strong").textContent).toBe("Parlez-lui simplement. Vous l'adopterez.");
  expect(advantages.textContent).not.toContain("Essayez Zirius gratuitement.");
  expect(advantages.textContent).toContain("Claude, ChatGPT et d'autres outils peuvent intervenir à certaines étapes. Mais avec ΣIRIUS, vous avez un interlocuteur unique : vous lui parlez et, hop ! Il rassemble vos demandes, vos dossiers et vos outils, puis vous accompagne tout au long de votre travail.");
  expect(container.textContent).not.toContain("Tout se fait automatiquement");
});
test("trial explains activation, limits and personal keys without automatic payment", () => {
  expect(container.querySelector(".public-trial-highlight").textContent).toContain("15 jours d'essai gratuit");
  const trial = container.querySelector(".public-trial");
  expect(trial.textContent).toContain("première connexion activant votre compte");
  expect(trial.textContent).toContain("quotas quotidiens");
  expect(trial.textContent).toContain("Sans engagement ni paiement automatique");
  expect(trial.textContent).toContain("aucun abonnement à annuler");
  expect(trial.textContent).toContain("vos propres clés API");
  expect(trial.textContent).toContain("distinct de l'achat d'une licence");
  expect(trial.textContent).toContain("ne relance pas les 15 jours");
});

test("rental exposes the first month and renewal price and requires explicit consent", async () => {
  act(() => container.querySelector(".public-plan-monthly").click());
  expect(container.querySelector(".public-order-summary").textContent).toContain("10 €");
  expect(container.querySelector(".public-order-summary").textContent).toContain("32 €/mois");
  expect(container.querySelector(".public-paypal-btn")).toBeNull();
  const email = container.querySelector("#public-email");
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(email, "client@example.com");
    email.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]').textContent).toContain("Acceptez");
  act(() => container.querySelector('.public-subscription-consent input').click());
  await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/public/license-checkout"), expect.objectContaining({
    body: JSON.stringify({ email: "client@example.com", phone: "", tier: "monthly", origin_url: window.location.origin, subscription_accepted: true }),
  }));
  act(() => container.querySelector(".public-plan-standard").click());
  act(() => container.querySelector(".public-plan-monthly").click());
  expect(container.querySelector('.public-subscription-consent input').checked).toBe(false);
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
  expect(container.querySelectorAll(".public-matrix-actions li")).toHaveLength(6);
  expect(container.querySelector(".public-matrix h2").textContent).toBe("Découvrez les fonctionnalités de ΣIRIUS");
  expect(container.querySelector(".public-matrix-actions").textContent).toContain("Rédaction de documents");
  expect(container.querySelector(".public-matrix-actions").textContent).toContain("Analyse assistée par IA");
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

test("the ODYSSEIA summary opens as an accessible window and closes with Escape", () => {
  const opener = container.querySelector(".public-odysseia-card button");
  expect(opener.textContent).toContain("Lire la synthèse");
  act(() => opener.click());

  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog).not.toBeNull();
  expect(dialog.getAttribute("aria-labelledby")).toBe("public-odysseia-title");
  expect(dialog.textContent).toContain("L’ère mythologique grecque");
  expect(dialog.textContent).toContain("n’est pas une période officielle");
  expect(dialog.textContent).toContain("Hésiode");
  expect(dialog.textContent).toContain("Hisarlık");
  expect(dialog.querySelector('img[src="/Designer%20(16).png"]')).not.toBeNull();
  expect(document.activeElement).toBe(dialog.querySelector("button"));
  expect(document.body.style.overflow).toBe("hidden");

  act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(document.body.style.overflow).toBe("");
});

test("the ODYSSEIA summary closes when the backdrop is clicked", () => {
  act(() => container.querySelector(".public-odysseia-card button").click());
  const backdrop = container.querySelector(".public-odysseia-backdrop");
  act(() => backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

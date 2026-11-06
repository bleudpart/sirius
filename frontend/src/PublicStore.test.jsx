import React, { act } from "react";
import { createRoot } from "react-dom/client";
import fs from "fs";
import path from "path";
import PublicStore from "./PublicStore";

jest.mock("./components/ReactorVisuals", () => ({
  CoreRings: () => null,
  ReactorCore: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container;
let root;
let pauseMedia;
let playMedia;
const originalFetch = global.fetch;

beforeEach(() => {
  pauseMedia = jest.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  playMedia = jest.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
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
  pauseMedia.mockRestore();
  playMedia.mockRestore();
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

test("the store offers account creation without checkout or the assistant boot", () => {
  expect(container.querySelector('nav a[href="/compte"]').textContent).toBe("Connexion / Créer un compte");
  window.history.replaceState({}, "", "/compte");
  try {
    act(() => root.render(<PublicStore />));
    expect(container.querySelector('[data-testid="auth-screen"]')).not.toBeNull();
    expect(container.querySelector(".public-account")).not.toBeNull();
    expect(container.querySelector(".public-purchase")).toBeNull();
  } finally {
    window.history.replaceState({}, "", "/");
  }
});

test("the store starts the looping Zirius theme softly and pauses it for the demo", () => {
  const audio = container.querySelector("#public-theme-player");
  expect(audio.getAttribute("src")).toBe("/audio/zirius-loop.wav?revision=3");
  expect(audio.controls).toBe(false);
  expect(audio.hidden).toBe(true);
  expect(audio.loop).toBe(true);
  expect(audio.autoplay).toBe(true);
  expect(audio.preload).toBe("auto");
  expect(playMedia).toHaveBeenCalledTimes(1);
  expect(audio.volume).toBe(0.12);
  const pause = jest.spyOn(audio, "pause").mockImplementation(() => {});
  act(() => container.querySelector("video").dispatchEvent(new Event("play", { bubbles: true })));
  expect(pause).toHaveBeenCalledTimes(1);
});

test("blocked autoplay is explained and manual playback clears the notice", async () => {
  act(() => root.unmount());
  root = createRoot(container);
  playMedia.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
  await act(async () => root.render(<PublicStore />));
  expect(container.querySelector('[role="status"]').textContent).toContain("bloqué par le navigateur");
  await act(async () => container.querySelector(".public-theme-toggle").click());
  expect(playMedia).toHaveBeenCalledTimes(3);
  act(() => container.querySelector("audio").dispatchEvent(new Event("play")));
  expect(container.textContent).not.toContain("bloqué par le navigateur");
  expect(container.querySelector(".public-theme-toggle").textContent).toBe("Couper le son");
  act(() => container.querySelector(".public-theme-toggle").click());
  expect(container.querySelector(".public-theme-toggle").textContent).toBe("Activer le son");
  expect(pauseMedia).toHaveBeenCalled();
});

test("an unavailable music file is reported without blocking the store", () => {
  act(() => container.querySelector("audio").dispatchEvent(new Event("error")));
  expect(container.querySelector('[role="alert"]').textContent).toContain("musique est indisponible");
  expect(container.querySelectorAll(".public-plan")).toHaveLength(4);
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
  expect(container.querySelector(".public-hero .public-eyebrow").textContent).toBe("Votre assistant de travail");
  expect(container.querySelector(".public-hero h1").textContent).toBe("Parlez à ΣIRIUS.Il prépare votre travail.");
  expect(container.querySelector(".public-value").textContent).toContain("prépare les prochaines étapes avec vous");
  expect(container.querySelector(".public-slogan").textContent).toBe("ΣIRIUS travaille pour vous.");
});

test("three concrete requests lead to the trial instead of checkout", () => {
  expect(container.querySelectorAll(".public-request-examples li")).toHaveLength(3);
  const actions = container.querySelectorAll(".public-hero .public-primary-cta");
  expect(actions).toHaveLength(1);
  expect(actions[0].getAttribute("href")).toBe("#essayer");
  expect(container.querySelector(".public-demo-text-link").getAttribute("href")).toBe("#demonstration");
  expect(container.querySelector(".public-purchase").open).toBe(false);
  expect(container.querySelector("#public-phone").required).toBe(false);
  expect(container.querySelector("#essayer a").getAttribute("href")).toContain("releases/download/v1.0.69/");
  expect(container.querySelector("#essayer").textContent).toContain("1.0.69");
});

test("new features are reachable from navigation and presented before the offers", () => {
  expect(container.querySelector('nav a[href="#nouveautes"]').textContent).toBe("Nouveautés");
  const updates = container.querySelector("#nouveautes");
  expect(updates.getAttribute("aria-labelledby")).toBe(updates.querySelector("h2").id);
  expect(updates.textContent).toContain("Version 1.0.69");
  expect(updates.previousElementSibling.id).toBe("matrice-demo");
  expect(updates.nextElementSibling.id).toBe("offres");
  const cards = [...updates.querySelectorAll("article")];
  expect(cards.map((card) => card.querySelector("h3").textContent)).toEqual([
    "Photos et étiquettes HACCP", "Réceptions et traçabilité",
    "Finance et rentabilité", "Tri-Cortex et ZEUS CORTEX", "Consultations MYTHOS",
  ]);
  cards.forEach((card) => expect(card.getAttribute("aria-labelledby")).toBe(card.querySelector("h3").id));
  expect(updates.querySelector("a").getAttribute("href")).toBe("#essayer");
});

test("new features explain human review, sanitary rules and analytics availability", () => {
  const updates = container.querySelector("#nouveautes");
  expect(updates.textContent).toContain("date et heure de fabrication, DLC exacte");
  expect(updates.textContent).toContain("J+3 n'est pas une règle universelle");
  expect(updates.textContent).toContain("Alertes 48 heures");
  expect(updates.textContent).toContain("ne remplacent pas l'inventaire physique");
  expect(updates.textContent).toContain("Menu engineering");
  expect(updates.textContent).toContain("food cost réel et théorique");
  expect(updates.textContent).toContain("hausse fournisseur");
  expect(updates.textContent).toContain("Seuil de rentabilité");
  expect(updates.textContent).toContain("accessibles via API");
  expect(updates.textContent).toContain("sans panneau dédié ni rapprochement automatique");
  expect(updates.textContent).toContain("Trois graphes analytiques ZEUS CORTEX");
  expect(updates.textContent).toContain("quatre subagents");
  expect(updates.textContent).toContain("configuration et une connexion réseau");
  expect(updates.textContent).toContain("selon votre formule");
  expect(updates.textContent).toContain("PROMÉTHÉE prépare un plan de projet");
  expect(updates.textContent).toContain("e-mail après confirmation");
  expect(updates.textContent).toContain("SOLON ne remplace pas un avocat");
  expect(updates.textContent).toContain("serveur SMTP configuré");
});

test("Windows installer and portable downloads point to the same public release", () => {
  const downloads = [...container.querySelectorAll("#essayer .public-downloads a")];
  expect(downloads.map((link) => link.getAttribute("href"))).toEqual([
    "https://github.com/bleudpart/sirius/releases/download/v1.0.69/sirius-setup-1.0.69.exe",
    "https://github.com/bleudpart/sirius/releases/download/v1.0.69/SIRIUS-Portable-1.0.69.exe",
  ]);
  expect(downloads[0].textContent).toContain("Télécharger pour Windows");
  expect(downloads[1].textContent).toContain("version portable");
  expect(container.querySelector("#essayer").textContent).toContain("sans installation");
  expect(container.textContent).not.toContain("1.0.57");
});

test("the creator introduces Sirius immediately after the demonstration and before the workflow", () => {
  const founder = container.querySelector(".public-founder");
  expect(founder.getAttribute("aria-labelledby")).toBe("public-founder-title");
  expect(founder.querySelector("h2").textContent).toBe("Daniel Partel vous présente ΣIRIUS");
  expect(founder.querySelector("p").textContent).toBe("J'ai créé ΣIRIUS pour celles et ceux qui souhaitent profiter des outils numériques sans avoir à maîtriser l'intelligence artificielle. Vous lui parlez naturellement : il rassemble vos demandes, vos dossiers et vos outils pour vous accompagner dans votre travail.");
  expect(container.querySelector("#demonstration").nextElementSibling).toBe(founder);
  expect(founder.nextElementSibling.querySelector("h2").id).toBe("public-advantage-title");
});

test("business context and workflow precede functions and offers without removing existing sections", () => {
  const sections = [...container.querySelectorAll("main > section")].map((section) => section.className);
  const workflow = container.querySelector("#public-advantage-title").parentElement;
  const workflowIndex = [...container.querySelectorAll("main > section")].indexOf(workflow);
  expect(sections.indexOf("public-demo public-workflow")).toBeLessThan(workflowIndex);
  expect(workflowIndex).toBeLessThan(sections.indexOf("public-situations"));
  expect(sections.indexOf("public-situations")).toBeLessThan(sections.indexOf("public-matrix"));
  expect(sections.indexOf("public-matrix")).toBeLessThan(sections.indexOf("public-plans"));
  expect(sections.indexOf("public-plans")).toBeLessThan(sections.indexOf("public-odysseia-card"));
  const steps = workflow.querySelectorAll(".public-workflow-steps li");
  expect(steps).toHaveLength(3);
  expect(steps[1].textContent).toContain("rassemble");
  expect(steps[2].textContent).toContain("Vous vérifiez et validez");
  expect(container.querySelector(".public-matrix-actions li strong").textContent).toBe("Retrouvez rapidement vos dossiers");
});
test("store leads with accessible assistance, speed and continuity without promising unlimited autonomy", () => {
  expect(container.querySelector(".public-eyebrow").textContent).toBe("Votre assistant de travail");
  expect(container.querySelector(".public-hero").textContent).toContain("Décrivez simplement");
  const advantages = container.querySelector("#public-advantage-title").parentElement;
  expect(advantages.querySelectorAll("li")).toHaveLength(3);
  expect(advantages.textContent).toContain("Vous gardez le dernier mot");
  expect(advantages.textContent).not.toContain("Demandez-lui de rédiger un message");
  expect(advantages.textContent).toContain("pas besoin d'apprendre à rédiger des prompts");
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
  const video = container.querySelector("video");
  expect(video.controls).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(video.querySelector("source").getAttribute("src")).toBe("/demo/sirius-demo-store.mp4");
  expect(video.querySelector("track").getAttribute("src")).toBe("/demo/sirius-demo-store.vtt");
  expect(video.querySelector("track").getAttribute("kind")).toBe("subtitles");
  expect(video.querySelector("track").hasAttribute("default")).toBe(true);
  const demoNote = container.querySelector("#demonstration .public-function-note").textContent;
  expect(demoNote).toContain("Démonstration muette");
  expect(demoNote).toContain("Session simulée et données fictives");
  expect(demoNote).toContain("aucune réponse IA ni aucun envoi réel");
  expect(container.querySelector("blockquote")).toBeNull();
  expect(container.querySelector(".public-metrics")).toBeNull();
  for (const claim of ["+12 000", "24h/24", "Instantané", "Ils utilisent", "256 bits", "Voir une démo", "aucun débit réel"]) {
    expect(container.textContent).not.toContain(claim);
  }
  const hudPreview = container.querySelector(".hud-preview img");
  expect(hudPreview.getAttribute("src")).toBe("/hud-preview.png");
  expect(hudPreview.getAttribute("alt")).toContain("profil fictif");
  expect(container.querySelector(".public-preview-caption").textContent).toContain("peut différer de la version téléchargée");
  expect(container.querySelectorAll(".public-matrix-actions li")).toHaveLength(6);
  expect(container.querySelector(".public-matrix h2").textContent).toBe("Ce que vous pouvez lui confier");
  expect(container.querySelector(".public-matrix-actions").textContent).toContain("Préparez vos documents");
  expect(container.querySelector(".public-matrix-actions").textContent).toContain("Analysez les informations importantes");
  expect(container.textContent).toContain("pas une démonstration en direct");
  expect(container.querySelector(".public-control").textContent).toContain("microphone est facultatif");
  expect(container.textContent).toContain("leur délai de réponse peut varier");
  expect(container.textContent).toContain("ne garantit pas que le prestataire est en mode test");
  expect(container.querySelector(".public-demo-link").textContent).toContain("Voir les fonctions");
});

test("demo subtitles describe the fictional walkthrough in chronological order", () => {
  const subtitles = fs.readFileSync(path.join(__dirname, "..", "public", "demo", "sirius-demo-store.vtt"), "utf8");
  expect(subtitles).toMatch(/^WEBVTT/);
  for (const phrase of ["session simulée", "données fictives", "MNÉMOSYNE", "CHRONOS", "aucune réponse IA ni aucun envoi réel"]) {
    expect(subtitles).toContain(phrase);
  }
  const cues = [...subtitles.matchAll(/^(\d\d):(\d\d):(\d\d\.\d{3}) --> (\d\d):(\d\d):(\d\d\.\d{3})$/gm)];
  expect(cues).toHaveLength(5);
  let previousEnd = 0;
  for (const cue of cues) {
    const start = Number(cue[1]) * 3600 + Number(cue[2]) * 60 + Number(cue[3]);
    const end = Number(cue[4]) * 3600 + Number(cue[5]) * 60 + Number(cue[6]);
    expect(start).toBeGreaterThanOrEqual(previousEnd);
    expect(end).toBeGreaterThan(start);
    previousEnd = end;
  }
  expect(previousEnd).toBe(31);
});

test("the store copyright has its own styling without changing the legal links", () => {
  const copyright = container.querySelector(".public-footer .public-copyright");
  expect(copyright.textContent).toBe("© 2026 ΣIRIUS par Daniel Partel");
  expect(copyright.closest("footer").querySelectorAll("a")).toHaveLength(5);
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
  expect(section.querySelector('img[src="/demo/sirius-planning.png"]').getAttribute("alt"))
    .toContain("rendez-vous fictif");
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

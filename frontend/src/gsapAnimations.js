// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Animations GSAP centralisées : ouverture, fermeture, resize élastique, holographique.
import { gsap } from "gsap";

// Les fenêtres restent opaques pendant leurs transitions : sans fondu ni flou, le HUD
// ne transparaît jamais et la WebView Android n'a pas de filtre coûteux à recalculer.
export function animateWindowOpen(el) {
  gsap.killTweensOf(el);
  gsap.from(el, {
    scale: 0.97,
    y: 10,
    duration: 0.22,
    ease: "power2.out",
    clearProps: "transform",
  });
}

export function animateWindowClose(el, onComplete) {
  gsap.killTweensOf(el);
  gsap.to(el, {
    scale: 0.97,
    y: 10,
    duration: 0.12,
    ease: "power2.in",
    onComplete,
  });
}

export function animateResizeSettle(el) {
  gsap.killTweensOf(el, "transform");
  gsap.fromTo(
    el,
    { scale: 0.993 },
    { scale: 1, duration: 0.5, ease: "elastic.out(1, 0.35)", clearProps: "transform" }
  );
}

// Fermeture holographique 3D pour les panels couverts par holoFx
export function animateHoloClose(panel, onComplete) {
  gsap.killTweensOf(panel);
  gsap.to(panel, {
    opacity: 0,
    scale: 0.9,
    y: 18,
    rotationX: -9,
    filter: "brightness(2.2)",
    transformPerspective: 1400,
    duration: 0.22,
    ease: "power2.in",
    onComplete: () => {
      gsap.set(panel, { clearProps: "all" });
      onComplete();
    },
  });
}

// Variante pour .central-card : rotationX + blur plus prononcés
export function animateHoloCloseCard(panel, onComplete) {
  gsap.killTweensOf(panel);
  gsap.to(panel, {
    opacity: 0,
    scale: 0.85,
    rotationX: -8,
    filter: "brightness(2.4) blur(9px)",
    transformPerspective: 1400,
    duration: 0.22,
    ease: "power2.in",
    onComplete: () => {
      gsap.set(panel, { clearProps: "all" });
      onComplete();
    },
  });
}

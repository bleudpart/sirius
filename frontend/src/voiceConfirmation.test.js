import {
  isWindowCommand, moduleActionConfirmation, observeWindowChanges, shortStatusToSpeak, snapshotWindows, windowChangeConfirmation,
} from "./voiceConfirmation";

const addWindow = (title, cls = "zeus-screen") => {
  const el = document.createElement("div");
  el.className = cls;
  el.innerHTML = `<h2>${title}</h2><p>contenu</p>`;
  document.body.appendChild(el);
  return el;
};

describe("confirmations vocales des actions", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  test("ne surveille que les commandes d'action", () => {
    expect(isWindowCommand("Sirius ouvre Thémis")).toBe(true);
    expect(isWindowCommand("ferme la fenêtre")).toBe(true);
    expect(isWindowCommand("affiche la météo")).toBe(true);
    expect(isWindowCommand("quel temps fait-il demain ?")).toBe(false);
    expect(isWindowCommand("explique-moi la photosynthèse")).toBe(false);
    expect(isWindowCommand("allume la lumière du salon")).toBe(true);
    expect(isWindowCommand("envoie un mail à Paul")).toBe(true);
  });

  test("observe les fenêtres ouvertes au doigt ou à la souris", async () => {
    const changes = [];
    const stop = observeWindowChanges((prev, next) => changes.push(windowChangeConfirmation("", prev, next)), { delay: 10 });
    addWindow("Atlas");
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(changes).toEqual(["J'ouvre Atlas."]);
  });

  test("formule la confirmation selon le verbe", () => {
    expect(moduleActionConfirmation("ouvre thémis", "THÉMIS — Gestion")).toBe("J'ouvre THÉMIS — Gestion.");
    expect(moduleActionConfirmation("affiche la bourse", "Bourse")).toBe("J'affiche Bourse.");
    expect(moduleActionConfirmation("lance atlas", "Atlas")).toBe("Je lance Atlas.");
    expect(moduleActionConfirmation("ferme atlas", "Atlas", "close")).toBe("Je ferme Atlas.");
    expect(moduleActionConfirmation("masque atlas", "Atlas", "close")).toBe("Je masque Atlas.");
  });

  test("annonce la fenêtre ouverte", () => {
    const before = snapshotWindows();
    addWindow("ZEUS CORTEX");
    expect(windowChangeConfirmation("ouvre le cortex", before, snapshotWindows())).toBe("J'ouvre Zeus Cortex.");
  });

  test("lit le titre doré complet plutôt que le nom technique du panneau", () => {
    const before = snapshotWindows();
    const panel = addWindow("Sous-section", "prime-screen");
    panel.setAttribute("data-testid", "pantheon-panel");
    panel.setAttribute("aria-label", "Pantheon panel");
    panel.insertAdjacentHTML("afterbegin", '<div class="oracle-title font-divine">PANTHEON SYSTEM</div>');
    expect(windowChangeConfirmation("ouvre panthéon", before, snapshotWindows())).toBe("J'ouvre Pantheon System.");
  });

  test("ne tronque ni le sous-titre ni les titres longs", () => {
    const before = snapshotWindows();
    addWindow("HÉPHAÏSTOS — AUTO-MAINTENANCE ET DIAGNOSTIC DU SYSTÈME");
    expect(windowChangeConfirmation("ouvre héphaïstos", before, snapshotWindows()))
      .toBe("J'ouvre Héphaïstos — Auto-Maintenance Et Diagnostic Du Système.");
  });

  test("annonce la fenêtre fermée, pas celle rangée en pastille", () => {
    const atlas = addWindow("Atlas");
    const before = snapshotWindows();
    atlas.remove();
    expect(windowChangeConfirmation("ferme atlas", before, snapshotWindows())).toBe("Je ferme Atlas.");

    const themis = addWindow("Thémis");
    const before2 = snapshotWindows();
    themis.classList.add("holo-win", "holo-minimized");
    expect(windowChangeConfirmation("ferme", before2, snapshotWindows())).toBeNull();
  });

  test("ne lit que les messages courts et définitifs", () => {
    expect(shortStatusToSpeak("Lumière du salon allumée.", "avant", "allume le salon")).toBe("Lumière du salon allumée.");
    expect(shortStatusToSpeak("Recherche en cours...", "avant", "x")).toBeNull();
    expect(shortStatusToSpeak("a".repeat(130), "avant", "x")).toBeNull();
    expect(shortStatusToSpeak("même", "même", "x")).toBeNull();
    expect(shortStatusToSpeak("ouvre atlas", "avant", "ouvre atlas")).toBeNull();
  });
});

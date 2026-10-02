import { act } from "react";
import { createRoot } from "react-dom/client";
import SportCoachPanel from "./SportCoachPanel";
import { sportStorageKey } from "./sportSessions";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("SportCoachPanel", () => {
  let container;
  let root;
  let writes;
  let removals;
  let network;
  let xhrOpen;
  let originalFetch;
  const user = { id: "sport-test-user" };
  const otherUser = { id: "sport-other-user" };

  beforeEach(() => {
    localStorage.removeItem(sportStorageKey(user));
    localStorage.removeItem(sportStorageKey(otherUser));
    writes = jest.spyOn(Storage.prototype, "setItem");
    removals = jest.spyOn(Storage.prototype, "removeItem");
    originalFetch = globalThis.fetch;
    network = jest.fn();
    globalThis.fetch = network;
    xhrOpen = jest.spyOn(XMLHttpRequest.prototype, "open");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<SportCoachPanel user={user} onClose={() => {}} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
    localStorage.removeItem(sportStorageKey(user));
    localStorage.removeItem(sportStorageKey(otherUser));
  });

  const button = (text) => [...container.querySelectorAll("button")]
    .find((entry) => entry.textContent.includes(text) || entry.getAttribute("aria-label") === text);
  const select = (text, value) => {
    const label = [...container.querySelectorAll("label")].find((node) => node.textContent.includes(text));
    act(() => {
      label.querySelector("select").value = value;
      label.querySelector("select").dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const propose = (comfort = "confortable", effort = "modere") => {
    select("Confort des mouvements", comfort);
    select("Effort ressenti", effort);
    act(() => button("Voir les adaptations locales").click());
  };
  const finishSteps = (skip = false) => {
    for (let index = 0; index < 10 && button("Effectué"); index += 1) {
      act(() => button(skip ? "Passer" : "Effectué").click());
    }
    expect(container.textContent).toContain("Retour au calme");
  };
  const remount = (nextUser = user) => {
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<SportCoachPanel user={nextUser} onClose={() => {}} />));
  };
  const seed = (entries, targetUser = user) => {
    localStorage.setItem(sportStorageKey(targetUser), JSON.stringify(entries));
    remount();
    writes.mockClear();
    removals.mockClear();
  };
  const savedEntry = (overrides = {}) => ({
    id: "one", at: "2026-02-03T12:00:00Z", goal: "mobilite", exercises: ["walk"], effort: "difficile",
    ...overrides,
  });
  const expectPrivate = () => {
    expect(network).not.toHaveBeenCalled();
    expect(xhrOpen).not.toHaveBeenCalled();
  };

  test("shows safety and local privacy before starting", () => {
    expect(container.textContent).toContain("pas un avis médical");
    expect(container.textContent).toContain("uniquement sur cet appareil");
    expect(localStorage.getItem(sportStorageKey(user))).toBeNull();
  });

  test("shows the supplied portrait beside the coach content like other Pantheon modules", () => {
    const panel = container.querySelector('[data-testid="sport-coach"]');
    const portrait = container.querySelector('[data-testid="asclepios-portrait"]');
    expect(panel.children[1]).toBe(portrait);
    expect(panel.children[2].classList.contains("sport-body")).toBe(true);
    expect(portrait.classList.contains("mythos-avatar")).toBe(true);
    expect(portrait.getAttribute("src")).toMatch(/\/api\/mythos\/img\/asclepios\.png$/);
    expect(container.textContent).toContain("BIEN-ÊTRE & SANTÉ");
    expectPrivate();
  });

  test("skipping does not claim completion, stopping does not persist", () => {
    act(() => button("Préparer une séance").click());
    expect(container.textContent).toContain("Étape 1");
    expect(container.querySelectorAll(".sport-figure")).toHaveLength(1);
    act(() => button("Pause").click());
    expect(button("Effectué").disabled).toBe(true);
    expect(button("Passer").disabled).toBe(true);
    act(() => button("Reprendre").click());
    act(() => button("Passer").click());
    expect(container.textContent).toContain("Étape 2");
    expect(container.textContent).toContain("0 mouvement(s) noté(s)");
    act(() => button("Arrêter sans enregistrer").click());
    expect(localStorage.getItem(sportStorageKey(user))).toBeNull();
  });

  test("records a session only after explicit completion", () => {
    act(() => button("Préparer une séance").click());
    for (let index = 0; index < 4; index += 1) {
      act(() => button("Effectué").click());
    }
    expect(container.textContent).toContain("Retour au calme");
    expect(localStorage.getItem(sportStorageKey(user))).toBeNull();
    act(() => button("Terminer et enregistrer").click());
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))[0].exercises).toHaveLength(4);
    expect(container.textContent).toContain("Séance enregistrée");
  });

  test("deletes the journal only after confirmation", () => {
    act(() => root.unmount());
    localStorage.setItem(sportStorageKey(user), JSON.stringify([{
      id: "one", at: "2026-02-03T12:00:00Z", goal: "force", exercises: ["walk"], effort: "facile",
    }]));
    root = createRoot(container);
    act(() => root.render(<SportCoachPanel user={user} onClose={() => {}} />));
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    act(() => button("Effacer le journal").click());
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))).toHaveLength(1);
    confirm.mockReturnValue(true);
    act(() => button("Effacer le journal").click());
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))).toEqual([]);
    confirm.mockRestore();
  });

  test("preserves unreadable history until explicit reset", () => {
    act(() => root.unmount());
    localStorage.setItem(sportStorageKey(user), '[{"id":"broken"}]');
    root = createRoot(container);
    act(() => root.render(<SportCoachPanel user={user} onClose={() => {}} />));
    expect(button("Préparer une séance").disabled).toBe(true);
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    act(() => button("Effacer le journal illisible").click());
    expect(localStorage.getItem(sportStorageKey(user))).not.toBeNull();
    confirm.mockReturnValue(true);
    act(() => button("Effacer le journal illisible").click());
    expect(localStorage.getItem(sportStorageKey(user))).toBeNull();
    expect(button("Préparer une séance").disabled).toBe(false);
    confirm.mockRestore();
  });

  test("history is not consulted for a proposal or automatically applied on opening", () => {
    seed([savedEntry()]);
    expect(container.querySelector(".sport-proposal")).toBeNull();
    expect(button("Voir les adaptations locales").disabled).toBe(true);
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    act(() => button("Préparer une séance").click());
    expect(container.textContent).toContain("Format : Habituelle");
    expect(container.textContent).toContain("Étape 1 / 4");
    expect(writes).not.toHaveBeenCalled();
    expectPrivate();
  });

  test("proposing gentle does not apply it without approval, and no draft is stored", () => {
    seed([savedEntry()]);
    propose();
    expect(container.textContent).toContain("Proposition : Douce");
    expect(container.textContent).toContain("1 séance(s) locale(s)");
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    act(() => button("Préparer une séance").click());
    expect(container.textContent).toContain("Format : Habituelle");
    finishSteps();
    act(() => button("Terminer et enregistrer").click());
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))[0].adaptation).toBeUndefined();
    expectPrivate();
  });

  test.each([
    ["Douce", "gentle", 4, 25],
    ["Courte", "short", 3, 15],
    ["Habituelle", "usual", 4, 25],
  ])("explicit %s choice persists only at finish and is visible after reopening", (label, choice, count, minutes) => {
    propose("a_ajuster", "difficile");
    act(() => button(`Choisir : ${label}`).click());
    expect(button(`Choisir : ${label}`).getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain(`Choix confirmé : ${label}`);
    expect(writes).not.toHaveBeenCalled();
    act(() => button("Préparer une séance").click());
    expect(container.textContent).toContain(`Format : ${label}`);
    expect(container.textContent).toContain(`environ ${minutes} minutes`);
    expect(container.textContent).toContain(`Étape 1 / ${count}`);
    act(() => button("Passer").click());
    act(() => button("Pause").click());
    expect(button("Effectué").disabled).toBe(true);
    expect(button("Passer").disabled).toBe(true);
    act(() => button("Reprendre").click());
    finishSteps();
    select("Comment était cette séance", "facile");
    expect(container.textContent).toContain("les ressentis de préparation");
    expect(writes).not.toHaveBeenCalled();
    act(() => button("Terminer et enregistrer").click());
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0]).toBe(sportStorageKey(user));
    const saved = JSON.parse(localStorage.getItem(sportStorageKey(user)))[0];
    expect(saved.adaptation).toEqual({ choice, comfort: "a_ajuster", effort: "difficile" });
    expect(saved.effort).toBe("facile");
    expect(saved.minutes).toBe(minutes);
    expect(saved.exercises).toHaveLength(count - 1);
    expect(saved.exercises).not.toContain("walk");
    remount();
    expect(container.textContent).toContain(`choix : ${label}`);
    expect(container.textContent).toContain("confort de préparation : Je préfère alléger les mouvements");
    expect(container.textContent).toContain("effort de préparation : difficile");
    expect(container.querySelector(".sport-proposal")).toBeNull();
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expectPrivate();
  });

  test("a 15-minute short choice gives two manually completed steps and ten indicative minutes", () => {
    select("Temps disponible", "15");
    propose();
    act(() => button("Choisir : Courte").click());
    act(() => button("Préparer une séance").click());
    expect(container.textContent).toContain("environ 10 minutes");
    expect(container.textContent).toContain("Étape 1 / 2");
    finishSteps(true);
    act(() => button("Terminer et enregistrer").click());
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))[0].exercises).toEqual([]);
    propose();
    expect(container.textContent).toContain("0 séance(s) locale(s)");
    expectPrivate();
  });

  test.each([
    ["Confort des mouvements", "a_ajuster"],
    ["Effort ressenti", "difficile"],
    ["Objectif", "force"],
    ["Matériel", "elastique"],
    ["Temps disponible", "40"],
  ])("changing %s invalidates the previous proposal and approval", (field, value) => {
    propose();
    act(() => button("Choisir : Courte").click());
    select(field, value);
    expect(container.querySelector(".sport-proposal")).toBeNull();
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    act(() => button("Préparer une séance").click());
    expect(container.textContent).toContain("Format : Habituelle");
    expect(writes).not.toHaveBeenCalled();
    expectPrivate();
  });

  test("ignoring, stopping and closing do not save or retain adaptation drafts", () => {
    propose();
    act(() => button("Choisir : Douce").click());
    act(() => button("Ignorer les adaptations").click());
    expect(container.querySelector(".sport-proposal")).toBeNull();
    expect(button("Voir les adaptations locales").disabled).toBe(true);
    propose();
    act(() => button("Choisir : Douce").click());
    act(() => button("Préparer une séance").click());
    act(() => button("Effectué").click());
    act(() => button("Arrêter sans enregistrer").click());
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expect(button("Voir les adaptations locales").disabled).toBe(true);
    propose();
    act(() => button("Choisir : Courte").click());
    const onClose = jest.fn();
    act(() => root.render(<SportCoachPanel user={user} onClose={onClose} />));
    act(() => button("Fermer").click());
    expect(onClose).toHaveBeenCalledTimes(1);
    remount();
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expectPrivate();
  });

  test("switching accounts discards live progress and cannot copy history or choices", () => {
    seed([savedEntry()]);
    propose();
    act(() => button("Choisir : Douce").click());
    act(() => button("Préparer une séance").click());
    act(() => button("Effectué").click());
    act(() => root.render(<SportCoachPanel user={otherUser} onClose={() => {}} />));
    expect(container.textContent).toContain("Aucune séance enregistrée");
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expect(container.querySelector(".sport-step")).toBeNull();
    propose();
    expect(container.textContent).toContain("0 séance(s) locale(s)");
    act(() => button("Choisir : Courte").click());
    act(() => button("Préparer une séance").click());
    finishSteps();
    act(() => button("Terminer et enregistrer").click());
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0][0]).toBe(sportStorageKey(otherUser));
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))).toEqual([savedEntry()]);
    act(() => root.render(<SportCoachPanel user={user} onClose={() => {}} />));
    expect(container.textContent).not.toContain("choix : Courte");
    expect(container.textContent).toContain("ressenti : difficile");
    expectPrivate();
  });

  test("failed save keeps approved metadata and progress available for explicit retry", () => {
    propose();
    act(() => button("Choisir : Douce").click());
    act(() => button("Préparer une séance").click());
    finishSteps();
    select("Comment était cette séance", "difficile");
    writes.mockImplementationOnce(() => { throw new Error("Quota dépassé"); });
    act(() => button("Terminer et enregistrer").click());
    expect(container.textContent).toContain("Enregistrement impossible : Quota dépassé");
    expect(container.textContent).toContain("La séance reste ouverte");
    expect(localStorage.getItem(sportStorageKey(user))).toBeNull();
    act(() => button("Terminer et enregistrer").click());
    const saved = JSON.parse(localStorage.getItem(sportStorageKey(user)))[0];
    expect(saved.adaptation.choice).toBe("gentle");
    expect(saved.effort).toBe("difficile");
    expect(saved.exercises).toHaveLength(4);
    expectPrivate();
  });

  test("deleting approved history clears suggestions only on successful confirmation", () => {
    const saved = savedEntry({ adaptation: { choice: "short", comfort: "confortable", effort: "modere" } });
    seed([saved]);
    propose();
    act(() => button("Choisir : Douce").click());
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
    act(() => button("Effacer le journal").click());
    expect(writes).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Choix confirmé : Douce");
    confirm.mockReturnValue(true);
    writes.mockImplementationOnce(() => { throw new Error("Stockage indisponible"); });
    act(() => button("Effacer le journal").click());
    expect(container.textContent).toContain("Suppression impossible");
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))).toEqual([saved]);
    act(() => button("Effacer le journal").click());
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))).toEqual([]);
    expect(container.querySelector(".sport-proposal")).toBeNull();
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expectPrivate();
  });

  test("invalid adaptation metadata is preserved and blocks both preparation and proposals", () => {
    const entries = [savedEntry({ adaptation: { choice: "automatic", comfort: "confortable", effort: "modere" } })];
    seed(entries);
    select("Confort des mouvements", "confortable");
    select("Effort ressenti", "modere");
    expect(container.querySelector('[role="alert"]').textContent).toContain("Historique local illisible");
    expect(button("Préparer une séance").disabled).toBe(true);
    expect(button("Voir les adaptations locales").disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))).toEqual(entries);
    expect(writes).not.toHaveBeenCalled();
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
    removals.mockImplementationOnce(() => { throw new Error("Accès refusé"); });
    act(() => button("Effacer le journal illisible").click());
    expect(container.textContent).toContain("Réinitialisation impossible : Accès refusé");
    expect(button("Préparer une séance").disabled).toBe(true);
    act(() => button("Effacer le journal illisible").click());
    expect(localStorage.getItem(sportStorageKey(user))).toBeNull();
    expect(button("Préparer une séance").disabled).toBe(false);
    expect(button("Voir les adaptations locales").disabled).toBe(true);
    confirm.mockRestore();
    expectPrivate();
  });

  test("keeps the 50-entry limit and does not carry final effort into another session", () => {
    seed(Array.from({ length: 50 }, (_, index) => savedEntry({ id: `history-${index}` })));
    propose();
    act(() => button("Choisir : Courte").click());
    act(() => button("Préparer une séance").click());
    finishSteps();
    select("Comment était cette séance", "difficile");
    act(() => button("Terminer et enregistrer").click());
    const saved = JSON.parse(localStorage.getItem(sportStorageKey(user)));
    expect(saved).toHaveLength(50);
    expect(saved[0].adaptation.choice).toBe("short");
    expect(saved.some(({ id }) => id === "history-49")).toBe(false);
    act(() => button("Préparer une séance").click());
    finishSteps();
    expect(container.querySelector("select").value).toBe("modere");
    expectPrivate();
  });

  test("revisiting a completed step never duplicates it or saves during manual navigation", () => {
    propose();
    act(() => button("Choisir : Courte").click());
    act(() => button("Préparer une séance").click());
    act(() => button("Effectué").click());
    act(() => button("Précédent").click());
    act(() => button("Effectué").click());
    act(() => button("Passer").click());
    act(() => button("Effectué").click());
    expect(writes).not.toHaveBeenCalled();
    act(() => button("Terminer et enregistrer").click());
    expect(JSON.parse(localStorage.getItem(sportStorageKey(user)))[0].exercises).toEqual(["walk", "birdDog"]);
    expectPrivate();
  });

  test("requesting another proposal does not reuse approval from the previous proposal", () => {
    propose();
    act(() => button("Choisir : Courte").click());
    act(() => button("Voir les adaptations locales").click());
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expect(button("Choisir : Courte").getAttribute("aria-pressed")).toBe("false");
    expect(writes).not.toHaveBeenCalled();
    expectPrivate();
  });

  test("blocked local storage is reported and never triggers a remote fallback", () => {
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Lecture refusée"); });
    remount();
    expect(container.querySelector('[role="alert"]').textContent).toContain("Lecture refusée");
    expect(button("Préparer une séance").disabled).toBe(true);
    select("Confort des mouvements", "confortable");
    select("Effort ressenti", "facile");
    expect(button("Voir les adaptations locales").disabled).toBe(true);
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    expectPrivate();
  });

  test("account changes also discard an unstarted choice while retaining that account's journal", () => {
    seed([savedEntry()]);
    propose();
    act(() => button("Choisir : Douce").click());
    act(() => root.render(<SportCoachPanel user={otherUser} onClose={() => {}} />));
    expect(container.textContent).toContain("Aucune séance enregistrée");
    expect(container.querySelector(".sport-proposal")).toBeNull();
    expect(button("Voir les adaptations locales").disabled).toBe(true);
    act(() => root.render(<SportCoachPanel user={user} onClose={() => {}} />));
    expect(container.textContent).toContain("ressenti : difficile");
    expect(container.textContent).toContain("Aucune adaptation appliquée");
    expect(writes).not.toHaveBeenCalled();
    expectPrivate();
  });
});

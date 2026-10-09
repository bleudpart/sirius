jest.mock("@/voice", () => ({ speakFr: jest.fn(), cancelSpeech: jest.fn() }));

import { speakFr } from "@/voice";
import { parseReadPanelCommand, readPanelAloud } from "./readAloud";

const addPanel = (label, body) => {
  const panel = document.createElement("div");
  panel.className = "hud-panel";
  panel.setAttribute("aria-label", label);
  panel.innerHTML = `<h2>${label}</h2><p>${body}</p><button>Fermer</button>`;
  panel.getClientRects = () => [{}];
  document.body.appendChild(panel);
  return panel;
};

describe("lecture à voix haute sur commande", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    speakFr.mockClear();
  });

  test("parseReadPanelCommand extrait la fenêtre demandée", () => {
    expect(parseReadPanelCommand("lis Zeus Cortex")).toBe("Zeus Cortex");
    expect(parseReadPanelCommand("lis-moi la fenêtre de Thémis")).toBe("Thémis");
    expect(parseReadPanelCommand("lis ça")).toBe("");
    expect(parseReadPanelCommand("relis à voix haute le module météo.")).toBe("météo");
    expect(parseReadPanelCommand("lis ce qu'il y a dans le module ODYSSEIA")).toBe("ODYSSEIA");
    expect(parseReadPanelCommand("lis ce qu il y a dans le module ODYSSEIA")).toBe("ODYSSEIA");
    expect(parseReadPanelCommand("lis tout ce qu'il y a dans la fenêtre de Zeus Cortex")).toBe("Zeus Cortex");
    expect(parseReadPanelCommand("lis ce qui est affiché dans Thémis")).toBe("Thémis");
  });

  test("parseReadPanelCommand laisse passer les commandes mails et les autres", () => {
    expect(parseReadPanelCommand("lis mes mails")).toBeNull();
    expect(parseReadPanelCommand("lis le message 3")).toBeNull();
    expect(parseReadPanelCommand("lis le premier")).toBeNull();
    expect(parseReadPanelCommand("ouvre zeus cortex")).toBeNull();
  });

  test("readPanelAloud lit la fenêtre correspondante sans les boutons", () => {
    addPanel("Zeus Cortex", "Analyse stratégique du jour");
    addPanel("Météo", "Grand soleil sur Paris");
    expect(readPanelAloud("zeus cortex")).toBe(true);
    expect(speakFr).toHaveBeenCalledWith("Je lis Zeus Cortex. Analyse stratégique du jour");
  });

  test("readPanelAloud lit le contenu visible d'une fenêtre roue ciblée", () => {
    const panel = document.createElement("div");
    panel.className = "modwheel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "ODYSSEIA — bibliothèque des mythes anciens");
    panel.innerHTML = "<h2>ODYSSEIA</h2><section><h3>Paroles inspirées des mythes</h3><p>La sagesse est l'arme que nul bouclier ne peut arrêter.</p><button>Suivante</button></section>";
    panel.getClientRects = () => [{}];
    document.body.appendChild(panel);

    expect(readPanelAloud("ODYSSEIA")).toBe(true);
    expect(speakFr).toHaveBeenCalledWith(expect.stringContaining("Je lis ODYSSEIA"));
    expect(speakFr.mock.calls[0][0]).toContain("La sagesse est l'arme que nul bouclier ne peut arrêter");
    expect(speakFr.mock.calls[0][0]).not.toContain("Suivante");
  });

  test("readPanelAloud can target other accessible module dialogs", () => {
    const panel = document.createElement("section");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Journal des tâches");
    panel.innerHTML = "<h2>Journal des tâches</h2><p>Trois actions sont terminées et une tâche reste à faire.</p>";
    panel.getClientRects = () => [{}];
    document.body.appendChild(panel);

    expect(readPanelAloud("journal des tâches")).toBe(true);
    expect(speakFr).toHaveBeenCalledWith(expect.stringContaining("Trois actions sont terminées"));
  });

  test("readPanelAloud lit la dernière fenêtre si aucune ne correspond", () => {
    addPanel("Zeus Cortex", "Analyse stratégique du jour");
    addPanel("Météo", "Grand soleil sur Paris");
    expect(readPanelAloud("")).toBe(true);
    expect(speakFr).toHaveBeenCalledWith("Je lis Météo. Grand soleil sur Paris");
  });

  test("readPanelAloud renvoie false sans fenêtre visible", () => {
    expect(readPanelAloud("zeus")).toBe(false);
    expect(speakFr).not.toHaveBeenCalled();
  });
});

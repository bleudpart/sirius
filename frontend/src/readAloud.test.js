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

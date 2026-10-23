import { act } from "react";
import { createRoot } from "react-dom/client";
import DuerpSection from "./DuerpSection";
import HaccpModule from "./HaccpModule";
import { duerpPrintHtml, riskPriority } from "./duerpDocument";
import { findModuleForCommand, MODULE_ALIASES } from "./moduleCommandRouting";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, originalFetch;
const documentData = {
  id: "version-1", created_at: "2026-10-23T10:00:00Z", date_evaluation: "2026-10-23",
  etablissement: "Cuisine", adresse: "Rue test", employeur: "Responsable", effectif: 0,
  participants: "Équipe", motif_revision: "Initiale",
  risques: [{ unite: "Cuisine", situation: "Découpe", danger: "Couteau", personnes: "Cuisiniers",
    dommages: "Coupures", mesures_existantes: "Formation", gravite: 3, probabilite: 4,
    action: "Adapter le poste", responsable: "Chef", echeance: "2026-11-01", statut: "en_cours" }],
};
const reply = (data, ok = true, status = 200) => ({ ok, status, json: async () => data });
beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith("/current")) return reply({ document: documentData });
    if (url.endsWith("/duerp")) return reply({ items: [{
      ...documentData, nombre_risques: 1,
    }], truncated: false });
    if (url.endsWith("/overview")) return reply({});
    if (url.endsWith("/trace")) return reply({ items: [] });
    return reply({ document: documentData });
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch; jest.restoreAllMocks();
});
const render = async (node = <DuerpSection />) => act(async () => root.render(node));
const button = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.includes(text));
async function change(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(
    input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
  await act(async () => {
    descriptor.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("DUERP is an HACCP tab that opens directly with a source and preserves other tabs", async () => {
  await render(<HaccpModule initialSource={{ kind: "duerp" }} onClose={jest.fn()} />);
  expect(host.querySelector('[data-testid="haccp-tab-duerp"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="haccp-section-duerp"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid="haccp-tab-trace"]').click());
  expect(host.querySelector('[data-testid="haccp-section-trace"]')).not.toBeNull();
});

test("saved assessment loads with version, risk score, action and authenticated centralized API", async () => {
  await render();
  expect(host.textContent).toContain("score 12, priorité Haute");
  expect(host.querySelector('textarea').value).toBe("Cuisine");
  expect(button("IMPRIMER").disabled).toBe(false);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/api\/haccp\/duerp\/current$/);
  expect(global.fetch.mock.calls[0][1].credentials).toBe("include");
});

test("saving creates a new version, strips computed scores and preserves dates and zero workforce", async () => {
  await render();
  await change(host.querySelector('input'), "Cuisine révisée");
  expect(button("IMPRIMER").disabled).toBe(true);
  global.fetch.mockImplementationOnce(async (url, options) => {
    const body = JSON.parse(options.body);
    expect(body.etablissement).toBe("Cuisine révisée");
    expect(body.effectif).toBe(0);
    expect(body.risques[0].echeance).toBe("2026-11-01");
    expect(body.risques[0]).not.toHaveProperty("score");
    expect(body).not.toHaveProperty("id");
    return reply({ document: { ...body, id: "version-2", created_at: "2026-10-23T11:00:00Z" } });
  });
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.textContent).toContain("Nouvelle version DUERP enregistrée");
  expect(button("IMPRIMER").disabled).toBe(false);
  expect(host.querySelectorAll('select[aria-label="Version DUERP"] option')).toHaveLength(3);
});

test("save failure is visible and retains edited data without enabling printing", async () => {
  await render();
  await change(host.querySelector('input'), "À conserver");
  global.fetch.mockResolvedValueOnce(reply({ detail: "Connexion refusée." }, false, 401));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Connexion refusée");
  expect(host.querySelector('input').value).toBe("À conserver");
  expect(button("IMPRIMER").disabled).toBe(true);
});

test("initial load failure is explicit", async () => {
  global.fetch.mockRejectedValue(new Error("Serveur indisponible"));
  await render();
  expect(host.querySelector('[role="alert"]').textContent).toContain("Serveur indisponible");
  expect(button("IMPRIMER").disabled).toBe(true);
});

test("dirty DUERP requires confirmation before changing HACCP tab or closing", async () => {
  const onClose = jest.fn();
  jest.spyOn(window, "confirm").mockReturnValue(false);
  await render(<HaccpModule initialSource={{ kind: "duerp" }} onClose={onClose} />);
  await change(host.querySelector('input'), "Pas encore sauvé");
  await act(async () => host.querySelector('[data-testid="haccp-tab-trace"]').click());
  expect(host.querySelector('[data-testid="haccp-section-duerp"]')).not.toBeNull();
  await act(async () => host.querySelector('[data-testid="haccp-close-btn"]').click());
  expect(onClose).not.toHaveBeenCalled();
  expect(window.confirm).toHaveBeenCalledTimes(2);
});

test("print document contains all risks, action plan, signatures and safely escaped text, not HUD", () => {
  const html = duerpPrintHtml({
    ...documentData, etablissement: '<img src=x onerror="attack()">',
    risques: [...documentData.risques, { ...documentData.risques[0], unite: "Plonge" }],
  });
  expect(html).toContain("A4 landscape");
  expect(html).toContain("plan d'actions");
  expect(html).toContain("Plonge");
  expect(html).toContain("Adapter le poste");
  expect(html).toContain("01/11/2026");
  expect(html).toContain('lang="fr"');
  expect(html).toContain("Signature");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("prime-screen");
  expect(html).toContain("Effectif :</b> 0");
});

test("empty document prints fillable lines without claiming no risks or certification", () => {
  const html = duerpPrintHtml({ ...documentData, risques: [], adresse: "" });
  expect(html).toContain("À compléter");
  expect(html).toContain("ne signifie pas une absence de risques");
  expect(html).toContain("aucune conformité");
  expect((html.match(/<tr>/g) || [])).toHaveLength(7);
});

test.each([[1, 4, "Basse"], [2, 3, "Moyenne"], [3, 3, "Moyenne"], [3, 4, "Haute"]])(
  "risk priority matches printed and server thresholds (%s × %s)", (gravite, probabilite, label) => {
    expect(riskPriority({ gravite, probabilite })).toEqual({ score: gravite * probabilite, label });
  });

test.each(["ouvre le DUERP", "ouvre le document unique", "affiche les risques professionnels"])(
  "DUERP command routes to HACCP: %s", (command) => {
    expect(findModuleForCommand(command, [{ id: "haccp", label: "HACCP — sécurité alimentaire & DUERP" }], MODULE_ALIASES).item?.id).toBe("haccp");
  });

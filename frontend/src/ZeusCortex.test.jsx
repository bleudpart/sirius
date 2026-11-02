import React, { act } from "react";
import { createRoot } from "react-dom/client";
import ZeusCortex from "./ZeusCortex";
import { validateAnalyticalView } from "./ZeusAnalyticalBrain";
import { API_BASE_URL } from "./lib/api";
import { formatFinanceValue } from "./companyFinance";
import fixture from "./__fixtures__/brainAnalytical.json";

jest.mock("./ZeusTriCortex", () => () => null);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let host;
let originalFetch;
let current;
const clone = (value) => JSON.parse(JSON.stringify(value));
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => clone(body) });
const buttons = () => Array.from(host.querySelectorAll("button"));
const button = (label) => buttons().find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
const click = async (element) => {
  expect(element).toBeTruthy();
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
const mount = async () => {
  await act(async () => root.render(<ZeusCortex onClose={jest.fn()} onAsk={jest.fn()} />));
};

function serve(handler) {
  global.fetch = jest.fn((url, options = {}) => {
    const path = String(url).slice(API_BASE_URL.length);
    if (path === "/cortex/stats") return reply(200, { totaux: { commandes: 7 }, intents: [] });
    if (path === "/cortex/dashboard?days=30") return reply(200, { journal: [], services: [], flows: [], timeline: [] });
    if (handler) {
      const result = handler(path, options);
      if (result) return result;
    }
    if (path === "/cortex/analytique") return reply(200, current);
    if (path === "/finance/a/cerveau/analyse") return reply(202, { company_id: "a", acceptee: true });
    const match = path.match(/^\/finance\/a\/cerveau\/alertes\/(\d+)\/acquitter$/);
    if (match) {
      const row = current.etat.alertes.find((a) => String(a.id) === match[1]);
      row.statut = "ACQUITTEE";
      row.acquittee_le = "2026-03-31T12:00:00Z";
      return reply(200, row);
    }
    return reply(404, { detail: `Route inattendue : ${path}` });
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  originalFetch = global.fetch;
  current = clone(fixture);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  serve();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
  jest.useRealTimers();
});

test("le contrat réel du backend affiche les trois cerveaux, les chiffres et la télémétrie existante", async () => {
  expect(validateAnalyticalView(fixture)).toBe(fixture);
  await mount();
  expect(host.querySelector('[data-testid="zeus-analytical"]')).not.toBeNull();
  expect(host.textContent).toContain("AUDIT FINANCIER · SENTINEL");
  expect(host.textContent).toContain("Brain 1 · dialogue direct");
  expect(host.textContent).toContain("Brain 2 · logique métier directe");
  expect(host.textContent).toContain("Brain 3 · Sentinel Master");
  expect(host.textContent).toContain("Entreprise A");
  expect(host.textContent).toContain(formatFinanceValue("-3000.00"));
  expect(host.textContent).toContain("J+15");
  expect(host.textContent).toContain("J+90");
  expect(host.textContent).toContain("Synthèse déterministe");
  expect(host.textContent).toContain("Aucun fournisseur IA configuré.");
  expect(host.textContent).toContain("Analyse vérifiée sur les pièces enregistrées.");
  expect(host.querySelector('[data-testid="zeus-totals"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="zeus-ask-input"]').placeholder).toContain("ΣIRIUS");
  expect(global.fetch.mock.calls.every(([url, opts]) => String(url).startsWith(API_BASE_URL) && opts.credentials === "include")).toBe(true);
});

test("relance une analyse par POST sans aucune valeur financière", async () => {
  await mount();
  await click(button("Relancer l’analyse"));
  const call = global.fetch.mock.calls.find(([url]) => url.endsWith("/cerveau/analyse"));
  expect(call[1].method).toBe("POST");
  expect(call[1].headers).toEqual({ "Content-Type": "application/json" });
  expect(call[1].body).toBe("{}");
  expect(host.textContent).toContain("Analyse planifiée en arrière-plan.");
});

test("acquitte une alerte et recharge son statut sans modifier le registre financier", async () => {
  await mount();
  const row = fixture.etat.alertes[0];
  await click(button(`Acquitter : ${row.alerte.libelle_metrique}`));
  expect(host.textContent).toContain("Alerte acquittée : aucune écriture financière modifiée.");
  expect(button(`Acquitter : ${row.alerte.libelle_metrique}`)).toBeUndefined();
  expect(host.textContent).toContain("Acquittée le");
});

test("affiche l'absence de profil sans chiffres fictifs ni bouton de relance", async () => {
  current.etat = null;
  current.message = "Créez le profil financier dans NUMMARIUS → Saisie & imports.";
  await mount();
  expect(host.textContent).toContain(current.message);
  expect(button("Relancer l’analyse")).toBeUndefined();
  expect(host.textContent).not.toContain("Entreprise A");
  expect(host.querySelector('[data-testid="zeus-journal"]')).not.toBeNull();
});

test("un moteur arrêté ne permet pas de lancer une analyse", async () => {
  current.etat.orchestrateur.actif = false;
  await mount();
  expect(host.textContent).toContain("Moteur arrêté");
  expect(button("Relancer l’analyse").disabled).toBe(true);
});

test("une erreur réseau analytique ne casse pas le reste de ZEUS CORTEX", async () => {
  serve((path) => path === "/cortex/analytique" ? reply(503, { detail: "État analytique indisponible." }) : null);
  await mount();
  expect(host.querySelector('[role="alert"]').textContent).toContain("État analytique indisponible");
  expect(host.querySelector('[data-testid="zeus-services"]')).not.toBeNull();
  expect(button("Réessayer")).toBeTruthy();
});

test("refuse un montant flottant et retire les anciens chiffres quand les droits changent", async () => {
  const invalid = clone(fixture);
  invalid.etat.snapshot.indicateurs[0].valeur = 36000;
  expect(() => validateAnalyticalView(invalid)).toThrow("incohérente");
  await mount();
  serve((path) => path === "/cortex/analytique" ? reply(403, { detail: "Accès entreprise révoqué." }) : null);
  await act(async () => jest.advanceTimersByTime(8100));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Accès entreprise révoqué.");
  expect(host.textContent).not.toContain("Entreprise A");
});

test("ne superpose pas les lectures lentes et annule la requête au démontage", async () => {
  let signal;
  serve((path, opts) => {
    if (path !== "/cortex/analytique") return null;
    signal = opts.signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Annulé", "AbortError")), { once: true });
    });
  });
  await mount();
  await act(async () => jest.advanceTimersByTime(16000));
  expect(global.fetch.mock.calls.filter(([url]) => url.endsWith("/cortex/analytique"))).toHaveLength(1);
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
});

test("distingue une synthèse IA périmée des indicateurs actuels", async () => {
  current.etat.synthese.source = "IA";
  current.etat.synthese.modele = "Modele-test";
  current.etat.synthese.motif_repli = null;
  current.etat.synthese_a_jour = false;
  await mount();
  expect(host.textContent).toContain("Rédaction IA");
  expect(host.textContent).toContain("Cette synthèse porte sur un état antérieur");
});

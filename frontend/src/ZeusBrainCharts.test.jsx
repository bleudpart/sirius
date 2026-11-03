import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ExchangeChart, OutcomeDonut, SquadRose } from "./ZeusBrainCharts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host;
let root;
const show = (element) => act(async () => root.render(element));
const label = () => host.querySelector("svg").getAttribute("aria-label");
const exchange = (latency, extra = {}) => ({
  at: Date.parse("2026-11-02T12:00:00Z"), latency_ms: latency, first_token_ms: null, failed: false, count: 1, ...extra,
});
const squad = (overrides = {}) => [
  { id: "vision", label: "Vision", color: "#8d8fc4", completed: 6, failures: 0, status: "idle", statusLabel: "Disponible" },
  { id: "sanitary_guard", label: "SanitaryGuard", color: "#77b18b", completed: 3, failures: 0, status: "idle", statusLabel: "Disponible" },
  { id: "margin_audit", label: "MarginAudit", color: "#d29f68", completed: 1, failures: 0, status: "idle", statusLabel: "Disponible" },
  { id: "archivist", label: "Archivist", color: "#b783a4", completed: 0, failures: 0, status: "idle", statusLabel: "Disponible" },
].map((agent) => ({ ...agent, ...(overrides[agent.id] || {}) }));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("ExchangeChart (Cerveau 1)", () => {
  test("annonce l'absence de mesure sans tracer de courbe", async () => {
    await show(<ExchangeChart exchanges={[]} />);
    expect(label()).toBe("Durée des échanges du Cerveau 1 : aucune mesure.");
    expect(host.textContent).toContain("Aucun échange mesuré pour l’instant");
    expect(host.querySelectorAll(".tri-point, .tri-line, .tri-halo")).toHaveLength(0);
  });

  test("distingue une mesure indisponible d'une absence d'échange", async () => {
    await show(<ExchangeChart exchanges={[]} available={false} />);
    expect(host.textContent).toContain("Mesure indisponible");
    expect(host.textContent).not.toContain("Aucun échange mesuré");
  });

  test("trace un point par échange, la moyenne et un résumé accessible", async () => {
    await show(<ExchangeChart exchanges={[exchange(300), exchange(600), exchange(900)]} />);
    expect(host.querySelectorAll(".tri-point")).toHaveLength(3);
    expect(host.querySelectorAll(".tri-point.is-last")).toHaveLength(1);
    expect(host.querySelector(".tri-line-total")).not.toBeNull();
    expect(label()).toBe("Durée de 3 échanges mesurés du Cerveau 1 : dernière 900 ms, moyenne 600 ms, maximum 900 ms.");
    expect(host.querySelectorAll(".tri-tick-mean")).toHaveLength(2);
    expect([...host.querySelectorAll(".tri-tick-mean")].map((item) => item.textContent)).toEqual(["moy.", "600 ms"]);
    expect(host.textContent).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  test("explique les deux séries dans le graphe, seulement quand il y a des mesures", async () => {
    await show(<ExchangeChart exchanges={[exchange(300), exchange(500)]} />);
    expect(host.querySelector(".tri-key").textContent).toBe("Durée totalePremier fragment");
    await show(<ExchangeChart exchanges={[]} />);
    expect(host.querySelector(".tri-key")).toBeNull();
  });

  test("n'invente pas de courbe pour un seul échange", async () => {
    await show(<ExchangeChart exchanges={[exchange(700)]} />);
    expect(host.querySelectorAll(".tri-point")).toHaveLength(1);
    expect(host.querySelector(".tri-line-total")).toBeNull();
    expect(label()).toContain("1 échange mesuré");
    expect(host.querySelector(".tri-halo").classList.contains("is-busy")).toBe(false);
  });

  test("ne relie le premier fragment qu'entre des échanges où il a été mesuré", async () => {
    const items = [exchange(300, { first_token_ms: 40 }), exchange(320, { first_token_ms: 50 }), exchange(500), exchange(310, { first_token_ms: 45 })];
    await show(<ExchangeChart exchanges={items} />);
    expect(host.querySelectorAll(".tri-line-fragment")).toHaveLength(1);
    expect(host.querySelectorAll(".tri-point-fragment")).toHaveLength(3);
  });

  test("signale un échec, des échanges regroupés et le relevé antérieur à l'ouverture", async () => {
    await show(<ExchangeChart busy exchanges={[exchange(300, { at: null }), exchange(450, { failed: true, count: 2 })]} />);
    const failed = host.querySelector(".tri-point.is-failed");
    expect(failed).not.toBeNull();
    expect(failed.querySelector("title").textContent).toContain("en échec");
    expect(failed.querySelector("title").textContent).toContain("2 échanges regroupés");
    expect(host.textContent).toContain("avant l’ouverture");
    expect(host.querySelector(".tri-halo").classList.contains("is-busy")).toBe(true);
  });

  test("utilise un dégradé propre à chaque graphe", async () => {
    await show(<><ExchangeChart exchanges={[exchange(300), exchange(500)]} /><ExchangeChart exchanges={[exchange(300), exchange(500)]} /></>);
    const ids = [...host.querySelectorAll("linearGradient")].map((item) => item.id);
    expect(new Set(ids).size).toBe(2);
    const fills = [...host.querySelectorAll("path[fill^='url(']")].map((item) => item.getAttribute("fill").slice(5, -1));
    expect(fills.sort()).toEqual([...ids].sort());
    expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
  });
});

describe("OutcomeDonut (Cerveau 2)", () => {
  test("résume les tâches avec taux de réussite, valeurs et parts", async () => {
    await show(<OutcomeDonut completed={8} failures={1} queued={1} />);
    expect(label()).toBe("Tâches du Cerveau 2 : 8 terminées, 1 échec, 1 en file, taux de réussite 88 %.");
    expect(host.querySelector(".tri-big").textContent).toBe("88 %");
    expect(host.querySelectorAll("path.tri-slice")).toHaveLength(3);
    expect(host.textContent).toContain("80 %");
    expect(host.textContent).toContain("Terminées");
    expect(host.textContent).toContain("Échecs");
    expect(host.textContent).toContain("En file");
  });

  test("n'annonce pas 100 % tant qu'un échec existe, même très rare", async () => {
    await show(<OutcomeDonut completed={999} failures={1} queued={0} />);
    expect(host.querySelector(".tri-big").textContent).toBe("99 %");
    const failed = host.querySelectorAll("path.tri-slice[fill='#e58a80']");
    expect(failed).toHaveLength(1);
    expect(failed[0].querySelector("title").textContent).toBe("Échecs : 1 (0,1 %)");
  });

  test("affiche 100 % avec un cercle plein quand tout est terminé", async () => {
    await show(<OutcomeDonut completed={5} failures={0} queued={0} />);
    expect(host.querySelector(".tri-big").textContent).toBe("100 %");
    expect(host.querySelectorAll("path.tri-slice")).toHaveLength(0);
    expect(host.querySelectorAll("circle[stroke='#d8b875']")).toHaveLength(1);
  });

  test("affiche 0 % quand toutes les tâches terminées ont échoué", async () => {
    await show(<OutcomeDonut completed={0} failures={3} queued={0} />);
    expect(host.querySelector(".tri-big").textContent).toBe("0 %");
  });

  test("ne dessine aucun arc sans tâche mesurée", async () => {
    await show(<OutcomeDonut completed={0} failures={0} queued={0} />);
    expect(host.querySelector(".tri-big").textContent).toBe("—");
    expect(host.textContent).toContain("aucune tâche terminée");
    expect(host.querySelectorAll("path.tri-slice, circle[stroke]")).toHaveLength(0);
  });

  test("distingue une mesure indisponible et n'affiche aucun compteur", async () => {
    await show(<OutcomeDonut completed={0} failures={0} queued={0} available={false} />);
    expect(label()).toBe("Tâches du Cerveau 2 : mesure indisponible.");
    expect(host.textContent).toContain("indisponible");
    expect(host.querySelectorAll(".tri-legend-value")).toHaveLength(3);
    expect([...host.querySelectorAll(".tri-legend-value")].every((item) => item.textContent === "—")).toBe(true);
  });

  test("anime le cercle uniquement pendant une activité réelle", async () => {
    await show(<OutcomeDonut completed={1} failures={0} queued={0} busy />);
    expect(host.querySelector(".tri-donut").classList.contains("is-busy")).toBe(true);
    await show(<OutcomeDonut completed={1} failures={0} queued={0} />);
    expect(host.querySelector(".tri-donut").classList.contains("is-busy")).toBe(false);
  });
});

describe("SquadRose (Cerveau 3)", () => {
  const radius = (petal) => Number(petal.getAttribute("d").match(/A([\d.]+),/)[1]);

  test("trace un pétale par agent actif, proportionnel aux tâches terminées", async () => {
    await show(<SquadRose agents={squad()} />);
    const petals = [...host.querySelectorAll(".tri-petal")];
    expect(petals).toHaveLength(3);
    expect(radius(petals[0])).toBeCloseTo(80);
    expect(radius(petals[1])).toBeCloseTo(53);
    expect(radius(petals[2])).toBeCloseTo(35);
    expect(host.querySelector(".tri-big").textContent).toBe("10");
    expect(label()).toBe("Tâches terminées par agent du Cerveau 3 : Vision 6, SanitaryGuard 3, MarginAudit 1, Archivist 0.");
    expect(host.textContent).toContain("6 terminées");
    expect(host.textContent).toContain("0 terminée");
  });

  test("met en évidence un agent actif et signale un agent en échec", async () => {
    await show(<SquadRose agents={squad({
      vision: { status: "busy", statusLabel: "En activité" },
      archivist: { completed: 2, failures: 1, status: "failed", statusLabel: "En échec" },
    })} />);
    expect(host.querySelectorAll(".tri-petal.is-busy")).toHaveLength(1);
    expect(host.querySelectorAll(".tri-petal.is-alert")).toHaveLength(1);
    expect(host.textContent).toContain("En activité");
    expect(host.textContent).toContain("1 échec");
  });

  test("n'affiche aucun pétale quand aucun agent n'a terminé de tâche", async () => {
    await show(<SquadRose agents={squad({ vision: { completed: 0 }, sanitary_guard: { completed: 0 }, margin_audit: { completed: 0 } })} />);
    expect(host.querySelectorAll(".tri-petal")).toHaveLength(0);
    expect(host.querySelector(".tri-big").textContent).toBe("0");
    expect(host.textContent).toContain("échelle 0–4");
  });

  test("distingue une mesure indisponible", async () => {
    await show(<SquadRose available={false} agents={squad({ vision: { completed: 0 }, sanitary_guard: { completed: 0 }, margin_audit: { completed: 0 } })} />);
    expect(label()).toBe("Agents du Cerveau 3 : mesure indisponible.");
    expect(host.querySelectorAll(".tri-petal")).toHaveLength(0);
    expect(host.querySelector(".tri-big").textContent).toBe("—");
  });

  test("utilise des identifiants de dégradé uniques et valides pour url(#…)", async () => {
    await show(<><SquadRose agents={squad()} /><SquadRose agents={squad()} /></>);
    const ids = [...host.querySelectorAll("radialGradient")].map((item) => item.id);
    expect(new Set(ids).size).toBe(8);
    expect(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true);
    host.querySelectorAll(".tri-petal").forEach((petal) => expect(ids).toContain(petal.getAttribute("fill").slice(5, -1)));
  });
});

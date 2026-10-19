import {
  AMBIANCES, applyInteriorProposal, computeInteriorTotals, computeRoomFinishes, emptyInterior,
  interiorReportHtml, loadInterior, mergePurchases, parseInteriorRequest, photoAmbiance, planKey,
  roomAmbiance, saveInterior,
} from "./interiorDesign";

const PLAN = {
  titre: "Appartement <test>",
  pieces: [
    { nom: "Séjour", x: 0, y: 0, l: 5, p: 4, hauteur: 2.5 },
    { nom: "Salle de bain", x: 5, y: 0, l: 2, p: 2 },
  ],
  ouvertures: [
    { type: "porte", piece: "Séjour", mur: "sud", position: 1, largeur: 0.9 },
    { type: "fenetre", piece: "Séjour", mur: "nord", position: 1, largeur: 1.2 },
  ],
  mobilier: [
    { nom: "Vieux canapé", x: 1, y: 1, l: 2, p: 0.9 },
    { nom: "Lavabo", x: 5.2, y: 0.2, l: 0.6, p: 0.45 },
  ],
};

const memoryStorage = () => {
  const data = {};
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
};

test("métrés d'une pièce : murs nets, peinture, sol, plinthes et éclairage", () => {
  const f = computeRoomFinishes(PLAN.pieces[0], PLAN, { couches: 2, ambiance: AMBIANCES[0] });
  // périmètre 18 m × 2,5 m = 45 m² − porte 0,9 × 2,04 − fenêtre 1,2 × 1,25
  expect(f.murs_nets).toBeCloseTo(45 - 1.836 - 1.5, 2);
  expect(f.surface_sol).toBe(20);
  // (41,66 murs + 20 plafond) × 2 couches / 10 m²/L = 12,3 L → 5 pots de 2,5 L
  expect(f.pots_2_5l).toBe(5);
  expect(f.sol.commande_m2).toBe(22);
  expect(f.plinthes_ml).toBeCloseTo((18 - 0.9) * 1.05, 1);
  expect(f.eclairage).toMatchObject({ lux: 250, lumens: 5000, kelvin: 2700 });
  expect(f.budget_eur.min).toBeGreaterThan(0);
  expect(f.budget_eur.max).toBeGreaterThan(f.budget_eur.min);
});

test("pièce humide : carrelage et pas de plinthes bois", () => {
  const f = computeRoomFinishes(PLAN.pieces[1], PLAN, { ambiance: AMBIANCES[2] });
  expect(f.sol.nom).toMatch(/Carrelage/);
  expect(f.plinthes_ml).toBe(0);
  expect(f.hauteur).toBe(2.5);
});

test("totaux additionnent les pièces", () => {
  const finishes = PLAN.pieces.map((p) => computeRoomFinishes(p, PLAN, { ambiance: AMBIANCES[1] }));
  const totals = computeInteriorTotals(finishes);
  expect(totals.surface_sol).toBe(24);
  expect(totals.pots_2_5l).toBe(finishes[0].pots_2_5l + finishes[1].pots_2_5l);
  expect(totals.budget_max).toBe(finishes[0].budget_eur.max + finishes[1].budget_eur.max);
});

test("la proposition IA remplace uniquement le mobilier de la pièce", () => {
  const next = applyInteriorProposal(PLAN, "Séjour", [{ nom: "Canapé lin", x: 0.5, y: 2.5, l: 2.2, p: 0.9 }]);
  expect(next.mobilier.map((m) => m.nom)).toEqual(["Lavabo", "Canapé lin"]);
  expect(PLAN.mobilier).toHaveLength(2);
});

test("palette tirée d'une photo : murs clairs, accent saturé", () => {
  const style = photoAmbiance({ style: "Bohème", palette: ["#3A3A3A", "#F5EFE6", "#D2691E", "#A89F91"], matieres: ["rotin"] });
  expect(style.nom).toBe("Bohème");
  expect(style.palette.murs).toBe("#F5EFE6");
  expect(style.palette.accent).toBe("#D2691E");
  expect(style.matieres).toEqual(["rotin"]);
});

test("état intérieur persistant et réinitialisé si le plan change", () => {
  const storage = memoryStorage();
  const state = { ...emptyInterior(PLAN), ambiance: "industriel", pieces: { "Séjour": { notes: "Mur TV" } } };
  saveInterior(state, storage);
  expect(loadInterior(PLAN, storage).pieces["Séjour"].notes).toBe("Mur TV");
  const other = { ...PLAN, pieces: [{ nom: "Garage", x: 0, y: 0, l: 6, p: 4 }] };
  expect(loadInterior(other, storage)).toEqual(emptyInterior(other));
  expect(planKey(other)).not.toBe(planKey(PLAN));
});

test("ambiance par pièce et ambiance photo", () => {
  const state = {
    ...emptyInterior(PLAN), ambiance: "scandinave",
    pieces: { "Séjour": { ambiance: "photo", inspiration: { palette: ["#FFFFFF", "#AA2200"] } } },
  };
  expect(roomAmbiance(state, "Salle de bain").id).toBe("scandinave");
  expect(roomAmbiance(state, "Séjour").palette.accent).toBe("#AA2200");
});

test("la liste d'achats ignore les doublons de la même pièce", () => {
  const first = mergePurchases([], [{ article: "Lampadaire", quantite: 1, budget_eur: 120 }], "Séjour");
  const second = mergePurchases(first, [{ article: "lampadaire", quantite: 1, budget_eur: 99 }, { article: "Tapis", quantite: 1, budget_eur: 200 }], "Séjour");
  expect(second.map((a) => a.article)).toEqual(["Lampadaire", "Tapis"]);
  expect(second[1]).toMatchObject({ piece: "Séjour", fait: false });
});

test("comprend une demande dictée : pièce et ambiance", () => {
  expect(parseInteriorRequest("Aménage le séjour en style art déco", PLAN)).toEqual({ piece: "Séjour", ambiance: "artdeco" });
  expect(parseInteriorRequest("décore la salle de bain façon zen", PLAN)).toEqual({ piece: "Salle de bain", ambiance: "japandi" });
  expect(parseInteriorRequest("quelque chose de joli", PLAN)).toEqual({ piece: "", ambiance: "" });
});

test("la fiche HTML échappe les contenus saisis", () => {
  const state = { ...emptyInterior(PLAN), pieces: { "Séjour": { notes: "<script>alert(1)</script>" } },
    achats: [{ article: "Lampe <b>", quantite: 2, budget_eur: 50, piece: "Séjour" }] };
  const finishes = PLAN.pieces.map((p) => computeRoomFinishes(p, PLAN, { ambiance: AMBIANCES[0] }));
  const html = interiorReportHtml(PLAN, state, finishes);
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Appartement &lt;test&gt;");
  expect(html).toContain("100 €");
});

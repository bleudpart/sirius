import { areaPath, donutSegments, formatMs, niceScale, polar, sectorPath, smoothPath } from "./chartMath";

const numbers = (path) => path.match(/-?\d+(?:\.\d+)?/g).map(Number);

describe("niceScale", () => {
  test.each([
    [412, 4, false, [0, 200, 400, 600]],
    [400, 4, false, [0, 100, 200, 300, 400]],
    [900, 4, false, [0, 500, 1000]],
    [1800, 4, false, [0, 500, 1000, 1500, 2000]],
    [0.3, 4, false, [0, 0.1, 0.2, 0.3]],
    [7, 4, true, [0, 2, 4, 6, 8]],
    [3, 4, true, [0, 1, 2, 3]],
    [1, 4, true, [0, 1]],
  ])("arrondit %p à une échelle lisible (entier : %p)", (max, target, integer, ticks) => {
    const scale = niceScale(max, target, { integer });
    expect(scale.ticks).toEqual(ticks);
    expect(scale.max).toBe(ticks[ticks.length - 1]);
    expect(scale.max).toBeGreaterThanOrEqual(max);
  });

  test.each([0, -5, NaN, Infinity])("renvoie une échelle neutre pour %p", (value) => {
    expect(niceScale(value)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
  });
});

describe("smoothPath", () => {
  test("ne produit rien sans mesure et un simple point de départ avec une mesure", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([{ x: 10, y: 20 }])).toBe("M10,20");
  });

  test("relie deux mesures par une droite", () => {
    expect(smoothPath([{ x: 0, y: 0 }, { x: 30, y: 30 }])).toBe("M0,0C10,10 20,20 30,30");
  });

  test("ne dépasse jamais les mesures voisines entre deux points", () => {
    const points = [60, 60, 20, 140, 135, 40, 40, 90].map((y, index) => ({ x: index * 40, y }));
    const values = numbers(smoothPath(points));
    // M x y puis, par segment, deux points de contrôle et le point d'arrivée.
    for (let segment = 0; segment < points.length - 1; segment += 1) {
      const start = 2 + segment * 6;
      const [, c1y, , c2y] = values.slice(start, start + 4);
      const low = Math.min(points[segment].y, points[segment + 1].y);
      const high = Math.max(points[segment].y, points[segment + 1].y);
      expect(c1y).toBeGreaterThanOrEqual(low - 0.01);
      expect(c1y).toBeLessThanOrEqual(high + 0.01);
      expect(c2y).toBeGreaterThanOrEqual(low - 0.01);
      expect(c2y).toBeLessThanOrEqual(high + 0.01);
    }
  });
});

describe("areaPath", () => {
  test("exige au moins deux mesures", () => {
    expect(areaPath([{ x: 0, y: 5 }], 100)).toBe("");
  });

  test("ferme la courbe sur la ligne de base", () => {
    const path = areaPath([{ x: 10, y: 50 }, { x: 70, y: 20 }], 170);
    expect(path.startsWith("M10,50C")).toBe(true);
    expect(path.endsWith("L70,170L10,170Z")).toBe(true);
  });
});

describe("polar et sectorPath", () => {
  test("place 0° à midi et tourne dans le sens horaire", () => {
    const top = polar(100, 100, 50, 0);
    const right = polar(100, 100, 50, 90);
    const bottom = polar(100, 100, 50, 180);
    const left = polar(100, 100, 50, 270);
    expect([top.x, top.y]).toEqual([100, 50]);
    expect(right.x).toBeCloseTo(150);
    expect(right.y).toBeCloseTo(100);
    expect(bottom.x).toBeCloseTo(100);
    expect(bottom.y).toBeCloseTo(150);
    expect(left.x).toBeCloseTo(50);
    expect(left.y).toBeCloseTo(100);
  });

  test("choisit le grand arc au-delà de 180°", () => {
    expect(sectorPath(100, 100, 20, 60, 0, 90)).toContain("A60,60 0 0 1");
    expect(sectorPath(100, 100, 20, 60, 0, 270)).toContain("A60,60 0 1 1");
    expect(sectorPath(100, 100, 20, 60, 0, 270)).toContain("A20,20 0 1 0");
  });

  test("dessine un secteur fermé entre deux rayons", () => {
    const path = sectorPath(100, 100, 20, 60, 0, 90);
    expect(path.startsWith("M100,40A60,60 0 0 1 160,100L120,100A20,20 0 0 0 100,80Z")).toBe(true);
  });
});

describe("donutSegments", () => {
  test("répartit 360° au prorata et laisse un intervalle entre les arcs visibles", () => {
    const [first, second, third] = donutSegments([3, 1, 0], 4);
    expect(first).toEqual({ from: 2, to: 268, share: 0.75 });
    expect(second).toEqual({ from: 272, to: 358, share: 0.25 });
    expect(third).toBeNull();
  });

  test("occupe le cercle entier sans intervalle quand une seule valeur existe", () => {
    expect(donutSegments([5, 0, 0], 4)).toEqual([{ from: 0, to: 360, share: 1 }, null, null]);
  });

  test("ne dessine rien sans donnée", () => {
    expect(donutSegments([0, 0, 0])).toEqual([null, null, null]);
  });

  test("garantit un arc visible aux très petites parts sans fausser leur part réelle", () => {
    const [done, failed, queued] = donutSegments([96, 3, 1], 3, 6);
    expect(done.share).toBeCloseTo(0.96);
    expect(queued.share).toBeCloseTo(0.01);
    expect(queued.to - queued.from).toBeCloseTo(6);
    expect(failed.to - failed.from).toBeGreaterThanOrEqual(6);
    expect(queued.to + 1.5).toBeCloseTo(360);
    expect(failed.from - done.to).toBeCloseTo(3);
  });

  test("n'altère pas la répartition quand aucune part n'est trop petite", () => {
    expect(donutSegments([3, 1, 0], 4, 6)).toEqual(donutSegments([3, 1, 0], 4));
  });

  test("conserve la répartition si toutes les parts sont trop petites pour être relevées", () => {
    const parts = donutSegments(Array.from({ length: 100 }, () => 1), 0, 6);
    expect(parts[99].to).toBeCloseTo(360);
    expect(parts[0].to - parts[0].from).toBeCloseTo(3.6);
  });
});

describe("formatMs", () => {
  test.each([
    [0, "0 ms"],
    [412.4, "412 ms"],
    [999.6, "1 s"],
    [1000, "1 s"],
    [1800, "1,8 s"],
    [12500, "13 s"],
  ])("formate %p en %p", (value, text) => {
    expect(formatMs(value)).toBe(text);
  });
});

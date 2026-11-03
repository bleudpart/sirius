// Calculs géométriques purs pour les graphes SVG du panneau Tri-Cortex.

const round = (value) => Number(value.toFixed(2));

// Échelle « ronde » : pas de 1, 2, 5 ou 10 × 10^n, avec au plus `target` intervalles.
export function niceScale(max, target = 4, { integer = false } = {}) {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, step: 1, ticks: [0, 1] };
  const exponent = Math.floor(Math.log10(max / target));
  const units = [1, 2, 5, 10].map((factor) => factor * 10 ** exponent).filter((unit) => !integer || unit >= 1);
  const step = units.find((unit) => Math.ceil(max / unit - 1e-9) <= target) ?? Math.ceil(max / target);
  const intervals = Math.ceil(max / step - 1e-9);
  const ticks = Array.from({ length: intervals + 1 }, (_, index) => Number((index * step).toFixed(10)));
  return { max: ticks[intervals], step, ticks };
}

// Courbe de Hermite monotone : lisse, sans dépassement entre deux mesures réelles.
export function smoothPath(points) {
  const n = points.length;
  if (!n) return "";
  const start = `M${round(points[0].x)},${round(points[0].y)}`;
  if (n === 1) return start;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1].x - points[i].x);
    slope.push((points[i + 1].y - points[i].y) / dx[i]);
  }
  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  let path = start;
  for (let i = 0; i < n - 1; i += 1) {
    const h = dx[i] / 3;
    path += `C${round(points[i].x + h)},${round(points[i].y + tangent[i] * h)}`
      + ` ${round(points[i + 1].x - h)},${round(points[i + 1].y - tangent[i + 1] * h)}`
      + ` ${round(points[i + 1].x)},${round(points[i + 1].y)}`;
  }
  return path;
}

export function areaPath(points, baseline) {
  if (points.length < 2) return "";
  const last = points[points.length - 1];
  return `${smoothPath(points)}L${round(last.x)},${round(baseline)}L${round(points[0].x)},${round(baseline)}Z`;
}

// Angles en degrés, 0° à midi, sens horaire.
export function polar(cx, cy, radius, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return { x: cx + radius * Math.sin(radians), y: cy - radius * Math.cos(radians) };
}

// Secteur annulaire : un pétale entre deux rayons et deux angles.
export function sectorPath(cx, cy, inner, outer, from, to) {
  const a = polar(cx, cy, outer, from);
  const b = polar(cx, cy, outer, to);
  const c = polar(cx, cy, inner, to);
  const d = polar(cx, cy, inner, from);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${round(a.x)},${round(a.y)}A${outer},${outer} 0 ${large} 1 ${round(b.x)},${round(b.y)}`
    + `L${round(c.x)},${round(c.y)}A${inner},${inner} 0 ${large} 0 ${round(d.x)},${round(d.y)}Z`;
}

// Répartit 360° entre des valeurs positives, en laissant `gap` degrés entre deux arcs.
// `floor` garantit un arc visible minimal aux très petites parts, prélevé sur les plus grandes ;
// `share` reste la part réelle.
export function donutSegments(values, gap = 0, floor = 0) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return values.map(() => null);
  const visible = values.filter((value) => value > 0).length;
  const spread = visible > 1 ? gap : 0;
  const sweeps = values.map((value) => (value > 0 ? (value / total) * 360 : 0));
  const minimum = floor > 0 ? floor + spread : 0;
  const small = sweeps.map((sweep) => sweep > 0 && sweep < minimum);
  const lifted = sweeps.reduce((sum, sweep, index) => sum + (small[index] ? minimum - sweep : 0), 0);
  const others = sweeps.reduce((sum, sweep, index) => sum + (small[index] ? 0 : sweep), 0);
  const fitted = lifted > 0 && others > lifted
    ? sweeps.map((sweep, index) => (small[index] ? minimum : (sweep * (others - lifted)) / others))
    : sweeps;
  let cursor = 0;
  return values.map((value, index) => {
    if (!(value > 0)) return null;
    const from = cursor + spread / 2;
    const to = Math.max(from, cursor + fitted[index] - spread / 2);
    cursor += fitted[index];
    return { from, to, share: value / total };
  });
}

export function formatMs(value) {
  const ms = Math.round(value);
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${String(seconds >= 10 ? Math.round(seconds) : Number(seconds.toFixed(1))).replace(".", ",")} s`;
}

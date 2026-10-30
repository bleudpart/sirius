export const SIRIUS_THEME = Object.freeze({
  colors: Object.freeze({
    cyan: "#91e6f2",
    cyanBright: "#d3faff",
    cyanDeep: "#091a2b",
    gold: "#d8b875",
    goldBright: "#f2d99a",
    background: "#061321",
    steel: "#31536c",
    text: "#eaf4f5",
    textSecondary: "#9fb2bf",
    glass: "rgba(20, 45, 66, 0.58)",
  }),
  glow: Object.freeze({
    intensity: 0.55,
    cyan: "rgba(145, 230, 242, 0.55)",
    gold: "rgba(216, 184, 117, 0.55)",
  }),
  layout: Object.freeze({
    medallionCount: 0,
    globeScale: 0.58,
  }),
  spacing: Object.freeze({
    xs: 4,
    sm: 8,
    md: 12,
    lg: 18,
    xl: 24,
  }),
  radius: Object.freeze({
    control: 8,
    panel: 18,
    pill: 999,
  }),
  motion: Object.freeze({
    fast: 120,
    normal: 200,
    slow: 320,
  }),
});

export function renderHUD(state, theme = loadVisualTheme()) {
  const colors = normalizeVisualTheme(theme);
  return {
    core: {
      color: colors.cyan,
      glow: SIRIUS_THEME.glow.intensity,
      active: state.coreActive,
    },
    guardian: {
      color: colors.cyan,
      gold: colors.gold,
      visible: state.guardianActive,
    },
    medallions: {
      count: SIRIUS_THEME.layout.medallionCount,
      color: colors.gold,
    },
    infoPanels: state.infoPanels,
  };
}

export const VISUAL_THEME_DEFAULTS = Object.freeze({
  cyan: SIRIUS_THEME.colors.cyan,
  gold: SIRIUS_THEME.colors.gold,
  background: SIRIUS_THEME.colors.background,
});

const VISUAL_THEME_STORAGE_KEY = "sirius_visual_theme";
const COLOR_PATTERN = /^#[\da-f]{6}$/i;

export function normalizeVisualTheme(value = {}) {
  return Object.fromEntries(Object.entries(VISUAL_THEME_DEFAULTS).map(([key, fallback]) => [
    key,
    COLOR_PATTERN.test(value?.[key] || "") ? value[key] : fallback,
  ]));
}

export function loadVisualTheme() {
  try {
    return normalizeVisualTheme(JSON.parse(localStorage.getItem(VISUAL_THEME_STORAGE_KEY) || "{}"));
  } catch {
    return { ...VISUAL_THEME_DEFAULTS };
  }
}

function colorWithAlpha(color, alpha) {
  const [red, green, blue] = color.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16));
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function lightenColor(color, amount) {
  const channels = color.slice(1).match(/.{2}/g).map((part) => parseInt(part, 16));
  return `#${channels.map((channel) => Math.round(channel + (255 - channel) * amount)
    .toString(16).padStart(2, "0")).join("")}`;
}

export function saveVisualTheme(patch) {
  if (Object.entries(patch).some(([key, color]) => !(key in VISUAL_THEME_DEFAULTS) || !COLOR_PATTERN.test(color || ""))) {
    throw new Error("Une couleur de ΣIRIUS est invalide.");
  }
  const next = normalizeVisualTheme({ ...loadVisualTheme(), ...patch });
  localStorage.setItem(VISUAL_THEME_STORAGE_KEY, JSON.stringify(next));
  applyVisualTheme(next);
  window.dispatchEvent(new CustomEvent("sirius-visual-theme-changed", { detail: next }));
  return next;
}

export function getHUDStyleVariables(theme = loadVisualTheme()) {
  const colors = normalizeVisualTheme(theme);
  return {
    "--sirius-cyan": colors.cyan,
    "--sirius-cyan-bright": lightenColor(colors.cyan, 0.3),
    "--sirius-cyan-light": lightenColor(colors.cyan, 0.3),
    "--sirius-cyan-glow": colorWithAlpha(colors.cyan, SIRIUS_THEME.glow.intensity),
    "--sirius-cyan-line": colorWithAlpha(colors.cyan, 0.24),
    "--sirius-cyan-shadow": colorWithAlpha(colors.cyan, 0.045),
    "--workspace-cyan": colors.cyan,
    "--sirius-cyan-deep": SIRIUS_THEME.colors.cyanDeep,
    "--sirius-gold": colors.gold,
    "--sirius-gold-bright": lightenColor(colors.gold, 0.3),
    "--sirius-gold-light": lightenColor(colors.gold, 0.3),
    "--sirius-background": colors.background,
    "--sirius-gold-glow": colorWithAlpha(colors.gold, SIRIUS_THEME.glow.intensity),
    "--workspace-gold": colors.gold,
    "--sirius-globe-scale": SIRIUS_THEME.layout.globeScale,
    "--sirius-space-xs": `${SIRIUS_THEME.spacing.xs}px`,
    "--sirius-space-sm": `${SIRIUS_THEME.spacing.sm}px`,
    "--sirius-space-md": `${SIRIUS_THEME.spacing.md}px`,
    "--sirius-space-lg": `${SIRIUS_THEME.spacing.lg}px`,
    "--sirius-space-xl": `${SIRIUS_THEME.spacing.xl}px`,
    "--sirius-radius-control": `${SIRIUS_THEME.radius.control}px`,
    "--sirius-radius-panel": `${SIRIUS_THEME.radius.panel}px`,
    "--sirius-radius-pill": `${SIRIUS_THEME.radius.pill}px`,
    "--sirius-motion-fast": `${SIRIUS_THEME.motion.fast}ms`,
    "--sirius-motion-normal": `${SIRIUS_THEME.motion.normal}ms`,
    "--sirius-motion-slow": `${SIRIUS_THEME.motion.slow}ms`,
  };
}

export function applyVisualTheme(theme = loadVisualTheme()) {
  const root = document.documentElement;
  for (const [property, value] of Object.entries(getHUDStyleVariables(theme))) {
    root.style.setProperty(property, value);
  }
}

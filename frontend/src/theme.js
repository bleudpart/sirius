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

export function renderHUD(state) {
  return {
    core: {
      color: SIRIUS_THEME.colors.cyan,
      glow: SIRIUS_THEME.glow.intensity,
      active: state.coreActive,
    },
    guardian: {
      color: SIRIUS_THEME.colors.cyan,
      gold: SIRIUS_THEME.colors.gold,
      visible: state.guardianActive,
    },
    medallions: {
      count: SIRIUS_THEME.layout.medallionCount,
      color: SIRIUS_THEME.colors.gold,
    },
    infoPanels: state.infoPanels,
  };
}

export function getHUDStyleVariables() {
  return {
    "--sirius-cyan": SIRIUS_THEME.colors.cyan,
    "--sirius-cyan-bright": SIRIUS_THEME.colors.cyanBright,
    "--sirius-cyan-deep": SIRIUS_THEME.colors.cyanDeep,
    "--sirius-gold": SIRIUS_THEME.colors.gold,
    "--sirius-gold-bright": SIRIUS_THEME.colors.goldBright,
    "--sirius-background": SIRIUS_THEME.colors.background,
    "--sirius-cyan-glow": SIRIUS_THEME.glow.cyan,
    "--sirius-gold-glow": SIRIUS_THEME.glow.gold,
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

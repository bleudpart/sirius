const WINDOW_SURFACES = ".prime-screen, .zeus-screen, .eu-screen, .setup-screen, .iw-panel, .atlas-panel, .kr-panel, .p3d-overlay, .esp-panel, .about-panel, .media-hud-window, .productivity-screen, .connections-screen, .fp-overlay, .vision-card, .keys-panel, .sp-journal, .getting-started, .modwheel, .sirius-display";

export function closeForegroundWindow() {
  const candidates = [...document.querySelectorAll(WINDOW_SURFACES)].filter((el) => {
    const style = getComputedStyle(el);
    return !el.closest(".boot-screen, .auth-screen, .holo-minimized, .holo-closing")
      && style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
  }).map((el, order) => {
    let z = 0;
    for (let parent = el; parent; parent = parent.parentElement) {
      const value = Number.parseInt(getComputedStyle(parent).zIndex, 10);
      if (Number.isFinite(value)) z = Math.max(z, value);
    }
    const close = [...el.querySelectorAll("button")].find((button) =>
      button.closest(WINDOW_SURFACES) === el && !button.disabled
      && (button.matches(".mobile-window-close, .setup-close, .zeus-close, .eu-close, .modwheel-close, .fp-close, .p3d-close, .keys-close, .media-close-btn")
        || /fermer/i.test(button.getAttribute("aria-label") || "")
        || button.querySelector(".lucide-x"))
    );
    return { el, close, z, order };
  }).filter(({ close }) => close).sort((a, b) => b.z - a.z || b.order - a.order);
  const current = candidates[0];
  if (!current) return null;
  const title = current.el.querySelector(".zeus-title, .oracle-title, .eu-title, .fp-title, .p3d-title, .keys-title, .vision-title, .sp-title, h1, h2");
  const name = title?.textContent.trim() || current.el.getAttribute("aria-label") || "la fenêtre";
  current.close.click();
  return name;
}

export function createWindowController(setters, display) {
  const closers = {
    display: () => setters.setDisplayOpen(false),
    files: () => setters.setShowFiles(false),
    plans: () => setters.setShowPlans?.(false),
    photo3d: () => setters.setShowPhoto3D?.(false),
    connections: () => setters.setShowConnections?.(false),
    reveil: () => setters.setShowReveil?.(false),
    enterprise: () => setters.setShowEnterprise?.(false),
    architect: () => setters.setShowArchitect(false),
    pantheon: () => setters.setShowPantheon(false),
    cortex: () => setters.setShowCortex(false),
    nexus: () => setters.setShowNexus(false),
    oracle: () => setters.setShowOracle(false),
    nummarius: () => setters.setShowNummarius(false),
    europeana: () => setters.setShowEuropeana(false),
    haccp: () => setters.setHaccp(null),
    prime: () => setters.setShowPrime(false),
    dev: () => setters.setShowDev(false),
    analytics: () => setters.setShowAnalytics(false),
    memory: () => setters.setShowMemory(false),
    memorymgr: () => setters.setShowMemoryMgr(false),
    argus: () => setters.setShowArgus(false),
    keys: () => setters.setShowKeysStatus(false),
    gcal: () => setters.setShowCalendar(false),
    faceid: () => setters.setShowFaceId(false),
    keraunos: () => setters.setShowKeraunos(false),
    espace: () => setters.setShowEspace(false),
    about: () => setters.setShowAbout(false),
    locus: () => setters.setShowLocus(false),
    atlas: () => setters.setShowAtlas(false),
    heracles: () => setters.setShowHeracles(false),
    hephaistos: () => setters.setShowHephaistos(false),
    mythos: () => setters.setShowMythosGallery(false),
    trailer: () => setters.setShowTrailer(false),
    promo: () => setters.setShowPromo(false),
    themis: () => setters.setShowThemis(false),
    agora: () => setters.setShowAgora(false),
    solon: () => setters.setShowSolon(false),
    promethee: () => setters.setShowPromethee(false),
    "dossiers-pro": () => setters.setShowWorkDossiers?.(false),
    "sport-coach": () => setters.setShowSportCoach?.(false),
    ...Object.fromEntries(["workflows", "pricing", "dossiers", "audit", "documents", "planning"].map((id) => [id, () => setters.setActiveWorkModule(null)])),
    calliope: () => setters.setShowCalliope(false),
    pythagore: () => setters.setShowPythagore(false),
    news: () => setters.setShowNews(false),
    packager: () => setters.setShowPackager(false),
    install: () => setters.setShowInstall(false),
    scripts: () => setters.setShowScripts(false),
    vision: () => setters.setShowVision(false),
    admin: () => setters.setShowAdmin(false),
    setup: () => setters.setShowSetup(false),
    gallery: () => setters.setShowGallery(false),
    spotify: () => setters.setShowSpotifyWin(false),
    media: () => setters.setShowMediaHud(false),
    "media-modules": () => setters.setShowMediaModules?.(false),
    "info-hub": () => setters.setShowInfoWheel?.(false),
    productivity: () => setters.setShowProductivity(false),
  };

  return {
    close(target) {
      const close = closers[target];
      if (!close) return false;
      close();
      return true;
    },
    closeDisplay: closers.display,
    closers,
    display,
  };
}

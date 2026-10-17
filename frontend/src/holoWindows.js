// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Fenêtres holographiques 3D : transforme les écrans plats en panneaux cyan flottants,
// déplaçables (drag sur l'en-tête), redimensionnables (poignée bas-droite) et fermables.
import { trackWindowGesture, isPrimaryGesture } from "./windowGesture";

const SEL = ".prime-screen, .zeus-screen, .eu-screen, .setup-screen, .iw-panel";
const MOBILE_SEL = ".atlas-panel, .kr-panel, .p3d-overlay, .esp-panel, .about-panel, .media-hud-window, .productivity-screen, .connections-screen, .fp-overlay, .vision-card, .keys-panel, .sp-journal, .getting-started, .archive-gallery";
const mobilePage = () => window.matchMedia("(max-width: 1023px)").matches;
let zTop = 1000;
let mobileZTop = 1200;
const bumpZ = () => mobilePage()
  ? (mobileZTop = Math.min(mobileZTop + 1, 1490))
  : (zTop = Math.min(zTop + 1, 1190));
let cascade = 0;
let geom = {};
try { geom = JSON.parse(localStorage.getItem("sirius_holo_geom") || "{}"); } catch (e) { geom = {}; }
const save = () => { try { localStorage.setItem("sirius_holo_geom", JSON.stringify(geom)); } catch (e) { /* plein */ } };
export function resetHoloWindowLayout() {
  geom = {};
  cascade = 0;
  try { localStorage.removeItem("sirius_holo_geom"); } catch (e) { /* stockage indisponible */ }
}
// Migration unique : oublie l'ancienne géométrie (trop grande) de la fenêtre Configuration
try {
  if (!localStorage.getItem("sirius_holo_v2")) {
    delete geom["sirius-setup"];
    save();
    localStorage.setItem("sirius_holo_v2", "1");
  }
} catch (e) { /* stockage indisponible */ }
// Migration v3 : les anciennes tailles réduites masquaient le contenu des modules.
try {
  if (!localStorage.getItem("sirius_holo_v3")) {
    geom = {};
    save();
    localStorage.setItem("sirius_holo_v3", "1");
  }
} catch (e) { /* stockage indisponible */ }

const keyOf = (el) => el.getAttribute("data-testid") || (el.className || "win").split(" ")[0];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const zoomLevel = () => Number.parseFloat(getComputedStyle(document.body).zoom) || 1;
const viewport = () => ({ width: window.innerWidth / zoomLevel(), height: window.innerHeight / zoomLevel() });

function apply(el, g) {
  el.style.left = `${Math.round(g.x)}px`;
  el.style.top = `${Math.round(g.y)}px`;
  el.style.width = `${Math.round(g.w)}px`;
  el.style.height = `${Math.round(g.h)}px`;
}

function track(e0, el, k, fn) {
  el.__gestureDispose?.();
  el.classList.add("holo-manip");
  el.__cur = { ...el.__geo };
  const move = (e) => fn((e.clientX - e0.clientX) / zoomLevel(), (e.clientY - e0.clientY) / zoomLevel());
  const up = () => {
    el.classList.remove("holo-manip");
    el.__geo = { ...el.__cur };
    geom[k] = { ...el.__cur };
    save();
  };
  el.__gestureDispose = trackWindowGesture(e0, { element: el, onMove: move, onEnd: up });
}

function startDrag(e, el, k) {
  if (mobilePage() || el.classList.contains("sirius-window-expanded") || !isPrimaryGesture(e)) return;
  if (e.target.closest("button, input, select, textarea, a, [role=button]")) return;
  const g0 = { ...el.__geo };
  const { width, height } = viewport();
  track(e, el, k, (dx, dy) => {
    el.__cur.x = clamp(g0.x + dx, -g0.w + 140, width - 140);
    el.__cur.y = clamp(g0.y + dy, 0, height - 52);
    apply(el, el.__cur);
  });
}

function startResize(e, el, k) {
  if (mobilePage() || el.classList.contains("sirius-window-expanded") || !isPrimaryGesture(e)) return;
  e.stopPropagation();
  const g0 = { ...el.__geo };
  const { width, height } = viewport();
  track(e, el, k, (dx, dy) => {
    el.__cur.w = clamp(g0.w + dx, Math.min(460, width - 16), Math.max(460, width - g0.x - 8));
    el.__cur.h = clamp(g0.h + dy, Math.min(320, height - 16), Math.max(320, height - g0.y - 8));
    apply(el, el.__cur);
  });
}

// ---- Popups interactifs (réponses de Sirius, alertes) : drag + resize à la demande ----
const POP_SEL = ".central-card, .holo-popup";
const HEAD_SEL = "header, .zeus-head, .eu-head, .gcal-head, .setup-head, .fp-header, .p3d-bar, .keys-bar, .vision-head, .sp-bar, .atlas-bar, .kr-bar, .esp-bar, .about-bar, .ww-bar, .media-hud-header, .holo-win-bar";

function closeOf(el) {
  return [...el.querySelectorAll("button")].find((button) =>
    button.closest(`${SEL}, ${MOBILE_SEL}`) === el
      && !button.classList.contains("sirius-window-close-proxy")
      && (button.querySelector(".lucide-x") || /fermer/i.test(button.getAttribute("aria-label") || "")
        || button.matches(".setup-close, .zeus-close, .eu-close, .fp-close, .p3d-close, .keys-close, .media-close-btn"))
  );
}

// position:fixed est relatif à l'ancêtre transformé le plus proche (containing block)
function fixedOffset(el) {
  let a = el.parentElement;
  while (a && a !== document.body) {
    const cs = getComputedStyle(a);
    if (cs.transform !== "none" || cs.perspective !== "none" || cs.filter !== "none") {
      const r = a.getBoundingClientRect();
      return { x: r.x + a.clientLeft, y: r.y + a.clientTop };
    }
    a = a.parentElement;
  }
  return { x: 0, y: 0 };
}

function applyPop(el, g) {
  const off = el.__off || { x: 0, y: 0 };
  el.style.left = `${Math.round(g.x - off.x)}px`;
  el.style.top = `${Math.round(g.y - off.y)}px`;
  el.style.width = `${Math.round(g.w)}px`;
  el.style.height = `${Math.round(g.h)}px`;
}

function freeEl(el) {
  if (el.__freed) return;
  const r = el.getBoundingClientRect();
  el.__off = fixedOffset(el);
  el.classList.add("holo-freed");
  el.style.position = "fixed";
  el.__geo = { x: r.x, y: r.y, w: r.width, h: r.height };
  applyPop(el, el.__geo);
  el.style.zIndex = bumpZ();
  el.__freed = true;
}

function popTrack(e0, el, fn) {
  el.__gestureDispose?.();
  el.classList.add("holo-manip");
  el.__cur = { ...el.__geo };
  let moved = false;
  const move = (e) => {
    const dx = e.clientX - e0.clientX, dy = e.clientY - e0.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
    fn(dx, dy);
  };
  const up = () => {
    el.classList.remove("holo-manip");
    el.__geo = { ...el.__cur };
  };
  el.__gestureDispose = trackWindowGesture(e0, { element: el, onMove: move, onEnd: up });
  // supprime le clic (fermeture) qui suivrait un vrai déplacement
  el.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); } }, { capture: true, once: true });
}

function decoratePopup(el) {
  if (el.__holoPop) return;
  el.__holoPop = true;
  el.classList.add("holo-pop");
  // La fenêtre de réponse centrale retient sa taille/position entre les sessions
  const pk = el.classList.contains("central-card") ? "pop:central-card" : null;
  const bar = document.createElement("div");
  bar.className = "holo-pop-bar holo-drag";
  bar.setAttribute("data-testid", "holo-pop-drag");
  bar.innerHTML = "<span></span><span></span><span></span>";
  el.prepend(bar);
  bar.addEventListener("pointerdown", (e) => {
    if (!isPrimaryGesture(e) || e.target.closest("button, input, select, textarea, a")) return;
    freeEl(el);
    const g0 = { ...el.__geo };
    popTrack(e, el, (dx, dy) => {
      el.__cur.x = clamp(g0.x + dx, -g0.w + 90, window.innerWidth - 90);
      el.__cur.y = clamp(g0.y + dy, 0, window.innerHeight - 40);
      applyPop(el, el.__cur);
    }, pk);
  });
  const rz = document.createElement("div");
  rz.className = "holo-pop-resize";
  rz.setAttribute("data-testid", "holo-pop-resize");
  el.appendChild(rz);
  rz.addEventListener("pointerdown", (e) => {
    if (!isPrimaryGesture(e)) return;
    e.stopPropagation();
    freeEl(el);
    const g0 = { ...el.__geo };
    popTrack(e, el, (dx, dy) => {
      el.__cur.w = clamp(g0.w + dx, 250, Math.max(300, window.innerWidth - g0.x - 4));
      el.__cur.h = clamp(g0.h + dy, 140, Math.max(200, window.innerHeight - g0.y - 4));
      applyPop(el, el.__cur);
    }, pk);
  });
  // Restauration de la géométrie mémorisée (bornée à l'écran)
  const g = pk && geom[pk];
  if (g && g.w) {
    freeEl(el);
    el.__geo = {
      x: clamp(g.x, -g.w + 90, window.innerWidth - 90),
      y: clamp(g.y, 0, window.innerHeight - 40),
      w: Math.min(g.w, window.innerWidth - 8),
      h: Math.min(g.h, window.innerHeight - 8),
    };
    applyPop(el, el.__geo);
  }
}

// ---- Dock de pastilles (fenêtres réduites) ----
function dock() {
  let d = document.getElementById("holo-dock");
  if (!d) {
    d = document.createElement("div");
    d.id = "holo-dock";
    d.setAttribute("data-testid", "holo-dock");
    document.body.appendChild(d);
  }
  return d;
}

function titleOf(el) {
  const t = el.querySelector(".oracle-title, .prime-title, .zeus-title, .eu-title, .gcal-title, .setup-title, .fp-title, .p3d-title, .keys-title, .vision-title, .sp-title, .atlas-title, .kr-title, .esp-title, .ww-title, .sirius-window-title, h1, h2");
  const txt = (t && t.textContent.trim()) || (el.getAttribute("data-testid") || "fenêtre").replace(/-/g, " ");
  return txt.replace(/\s+/g, " ").slice(0, 30).toUpperCase();
}

function minimize(el) {
  if (el.__pill) return;
  el.classList.add("holo-minimized");
  const pill = document.createElement("div");
  pill.className = "holo-dock-pill";
  pill.setAttribute("data-testid", "holo-dock-pill");
  const restore = document.createElement("button");
  restore.type = "button";
  restore.className = "hdp-restore";
  restore.title = "Restaurer la fenêtre";
  restore.setAttribute("aria-label", `Rouvrir ${titleOf(el)}`);
  const dot = document.createElement("span");
  dot.className = "hdp-dot";
  const label = document.createElement("span");
  label.className = "hdp-label";
  label.textContent = titleOf(el);
  restore.append(dot, label);
  pill.appendChild(restore);
  restore.addEventListener("click", () => {
    pill.remove();
    el.__pill = null;
    if (document.body.contains(el)) {
      el.classList.remove("holo-minimized");
      el.style.zIndex = bumpZ();
    }
  });
  const close = closeOf(el);
  if (close) {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "minimized-pill-close";
    dismiss.setAttribute("aria-label", `Fermer ${titleOf(el)}`);
    dismiss.title = `Fermer ${titleOf(el)}`;
    dismiss.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    dismiss.addEventListener("click", (event) => {
      event.stopPropagation();
      if (close.disabled) return;
      close.click();
      pill.remove();
      el.__pill = null;
    });
    pill.appendChild(dismiss);
  }
  dock().appendChild(pill);
  el.__pill = pill;
}

function decorateWindowControls(el) {
  if (el.classList.contains("auth-screen") || el.closest(".boot-screen")) return;
  const close = closeOf(el);
  if (!close) return;
  el.classList.add("sirius-module-window");
  if (!close.getAttribute("aria-label")) close.setAttribute("aria-label", "Fermer la fenêtre");
  let bar = close.closest(HEAD_SEL) || el.querySelector(HEAD_SEL);
  if (!bar) {
    bar = document.createElement("header");
    const title = el.querySelector("h1, h2");
    const heading = document.createElement("span");
    heading.className = "sirius-window-title";
    heading.textContent = title?.textContent || titleOf(el);
    title?.classList.add("sirius-window-native-title");
    bar.appendChild(heading);
    el.prepend(bar);
  }
  bar.classList.add("sirius-window-header", "mobile-window-controls");
  let visibleClose = close;
  if (!bar.contains(close)) {
    // Keep React's native button in place; its proxy delegates to the same handler.
    visibleClose = bar.querySelector(".sirius-window-close-proxy");
    if (!visibleClose) {
      visibleClose = document.createElement("button");
      visibleClose.type = "button";
      visibleClose.className = "sirius-window-close-proxy";
      visibleClose.textContent = "\u00d7";
      visibleClose.setAttribute("aria-label", close.getAttribute("aria-label"));
      visibleClose.addEventListener("click", (event) => {
        event.stopPropagation();
        const nativeClose = closeOf(el);
        if (nativeClose && !nativeClose.disabled) nativeClose.click();
      });
      bar.appendChild(visibleClose);
    }
    close.classList.add("sirius-window-native-close");
    visibleClose.disabled = close.disabled;
  }
  visibleClose.classList.add("sirius-window-close", "mobile-window-close");
  visibleClose.title = "Fermer la fenêtre";
  let mn = el.querySelector(".holo-win-min");
  if (!mn) {
    mn = document.createElement("button");
    mn.className = "holo-win-min";
    mn.type = "button";
    mn.setAttribute("data-testid", "holo-win-min");
    mn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>';
    mn.addEventListener("click", (e) => { e.stopPropagation(); minimize(el); });
  }
  mn.classList.add("mobile-window-min");
  mn.type = "button";
  mn.setAttribute("aria-label", "Réduire la fenêtre");
  mn.title = "Réduire en pastille";
  bar.appendChild(mn);
  if (el.__holoWin && !bar.querySelector(".sirius-window-max")) {
    const maximize = document.createElement("button");
    maximize.type = "button";
    maximize.className = "sirius-window-max";
    maximize.setAttribute("aria-label", "Agrandir la fenêtre");
    maximize.setAttribute("aria-pressed", "false");
    maximize.title = "Agrandir la fenêtre";
    maximize.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
    maximize.addEventListener("pointerdown", (event) => event.stopPropagation());
    maximize.addEventListener("click", (event) => {
      event.stopPropagation();
      const expanded = el.classList.toggle("sirius-window-expanded");
      const label = expanded ? "Restaurer la taille de la fenêtre" : "Agrandir la fenêtre";
      maximize.setAttribute("aria-label", label);
      maximize.setAttribute("aria-pressed", String(expanded));
      maximize.title = label;
    });
    bar.appendChild(maximize);
  }
}

function decorate(el) {
  if (el.__holoWin || el.classList.contains("auth-screen") || el.closest(".boot-screen")) return;
  // Une seule surface de module reste active : les précédentes sont rangées dans le dock.
  if (!mobilePage()) document.querySelectorAll(".holo-win:not(.holo-minimized)").forEach((openWindow) => {
    if (openWindow !== el) minimize(openWindow);
  });
  el.__holoWin = true;
  el.classList.add("holo-win");
  const k = keyOf(el);
  const isSetup = el.classList.contains("setup-screen");
  const { width, height } = viewport();
  const W = Math.min(width * 0.94, isSetup ? 1000 : 1600);
  const topInset = mobilePage() ? 8 : 72;
  const H = Math.min(height * 0.90, 980, height - topInset - 16);
  let g = geom[k];
  if (!g || !g.w || g.w > width + 40 || g.h > height + 40) {
    const off = (cascade++ % 6) * 36;
    g = {
      x: clamp((width - W) / 2 + off, 8, Math.max(8, width - W - 8)),
      y: clamp(Math.max(topInset, (height - H) / 2 - 6) + off * 0.7, topInset, Math.max(topInset, height - H - 8)),
      w: W, h: H,
    };
  }
  g = { ...g, w: Math.min(g.w, width - 16), h: Math.min(g.h, height - topInset - 16) };
  g.x = clamp(g.x, 8, Math.max(8, width - g.w - 8));
  g.y = clamp(g.y, topInset, Math.max(topInset, height - g.h - 8));
  el.__geo = g;
  apply(el, g);
  el.style.zIndex = bumpZ();
  el.addEventListener("pointerdown", (e) => {
    el.style.zIndex = bumpZ();
    if (e.target === el) e.stopPropagation(); // neutralise la fermeture « clic à côté » des setup-screen
  }, true);

  // Barre de saisie : en-tête existant, sinon strip holographique injecté
  let bar = el.querySelector(HEAD_SEL);
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "holo-win-bar";
    const heading = document.createElement("span");
    heading.className = "sirius-window-title";
    heading.textContent = titleOf(el);
    bar.appendChild(heading);
    el.prepend(bar);
  }
  bar.classList.add("holo-drag");
  bar.setAttribute("data-testid", "holo-win-drag");
  bar.addEventListener("pointerdown", (e) => startDrag(e, el, k));

  const mn = document.createElement("button");
  mn.type = "button";
  mn.className = "holo-win-min";
  mn.setAttribute("data-testid", "holo-win-min");
  mn.title = "Réduire en pastille";
  mn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="4" y1="19" x2="20" y2="19"/></svg>';
  mn.addEventListener("pointerdown", (e) => e.stopPropagation());
  mn.addEventListener("click", (e) => { e.stopPropagation(); minimize(el); });
  bar.appendChild(mn);

  const rz = document.createElement("div");
  rz.className = "holo-win-resize";
  rz.setAttribute("data-testid", "holo-win-resize");
  rz.title = "Redimensionner";
  el.appendChild(rz);
  rz.addEventListener("pointerdown", (e) => startResize(e, el, k));
  decorateWindowControls(el);
}

export function minimizeAll() {
  const wins = document.querySelectorAll(".holo-win:not(.holo-minimized), .mobile-window-controls");
  const windows = new Set([...wins].map((el) => el.closest(`${SEL}, ${MOBILE_SEL}`)).filter(Boolean));
  const openWindows = [...windows].filter((el) => !el.classList.contains("holo-minimized"));
  openWindows.forEach((el) => minimize(el));
  return openWindows.length;
}

function reflowWindows() {
  if (mobilePage()) return;
  const { width, height } = viewport();
  document.querySelectorAll(".holo-win").forEach((el) => {
    if (!el.__geo) return;
    const g = { ...el.__geo, w: Math.min(el.__geo.w, width - 16), h: Math.min(el.__geo.h, height - 88) };
    g.x = clamp(g.x, 8, Math.max(8, width - g.w - 8));
    g.y = clamp(g.y, 72, Math.max(72, height - g.h - 8));
    el.__geo = g;
    apply(el, g);
  });
}

export function initHoloWindows() {
  if (window.__holoWinInit) return;
  window.__holoWinInit = true;
  window.removeEventListener("resize", reflowWindows);
  window.removeEventListener("sirius-hud-preferences", reflowWindows);
  window.addEventListener("resize", reflowWindows);
  window.addEventListener("sirius-hud-preferences", reflowWindows);
  document.querySelectorAll(SEL).forEach(decorate);
  document.querySelectorAll(MOBILE_SEL).forEach(decorateWindowControls);
  document.querySelectorAll(POP_SEL).forEach(decoratePopup);
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches(SEL)) decorate(n);
        if (n.matches && n.matches(MOBILE_SEL)) decorateWindowControls(n);
        if (n.matches && n.matches(POP_SEL)) decoratePopup(n);
        if (n.querySelectorAll) {
          n.querySelectorAll(SEL).forEach(decorate);
          n.querySelectorAll(MOBILE_SEL).forEach(decorateWindowControls);
          n.querySelectorAll(POP_SEL).forEach(decoratePopup);
        }
      }
      for (const n of m.removedNodes) {
        if (n.nodeType !== 1) continue;
        const gone = [];
        if (n.__pill) gone.push(n);
        if (n.querySelectorAll) n.querySelectorAll(".holo-minimized").forEach((x) => x.__pill && gone.push(x));
        gone.forEach((x) => {
          if (!document.body.contains(x)) { x.__pill.remove(); x.__pill = null; }
        });
      }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

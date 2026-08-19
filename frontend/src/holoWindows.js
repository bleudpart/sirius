// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Fenêtres holographiques 3D : transforme les écrans plats en panneaux cyan flottants,
// déplaçables (drag sur l'en-tête), redimensionnables (poignée bas-droite) et fermables.
const SEL = ".prime-screen, .zeus-screen, .eu-screen, .setup-screen, .iw-panel";
let zTop = 1000;
const bumpZ = () => (zTop = Math.min(zTop + 1, 1190));
let cascade = 0;
let geom = {};
try { geom = JSON.parse(localStorage.getItem("sirius_holo_geom") || "{}"); } catch (e) { geom = {}; }
const save = () => { try { localStorage.setItem("sirius_holo_geom", JSON.stringify(geom)); } catch (e) { /* plein */ } };
// Migration unique : oublie l'ancienne géométrie (trop grande) de la fenêtre Configuration
try {
  if (!localStorage.getItem("sirius_holo_v2")) {
    delete geom["sirius-setup"];
    save();
    localStorage.setItem("sirius_holo_v2", "1");
  }
} catch (e) { /* stockage indisponible */ }

const keyOf = (el) => el.getAttribute("data-testid") || (el.className || "win").split(" ")[0];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function apply(el, g) {
  el.style.left = `${Math.round(g.x)}px`;
  el.style.top = `${Math.round(g.y)}px`;
  el.style.width = `${Math.round(g.w)}px`;
  el.style.height = `${Math.round(g.h)}px`;
}

function track(e0, el, k, fn) {
  e0.preventDefault();
  el.classList.add("holo-manip");
  el.__cur = { ...el.__geo };
  const move = (e) => fn(e.clientX - e0.clientX, e.clientY - e0.clientY);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    el.classList.remove("holo-manip");
    el.__geo = { ...el.__cur };
    geom[k] = { ...el.__cur };
    save();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function startDrag(e, el, k) {
  if (e.target.closest("button, input, select, textarea, a, [role=button]")) return;
  const g0 = { ...el.__geo };
  track(e, el, k, (dx, dy) => {
    el.__cur.x = clamp(g0.x + dx, -g0.w + 140, window.innerWidth - 140);
    el.__cur.y = clamp(g0.y + dy, 0, window.innerHeight - 52);
    apply(el, el.__cur);
  });
}

function startResize(e, el, k) {
  e.stopPropagation();
  const g0 = { ...el.__geo };
  track(e, el, k, (dx, dy) => {
    el.__cur.w = clamp(g0.w + dx, 460, Math.max(520, window.innerWidth - g0.x - 4));
    el.__cur.h = clamp(g0.h + dy, 320, Math.max(360, window.innerHeight - g0.y - 4));
    apply(el, el.__cur);
  });
}

// ---- Popups interactifs (réponses de Sirius, alertes) : drag + resize à la demande ----
const POP_SEL = ".central-card, .holo-popup";

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
  e0.preventDefault();
  el.classList.add("holo-manip");
  el.__cur = { ...el.__geo };
  let moved = false;
  const move = (e) => {
    const dx = e.clientX - e0.clientX, dy = e.clientY - e0.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
    fn(dx, dy);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    el.classList.remove("holo-manip");
    el.__geo = { ...el.__cur };
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
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
    if (e.target.closest("button, input, select, textarea, a")) return;
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
  const t = el.querySelector(".zeus-title, .eu-title, .gcal-title, .setup-title, h1, h2");
  const txt = (t && t.textContent.trim()) || (el.getAttribute("data-testid") || "fenêtre").replace(/-/g, " ");
  return txt.replace(/\s+/g, " ").slice(0, 30).toUpperCase();
}

function minimize(el) {
  if (el.__pill) return;
  el.classList.add("holo-minimized");
  const pill = document.createElement("button");
  pill.className = "holo-dock-pill";
  pill.setAttribute("data-testid", "holo-dock-pill");
  pill.title = "Restaurer la fenêtre";
  pill.innerHTML = `<span class="hdp-dot"></span><span class="hdp-label">${titleOf(el)}</span>`;
  pill.addEventListener("click", () => {
    pill.remove();
    el.__pill = null;
    if (document.body.contains(el)) {
      el.classList.remove("holo-minimized");
      el.style.zIndex = bumpZ();
    }
  });
  dock().appendChild(pill);
  el.__pill = pill;
}

function decorate(el) {
  if (el.__holoWin || el.classList.contains("auth-screen") || el.closest(".boot-screen")) return;
  el.__holoWin = true;
  el.classList.add("holo-win");
  const k = keyOf(el);
  const isSetup = el.classList.contains("setup-screen");
  const W = Math.min(window.innerWidth * (isSetup ? 0.92 : 0.86), isSetup ? 780 : 1240);
  const H = Math.min(window.innerHeight * (isSetup ? 0.94 : 0.86), isSetup ? 700 : 830);
  let g = geom[k];
  if (!g || !g.w || g.w > window.innerWidth + 40 || g.h > window.innerHeight + 40) {
    const off = (cascade++ % 6) * 36;
    g = { x: (window.innerWidth - W) / 2 + off, y: Math.max(8, (window.innerHeight - H) / 2 - 6) + off * 0.7, w: W, h: H };
  }
  g = { ...g, x: clamp(g.x, -g.w + 140, window.innerWidth - 140), y: clamp(g.y, 0, window.innerHeight - 52) };
  el.__geo = g;
  apply(el, g);
  el.style.zIndex = bumpZ();
  el.addEventListener("pointerdown", (e) => {
    el.style.zIndex = bumpZ();
    if (e.target === el) e.stopPropagation(); // neutralise la fermeture « clic à côté » des setup-screen
  }, true);

  // Barre de saisie : en-tête existant, sinon strip holographique injecté
  let bar = el.querySelector(".zeus-head, .eu-head, .gcal-head");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "holo-win-bar";
    bar.innerHTML = "<span></span><span></span><span></span>";
    el.prepend(bar);
  }
  bar.classList.add("holo-drag");
  bar.setAttribute("data-testid", "holo-win-drag");
  bar.addEventListener("pointerdown", (e) => startDrag(e, el, k));

  const mn = document.createElement("button");
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
}

export function minimizeAll() {
  const wins = document.querySelectorAll(".holo-win:not(.holo-minimized)");
  wins.forEach((el) => minimize(el));
  return wins.length;
}

export function initHoloWindows() {
  if (window.__holoWinInit) return;
  window.__holoWinInit = true;
  document.querySelectorAll(SEL).forEach(decorate);
  document.querySelectorAll(POP_SEL).forEach(decoratePopup);
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches && n.matches(SEL)) decorate(n);
        if (n.matches && n.matches(POP_SEL)) decoratePopup(n);
        if (n.querySelectorAll) {
          n.querySelectorAll(SEL).forEach(decorate);
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

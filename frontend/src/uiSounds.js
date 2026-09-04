// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
// Sons d'interface synthétisés (Web Audio) : clics cristallins, chimes d'ouverture/fermeture.
let ctx = null;
const ac = () => {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
};
const enabled = () => localStorage.getItem("sirius_ui_sounds") !== "off";

function tone(freq, dur, { type = "sine", gain = 0.035, delay = 0, glide = 0 } = {}) {
  try {
    const c = ac();
    if (c.state !== "running") return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  } catch (e) { /* audio indisponible */ }
}

// Clic cristallin : deux harmoniques très courtes
export function playClick() {
  if (!enabled()) return;
  tone(2400, 0.05, { gain: 0.022 });
  tone(3600, 0.04, { gain: 0.012, delay: 0.005 });
}

// Chime d'ouverture : arpège doré ascendant
export function playOpen() {
  if (!enabled()) return;
  tone(880, 0.22, { gain: 0.03 });
  tone(1318.5, 0.24, { gain: 0.026, delay: 0.07 });
  tone(1760, 0.3, { gain: 0.022, delay: 0.14 });
}

// Chime de fermeture : descente douce
export function playClose() {
  if (!enabled()) return;
  tone(1318.5, 0.18, { gain: 0.022 });
  tone(880, 0.24, { gain: 0.02, delay: 0.06, glide: 660 });
}

// Câblage global : clics délégués + chimes à l'ouverture/fermeture des panneaux plein écran
let wired = false;
export function initUiSounds() {
  if (wired) return;
  wired = true;
  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("button, a, select, [role='button']")) playClick();
  }, { capture: true, passive: true });
  const PANEL_CLASSES = ["prime-screen", "setup-screen", "modmenu", "zeus-screen", "central-card", "holo-popup", "hud-panel", "atlas-panel", "kr-panel"];
  const isPanel = (n) => n.nodeType === 1 && n.classList && PANEL_CLASSES.some((c) => n.classList.contains(c));
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) if (isPanel(n)) { playOpen(); return; }
      for (const n of m.removedNodes) if (isPanel(n)) { playClose(); return; }
    }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

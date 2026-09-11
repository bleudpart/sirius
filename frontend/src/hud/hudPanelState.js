// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// État partagé (localStorage + événement custom) pour les fenêtres HUD flottantes
// (.shud-panel) : quelles sont masquées, et où sont-elles ancrées quand détachées de
// leur colonne par glisser-déposer. Un simple module de fonctions (pas de contexte React)
// suffit ici : chaque HudPanel s'abonne à l'événement pour rester synchronisé, y compris
// avec la petite barre de restauration affichée dans les colonnes.
import { useEffect, useState } from "react";

const HIDDEN_KEY = "sirius_hud_hidden_panels";
const POS_PREFIX = "sirius_hud_float_";
const EVT = "sirius-hud-panel-visibility";

function readHidden() {
  try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY)) || []); } catch { return new Set(); }
}
function writeHidden(set) {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set])); } catch { /* stockage plein ignoré */ }
  window.dispatchEvent(new Event(EVT));
}

export function hideHudPanel(key) {
  const s = readHidden();
  s.add(key);
  writeHidden(s);
}
export function restoreHudPanel(key) {
  const s = readHidden();
  s.delete(key);
  writeHidden(s);
}

export function useHudHiddenKeys() {
  const [keys, setKeys] = useState(() => readHidden());
  useEffect(() => {
    const onChange = () => setKeys(readHidden());
    window.addEventListener(EVT, onChange);
    return () => window.removeEventListener(EVT, onChange);
  }, []);
  return keys;
}

export function readFloatPos(key) {
  try { return JSON.parse(localStorage.getItem(POS_PREFIX + key)); } catch { return null; }
}
export function writeFloatPos(key, pos) {
  try { localStorage.setItem(POS_PREFIX + key, JSON.stringify(pos)); } catch { /* stockage plein ignoré */ }
}
export function clearFloatPos(key) {
  try { localStorage.removeItem(POS_PREFIX + key); } catch { /* ignoré */ }
}

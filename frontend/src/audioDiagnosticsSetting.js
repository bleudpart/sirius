export const AUDIO_DIAGNOSTICS_STORAGE_KEY = "sirius_show_audio_diagnostics";
export const AUDIO_DIAGNOSTICS_EVENT = "sirius-audio-diagnostics-changed";

export function loadShowAudioDiagnostics() {
  try {
    return localStorage.getItem(AUDIO_DIAGNOSTICS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveShowAudioDiagnostics(enabled) {
  try {
    if (enabled) localStorage.setItem(AUDIO_DIAGNOSTICS_STORAGE_KEY, "1");
    else localStorage.removeItem(AUDIO_DIAGNOSTICS_STORAGE_KEY);
  } catch {
    // Stockage indisponible : le choix reste valable pour cette session.
  }
  window.dispatchEvent(new CustomEvent(AUDIO_DIAGNOSTICS_EVENT, { detail: { enabled: Boolean(enabled) } }));
}

// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
/**
 * Moteur d'ambiance SIRIUS — lecture des vrais fichiers musicaux installés
 * (public/audio/ambiance.mp3, public/audio/gregorien.mp3), en boucle.
 * Expose la même interface que HTMLAudioElement (.play(), .pause(), .volume, .src)
 * pour rester compatible avec tout le code existant dans App.js.
 *
 * Presets :
 *   "epique"    — public/audio/ambiance.mp3
 *   "gregorien" — public/audio/gregorien.mp3
 *
 * (Une version précédente synthétisait un drone via Web Audio API — remplacée ici par la
 * lecture des vrais morceaux déjà installés dans le projet, à la demande explicite : le rendu
 * synthétique ne sonnait pas comme de la musique, seulement comme un bruit sourd.)
 */

const TRACKS = {
  epique: "/audio/ambiance.mp3",
  gregorien: "/audio/gregorien.mp3",
};

// Douceur du volume selon l'humeur de SIRIUS (pas de filtrage possible sur un fichier audio
// réel comme sur un synthétiseur — on se contente d'un léger « ducking » du volume pour ne
// pas couvrir la voix pendant que SIRIUS parle).
const MOOD_GAIN = {
  idle: 1.0,
  thinking: 0.85,
  speaking: 0.6,
  listening: 0.8,
};

export class AmbientEngine {
  constructor(preset = "epique") {
    this._src = TRACKS[preset] || TRACKS.epique;
    this._volume = 0.12;
    this._moodMul = 1.0;
    this._audio = null;
  }

  // ── HTMLAudioElement-compatible interface ────────────────────────────────

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._audio) this._audio.volume = this._volume * this._moodMul;
  }

  // src = "" signale un nettoyage (utilisé par les gestionnaires de nettoyage dans App.js)
  set src(v) { if (v === "") this._destroy(); }

  play() {
    if (!this._audio) {
      const a = new Audio(this._src);
      a.loop = true;
      a.volume = this._volume * this._moodMul;
      this._audio = a;
    }
    return this._audio.play().catch(() => {});
  }

  pause() {
    if (this._audio) this._audio.pause();
  }

  // ── Mood API (optionnelle — appelée quand le statut de SIRIUS change) ────

  setMood(status) {
    if (!this._audio) return;
    this._moodMul = MOOD_GAIN[status] ?? MOOD_GAIN.idle;
    this._audio.volume = this._volume * this._moodMul;
  }

  // ── Interne ───────────────────────────────────────────────────────────────

  _destroy() {
    if (!this._audio) return;
    try { this._audio.pause(); this._audio.src = ""; } catch {}
    this._audio = null;
  }
}

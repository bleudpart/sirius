// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
/**
 * Moteur d'ambiance ΣIRIUS — lecture des vrais fichiers musicaux installés
 * (public/audio/zirius-loop.wav, public/audio/gregorien.mp3), en boucle.
 * Expose la même interface que HTMLAudioElement (.play(), .pause(), .volume, .src)
 * pour rester compatible avec tout le code existant dans App.js.
 *
 * Presets :
 *   "epique"    — thème Zirius (identifiant conservé pour les réglages existants)
 *   "gregorien" — public/audio/gregorien.mp3
 *
 * (Une version précédente synthétisait un drone via Web Audio API — remplacée ici par la
 * lecture des vrais morceaux déjà installés dans le projet, à la demande explicite : le rendu
 * synthétique ne sonnait pas comme de la musique, seulement comme un bruit sourd.)
 */

import { GaplessLoop } from "./gaplessLoop";

const TRACKS = {
  epique: "/audio/zirius-loop.wav?revision=3",
  gregorien: "/audio/gregorien.mp3",
};

// Douceur du volume selon l'humeur de ΣIRIUS (pas de filtrage possible sur un fichier audio
// réel comme sur un synthétiseur — on se contente d'un léger « ducking » du volume pour ne
// pas couvrir la voix pendant que ΣIRIUS parle).
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
    this._loop = null;
    this._gapless = undefined;
  }

  // ── HTMLAudioElement-compatible interface ────────────────────────────────

  get volume() { return this._volume; }
  set volume(v) {
    this._volume = Math.max(0, Math.min(1, v));
    this._applyVolume();
  }

  // src = "" signale un nettoyage (utilisé par les gestionnaires de nettoyage dans App.js)
  set src(v) { if (v === "") this._destroy(); }

  play() {
    if (this._gapless === undefined) {
      this._gapless = this._src.endsWith(".wav") || this._src.includes(".wav?")
        ? GaplessLoop.supported() : false;
    }
    if (this._gapless) {
      if (!this._loop) {
        this._loop = new GaplessLoop(this._src);
        this._loop.volume = this._volume * this._moodMul;
      }
      return this._loop.play().catch((error) => {
        // Lecture bloquée : le prochain geste relancera la boucle sans trou.
        if (error?.name === "NotAllowedError") return undefined;
        // Décodage impossible : retour au lecteur classique.
        this._loop?.destroy();
        this._loop = null;
        this._gapless = false;
        return this.play();
      });
    }
    if (!this._audio) {
      const a = new Audio(this._src);
      a.loop = true;
      a.volume = this._volume * this._moodMul;
      this._audio = a;
    }
    return this._audio.play().catch(() => {});
  }

  pause() {
    if (this._loop) this._loop.pause();
    if (this._audio) this._audio.pause();
  }

  // ── Mood API (optionnelle — appelée quand le statut de ΣIRIUS change) ────

  setMood(status) {
    if (!this._audio && !this._loop) return;
    this._moodMul = MOOD_GAIN[status] ?? MOOD_GAIN.idle;
    this._applyVolume();
  }

  // ── Interne ───────────────────────────────────────────────────────────────

  _applyVolume() {
    const value = this._volume * this._moodMul;
    if (this._audio) this._audio.volume = value;
    if (this._loop) this._loop.volume = value;
  }

  _destroy() {
    if (this._loop) { this._loop.destroy(); this._loop = null; }
    if (!this._audio) return;
    try { this._audio.pause(); this._audio.src = ""; } catch {}
    this._audio = null;
  }
}

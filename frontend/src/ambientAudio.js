// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés.
/**
 * Moteur d'ambiance procédural (Web Audio API).
 * Expose la même interface que HTMLAudioElement (.play(), .pause(), .volume, .src)
 * pour rester compatible avec tout le code existant dans App.js.
 *
 * Presets :
 *   "epique"    — drone synthwave sci-fi, grave et électronique
 *   "gregorien" — nappe éthérée harmonique, lumineux et méditatif
 */

const PRESETS = {
  epique: {
    baseGain: 0.90,
    // Filtre remonté de 200 Hz à 480 Hz : à 200 Hz, seules les couches sub-graves (40-110 Hz)
    // passaient réellement — le résultat était un grondement sourd sans aucune couleur
    // mélodique. À 480 Hz, les couches 220/330 Hz (qui donnent le caractère « épique », proche
    // d'un accord tenu) deviennent nettement audibles, et 660/880 Hz ajoutent un léger scintillement.
    filter: { type: "lowpass", freq: 480, q: 0.9 },
    lfo: { rate: 0.07, depth: 65 },
    layers: [
      { freq: 40,  type: "sine",     vol: 0.20 },
      { freq: 80,  type: "sine",     vol: 0.16 },
      { freq: 110, type: "sine",     vol: 0.14 },
      { freq: 220, type: "triangle", vol: 0.16 },
      { freq: 330, type: "sine",     vol: 0.11 },
      { freq: 660, type: "triangle", vol: 0.05 },
      { freq: 880, type: "sine",     vol: 0.02 },
    ],
    moods: {
      idle:     { filterFreq: 480, lfoRate: 0.07, gainMul: 1.00 },
      thinking: { filterFreq: 600, lfoRate: 0.14, gainMul: 0.85 },
      speaking: { filterFreq: 700, lfoRate: 0.22, gainMul: 0.70 },
      listening:{ filterFreq: 540, lfoRate: 0.10, gainMul: 0.80 },
    },
  },
  gregorien: {
    baseGain: 0.85,
    filter: { type: "bandpass", freq: 520, q: 1.1 },
    lfo: { rate: 0.04, depth: 110 },
    layers: [
      { freq: 174, type: "sine",     vol: 0.26 },
      { freq: 261, type: "sine",     vol: 0.20 },
      { freq: 348, type: "triangle", vol: 0.14 },
      { freq: 522, type: "sine",     vol: 0.08 },
      { freq: 696, type: "triangle", vol: 0.04 },
      { freq: 1044,type: "sine",     vol: 0.012 },
      { freq: 1566,type: "sine",     vol: 0.004 },
    ],
    moods: {
      idle:     { filterFreq: 520, lfoRate: 0.04, gainMul: 1.00 },
      thinking: { filterFreq: 680, lfoRate: 0.09, gainMul: 0.88 },
      speaking: { filterFreq: 820, lfoRate: 0.14, gainMul: 0.75 },
      listening:{ filterFreq: 600, lfoRate: 0.06, gainMul: 0.85 },
    },
  },
};

export class AmbientEngine {
  constructor(preset = "epique") {
    this._preset  = PRESETS[preset] || PRESETS.epique;
    this._volume  = 0.12;
    this._paused  = false;
    this._started = false;
    this._ctx     = null;
    this._master  = null;
    this._filter  = null;
    this._lfo     = null;
    this._lfoGain = null;
    this._oscs    = [];
  }

  // ── HTMLAudioElement-compatible interface ────────────────────────────────

  get volume()    { return this._volume; }
  set volume(v)   {
    this._volume = Math.max(0, Math.min(1, v));
    if (this._master && !this._paused) {
      const target = this._volume * this._preset.baseGain;
      this._master.gain.setTargetAtTime(target, this._ctx.currentTime, 0.4);
    }
  }

  // src = "" signals cleanup (used in App.js cleanup handlers)
  set src(v) { if (v === "") this._destroy(); }

  play() {
    this._paused = false;
    if (!this._started) {
      this._boot();
    } else if (this._master) {
      const target = this._volume * this._preset.baseGain;
      this._master.gain.setTargetAtTime(target, this._ctx.currentTime, 1.8);
    }
    // Filet de sécurité : sur certains navigateurs, l'AudioContext démarre (ou reste) en état
    // "suspended" tant qu'aucun geste utilisateur n'a été détecté par la politique autoplay —
    // les oscillateurs tournent alors dans le vide, silencieusement, sans jamais produire de
    // son audible. On tente systématiquement une reprise explicite à chaque appel de play().
    if (this._ctx && this._ctx.state === "suspended") {
      this._ctx.resume().catch(() => {});
    }
    return Promise.resolve();
  }

  pause() {
    this._paused = true;
    if (this._master) {
      this._master.gain.setTargetAtTime(0, this._ctx.currentTime, 1.2);
    }
  }

  // ── Mood API (optional — called when SIRIUS status changes) ──────────────

  setMood(status) {
    if (!this._ctx || !this._filter || !this._lfo || !this._master || this._paused) return;
    const p = this._preset.moods[status] || this._preset.moods.idle;
    const t = this._ctx.currentTime;
    this._filter.frequency.setTargetAtTime(p.filterFreq, t, 2.5);
    this._lfo.frequency.setTargetAtTime(p.lfoRate, t, 3.5);
    const target = this._volume * this._preset.baseGain * p.gainMul;
    this._master.gain.setTargetAtTime(target, t, 2.0);
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _boot() {
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return; // Web Audio not available
    }
    const ctx = this._ctx;
    const cfg = this._preset;

    // Master gain — fades in from 0 over 5 s
    this._master = ctx.createGain();
    this._master.gain.setValueAtTime(0, ctx.currentTime);
    this._master.gain.linearRampToValueAtTime(
      this._volume * cfg.baseGain,
      ctx.currentTime + 5
    );
    this._master.connect(ctx.destination);

    // Filter
    this._filter = ctx.createBiquadFilter();
    this._filter.type      = cfg.filter.type;
    this._filter.frequency.value = cfg.filter.freq;
    this._filter.Q.value   = cfg.filter.q;
    this._filter.connect(this._master);

    // LFO → filter frequency modulation (organic breathing)
    this._lfo = ctx.createOscillator();
    this._lfo.type = "sine";
    this._lfo.frequency.value = cfg.lfo.rate;
    this._lfoGain = ctx.createGain();
    this._lfoGain.gain.value = cfg.lfo.depth;
    this._lfo.connect(this._lfoGain);
    this._lfoGain.connect(this._filter.frequency);
    this._lfo.start();

    // Oscillator layers — each slightly detuned for organic warmth
    for (const layer of cfg.layers) {
      const osc = ctx.createOscillator();
      const g   = ctx.createGain();
      osc.type = layer.type;
      // ±0.15% random detune per layer
      osc.frequency.value = layer.freq * (1 + (Math.random() - 0.5) * 0.003);
      g.gain.value = layer.vol;
      osc.connect(g);
      g.connect(this._filter);
      osc.start();
      this._oscs.push({ osc, g });
    }

    this._started = true;
  }

  _destroy() {
    if (!this._ctx) return;
    try {
      if (this._master) {
        this._master.gain.setTargetAtTime(0, this._ctx.currentTime, 0.5);
      }
      setTimeout(() => {
        this._oscs.forEach(({ osc }) => { try { osc.stop(); } catch {} });
        if (this._lfo) { try { this._lfo.stop(); } catch {} }
        this._ctx.close();
      }, 800);
    } catch {}
    this._started = false;
    this._oscs = [];
  }
}

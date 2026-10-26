// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
/**
 * Boucle audio sans coupure : le fichier est décodé une fois puis rejoué par
 * un AudioBufferSourceNode en boucle, calé à l'échantillon près. Un élément
 * <audio loop> laisse un léger trou au raccord selon le moteur (Chromium,
 * WebView Android), ce qui décale la musique d'un tour à l'autre.
 */

const decoded = new Map();

function contextClass() {
  if (typeof window === "undefined") return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

function notAllowed() {
  const error = new Error("Lecture audio refusée par le navigateur.");
  error.name = "NotAllowedError";
  return error;
}

export class GaplessLoop {
  static supported() {
    return Boolean(contextClass()) && typeof fetch === "function";
  }

  constructor(url, { onPlay, onPause } = {}) {
    this._url = url;
    this._volume = 1;
    this._onPlay = onPlay;
    this._onPause = onPause;
    this._context = null;
    this._gain = null;
    this._source = null;
    this._destroyed = false;
  }

  get volume() { return this._volume; }
  set volume(value) {
    this._volume = Math.max(0, Math.min(1, value));
    if (this._gain) this._gain.gain.value = this._volume;
  }

  _buffer(context) {
    if (!decoded.has(this._url)) {
      const pending = fetch(this._url)
        .then((response) => {
          if (!response.ok) throw new Error("Musique indisponible.");
          return response.arrayBuffer();
        })
        .then((data) => context.decodeAudioData(data));
      pending.catch(() => decoded.delete(this._url));
      decoded.set(this._url, pending);
    }
    return decoded.get(this._url);
  }

  async play() {
    if (this._destroyed) return;
    if (!this._context) {
      const Context = contextClass();
      this._context = new Context({ latencyHint: "playback" });
      this._gain = this._context.createGain();
      this._gain.gain.value = this._volume;
      this._gain.connect(this._context.destination);
      this._context.onstatechange = () => {
        if (this._destroyed || !this._source) return;
        if (this._context.state === "running") this._onPlay?.();
        else if (this._context.state === "suspended") this._onPause?.();
      };
    }
    const buffer = await this._buffer(this._context);
    if (this._destroyed) return;
    if (!this._source) {
      const source = this._context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this._gain);
      source.start(0);
      this._source = source;
    }
    // Sans geste utilisateur, resume() peut rester en attente : on signale le blocage.
    await Promise.race([
      this._context.resume(),
      new Promise((resolve) => setTimeout(resolve, 400)),
    ]);
    if (this._context.state !== "running") throw notAllowed();
    this._onPlay?.();
  }

  // suspend() fige la position : la reprise continue exactement au même point.
  pause() {
    if (this._context && this._context.state === "running") {
      this._context.suspend().catch(() => {});
    }
  }

  destroy() {
    this._destroyed = true;
    try { this._source?.stop(); } catch { /* déjà arrêté */ }
    this._source = null;
    this._context?.close().catch(() => {});
    this._context = null;
    this._gain = null;
  }
}

import React, { useState } from "react";
import { FLAT_EQUALIZER, loadVoiceEqualizer, saveVoiceEqualizer } from "./voiceEqualizer";

export default function VoiceEqualizerPanel({ localVoice }) {
  const [config, setConfig] = useState(loadVoiceEqualizer);
  const update = value => setConfig(saveVoiceEqualizer(value));
  const supported = Boolean(window.AudioContext || window.webkitAudioContext);
  const disabled = localVoice || !supported;
  return <fieldset className="voice-equalizer">
    <legend>Égaliseur vocal — audio premium</legend>
    <p>{localVoice
      ? "La voix locale utilise le réglage de hauteur ci-dessus. Choisissez une voix premium pour appliquer cet égaliseur."
      : supported ? "Trois bandes audio réelles. Réglages enregistrés automatiquement ; écoutez avec « Tester la voix »."
        : "Égaliseur indisponible : ce navigateur ne prend pas en charge Web Audio."}</p>
    <div className="voice-equalizer-bands">
      {[["bass", "Graves", "250 Hz"], ["mid", "Médiums", "1,2 kHz"], ["treble", "Aigus", "4 kHz"]].map(([key, label, frequency]) =>
        <label key={key} className="voice-equalizer-band">
          <span>{label} <small>{frequency}</small></span>
          <input type="range" min="-12" max="12" step="1" value={config[key]} disabled={disabled}
            aria-label={`Égaliseur ${label.toLowerCase()}`}
            onChange={event => update({ ...config, [key]: Number(event.target.value) })} />
          <output>{config[key] > 0 ? "+" : ""}{config[key]} dB</output>
        </label>)}
    </div>
    <button type="button" className="setup-reset" onClick={() => update({ ...FLAT_EQUALIZER })}>Remettre à plat — 0 dB</button>
    <p>Une marge de sécurité réduit le volume lors des amplifications pour éviter la saturation. Sans effet sur les voix locales de secours.</p>
  </fieldset>;
}

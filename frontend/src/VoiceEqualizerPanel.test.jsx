import React, { act } from "react";
import { createRoot } from "react-dom/client";
import VoiceEqualizer from "./VoiceEqualizerPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
test("premium controls persist gains, reset to flat and explicitly disable local synthesis", async () => {
  const previous = window.AudioContext;
  window.AudioContext = jest.fn();
  localStorage.removeItem("sirius_voice_equalizer");
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<VoiceEqualizer localVoice={false} />));
    const inputs = [...host.querySelectorAll("input")];
    expect(inputs).toHaveLength(6);
    expect(host.textContent).toContain("Infra-graves");
    expect(host.textContent).toContain("Bas-médiums");
    expect(host.textContent).toContain("Brillance");
    expect(inputs.every(input => !input.disabled)).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(inputs[1], "6");
        inputs[1].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(JSON.parse(localStorage.getItem("sirius_voice_equalizer")).bass).toBe(6);
    expect(host.textContent).toContain("+6 dB");
    await act(async () => host.querySelector("button").click());
    expect(JSON.parse(localStorage.getItem("sirius_voice_equalizer"))).toEqual({ sub: 0, bass: 0, lowMid: 0, mid: 0, treble: 0, air: 0 });
    await act(async () => root.render(<VoiceEqualizer localVoice />));
    expect([...host.querySelectorAll("input")].every(input => input.disabled)).toBe(true);
    expect(host.textContent).toContain("La voix locale");
  } finally {
    await act(async () => root.unmount());
    window.AudioContext = previous;
    localStorage.removeItem("sirius_voice_equalizer");
  }
});

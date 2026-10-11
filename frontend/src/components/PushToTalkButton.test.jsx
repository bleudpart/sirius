import React, { act } from "react";
import { createRoot } from "react-dom/client";
import PushToTalkButton from "./PushToTalkButton";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("keeps the same label container and exposes only the current status", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    for (const [active, ready, label, accessibleLabel] of [
      [false, false, "ESPACE", "Maintenir pour parler, relâcher pour envoyer"],
      [true, false, "OUVERTURE…", "Ouverture du microphone"],
      [true, true, "À VOUS", "Microphone ouvert : relâchez pour envoyer"],
      [false, false, "ESPACE", "Maintenir pour parler, relâcher pour envoyer"],
    ]) {
      act(() => root.render(<PushToTalkButton active={active} ready={ready} onStart={() => {}} onStop={() => {}} />));
      const button = container.querySelector("button");
      expect(button.querySelector(".ptt-label > span").textContent).toBe(label);
      expect(button.textContent).toBe(label);
      expect(button.getAttribute("aria-pressed")).toBe(String(active));
      expect(button.getAttribute("aria-label")).toBe(accessibleLabel);
      expect(button.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
    }
  } finally {
    act(() => root.unmount());
  }
});

test("press captures the pointer, survives leaving the button and stops on release or cancellation", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onStart = jest.fn();
  const onStop = jest.fn();
  try {
    act(() => root.render(<PushToTalkButton active={false} onStart={onStart} onStop={onStop} />));
    const button = container.querySelector("button");
    button.setPointerCapture = jest.fn();
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "pointerId", { value: 7 });
    act(() => button.dispatchEvent(down));
    expect(button.setPointerCapture).toHaveBeenCalledWith(7);
    expect(onStart).toHaveBeenCalledTimes(1);
    act(() => button.dispatchEvent(new Event("pointerout", { bubbles: true })));
    expect(onStop).not.toHaveBeenCalled();
    act(() => button.dispatchEvent(new Event("pointerup", { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(1);
    act(() => button.dispatchEvent(new Event("pointercancel", { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(2);
    act(() => button.dispatchEvent(new Event("lostpointercapture", { bubbles: true })));
    expect(onStop).toHaveBeenCalledTimes(3);
  } finally {
    act(() => root.unmount());
  }
});

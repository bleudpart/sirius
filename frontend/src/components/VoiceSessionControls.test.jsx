import { act } from "react";
import { createRoot } from "react-dom/client";
import VoiceSessionControls from "./VoiceSessionControls";
import MicrophoneIndicator from "./MicrophoneIndicator";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("shows each real phase with an always accessible stop button", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const stop = jest.fn();
  try {
    for (const [phase, label] of Object.entries({
      idle: "Prêt", requesting: "Ouverture du microphone…",
      listening: "J’écoute…", transcribing: "Je transcris…",
      thinking: "Je traite votre demande…", preparing: "Je prépare la voix…", speaking: "Je réponds…",
    })) {
      await act(async () => root.render(<VoiceSessionControls phase={phase} message="Voix de secours active" onStop={stop} />));
      expect(host.querySelector('[role="status"]').textContent).toContain(label);
      expect(host.textContent).toContain("Voix de secours active");
      const button = host.querySelector("button");
      expect(button.type).toBe("button");
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
    }
    expect(stop).toHaveBeenCalledTimes(7);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("microphone indicator follows capture rather than the conversational phase", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<MicrophoneIndicator active={false} />));
    const dot = host.querySelector(".voice-microphone-dot");
    expect(dot.getAttribute("aria-label")).toBe("Microphone fermé");
    expect(dot.classList.contains("is-open")).toBe(false);
    await act(async () => root.render(<MicrophoneIndicator active />));
    expect(dot.getAttribute("aria-label")).toBe("Microphone ouvert");
    expect(dot.classList.contains("is-open")).toBe(true);
    expect(dot.getAttribute("title")).toBe("Microphone ouvert");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("Android exposes an optional local recognition test without changing desktop controls", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const change = jest.fn();
  try {
    await act(async () => root.render(<VoiceSessionControls phase="idle" onStop={() => {}} />));
    expect(host.querySelector("select")).toBeNull();
    await act(async () => root.render(
      <VoiceSessionControls phase="idle" onStop={() => {}} androidRecognition="server" onRecognitionChange={change} />
    ));
    const select = host.querySelector("select");
    expect(select.value).toBe("server");
    await act(async () => {
      select.value = "native";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(change).toHaveBeenCalledWith("native");
  } finally {
    await act(async () => root.unmount());
  }
});

test("stops on pointer down before a global pointer-up can send a buffered phrase", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const events = [];
  const released = () => events.push("release");
  window.addEventListener("pointerup", released, true);
  try {
    await act(async () => root.render(<VoiceSessionControls phase="listening" onStop={() => events.push("stop")} />));
    const button = host.querySelector("button");
    await act(async () => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(events).toEqual(["stop", "release"]);
  } finally {
    window.removeEventListener("pointerup", released, true);
    await act(async () => root.unmount());
    host.remove();
  }
});

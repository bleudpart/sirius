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
      idle: "Prêt", requesting: "Activation du micro…",
      checking: "Préparation…", verifying: "Un instant…",
      rejected: "Demande ignorée", error: "Dialogue vocal interrompu",
      listening: "J’écoute…", transcribing: "Un instant…",
      thinking: "Je traite votre demande…", preparing: "Un instant…", speaking: "Je réponds…",
    })) {
      await act(async () => root.render(<VoiceSessionControls phase={phase} message="Voix de secours active" onStop={stop} />));
      expect(host.querySelector('[role="status"]').textContent).toContain(label);
      expect(host.textContent).toContain("Voix de secours active");
      const button = host.querySelector("button");
      expect(button.type).toBe("button");
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
    }
    expect(stop).toHaveBeenCalledTimes(11);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("shows discreet, accessible verification indicators without technical commentary", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<VoiceSessionControls phase="verifying" onStop={() => {}} />));
    let indicator = host.querySelector('[data-testid="voice-validation"]');
    expect(indicator.dataset.state).toBe("checking");
    expect(indicator.getAttribute("aria-label")).toBe("Vérification de la voix en cours");
    expect(host.textContent).not.toMatch(/vérifi|transcri/i);

    await act(async () => root.render(<VoiceSessionControls phase="transcribing" voiceValidation="verified" onStop={() => {}} />));
    indicator = host.querySelector('[data-testid="voice-validation"]');
    expect(indicator.dataset.state).toBe("verified");
    expect(indicator.getAttribute("aria-label")).toBe("Voix vérifiée pour cette demande");
    expect(host.textContent).not.toMatch(/vérifi|transcri/i);

    await act(async () => root.render(<VoiceSessionControls phase="transcribing" onStop={() => {}} />));
    indicator = host.querySelector('[data-testid="voice-validation"]');
    expect(indicator.dataset.state).toBe("idle");
    expect(indicator.getAttribute("aria-label")).toBe("Aucune vérification de voix en cours");

    await act(async () => root.render(
      <VoiceSessionControls phase="error" message="Le service est indisponible : demande ignorée." onStop={() => {}} />,
    ));
    expect(host.querySelector('[data-testid="voice-validation"]').dataset.state).toBe("idle");
    expect(host.textContent).toContain("Le service est indisponible : demande ignorée.");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("announces a refused voice immediately with a specific label", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <VoiceSessionControls
        phase="rejected"
        message="Voix non reconnue : demande ignorée. Utilisez le bouton maintenu si nécessaire."
        voiceValidation="rejected"
        onStop={() => {}}
      />,
    ));
    const status = host.querySelector(".voice-session-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("assertive");
    expect(status.textContent).toContain("Voix non reconnue : demande ignorée. Utilisez le bouton maintenu si nécessaire.");
    expect(status.textContent.match(/Voix non reconnue/g)).toHaveLength(1);
    expect(status.querySelector(".voice-session-detail")).toBeNull();
    expect(host.querySelector('[data-testid="voice-validation"]').dataset.state).toBe("rejected");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("Android compact mode keeps the full refusal accessible and shows only a short label", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const message = "Voix non reconnue : demande ignorée. Utilisez le bouton maintenu si nécessaire.";
  try {
    await act(async () => root.render(<VoiceSessionControls phase="rejected" message={message} voiceValidation="rejected" compact onStop={() => {}} />));
    const label = host.querySelector(".voice-session-label > span");
    expect(label.textContent).toBe("Voix non reconnue : demande ignorée.");
    expect(label.getAttribute("aria-label")).toBe(message);
    expect(label.title).toBe(message);
    expect(host.querySelector('[data-testid="voice-validation"]').dataset.state).toBe("rejected");
    expect(host.querySelector(".voice-session-status").getAttribute("aria-live")).toBe("assertive");
    expect(host.querySelector(".voice-session-controls").hasAttribute("data-quiet")).toBe(false);
    await act(async () => root.render(<VoiceSessionControls phase="thinking" compact onStop={() => {}} />));
    expect(host.querySelector(".voice-session-label").textContent).toContain("Je traite…");
    await act(async () => root.render(<VoiceSessionControls phase="idle" compact onStop={() => {}} />));
    expect(host.querySelector(".voice-session-controls").dataset.quiet).toBe("true");
  } finally {
    await act(async () => root.unmount());
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

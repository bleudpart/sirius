import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { openKeys, sealKeys } from "./deviceKeyStore";
import AuthGate, { useAuth } from "./AuthGate";
import SiriusSetup from "./SiriusSetup";
import { hasSavedPersonalKeys, loadApiKeys, setKeyAccount } from "./apiKeyStorage";
import { applyVisualTheme, VISUAL_THEME_DEFAULTS } from "./theme";

jest.mock("./deviceKeyStore", () => ({
  sealKeys: jest.fn(async (keys) => ({ sealed: JSON.stringify(keys) })),
  openKeys: jest.fn(async (envelope) => JSON.parse(envelope.sealed)),
}));

jest.mock("./components/ReactorVisuals", () => ({
  CoreRings: () => null,
  ReactorCore: () => null,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  sealKeys.mockImplementation(async (keys) => ({ sealed: JSON.stringify(keys) }));
  openKeys.mockImplementation(async (envelope) => JSON.parse(envelope.sealed));
});

test("la configuration propose AÈDES et conserve son préréglage conteur", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const saved = localStorage.getItem("sirius_voice");
  try {
    await act(async () => root.render(<SiriusSetup initialProfile={{ name: "Local" }}
      onComplete={jest.fn()} onCancel={jest.fn()} />));
    await act(async () => container.querySelector('[data-testid="setup-tab-voix"]').click());
    await act(async () => container.querySelector('[data-testid="setup-voice-preset-aedes"]').click());
    expect(JSON.parse(localStorage.getItem("sirius_voice"))).toEqual({ name: "browser-aedes", rate: 0.9, pitch: 0.94 });
    expect(container.querySelector('[data-testid="setup-voice-name"]').value).toBe("browser-aedes");
    expect(container.querySelector('[data-testid="setup-voice-preset-aedes"]').textContent).toContain("ACTIVE");
  } finally {
    await act(async () => root.unmount());
    if (saved === null) localStorage.removeItem("sirius_voice");
    else localStorage.setItem("sirius_voice", saved);
  }
});

test("le préréglage Gemini est explicite, sauvegardé et ne propose pas la hauteur Google", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const saved = localStorage.getItem("sirius_voice");
  try {
    await act(async () => root.render(<SiriusSetup initialTab="voix" onComplete={jest.fn()} onCancel={jest.fn()} />));
    await act(async () => host.querySelector('[data-testid="setup-voice-preset-gemini"]').click());
    expect(JSON.parse(localStorage.getItem("sirius_voice"))).toEqual({ name: "gemini", rate: 1, pitch: 0 });
    expect(host.querySelector('[data-testid="setup-voice-pitch"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-voice-rate"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-voice-name"]').value).toBe("gemini");
  } finally {
    await act(async () => root.unmount());
    if (saved === null) localStorage.removeItem("sirius_voice");
    else localStorage.setItem("sirius_voice", saved);
  }
});

test("la configuration sélectionne le microphone et ne demande l’accès qu’après action", async () => {
  const savedDevice = localStorage.getItem("sirius_microphone_device");
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const stop = jest.fn();
  const devices = [
    { kind: "audioinput", deviceId: "usb-1", label: "Micro USB" },
    { kind: "audioinput", deviceId: "built-in-1", label: "Micro intégré" },
  ];
  const mediaDevices = {
    enumerateDevices: jest.fn().mockResolvedValue(devices),
    getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
  };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: mediaDevices });
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SiriusSetup initialTab="voix" onComplete={jest.fn()} onCancel={jest.fn()} />));
    const select = host.querySelector('[data-testid="setup-microphone-device"]');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Microphone par défaut de l’appareil", "Micro USB", "Micro intégré",
    ]);
    expect(mediaDevices.getUserMedia).not.toHaveBeenCalled();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "usb-1");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(localStorage.getItem("sirius_microphone_device")).toBe("usb-1");
    await act(async () => host.querySelector('[data-testid="setup-microphone-detect"]').click());
    expect(mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("2 microphones disponibles");
  } finally {
    await act(async () => root.unmount());
    if (savedDevice === null) localStorage.removeItem("sirius_microphone_device");
    else localStorage.setItem("sirius_microphone_device", savedDevice);
    if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
    else delete navigator.mediaDevices;
  }
});

test("les outils audio Diagnostic s’activent depuis la configuration Android", async () => {
  const { Capacitor } = require("@capacitor/core");
  const platform = jest.spyOn(Capacitor, "getPlatform").mockReturnValue("android");
  const listener = jest.fn();
  window.addEventListener("sirius-audio-diagnostics-changed", listener);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SiriusSetup initialTab="voix" onComplete={jest.fn()} onCancel={jest.fn()} />));
    const toggle = host.querySelector('[data-testid="setup-audio-diagnostics"]');
    expect(toggle.checked).toBe(false);
    await act(async () => toggle.click());
    expect(localStorage.getItem("sirius_show_audio_diagnostics")).toBe("1");
    expect(listener.mock.calls.at(-1)[0].detail).toEqual({ enabled: true });
    await act(async () => toggle.click());
    expect(localStorage.getItem("sirius_show_audio_diagnostics")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    window.removeEventListener("sirius-audio-diagnostics-changed", listener);
    localStorage.removeItem("sirius_show_audio_diagnostics");
    platform.mockRestore();
  }
});

test("le réglage audio Diagnostic n’apparaît pas hors Android", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SiriusSetup initialTab="voix" onComplete={jest.fn()} onCancel={jest.fn()} />));
    expect(host.querySelector('[data-testid="setup-audio-diagnostics"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

test("les choix de couleurs du HUD sont immédiatement appliqués et enregistrés", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const savedTheme = localStorage.getItem("sirius_visual_theme");
  try {
    await act(async () => root.render(<SiriusSetup initialTab="hud" onComplete={jest.fn()} onCancel={jest.fn()} />));
    const color = host.querySelector('[data-testid="setup-theme-cyan"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(color, "#ff8800");
      color.dispatchEvent(new Event("input", { bubbles: true }));
      color.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(JSON.parse(localStorage.getItem("sirius_visual_theme")).cyan).toBe("#ff8800");
    expect(document.documentElement.style.getPropertyValue("--sirius-cyan")).toBe("#ff8800");
    expect(host.querySelector(".setup-theme-preview").style.getPropertyValue("--preview-cyan")).toBe("#ff8800");
  } finally {
    await act(async () => root.unmount());
    if (savedTheme === null) localStorage.removeItem("sirius_visual_theme");
    else localStorage.setItem("sirius_visual_theme", savedTheme);
    applyVisualTheme(savedTheme === null ? VISUAL_THEME_DEFAULTS : JSON.parse(savedTheme));
  }
});

test.each(["browser-female", "browser", "browser-aedes"])("la hauteur grave ou aiguë de %s est réglable et sauvegardée", async (name) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const saved = localStorage.getItem("sirius_voice");
  localStorage.setItem("sirius_voice", JSON.stringify({ name, rate: 1, pitch: 1 }));
  try {
    await act(async () => root.render(<SiriusSetup initialTab="voix" initialProfile={{ name: "Local" }}
      onComplete={jest.fn()} onCancel={jest.fn()} />));
    const slider = container.querySelector('[data-testid="setup-voice-pitch"]');
    expect(slider.min).toBe("0.5");
    expect(slider.max).toBe("2");
    for (const pitch of ["0.65", "1.65"]) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, pitch);
        slider.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(JSON.parse(localStorage.getItem("sirius_voice")).pitch).toBe(Number(pitch));
    }
  } finally {
    await act(async () => root.unmount());
    if (saved === null) localStorage.removeItem("sirius_voice");
    else localStorage.setItem("sirius_voice", saved);
  }
});

test("la configuration distingue Cerebras rapide, Groq vocal et Kimi réflexion", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ services: [] }) });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SiriusSetup initialTab="api"
      initialKeys={{ cerebras: "fake-cerebras", groq_key: "fake-groq" }}
      onComplete={jest.fn()} onCancel={jest.fn()} />));
    expect(container.querySelector('[data-testid="setup-key-cerebras"]').value).toBe("fake-cerebras");
    expect(container.querySelector('[data-testid="setup-key-groq_key"]').value).toBe("fake-groq");
    expect(container.textContent).toContain("gpt-oss-120b");
    expect(container.textContent).toContain("transcription et repli IA");
  } finally {
    await act(async () => root.unmount());
    global.fetch = originalFetch;
  }
});

test("Cerebras est prêt à configurer sans clé et sans empêcher Groq", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ services: [] }) });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<SiriusSetup initialTab="api"
      initialKeys={{ groq_key: "fake-groq" }}
      onComplete={jest.fn()} onCancel={jest.fn()} />));
    const cerebras = container.querySelector('[data-testid="setup-key-cerebras"]');
    expect(cerebras.value).toBe("");
    expect(cerebras.required).toBe(false);
    expect(cerebras.placeholder).toBe("Votre future clé API Cerebras");
    expect(container.textContent).toContain("laissez ce champ vide");
    expect(container.querySelector('[data-testid="setup-key-groq_key"]').value).toBe("fake-groq");
  } finally {
    await act(async () => root.unmount());
    global.fetch = originalFetch;
  }
});

function SettingsHarness() {
  const { openProfile } = useAuth();
  const [showSetup, setShowSetup] = useState(true);
  return showSetup ? (
    <SiriusSetup
      initialProfile={{ name: "Test Google Play" }}
      onCancel={() => setShowSetup(false)}
      onComplete={jest.fn()}
      onOpenAccount={() => {
        setShowSetup(false);
        openProfile();
      }}
    />
  ) : <div>HUD</div>;
}

test("settings opens the authenticated account and logout returns to login without deleting data", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const user = {
    email: "reviewer@example.test",
    name: "Test Google Play",
    role: "user",
    preferences: {},
  };
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => user });
  try {
    await act(async () => root.render(<AuthGate><SettingsHarness /></AuthGate>));
    const button = container.querySelector('[data-testid="setup-account-btn"]');
    expect(button.type).toBe("button");
    expect(container.querySelector('[data-testid="setup-name"]').value).toBe(user.name);
    act(() => button.click());
    expect(container.querySelector('[data-testid="sirius-setup"]')).toBeNull();
    expect(container.textContent).toContain(user.email);
    expect(container.querySelector('[data-testid="profile-delete-btn"]')).not.toBeNull();
    const logout = container.querySelector('[data-testid="profile-logout-btn"]');
    expect(logout).not.toBeNull();
    await act(async () => logout.click());
    expect(container.querySelector('[data-testid="profile-logout-btn"]')).toBeNull();
    expect(container.textContent).toContain("SE CONNECTER");
    const requestedUrls = global.fetch.mock.calls.map(([url]) => url);
    expect(requestedUrls.some((url) => url.endsWith("/api/auth/logout"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("deletion"))).toBe(false);
  } finally {
    act(() => root.unmount());
    global.fetch = originalFetch;
  }
});

test("update check follows the download until the installer is ready", async () => {
  jest.useFakeTimers();
  const container = document.createElement("div");
  const root = createRoot(container);
  const states = [
    { phase: "downloading", version: "1.0.32", percent: 40 },
    { phase: "ready", version: "1.0.32", percent: 100 },
  ];
  window.siriusUpdates = {
    check: jest.fn().mockResolvedValue({ ok: true, available: true, phase: "downloading", version: "1.0.32", percent: 5 }),
    status: jest.fn().mockImplementation(async () => states.shift()),
  };
  try {
    act(() => root.render(<SiriusSetup initialProfile={{ name: "Local" }} onComplete={jest.fn()} onCancel={jest.fn()} />));
    await act(async () => container.querySelector('[data-testid="setup-check-update"]').click());
    const status = () => container.querySelector('[data-testid="setup-update-status"]').textContent;
    expect(status()).toBe("Nouvelle version 1.0.32 en téléchargement… 5 %");
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(status()).toBe("Nouvelle version 1.0.32 en téléchargement… 40 %");
    const bar = () => container.querySelector('[data-testid="setup-update-progress"]');
    expect(bar().getAttribute("aria-valuenow")).toBe("40");
    expect(bar().firstChild.style.width).toBe("40%");
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(status()).toBe("Mise à jour 1.0.32 prête — fermez SIRIUS pour l'installer.");
    expect(bar().className).toContain("is-ready");
    expect(bar().firstChild.style.width).toBe("100%");
    await act(async () => { jest.advanceTimersByTime(3000); });
    expect(window.siriusUpdates.status).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
    delete window.siriusUpdates;
    jest.useRealTimers();
  }
});

test("settings without account access preserves preferences and does not offer a dead account button", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<SiriusSetup initialProfile={{ name: "Local" }} onComplete={jest.fn()} onCancel={jest.fn()} />));
    expect(container.querySelector('[data-testid="setup-account-btn"]')).toBeNull();
    expect(container.querySelector('[data-testid="setup-name"]').value).toBe("Local");
    act(() => container.querySelector('[data-testid="setup-tab-voix"]').click());
    expect(container.querySelector('[data-testid="setup-tab-voix"]').className).toContain("active");
  } finally {
    act(() => root.unmount());
  }
});

test("services tab distinguishes the trial from a personal encrypted vault", async () => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: async () => ({
      mode: "trial_then_personal", role: "user",
      trial: { state: "active", expires_at: "2026-10-17T00:00:00Z" },
      services: [{ id: "chat", label: "Réponses IA", state: "configured", scope: "Présence, pas test du modèle." }],
      quotas: { enabled: true, limits: { chat: 150 }, usage: { chat: 2 } },
    }),
  }));
  try {
    await act(async () => root.render(
      <SiriusSetup initialProfile={{ name: "Daniel" }} onCancel={jest.fn()} onComplete={jest.fn()} />,
    ));
    const apiTab = container.querySelector('[data-testid="setup-tab-api"]');
    expect(apiTab.textContent).toContain("CLÉS API ET SERVICES");
    const apiButton = container.querySelector('[data-testid="setup-api-btn"]');
    expect(apiButton.type).toBe("button");
    expect(apiButton.textContent).toContain("GÉRER MES CLÉS API");
    await act(async () => apiButton.click());
    expect(apiTab.className).toContain("active");
    const guide = container.querySelector('[data-testid="setup-api-guide"]');
    expect(guide).not.toBeNull();
    expect(guide.querySelectorAll('a[href^="https://"]')).toHaveLength(9);
    expect(guide.querySelectorAll('[data-testid^="setup-guide-"]')).toHaveLength(9);
    expect(guide.textContent).toContain("La mémoire locale de ΣIRIUS ne nécessite pas de clé API");
    expect(guide.textContent).toContain("Enregistrer vos clés");
    expect(guide.textContent).toContain("Maps JavaScript API");
    expect(guide.textContent).toContain("Cloud Text-to-Speech API");
    expect(container.querySelector('[data-testid="setup-trial"]').textContent).toContain("Essai actif");
    expect(container.querySelector('[data-testid="vault-controls"]').textContent).toContain("Mes clés personnelles");
    expect(container.querySelector('[data-testid="setup-account-quotas"]').textContent).toContain("2 / 150");
    expect(container.textContent).not.toContain("Voix : opérationnelle");
    await act(async () => container.querySelector('[data-testid="setup-tab-profil"]').click());
    await act(async () => apiTab.click());
    expect(container.querySelector('[data-testid="vault-controls"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    global.fetch = originalFetch;
  }
});

test.each(["unverifiable", "refused"])("saving a %s fal key never declares it validated", async (status) => {
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  setKeyAccount("fal-check");
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: async () => String(url).endsWith("/keys/validate")
      ? { ok: false, status, message: status === "unverifiable" ? "Clé fal.ai non vérifiable." : "Clé refusée." }
      : { mode: "trial_then_personal", services: [], trial: { state: "expired" }, quotas: { enabled: false } },
  }));
  try {
    await act(async () => root.render(
      <SiriusSetup initialProfile={{ name: "Test" }} initialKeys={{ fal: "personal-fal-test" }}
        initialTab="api" onComplete={jest.fn()} onCancel={jest.fn()} />,
    ));

    expect(container.querySelector('[data-testid="vault-save"]')).toBeNull();
    await act(async () => {
      container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(loadApiKeys()).toEqual({});
    if (status === "unverifiable") {
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Clé fal.ai"));
      expect(container.textContent).toContain("Enregistrement annulé");
    } else {
      expect(confirm).not.toHaveBeenCalled();
      expect(container.querySelector('[role="alert"]').textContent).toContain("vérification non réussie");
    }
  } finally {
    act(() => root.unmount()); setKeyAccount(""); confirm.mockRestore(); global.fetch = originalFetch;
  }
});

test("ENREGISTRER saves changed keys on the device automatically", async () => {
  jest.useFakeTimers();
  const originalFetch = global.fetch;
  const container = document.createElement("div");
  const root = createRoot(container);
  const onComplete = jest.fn();
  setKeyAccount("maps-auto-save");
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
  global.fetch = jest.fn((url) => Promise.resolve({
    ok: true,
    json: async () => String(url).endsWith("/keys/validate")
      ? { ok: false, status: "unverifiable", message: "Clé de carte utilisée dans le navigateur." }
      : { mode: "trial_then_personal", services: [], trial: { state: "expired" }, quotas: { enabled: false } },
  }));
  try {
    await act(async () => root.render(
      <SiriusSetup initialProfile={{ name: "Test" }} initialKeys={{ gmaps: "test-maps-key" }}
        initialTab="api" onComplete={onComplete} onCancel={jest.fn()} />,
    ));
    await act(async () => {
      container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Clé Google Maps"));
    expect(hasSavedPersonalKeys()).toBe(true);
    expect(loadApiKeys().gmaps).toBe("test-maps-key");
    await act(async () => jest.advanceTimersByTime(850));
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ name: "Test" }), expect.objectContaining({ gmaps: "test-maps-key" }));
  } finally {
    act(() => root.unmount());
    localStorage.removeItem("sirius_device_keys_v1:maps-auto-save");
    setKeyAccount("");
    confirm.mockRestore();
    global.fetch = originalFetch;
    jest.useRealTimers();
  }
});
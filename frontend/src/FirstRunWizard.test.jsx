import React, { act } from "react";
import { createRoot } from "react-dom/client";
import FirstRunWizard, { detectBrain } from "./FirstRunWizard";
import { API_BASE_URL } from "@/lib/api";
import { lockApiKeys } from "./apiKeyStorage";
import { speakFr } from "./voice";

jest.mock("./voice", () => ({ speakFr: jest.fn((text, options) => options.onend()) }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });
let container;
let root;
let originalFetch;

beforeEach(() => {
  lockApiKeys();
  speakFr.mockImplementation((text, options) => options.onend());
  originalFetch = global.fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  global.fetch = originalFetch;
});

const $ = (id) => container.querySelector(`[data-testid="${id}"]`);
const render = async (props) => {
  await act(async () => root.render(<FirstRunWizard onComplete={jest.fn()} {...props} />));
};
const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const setup = (overrides = {}) => ({
  mode: "trial_then_personal", role: "user", trial: { state: "active", expires_at: "2026-10-17T00:00:00Z" },
  services: [{ id: "chat", label: "IA", state: "configured" }],
  cloud: { available: false, linked: false }, ...overrides,
});

test("server health alone is never evidence of an operational model", async () => {
  const fetchImpl = jest.fn(() => json(404, {}));
  const result = await detectBrain(fetchImpl);
  expect(result.state).toBe("down");
  expect(fetchImpl).toHaveBeenCalledWith(`${API_BASE_URL}/setup/status`, expect.objectContaining({
    credentials: "include", signal: expect.any(AbortSignal),
  }));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("configured provider is not reported as tested", async () => {
  const fetchImpl = () => json(200, setup());
  expect(await detectBrain(fetchImpl)).toMatchObject({ state: "configured", via: "server" });
});

test("an unlinked PC links its Cloud account, then the user reaches the HUD", async () => {
  global.fetch = jest.fn((url, options = {}) => {
    if (url.endsWith("/setup/status")) return json(200, setup({
      services: linked ? [{ id: "chat", state: "available" }] : [{ id: "chat", state: "not_configured" }],
      cloud: { available: true, linked, email: "d@example.test" },
    }));
    if (url.endsWith("/cloud/link")) {
      const body = JSON.parse(options.body);
      if (body.password === "bon") { linked = true; return json(200, { linked: true, email: body.email }); }
      return json(401, { detail: "Email ou mot de passe incorrect." });
    }
    return json(404, {});
  });
  let linked = false;
  const onComplete = jest.fn();
  await render({ userName: "Daniel", userEmail: "d@example.test", keys: { groq_key: "" }, onComplete });

  expect($("fw-link-form")).not.toBeNull();
  expect($("fw-link-email").value).toBe("d@example.test");
  type($("fw-link-password"), "faux");
  await act(async () => $("fw-link-submit").click());
  expect($("fw-link-error").textContent).toBe("Email ou mot de passe incorrect.");

  type($("fw-link-password"), "bon");
  await act(async () => $("fw-link-submit").click());
  expect($("fw-brain-ok").textContent).toContain("test IA proposé");

  act(() => $("fw-next-brain").click());
  act(() => $("fw-next-mic").click());
  expect($("fw-name").value).toBe("Daniel");
  act(() => $("fw-finish").click());
  expect(onComplete).toHaveBeenCalledWith({ name: "Daniel" }, {});
});

test("the microphone test shows what SIRIUS heard", async () => {
  global.fetch = jest.fn((url) => {
    if (url.endsWith("/setup/status")) return json(200, setup());
    if (url.endsWith("/stt")) return json(200, { text: "Bonjour SIRIUS" });
    return json(404, {});
  });
  const record = jest.fn().mockResolvedValue(new Blob(["audio"]));
  await render({ record });
  act(() => $("fw-next-brain").click());
  await act(async () => $("fw-mic-test").click());
  expect(record).toHaveBeenCalled();
  expect($("fw-mic-ok").textContent).toContain("Bonjour SIRIUS");
  const sttCall = global.fetch.mock.calls.find(([url]) => url.endsWith("/stt"));
  expect(sttCall[1].body.get("file")).toBeTruthy();
});

test("a denied microphone explains how to fix it and can be skipped", async () => {
  global.fetch = jest.fn((url) => (url.endsWith("/setup/status") ? json(200, setup()) : json(404, {})));
  const record = jest.fn().mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  await render({ record });
  act(() => $("fw-next-brain").click());
  await act(async () => $("fw-mic-test").click());
  expect($("fw-mic-error").textContent).toContain("Autorisez-le");
  expect($("fw-next-mic").textContent).toBe("Passer");
});

test("expert mode hands over to the full settings screen", async () => {
  global.fetch = jest.fn(() => json(200, setup()));
  const onExpert = jest.fn();
  await render({ onExpert });
  act(() => $("fw-expert").click());
  expect(onExpert).toHaveBeenCalled();
});

test("the final summary does not claim untested AI or audible voice", async () => {
  global.fetch = jest.fn(() => json(200, setup()));
  await render({});
  act(() => $("fw-next-brain").click());
  act(() => $("fw-next-mic").click());
  expect($("fw-ready").textContent).toContain("Réponse IA : non vérifiée");
  expect($("fw-ready").textContent).toContain("Voix : non vérifiée");
});

test("actual IA confirmation and user-confirmed audio are recorded separately", async () => {
  global.fetch = jest.fn((url) => json(200, url.endsWith("/setup/test-chat")
    ? { ok: true, provider: "Groq" } : setup()));
  await render({});
  await act(async () => $("fw-chat-test").click());
  expect($("fw-chat-ok").textContent).toContain("Groq");
  act(() => $("fw-next-brain").click());
  act(() => $("fw-voice-test").click());
  act(() => $("fw-voice-heard").click());
  act(() => $("fw-next-mic").click());
  expect($("fw-ready").textContent).toContain("Réponse IA : test réussi");
  expect($("fw-ready").textContent).toContain("audible, confirmée par vous");
});

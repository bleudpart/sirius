import React, { act } from "react";
import { createRoot } from "react-dom/client";
import FirstRunWizard, { detectBrain } from "./FirstRunWizard";
import { API_BASE_URL } from "@/lib/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });
let container;
let root;
let originalFetch;

beforeEach(() => {
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

test("a cloud server without relay is reported ready through /health", async () => {
  const fetchImpl = jest.fn((url) => (url.endsWith("/cloud/status") ? json(404, {}) : json(200, { ok: true })));
  await expect(detectBrain(fetchImpl)).resolves.toEqual({ state: "ready", via: "server" });
  expect(fetchImpl).toHaveBeenCalledWith(`${API_BASE_URL}/health`);
});

test("a PC with its own keys does not ask for a Cloud account", async () => {
  const fetchImpl = () => json(200, { available: true, linked: false, local_brain: true });
  await expect(detectBrain(fetchImpl)).resolves.toEqual({ state: "ready", via: "local" });
});

test("an unlinked PC links its Cloud account, then the user reaches the HUD", async () => {
  global.fetch = jest.fn((url, options = {}) => {
    if (url.endsWith("/cloud/status")) return json(200, { available: true, linked: false, local_brain: false });
    if (url.endsWith("/cloud/link")) {
      const body = JSON.parse(options.body);
      return body.password === "bon"
        ? json(200, { available: true, linked: true, email: body.email })
        : json(401, { detail: "Email ou mot de passe incorrect." });
    }
    return json(404, {});
  });
  const onComplete = jest.fn();
  await render({ userName: "Daniel", userEmail: "d@example.test", keys: { groq_key: "" }, onComplete });

  expect($("fw-link-form")).not.toBeNull();
  expect($("fw-link-email").value).toBe("d@example.test");
  type($("fw-link-password"), "faux");
  await act(async () => $("fw-link-submit").click());
  expect($("fw-link-error").textContent).toBe("Email ou mot de passe incorrect.");

  type($("fw-link-password"), "bon");
  await act(async () => $("fw-link-submit").click());
  expect($("fw-brain-ok").textContent).toContain("d@example.test");

  act(() => $("fw-next-brain").click());
  act(() => $("fw-next-mic").click());
  expect($("fw-name").value).toBe("Daniel");
  act(() => $("fw-finish").click());
  expect(onComplete).toHaveBeenCalledWith({ name: "Daniel" }, { groq_key: "" });
});

test("the microphone test shows what SIRIUS heard", async () => {
  global.fetch = jest.fn((url) => {
    if (url.endsWith("/cloud/status")) return json(404, {});
    if (url.endsWith("/health")) return json(200, {});
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
  global.fetch = jest.fn((url) => (url.endsWith("/health") ? json(200, {}) : json(404, {})));
  const record = jest.fn().mockRejectedValue(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  await render({ record });
  act(() => $("fw-next-brain").click());
  await act(async () => $("fw-mic-test").click());
  expect($("fw-mic-error").textContent).toContain("Autorisez-le");
  expect($("fw-next-mic").textContent).toBe("Passer");
});

test("expert mode hands over to the full settings screen", async () => {
  global.fetch = jest.fn(() => json(200, { available: true, linked: false, local_brain: false }));
  const onExpert = jest.fn();
  await render({ onExpert });
  act(() => $("fw-expert").click());
  expect(onExpert).toHaveBeenCalled();
});

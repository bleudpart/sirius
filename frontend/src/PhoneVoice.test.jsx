import { act } from "react";
import { createRoot } from "react-dom/client";
import PhoneVoice from "./PhoneVoice";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, prepare, originalFetch;
const data = (settings = {}, items = []) => ({
  settings: { configured: true, inbound_enabled: false, allowed_numbers: ["+33123456789"], blueprint: {}, ...settings },
  history: { items },
});
const respond = (body, ok = true) => ({ ok, json: async () => body });
const render = (props = {}) => act(async () => root.render(<PhoneVoice onPrepare={prepare} {...props} />));
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const click = (text) => act(async () => button(text).click());
const fill = (element, value) => {
  const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element.dispatchEvent(new Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
};
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  prepare = jest.fn(); originalFetch = global.fetch; global.fetch = jest.fn().mockResolvedValue(respond(data()));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); global.fetch = originalFetch;
});

test("aucun réseau au montage, aucun appel sortant lors de la préparation", async () => {
  await render();
  expect(global.fetch).not.toHaveBeenCalled();
  await click("Charger");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].method).toBe("GET");
  expect(button("Préparer cet appel").disabled).toBe(true);
  await act(async () => {
    fill(host.querySelector("select"), "+33123456789");
    fill(host.querySelector("textarea"), "Demander les horaires");
    host.querySelector('input[type="checkbox"]').click();
  });
  await click("Préparer cet appel");
  expect(prepare).toHaveBeenCalledWith({
    title: "Appeler +33123456789", steps: [{
      id: "appel", action: "phone.dial", inputs: {
        number: "+33123456789", objective: "Demander les horaires", recipient_consent: true,
      },
    }],
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("aucun appel effectué");
  expect(host.textContent).toContain("pas un plafond financier garanti");
});

test("configuration absente verrouille les mutations et affiche la raison", async () => {
  global.fetch.mockResolvedValue(respond(data({ configured: false })));
  await render(); await click("Charger");
  expect(host.querySelector("fieldset").disabled).toBe(true);
  expect(button("Autoriser les appels").disabled).toBe(true);
  expect(host.textContent).toContain("configuration serveur incomplète");
});

test("opt-in entrant est une action distincte, jamais un POST de composition", async () => {
  global.fetch.mockResolvedValueOnce(respond(data()))
    .mockResolvedValueOnce(respond({}))
    .mockResolvedValueOnce(respond(data({ inbound_enabled: true })));
  await render(); await click("Charger"); await click("Autoriser les appels");
  const call = global.fetch.mock.calls[1];
  expect(call[0]).toMatch(/\/ariane\/phone\/inbound$/);
  expect(call[1].method).toBe("PUT");
  expect(JSON.parse(call[1].body)).toEqual({ enabled: true });
  expect(button("Désactiver les appels")).toBeTruthy();
  expect(global.fetch.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(0);
});

test("audit en lecture seule : suivi sans préparation, opt-in ni raccrochage", async () => {
  global.fetch.mockResolvedValue(respond(data({}, [{ id: "one", state: "queued", direction: "outbound" }])));
  await render({ auditOnly: true }); await click("Charger");
  expect(host.querySelector("select")).toBeNull();
  expect(button("raccrochage")).toBeUndefined();
  expect(button("Autoriser les appels")).toBeUndefined();
  expect(host.textContent).toContain("queued");
});

test("raccrochage affiche demandé sans annoncer une fin d'appel", async () => {
  const overview = data({}, [{ id: "one", state: "in-progress", direction: "outbound" }]);
  global.fetch.mockResolvedValueOnce(respond(overview))
    .mockResolvedValueOnce(respond({ state: "STOP_REQUESTED", message: "Raccrochage demandé ; attendre Vapi." }))
    .mockResolvedValueOnce(respond(overview));
  await render(); await click("Charger"); await click("Demander le raccrochage");
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/phone\/one\/stop$/);
  expect(global.fetch.mock.calls[1][1].method).toBe("POST");
  expect(host.textContent).toContain("Raccrochage demandé");
  expect(host.textContent).toContain("in-progress");
});

test("refus et résultats incertains restent visibles sans nouvelle tentative", async () => {
  global.fetch.mockResolvedValue(respond({ detail: "Cette ligne n'est pas liée à votre compte." }, false));
  await render(); await click("Charger");
  expect(host.querySelector('[role="alert"]').textContent).toContain("pas liée");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  global.fetch.mockRejectedValue(Object.assign(new Error("timeout"), { name: "AbortError" }));
  await click("Charger");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Résultat non confirmé");
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("démontage annule la lecture en attente sans mutation", async () => {
  let signal;
  global.fetch.mockImplementation((url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort",
      () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  });
  await render();
  act(() => button("Charger").click());
  expect(signal.aborted).toBe(false);
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

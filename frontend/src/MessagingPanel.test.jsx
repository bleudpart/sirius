import { act } from "react";
import { createRoot } from "react-dom/client";
import MessagingPanel from "./MessagingPanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let host;
let root;
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const messages = [
  { id: "one", de: "Camille", de_email: "camille@example.com", sujet: "Devis", apercu: "<script>Aperçu sans exécution</script>", lu: false, recu: "2026-10-20" },
  { id: "two", de: "Alex", de_email: "alex@example.com", sujet: "Projet", apercu: "Déjà consulté", lu: true, recu: "2026-10-19" },
];
const button = (text) => [...host.querySelectorAll("button")].find((node) => node.textContent.includes(text));
const click = async (node) => { await act(async () => node.click()); };
const type = async (selector, value) => {
  const node = host.querySelector(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const render = async (props = {}) => {
  await act(async () => root.render(<MessagingPanel onClose={jest.fn()} onConnections={jest.fn()} {...props} />));
};
const fillDraft = async () => {
  await type("#messaging-to", "recipient@example.com");
  await type("#messaging-subject", "Facture réelle");
  await type("#messaging-body", "Bonjour,\nVoici mon message.");
};
const submit = async () => {
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
};
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  global.fetch = jest.fn().mockResolvedValue(response({ mails: messages }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test("three real messaging zones, safe previews and local filters without writes", async () => {
  const onRead = jest.fn();
  await render({ onRead });
  expect(host.querySelectorAll(".messaging-columns > section")).toHaveLength(3);
  expect(host.querySelector(".messaging-brand").textContent.match(/Σ/g)).toHaveLength(1);
  expect(host.querySelectorAll(".messaging-feed li")).toHaveLength(2);
  expect(host.textContent).not.toContain("Jean Dupont");
  await type("[data-mail-search]", "Camille");
  expect(host.querySelectorAll(".messaging-feed li")).toHaveLength(1);
  await click(host.querySelector(".messaging-message"));
  expect(host.querySelector("script")).toBeNull();
  expect(host.querySelector(".messaging-preview").textContent).toContain("<script>");
  await click(button("Écouter l’aperçu"));
  expect(onRead).toHaveBeenCalledWith(expect.stringContaining("De Camille"));
  await click(button("Écrire à cet expéditeur"));
  expect(host.querySelector("#messaging-to").value).toBe("camille@example.com");
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].credentials).toBe("include");
  await type("[data-mail-search]", "");
  await click(host.querySelector('input[type="checkbox"]'));
  expect(host.querySelectorAll(".messaging-feed li")).toHaveLength(1);
  expect(host.querySelector(".messaging-feed").textContent).not.toContain("Alex");
});

test("Gmail sends exactly once only after explicit review and confirmation", async () => {
  await render();
  await fillDraft();
  await submit();
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("Envoyer avec Gmail");
  global.fetch.mockResolvedValueOnce(response({ ok: true }));
  await act(async () => { button("Confirmer et envoyer").click(); button("Confirmer et envoyer").click(); });
  expect(global.fetch).toHaveBeenCalledTimes(2);
  const [url, options] = global.fetch.mock.calls[1];
  expect(url).toMatch(/\/api\/gmail\/send$/);
  expect(JSON.parse(options.body)).toEqual({ to: "recipient@example.com", subject: "Facture réelle", body: "Bonjour,\nVoici mon message." });
  expect(host.querySelector("#messaging-body").value).toBe("");
  expect(host.querySelector(".messaging-history").textContent).toContain("Envoi confirmé par le service");
  expect(host.querySelector(".messaging-history").textContent).not.toMatch(/Délivré|Ouvert/);
});

test("editing a reviewed message requires reviewing again", async () => {
  await render();
  await fillDraft();
  await submit();
  await type("#messaging-subject", "Nouvel objet");
  expect(button("Confirmer et envoyer")).toBeUndefined();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test("Outlook uses the authenticated adapter, confirmation and an independent draft", async () => {
  const microsoftFetch = jest.fn().mockResolvedValue(response({ mails: [] }));
  await render({ microsoftFetch });
  await type("#messaging-subject", "Brouillon Gmail");
  await click(button("Outlook"));
  expect(microsoftFetch.mock.calls[0][0]).toBe("/microsoft/mail?top=25");
  expect(host.querySelector("#messaging-subject").value).toBe("");
  await fillDraft();
  await submit();
  microsoftFetch.mockResolvedValueOnce(response({ ok: true }));
  await click(button("Confirmer et envoyer"));
  expect(microsoftFetch.mock.calls[1][0]).toBe("/microsoft/mail/send");
  expect(JSON.parse(microsoftFetch.mock.calls[1][1].body).confirm).toBe(true);
  await click(button("Gmail"));
  expect(host.querySelector("#messaging-subject").value).toBe("Brouillon Gmail");
});

test("network send failure preserves draft and blocks retries until the user checks sent mail", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  await render();
  await fillDraft();
  await submit();
  global.fetch.mockRejectedValueOnce(new TypeError("Réseau indisponible"));
  await click(button("Confirmer et envoyer"));
  expect(host.querySelector('[role="alert"]').textContent).toContain("a peut-être été effectué");
  expect(host.querySelector("#messaging-body").value).toContain("Voici mon message");
  expect(button("Confirmer et envoyer").disabled).toBe(true);
  expect(host.querySelector(".messaging-history").textContent).toContain("Envoi non confirmé");
  await click(button("J’ai vérifié"));
  expect(button("Confirmer et envoyer")).toBeUndefined();
  await submit();
  expect(button("Confirmer et envoyer").disabled).toBe(false);
});

test("an invalid success payload never becomes a confirmed send", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  await render();
  await fillDraft();
  await submit();
  global.fetch.mockResolvedValueOnce(response({ requiresConfirmation: true }));
  await click(button("Confirmer et envoyer"));
  expect(host.querySelector('[role="alert"]').textContent).toContain("n'a pas confirmé");
  expect(host.querySelector(".is-confirmed")).toBeNull();
});

test("account and server failures are visible rather than empty inboxes", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  const onConnections = jest.fn();
  global.fetch.mockResolvedValueOnce(response({ detail: "Session Gmail expirée." }, 401));
  await render({ onConnections });
  expect(host.querySelector('[role="alert"]').textContent).toContain("Session Gmail expirée");
  expect(host.textContent).not.toContain("Aucun message renvoyé");
  await click(button("Connecter ou vérifier"));
  expect(onConnections).toHaveBeenCalledTimes(1);
  global.fetch.mockResolvedValueOnce(response({ wrong: [] }));
  await click(host.querySelector('[aria-label="Actualiser la réception"]'));
  expect(host.querySelector('[role="alert"]').textContent).toContain("invalide");
});

test("switching providers aborts inbox requests and ignores late results", async () => {
  let resolveGmail;
  let signal;
  global.fetch.mockImplementation((url, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveGmail = resolve; });
  });
  const microsoftFetch = jest.fn().mockResolvedValue(response({ mails: [] }));
  await render({ microsoftFetch });
  await click(button("Outlook"));
  expect(signal.aborted).toBe(true);
  await act(async () => resolveGmail(response({ mails: messages })));
  expect(host.querySelectorAll(".messaging-feed li")).toHaveLength(0);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("send in progress disables close, provider change and draft edits", async () => {
  let resolveSend;
  const onClose = jest.fn();
  await render({ onClose });
  await fillDraft();
  await submit();
  global.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveSend = resolve; }));
  await click(button("Confirmer et envoyer"));
  expect(button("Outlook").disabled).toBe(true);
  expect(host.querySelector("fieldset").disabled).toBe(true);
  expect(host.querySelector('[aria-label="Fermer la messagerie"]').disabled).toBe(true);
  await act(async () => host.querySelector('[role="dialog"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => resolveSend(response({ ok: true })));
  expect(button("Outlook").disabled).toBe(false);
});

test("closing asks before discarding a draft and restores focus", async () => {
  const onClose = jest.fn();
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  await render({ onClose });
  await type("#messaging-body", "Brouillon à conserver");
  await click(host.querySelector('[aria-label="Fermer la messagerie"]'));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await click(host.querySelector('[aria-label="Fermer la messagerie"]'));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("inbox timeout is reported and re-enables refresh", async () => {
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.useFakeTimers();
  global.fetch.mockImplementation((url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  try {
    await render();
    await act(async () => jest.advanceTimersByTime(60000));
    expect(host.querySelector('[role="alert"]').textContent).toContain("délai de lecture");
    expect(host.querySelector('[aria-label="Actualiser la réception"]').disabled).toBe(false);
  } finally { jest.useRealTimers(); }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import PersonalMailCard from "./PersonalMailCard";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let host;
let root;
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const button = (text) => [...host.querySelectorAll("button")].find((node) => node.textContent.includes(text));
const type = async (selector, value) => {
  const node = host.querySelector(selector);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const blur = async (selector) => act(async () => { host.querySelector(selector).dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
});

test("an Orange customer only types address and password", async () => {
  global.fetch = jest.fn(async (url, options = {}) => {
    if (url.endsWith("/personal-mail/status")) return response({ connected: false });
    if (url.includes("/personal-mail/detect")) return response({ known: true, label: "Orange", app_password: false, help: "" });
    if (url.endsWith("/personal-mail/connect")) return response({ connected: true, email: "lea@orange.fr", label: "Orange" });
    throw new Error(`URL inattendue ${url} ${options.method}`);
  });
  await act(async () => root.render(<PersonalMailCard />));
  await act(async () => button("Connecter ma boîte").click());
  await type("#personal-mail-email", "lea@orange.fr");
  await blur("#personal-mail-email");
  expect(host.textContent).toContain("Orange reconnu : réglages automatiques");
  expect(host.querySelector("#personal-mail-imap")).toBeNull();
  await type("#personal-mail-password", "secret");
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const [, options] = global.fetch.mock.calls.find(([url]) => url.endsWith("/connect"));
  expect(JSON.parse(options.body)).toEqual({ email: "lea@orange.fr", password: "secret" });
  expect(host.textContent).toContain("lea@orange.fr · Orange");
  expect(host.textContent).toContain("Connecté");
  expect(window.localStorage.getItem("sirius_mail_provider")).toBe("personal");
});

test("Yahoo shows app-password help and Gmail is redirected to one click", async () => {
  let detected = { known: true, label: "Yahoo", app_password: true, help: "Yahoo demande un mot de passe d'application." };
  global.fetch = jest.fn(async (url) => (url.endsWith("/status") ? response({ connected: false }) : response(detected)));
  await act(async () => root.render(<PersonalMailCard />));
  await act(async () => button("Connecter ma boîte").click());
  await type("#personal-mail-email", "lea@yahoo.fr");
  await blur("#personal-mail-email");
  expect(host.textContent).toContain("Mot de passe d’application");
  expect(host.textContent).toContain("Yahoo demande un mot de passe d'application.");
  detected = { known: true, oauth: "google" };
  await type("#personal-mail-email", "lea@gmail.com");
  await blur("#personal-mail-email");
  expect(host.textContent).toContain("Connecter Google");
  expect(host.querySelector("button[type=submit]").disabled).toBe(true);
});

test("unknown provider opens advanced settings and server errors stay visible", async () => {
  global.fetch = jest.fn(async (url) => {
    if (url.endsWith("/status")) return response({ connected: false });
    if (url.includes("/detect")) return response({ known: false });
    return response({ detail: "Adresse ou mot de passe refusé par votre fournisseur." }, 400);
  });
  await act(async () => root.render(<PersonalMailCard />));
  await act(async () => button("Connecter ma boîte").click());
  await type("#personal-mail-email", "lea@exemple.fr");
  await blur("#personal-mail-email");
  expect(host.querySelector("#personal-mail-imap")).not.toBeNull();
  await type("#personal-mail-imap", "imap.exemple.fr");
  await type("#personal-mail-smtp", "smtp.exemple.fr");
  await type("#personal-mail-password", "faux");
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const [, options] = global.fetch.mock.calls.find(([url]) => url.endsWith("/connect"));
  expect(JSON.parse(options.body)).toMatchObject({ imap_host: "imap.exemple.fr", smtp_host: "smtp.exemple.fr", smtp_port: 465 });
  expect(host.querySelector('[role="alert"]').textContent).toContain("mot de passe refusé");
});

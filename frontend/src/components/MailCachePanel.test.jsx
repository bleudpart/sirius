import { act } from "react";
import { createRoot } from "react-dom/client";
import MailCachePanel from "./MailCachePanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("discloses local copies, filters without a network request and reads only the selected preview", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onRead = jest.fn();
  const run = jest.fn();
  const clear = jest.fn();
  try {
    await act(async () => root.render(<MailCachePanel cache={{ account: "a", busy: {}, errors: {}, run, clear, providers: {
      google: { enabled: true, email: "owner@example.com", syncedAt: "2026-10-04T10:00:00Z", mails: [
        { id: "1", de: "Camille", sujet: "Devis fictif", apercu: "<script>Texte non exécuté</script>", recu: "2026-10-04" },
        { id: "2", de: "Alex", sujet: "Autre message", apercu: "Autre aperçu", recu: "2026-10-03" },
      ] },
    } }} onRead={onRead} />));
    expect(host.textContent).toContain("Stockage local non chiffré");
    expect(host.textContent).toContain("Copies locales, pas une boîte en direct");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("script")).toBeNull();
    const search = host.querySelector('input[type="search"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, "Camille");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelectorAll("li")).toHaveLength(1);
    await act(async () => host.querySelector("li button").click());
    expect(onRead).toHaveBeenCalledWith(expect.stringContaining("Copie locale Gmail, synchronisée le 04/10/2026"));
    expect(run).not.toHaveBeenCalled();
    await act(async () => Array.from(host.querySelectorAll("button")).find((node) => node.textContent === "Effacer et désactiver Gmail").click());
    expect(clear).toHaveBeenCalledWith("google");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("provider consoles have distinct logos, searches and independently scrollable feeds", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const run = jest.fn();
  const clear = jest.fn();
  const snapshot = (name) => ({ enabled: true, email: "owner@example.com", syncedAt: "2026-10-04T10:00:00Z",
    mails: [{ id: name, de: name, sujet: `${name} message`, apercu: "Aperçu", recu: "2026-10-04", lu: true }] });
  try {
    await act(async () => root.render(<MailCachePanel cache={{ account: "a", busy: {}, errors: {}, run, clear,
      providers: { google: snapshot("Camille"), microsoft: snapshot("Alex") } }} />));
    const google = host.querySelector(".mail-console-google");
    const microsoft = host.querySelector(".mail-console-microsoft");
    expect(google.querySelector(".provider-logo-gmail")).not.toBeNull();
    expect(microsoft.querySelector(".provider-logo-outlook")).not.toBeNull();
    expect(host.querySelectorAll('.mail-console-feed[role="region"][tabindex="0"]')).toHaveLength(2);
    const search = google.querySelector('input[type="search"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(search, "absent");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(google.querySelectorAll("li")).toHaveLength(0);
    expect(google.textContent).toContain("Aucun aperçu ne correspond");
    expect(microsoft.querySelectorAll("li")).toHaveLength(1);
    expect(microsoft.querySelector("input").value).toBe("");
    expect(run).not.toHaveBeenCalled();
    await act(async () => microsoft.querySelector('[aria-label="Synchroniser Outlook"]').click());
    expect(run).toHaveBeenCalledWith("microsoft", false);
    await act(async () => Array.from(google.querySelectorAll("button")).find((node) => node.textContent === "Effacer et désactiver Gmail").click());
    expect(clear).toHaveBeenCalledWith("google");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

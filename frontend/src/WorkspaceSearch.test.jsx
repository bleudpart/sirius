import { act } from "react";
import { createRoot } from "react-dom/client";
import WorkspaceSearch from "./WorkspaceSearch";
import { matchesSearch, readSearchSource } from "./workspaceSearchData";

global.IS_REACT_ACT_ENVIRONMENT = true;
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
const microsoft = (patch = {}) => ({ contacts: [], emails: [], evenements: [], sources: {
  contacts: { status: "available" }, emails: { status: "available" }, evenements: { status: "available" },
}, ...patch });
let host, root, props, previousFetch;
beforeEach(() => {
  previousFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue(response({ dossiers: [{ id: "d1", title: "Client Étienne", category: "commerce" }] }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  props = { initialQuery: "etienne", modules: [{ id: "dossiers", label: "MNÉMOSYNE", run: jest.fn() }],
    microsoftFetch: jest.fn().mockResolvedValue(response(microsoft())), onDossier: jest.fn(), onConnections: jest.fn(), onContact: jest.fn(), onClose: jest.fn() };
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); global.fetch = previousFetch; jest.restoreAllMocks(); jest.useRealTimers(); });
const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<WorkspaceSearch {...props} />)); };
const click = async (text) => { await act(async () => [...host.querySelectorAll("button")].find((button) => button.textContent === text).click()); };

test("matching ignores accents and punctuation and requires every word", () => {
  expect(matchesSearch("ETIENNE-commerce", "Client Étienne", "commerce")).toBe(true);
  expect(matchesSearch("etienne facture", "Étienne commerce")).toBe(false);
});
test("a failed provider does not hide dossiers and offers safe retry", async () => {
  await render({ microsoftFetch: jest.fn().mockResolvedValue(response({}, 401)) });
  expect(host.textContent).toContain("Client Étienne");
  expect(host.textContent).toContain("Connectez ou reconnectez");
  expect(host.textContent).toContain("son absence de résultat n'est pas une réponse négative");
  await click("Ouvrir ce dossier");
  expect(props.onDossier).toHaveBeenCalledWith("d1");
  expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/work-dossiers"), expect.objectContaining({ credentials: "include" }));
});
test("partial Microsoft failures preserve actual mail and contact results", async () => {
  const contact = { id: "c1", nom: "Étienne", email: "test@example.test" };
  await render({ microsoftFetch: jest.fn().mockResolvedValue(response(microsoft({
    contacts: [contact], emails: [{ id: "m1", sujet: "Devis", de: "Étienne", apercu: "À relire" }],
    sources: { contacts: { status: "available" }, emails: { status: "available" }, evenements: { status: "unavailable", http_status: 403 } },
  }))) });
  expect(host.textContent).toContain("Courriel — Devis");
  expect(host.textContent).toContain("Agenda non consulté (HTTP 403)");
  await click("Préparer un message à ce contact");
  expect(props.onContact).toHaveBeenCalledWith(contact);
});
test("an older server cannot silently confirm empty Microsoft sources", async () => {
  const data = await readSearchSource("microsoft", "x", { microsoftFetch: async () => response({ contacts: [], emails: [], evenements: [] }) });
  expect(data.warnings).toHaveLength(3);
});
test("invalid Microsoft display fields are rejected before rendering", async () => {
  await expect(readSearchSource("microsoft", "x", { microsoftFetch: async () => response(microsoft({ emails: [{ sujet: { invalid: true } }] })) }))
    .rejects.toThrow("Le format des résultats Microsoft est invalide");
});
test("malformed dossiers are reported, never treated as no matches", async () => {
  global.fetch.mockResolvedValue(response({ dossiers: [{ title: "incomplete" }] }));
  await render();
  expect(host.textContent).toContain("La liste des dossiers reçue est incomplète");
});
test("stopping keeps completed sources and ignores late results", async () => {
  let resolve;
  await render({ microsoftFetch: jest.fn(() => new Promise((done) => { resolve = done; })) });
  await click("Arrêter la recherche");
  expect(host.textContent).toContain("Client Étienne");
  expect(host.textContent).toContain("Recherche interrompue");
  await act(async () => resolve(response(microsoft({ emails: [{ id: "late", sujet: "Late result" }] }))));
  expect(host.textContent).not.toContain("Late result");
});
test("a source times out without discarding completed results", async () => {
  jest.useFakeTimers();
  await render({ microsoftFetch: jest.fn((_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) });
  await act(async () => jest.advanceTimersByTime(12000));
  expect(host.textContent).toContain("Le délai de réponse a été dépassé");
  expect(host.textContent).toContain("Client Étienne");
});
test("empty opening does not query providers; keyboard focus is contained and restored", async () => {
  const opener = document.createElement("button"); document.body.appendChild(opener); opener.focus();
  await render({ initialQuery: "" });
  expect(props.microsoftFetch).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(document.activeElement.id).toBe("workspace-query");
  const buttons = [...host.querySelectorAll("button:not(:disabled)")];
  buttons[buttons.length - 1].focus();
  await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
  expect(document.activeElement).toBe(buttons[0]);
  await act(async () => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(props.onClose).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  expect(document.activeElement).toBe(opener);
  opener.remove();
});
test("module synonyms are searchable offline without calling their actions", async () => {
  await render({ initialQuery: "archives" });
  expect(host.textContent).toContain("MNÉMOSYNE");
  expect(props.modules[0].run).not.toHaveBeenCalled();
  await click("MNÉMOSYNE");
  expect(props.modules[0].run).toHaveBeenCalledTimes(1);
});

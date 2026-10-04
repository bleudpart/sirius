import { act } from "react";
import { createRoot } from "react-dom/client";
import GettingStarted, { gettingStartedKey } from "./GettingStarted";
import { WORK_MODULES } from "../workModules";
import ModulesMenu from "../ModulesMenu";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
let props;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  props = { storageKey: gettingStartedKey({ id: "a" }), ready: true, requested: false, onClose: jest.fn(), onAssistant: jest.fn(), onModule: jest.fn() };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  jest.restoreAllMocks();
});
const render = async (patch = {}) => { props = { ...props, ...patch }; await act(async () => root.render(<GettingStarted key={props.storageKey} {...props} />)); };

test("waits for boot and setup, then explains optional connections, voice and all local modules", async () => {
  await render({ ready: false });
  expect(host.textContent).toBe("");
  await render({ ready: true });
  expect(host.textContent).toContain("Par où commencer");
  expect(host.textContent).toContain("Cette étape est facultative");
  expect(host.textContent).toContain("sans annuler une action déjà envoyée");
  WORK_MODULES.forEach((module) => {
    expect(host.textContent).toContain(module.label);
    expect(host.textContent).toContain(module.description);
  });
  expect(props.onModule).not.toHaveBeenCalled();
  expect(props.onAssistant).not.toHaveBeenCalled();
});

test.each([
  ["Poser une question", null],
  ["Organiser mon travail", "dossiers"],
  ["Connecter mes comptes", "connections"],
])("shortcut %s uses the existing action and persists dismissal", async (label, id) => {
  await render();
  const button = [...host.querySelectorAll(".getting-started-actions button")].find((el) => el.textContent.includes(label));
  await act(async () => button.click());
  if (id) expect(props.onModule).toHaveBeenCalledWith(id);
  else expect(props.onAssistant).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(props.storageKey)).toBe("done");
  expect(host.textContent).toBe("");
});

test("can be reopened and a different account sees its own first-use guide", async () => {
  localStorage.setItem(props.storageKey, "done");
  await render();
  expect(host.textContent).toBe("");
  await render({ requested: true });
  expect(host.textContent).toContain("Par où commencer");
  await render({ requested: false, storageKey: gettingStartedKey({ email: "b@example.test" }) });
  expect(host.textContent).toContain("Par où commencer");
  expect(localStorage.getItem(gettingStartedKey({ id: "a" }))).toBe("done");
});

test("storage failure is explicit and permits continuing without persistence", async () => {
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  jest.spyOn(console, "error").mockImplementation(() => {});
  await render();
  await act(async () => host.querySelector(".getting-started-dismiss").click());
  expect(host.querySelector('[role="alert"]').textContent).toContain("n'a pas pu être enregistré");
  await act(async () => host.querySelector('[role="alert"] button').click());
  expect(host.textContent).toBe("");
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test("module menu shows purpose first, preserves names and runs the original action", async () => {
  const run = jest.fn();
  const onClose = jest.fn();
  const Icon = () => null;
  await act(async () => root.render(<ModulesMenu open onClose={onClose} items={[
    { id: "dossiers", label: "MNÉMOSYNE# — dossiers et archives", Icon, run, group: "PANTHÉON" },
    { id: "themis", label: "THÉMIS# — gestion d'entreprise", Icon, run, group: "PANTHÉON" },
  ]} />));
  const button = host.querySelector('[data-testid="modules-menu-item-dossiers"]');
  expect(button.textContent).toBe("Dossiers et archivesMNÉMOSYNE#");
  expect(host.querySelector('[data-testid="modules-menu-item-themis"]').textContent).toBe("gestion d'entrepriseTHÉMIS#");
  await act(async () => button.click());
  expect(run).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledTimes(1);
});

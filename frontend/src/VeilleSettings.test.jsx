import { act } from "react";
import { createRoot } from "react-dom/client";
import VeilleSettings from "./VeilleSettings";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalFetch = global.fetch;
let root;
let host;

const reply = (data, ok = true, status = 200) => Promise.resolve({ ok, status, json: async () => data });
const byTestId = (id) => host.querySelector(`[data-testid="${id}"]`);
const setInput = (element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  global.fetch = originalFetch;
});

test("veille non configurée puis enregistrée avec le lieu résolu", async () => {
  global.fetch = jest.fn()
    .mockImplementationOnce(() => reply({ configured: false, enabled: false, city: "", location: null,
      meteo_locale: true, evenements: true, marches: true }))
    .mockImplementationOnce(() => reply({ configured: true, enabled: true, city: "Lyon",
      location: { name: "Lyon", country: "France" }, meteo_locale: true, evenements: true, marches: false }));
  await act(async () => root.render(<VeilleSettings />));
  expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/veille\/settings$/),
    expect.objectContaining({ credentials: "include" }));
  expect(byTestId("veille-status").textContent).toBe("Veille non configurée.");
  expect(byTestId("veille-preview-btn").disabled).toBe(true);
  expect(host.textContent).toContain("aucune position n'est envoyée à OSIRIS");
  expect(host.textContent).toContain("la vigilance Météo-France n'est pas incluse");

  await act(async () => setInput(byTestId("veille-city-input"), "  Lyon "));
  await act(async () => byTestId("veille-enabled").click());
  await act(async () => byTestId("veille-marches").click());
  await act(async () => byTestId("veille-save-btn").click());
  const [url, options] = global.fetch.mock.calls[1];
  expect(url).toMatch(/\/api\/veille\/settings$/);
  expect(options.method).toBe("PUT");
  expect(JSON.parse(options.body)).toEqual({
    enabled: true, city: "Lyon", meteo_locale: true, evenements: true, marches: false,
  });
  expect(byTestId("veille-status").textContent).toBe("Veille active autour de Lyon (France).");
  expect(byTestId("veille-marches").checked).toBe(false);
});

test("refus du serveur affiché sans faux succès", async () => {
  global.fetch = jest.fn()
    .mockImplementationOnce(() => reply({ configured: false, enabled: false, city: "", location: null }))
    .mockImplementationOnce(() => reply({ detail: "Ville introuvable : indiquez le nom exact de la commune." }, false, 422))
    .mockImplementationOnce(() => reply({ detail: [{ msg: "bad" }] }, false, 422));
  await act(async () => root.render(<VeilleSettings />));
  await act(async () => setInput(byTestId("veille-city-input"), "Nullepart"));
  await act(async () => byTestId("veille-save-btn").click());
  expect(byTestId("veille-error").textContent).toBe("Ville introuvable : indiquez le nom exact de la commune.");
  expect(byTestId("veille-status").textContent).toBe("Veille non configurée.");
  await act(async () => byTestId("veille-save-btn").click());
  expect(byTestId("veille-error").textContent).toBe("Réglages refusés (HTTP 422).");
});

test("aperçu de la veille affiché tel que renvoyé par le serveur", async () => {
  global.fetch = jest.fn()
    .mockImplementationOnce(() => reply({ configured: true, enabled: true, city: "Paris",
      location: { name: "Paris", country: "France" }, meteo_locale: true, evenements: true, marches: true }))
    .mockImplementationOnce(() => reply({ status: "partial", text: "Veille autour de Paris (France)\n- Source indisponible : Séismes" }));
  await act(async () => root.render(<VeilleSettings />));
  await act(async () => byTestId("veille-preview-btn").click());
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/api\/veille$/);
  expect(byTestId("veille-preview").textContent).toContain("Source indisponible : Séismes");
});

test("erreur de chargement signalée", async () => {
  global.fetch = jest.fn(() => reply({ detail: "Non authentifié" }, false, 401));
  await act(async () => root.render(<VeilleSettings />));
  expect(byTestId("veille-error").textContent).toBe("Non authentifié");
  expect(byTestId("veille-status")).toBeNull();
});

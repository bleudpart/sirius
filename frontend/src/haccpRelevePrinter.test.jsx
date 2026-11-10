import { act } from "react";
import { createRoot } from "react-dom/client";
import { setWordRelayEnabled, useHaccpRelevePrintRelay } from "./haccpRelevePrinter";

global.IS_REACT_ACT_ENVIRONMENT = true;
const relayId = "22222222-2222-4222-8222-222222222222";
const reply = (value) => ({ ok: true, status: 200, json: async () => value });

function Relay({ account = "one" }) {
  const { enabled, error } = useHaccpRelevePrintRelay(account);
  return <div>{enabled ? "Actif" : "Inactif"}{error && <p role="alert">{error}</p>}</div>;
}

test("the relay requires opt-in and stops after an error without retrying", async () => {
  jest.useFakeTimers();
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValueOnce(reply({ job: null })).mockRejectedValueOnce(new Error("Connexion perdue"));
  window.siriusHaccpPrinter = {};
  localStorage.setItem("sirius_haccp_word_relay_id", relayId);
  localStorage.removeItem("sirius_haccp_word_relay_enabled");
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Relay />));
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => setWordRelayEnabled(true));
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ relay_id: relayId });
  await act(async () => { jest.advanceTimersByTime(5000); });
  expect(host.querySelector('[role="alert"]').textContent).toContain("Connexion perdue");
  await act(async () => { jest.advanceTimersByTime(30000); });
  expect(global.fetch).toHaveBeenCalledTimes(2);
  await act(async () => root.unmount());
  host.remove(); global.fetch = originalFetch;
  delete window.siriusHaccpPrinter;
  localStorage.removeItem("sirius_haccp_word_relay_id");
  localStorage.removeItem("sirius_haccp_word_relay_enabled");
  jest.useRealTimers();
});

test("the relay cannot run without the desktop bridge or an account", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn();
  localStorage.setItem("sirius_haccp_word_relay_enabled", "true");
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Relay />));
  expect(global.fetch).not.toHaveBeenCalled();
  window.siriusHaccpPrinter = {};
  await act(async () => root.unmount());
  const second = createRoot(host);
  await act(async () => second.render(<Relay account={null} />));
  expect(global.fetch).not.toHaveBeenCalled();
  await act(async () => second.unmount());
  host.remove(); global.fetch = originalFetch;
  delete window.siriusHaccpPrinter;
  localStorage.removeItem("sirius_haccp_word_relay_enabled");
});

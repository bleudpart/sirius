import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import HaccpPrinter, { MobileHaccpLabelPrinter, useHaccpPrinterRelay } from "./HaccpPrinter";
import { setLanguage } from "./i18n/domTranslator";

global.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, oldFetch;
const config = { deviceName: "USB labels", widthMm: 60, heightMm: 50, enabled: true };
const reply = (data, ok = true) => ({ ok, status: ok ? 200 : 409, json: async () => data });
const button = (text) => [...host.querySelectorAll("button")].find((item) => item.textContent.includes(text));
const field = (text) => [...host.querySelectorAll("label")].find((item) => item.textContent.trim().startsWith(text))?.querySelector("input,select");

beforeEach(() => {
  oldFetch = global.fetch;
  global.fetch = jest.fn(async () => reply({ configured: true }));
  window.siriusHaccpPrinter = {
    getConfig: jest.fn(async () => config),
    listPrinters: jest.fn(async () => [{ name: "USB labels", displayName: "USB labels" }]),
    configure: jest.fn(async (value) => value),
    printJob: jest.fn(async () => ({ accepted: true })),
  };
  localStorage.setItem("sirius_haccp_print_relay_id", "ed10a199-a945-4dd5-9851-e90ad5436d51");
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { await setLanguage("fr"); root.unmount(); });
  host.remove(); global.fetch = oldFetch;
  delete window.siriusHaccpPrinter;
  localStorage.clear(); jest.useRealTimers(); jest.restoreAllMocks();
});

test("Windows configuration detects printers and activates only after the scoped server accepts", async () => {
  await act(async () => root.render(<HaccpPrinter />));
  expect(field("Imprimante Windows").value).toBe("USB labels");
  expect(field("Largeur").value).toBe("60");
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(window.siriusHaccpPrinter.configure.mock.calls[0][0]).toEqual({ ...config, enabled: false });
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
    relay_id: "ed10a199-a945-4dd5-9851-e90ad5436d51", device_name: "USB labels", width_mm: 60, height_mm: 50,
  });
  expect(window.siriusHaccpPrinter.configure.mock.calls[1][0]).toEqual(config);
});

test("server refusal leaves the local station disabled and reports the cause", async () => {
  global.fetch.mockResolvedValue(reply({ detail: "Compte Cloud non relié" }, false));
  await act(async () => root.render(<HaccpPrinter />));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(window.siriusHaccpPrinter.configure).toHaveBeenCalledTimes(1);
  expect(window.siriusHaccpPrinter.configure).toHaveBeenCalledWith({ ...config, enabled: false });
  expect(host.querySelector('[role="alert"]').textContent).toContain("Compte Cloud non relié");
});

test("web exposes the Linux pairing form without touching the Windows bridge", async () => {
  delete window.siriusHaccpPrinter;
  await act(async () => root.render(<HaccpPrinter />));
  expect(host.textContent).toContain("Relais Raspberry Pi (Linux)");
  expect(button("Détecter")).toBeUndefined();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("Linux pairing registers the station and shows its one-time scoped token", async () => {
  delete window.siriusHaccpPrinter;
  const token = "A".repeat(43);
  global.fetch.mockResolvedValue(reply({ configured: true, relay_id: "ed10a199-a945-4dd5-9851-e90ad5436d51", token }));
  await act(async () => root.render(<HaccpPrinter />));
  await act(async () => host.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({
    relay_id: "ed10a199-a945-4dd5-9851-e90ad5436d51",
    device_name: "Brother_QL_820NWBc", width_mm: 62, height_mm: 50, replace_existing: false,
  });
  expect(host.querySelector('input[readonly]').value).toBe(token);
});

function Relay() {
  const { error, status } = useHaccpPrinterRelay("user-one");
  return <div>{error ? <p role="alert">{error}</p> : <p>{status}</p>}</div>;
}
const job = { id: "c76e3188-786b-41a8-88e8-c50e9551f108", html: "<article>Label</article>", widthMm: 60, heightMm: 50 };

test("relay claims, sends only the server document to Electron and acknowledges spooler acceptance", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job })).mockResolvedValueOnce(reply({ status: "accepted" }));
  await act(async () => root.render(<Relay />));
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledTimes(1);
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledWith(job);
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).status).toBe("accepted");
  expect(host.textContent).toContain("Vérifiez la sortie papier");
});

test("printer error is acknowledged uncertain and automatically stops consuming instead of reprinting", async () => {
  window.siriusHaccpPrinter.printJob.mockRejectedValue(new Error("Papier absent"));
  global.fetch.mockResolvedValueOnce(reply({ job })).mockResolvedValueOnce(reply({ status: "uncertain" }));
  await act(async () => root.render(<Relay />));
  expect(JSON.parse(global.fetch.mock.calls[1][1].body).status).toBe("uncertain");
  expect(host.querySelector('[role="alert"]').textContent).toContain("Papier absent");
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledTimes(1);
});

test("lost acknowledgement never resubmits the physical print", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job })).mockRejectedValueOnce(new Error("Connexion perdue"));
  await act(async () => root.render(<Relay />));
  expect(host.querySelector('[role="alert"]').textContent).toContain("Connexion perdue");
  expect(window.siriusHaccpPrinter.printJob).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test("disabled station never claims a job", async () => {
  window.siriusHaccpPrinter.getConfig.mockResolvedValue({ ...config, enabled: false });
  await act(async () => root.render(<Relay />));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(window.siriusHaccpPrinter.printJob).not.toHaveBeenCalled();
});

const mobileDevice = "4ea1dcf0-c840-4cf5-8edf-ab0edcce55e7";
const mobileJob = { id: "c76e3188-786b-41a8-88e8-c50e9551f108", label_id: 8, transport: "mobile", status: "pending" };
const mobileHtml = "<!doctype html><html><body><article>Saumon</article></body></html>";

function MobilePrinter() {
  const [busy, setBusy] = useState(false);
  return <MobileHaccpLabelPrinter labelId={8} kitchenToken="qr-token" busy={busy} onBusyChange={setBusy}
    className="haccp-primary" label="J’ai vérifié : préparer" />;
}

async function prepareMobile(height = 140) {
  const previewDocument = document.implementation.createHTMLDocument("Aperçu");
  previewDocument.body.innerHTML = "<article>Saumon</article>";
  const article = previewDocument.querySelector("article");
  article.getBoundingClientRect = jest.fn(() => ({ width: 220, height }));
  Object.defineProperty(article, "scrollWidth", { configurable: true, value: 220 });
  Object.defineProperty(article, "scrollHeight", { configurable: true, value: height });
  jest.spyOn(HTMLIFrameElement.prototype, "contentDocument", "get").mockReturnValue(previewDocument);
  jest.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(234);
  jest.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(189);
  localStorage.setItem("sirius_cuisine_print_device_id", mobileDevice);
  await act(async () => root.render(<MobilePrinter />));
  await act(async () => button("J’ai vérifié").click());
  const frame = host.querySelector("iframe");
  frame.contentWindow.focus = jest.fn();
  frame.contentWindow.print = jest.fn();
  return frame;
}

test("QR mobile waits for review, checks the preview and prints only once on a separate tap", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job: mobileJob, html: mobileHtml }))
    .mockResolvedValueOnce(reply({ job: { ...mobileJob, status: "uncertain" }, html: mobileHtml, valid_for_ms: 60000 }));
  const frame = await prepareMobile();
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(global.fetch.mock.calls[0][0]).toMatch(/\/mobile\/demandes$/);
  expect(global.fetch.mock.calls[0][1].headers["X-Sirius-Cuisine"]).toBe("qr-token");
  expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ label_id: 8, reviewed: true, device_id: mobileDevice });
  await act(async () => frame.dispatchEvent(new Event("load")));
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(global.fetch.mock.calls[1][0]).toMatch(/\/prise$/);
  expect(frame.contentWindow.print).not.toHaveBeenCalled();
  expect(button("Imprimer sur la Brother").disabled).toBe(false);
  await act(async () => button("Imprimer sur la Brother").click());
  await act(async () => button("Imprimer sur la Brother").click());
  expect(frame.contentWindow.print).toHaveBeenCalledTimes(1);
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Vérifiez le papier");
});

test("QR mobile never claims or prints a label whose preview overflows", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job: mobileJob, html: mobileHtml }));
  const frame = await prepareMobile(200);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(button("Imprimer sur la Brother").disabled).toBe(true);
  expect(host.querySelector('[role="alert"]').textContent).toContain("Étiquette trop longue");
  expect(frame.contentWindow.print).not.toHaveBeenCalled();
});

test("QR mobile shows translated overflow and paper-check warnings", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job: mobileJob, html: mobileHtml }));
  await prepareMobile(200);
  await act(async () => { await setLanguage("ta"); });
  const warning = host.querySelector('[role="alert"]').textContent;
  expect(warning).toContain("லேபிள் மிக நீளமானது");
  expect(warning).toContain("மீண்டும் கோருவதற்கு முன் காகிதத்தைச் சரிபார்க்கவும்");
  expect(host.textContent).toContain("Android-இல் Brother சேவை 62 × 50 mm அளவைப் பட்டியலிடவில்லை");
});

test("QR mobile refuses printing after expiry", async () => {
  const clock = jest.spyOn(Date, "now").mockReturnValue(1000);
  global.fetch.mockResolvedValueOnce(reply({ job: mobileJob, html: mobileHtml }))
    .mockResolvedValueOnce(reply({ job: { ...mobileJob, status: "uncertain" }, html: mobileHtml, valid_for_ms: 1000 }));
  const frame = await prepareMobile();
  clock.mockReturnValue(2000);
  await act(async () => button("Imprimer sur la Brother").click());
  expect(host.querySelector('[role="alert"]').textContent).toContain("DLC dépassée");
  expect(frame.contentWindow.print).not.toHaveBeenCalled();
});

test("QR mobile also measures expiry with elapsed monotonic time", async () => {
  jest.spyOn(Date, "now").mockReturnValue(1000);
  const elapsed = jest.spyOn(performance, "now").mockReturnValue(500);
  global.fetch.mockResolvedValueOnce(reply({ job: mobileJob, html: mobileHtml }))
    .mockResolvedValueOnce(reply({ job: { ...mobileJob, status: "uncertain" }, html: mobileHtml, valid_for_ms: 1000 }));
  const frame = await prepareMobile();
  elapsed.mockReturnValue(1500);
  await act(async () => button("Imprimer sur la Brother").click());
  expect(host.querySelector('[role="alert"]').textContent).toContain("DLC dépassée");
  expect(frame.contentWindow.print).not.toHaveBeenCalled();
});

test("QR mobile refuses a different document returned at claim", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job: mobileJob, html: mobileHtml }))
    .mockResolvedValueOnce(reply({ job: { ...mobileJob, status: "uncertain" }, html: "<article>Autre</article>", valid_for_ms: 1000 }));
  const frame = await prepareMobile();
  expect(button("Imprimer sur la Brother").disabled).toBe(true);
  expect(host.querySelector('[role="alert"]').textContent).toContain("a changé");
  expect(frame.contentWindow.print).not.toHaveBeenCalled();
});

test("a lost claim response never triggers printing or a second claim", async () => {
  global.fetch.mockResolvedValueOnce(reply({ job: mobileJob, html: mobileHtml }))
    .mockRejectedValueOnce(new Error("Connexion perdue"));
  const frame = await prepareMobile();
  await act(async () => frame.dispatchEvent(new Event("load")));
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]').textContent).toContain("Connexion perdue");
  expect(button("Imprimer sur la Brother").disabled).toBe(true);
  expect(frame.contentWindow.print).not.toHaveBeenCalled();
});

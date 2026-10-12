import { act } from "react";
import { createRoot } from "react-dom/client";
import DocumentScanner from "./DocumentScanner";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("suspect SIRET requires explicit photo comparison before accounting review", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:scan-test");
  URL.revokeObjectURL = jest.fn();
  const change = async (node, value) => {
    await act(async () => {
      const prototype = node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
      node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<DocumentScanner initialDossier={{ id: "d1", title: "Comptabilité" }}
      onClose={jest.fn()} onSaved={jest.fn()} />));
    const dialog = document.querySelector('[aria-labelledby="document-scanner-title"]');
    const upload = dialog.querySelector('input[type="file"]');
    Object.defineProperty(upload, "files", { value: [new File(["photo"], "ticket.jpg", { type: "image/jpeg" })] });
    await act(async () => upload.dispatchEvent(new Event("change", { bubbles: true })));
    await change([...dialog.querySelectorAll("select")].find((node) => node.querySelector('option[value="sale"]')), "sale");
    const identifiers = [...dialog.querySelectorAll("textarea")].find((node) => node.placeholder.includes("SIRET"));
    await change(identifiers, "SIRET 12345678900812");
    expect(dialog.querySelector('[role="alert"]').textContent).toContain("Aucun chiffre n'a été remplacé");
    let checks = [...dialog.querySelectorAll('input[type="checkbox"]')];
    expect(checks[1].disabled).toBe(true);
    await act(async () => checks[0].click());
    expect(checks[1].disabled).toBe(false);
    await act(async () => checks[1].click());
    expect(dialog.querySelector('button[type="submit"]').disabled).toBe(false);
    await change(identifiers, "SIRET 73282932000074");
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
    checks = [...dialog.querySelectorAll('input[type="checkbox"]')];
    expect(checks[0].checked).toBe(false);
    expect(dialog.querySelector('button[type="submit"]').disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

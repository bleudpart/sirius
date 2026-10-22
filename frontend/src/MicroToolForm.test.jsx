import { act } from "react";
import { createRoot } from "react-dom/client";
import MicroToolForm from "./MicroToolForm";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, prepare, originalFetch;
const render = (props = {}) => act(async () => root.render(<MicroToolForm onPrepare={prepare} {...props} />));
const fill = (element, value) => {
  const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};
const click = () => act(async () => host.querySelector("button").click());
beforeEach(() => {
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  prepare = jest.fn(); originalFetch = global.fetch; global.fetch = jest.fn();
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); global.fetch = originalFetch;
});

test("une préparation transmet les valeurs exactes au formulaire ARIANE sans appel ni exécution", async () => {
  await render();
  expect(host.querySelector("button").disabled).toBe(true);
  await act(async () => {
    fill(host.querySelector("input"), "  Nettoyer les espaces  ");
    fill(host.querySelectorAll("textarea")[0], '"  Bonjour  "');
    fill(host.querySelectorAll("textarea")[1], '[{"input":" a ","expected":"a"}]');
  });
  await click();
  expect(prepare).toHaveBeenCalledWith({
    title: "Nettoyer les espaces", steps: [{
      id: "micro_outil", action: "microtools.compile", inputs: {
        objective: "Nettoyer les espaces", data: "  Bonjour  ", examples: [{ input: " a ", expected: "a" }],
      },
    }],
  });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(host.textContent).toContain("quatre maximum");
  expect(host.textContent).toContain("pas un script Python/JavaScript");
});

test.each(["not json", "[]", '[{"input":"x"}]', '[{"input":"x","expected":"x","code":"forbidden"}]'])(
  "exemples invalides refusés sans préparation : %s", async (invalid) => {
    await render();
    await act(async () => {
      fill(host.querySelector("input"), "Nettoyer");
      fill(host.querySelectorAll("textarea")[1], invalid);
    });
    await click();
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  },
);

test("zéro JSON est conservé et le verrou empêche toute préparation pendant une requête", async () => {
  await render();
  await act(async () => {
    fill(host.querySelector("input"), "Compter");
    fill(host.querySelectorAll("textarea")[0], "0");
    fill(host.querySelectorAll("textarea")[1], '[{"input":[],"expected":0}]');
  });
  await click();
  expect(prepare.mock.calls[0][0].steps[0].inputs.data).toBe(0);
  await render({ disabled: true });
  expect(host.querySelector("fieldset").disabled).toBe(true);
});

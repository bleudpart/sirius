import { act } from "react";
import { createRoot } from "react-dom/client";
import { HaccpCaptureWorkspace, HaccpKitchenPage } from "./lazyModules";

jest.mock("./HaccpWorkspace", () => function Workspace({ standalone }) {
  return <div>Capture HACCP : {standalone ? "autonome" : "intégrée"}</div>;
});
jest.mock("./HaccpKitchenPage", () => function Kitchen() {
  return <div>Page cuisine QR</div>;
});

global.IS_REACT_ACT_ENVIRONMENT = true;

test("the lazy HACCP entry points load the intended pages and keep standalone mode", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<><HaccpCaptureWorkspace standalone /><HaccpKitchenPage /></>));
  expect(host.textContent).toContain("Capture HACCP : autonome");
  expect(host.textContent).toContain("Page cuisine QR");
  await act(async () => root.unmount());
  host.remove();
});

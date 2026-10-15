import { act } from "react";
import { createRoot } from "react-dom/client";
import SiriusDisplay from "./SiriusDisplay";

jest.mock("./gsapAnimations", () => ({
  animateWindowOpen: jest.fn(), animateWindowClose: jest.fn(), animateResizeSettle: jest.fn(),
}));
jest.mock("./Analysis3D", () => () => null);
jest.mock("./ModulesMedia", () => () => null);
jest.mock("./ProactivePanel", () => ({ ProactiveConversation: () => null }));
jest.mock("./components/MediaPlayer", () => () => null);
jest.mock("./voice", () => ({ cleanTextForDisplay: (text) => text }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("history labels use each question and retain the full question in the tooltip", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onSelect = jest.fn();
  const history = [
    { id: 2, type: "message", titre: "ΣIRIUS — RÉPONSE", question: "Quels articles sont en stock bas ?", contenu: "Lait : 3 unités." },
    { id: 1, type: "message", titre: "ΣIRIUS — RÉPONSE", question: "Quelles factures sont impayées ?", contenu: "FAC-42 : 200 €." },
    { id: 0, type: "message", titre: "INFOS DU JOUR", contenu: "Actualités." },
  ];
  try {
    await act(async () => root.render(
      <SiriusDisplay item={history[0]} history={history} onSelect={onSelect} onClose={() => {}} />,
    ));
    const chips = host.querySelectorAll(".sd-history .sd-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0].textContent).toBe(history[0].question.slice(0, 22));
    expect(chips[1].textContent).toBe(history[1].question.slice(0, 22));
    expect(chips[0].title).toBe(history[0].question);
    expect(chips[1].title).toBe(history[1].question);
    expect(chips[2].textContent).toBe("INFOS DU JOUR");
    await act(async () => chips[1].click());
    expect(onSelect).toHaveBeenCalledWith(history[1]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

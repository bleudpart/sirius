import { act } from "react";
import { createRoot } from "react-dom/client";
import BulletinNavigation from "./BulletinNavigation";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("shows the actual title position and routes deliberate navigation through explicit bulletin commands", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const command = jest.fn();
  try {
    await act(async () => root.render(<BulletinNavigation navigation={{ count: 3, position: 1, title: "Titre courant", previousAt: 2, nextAt: 4, finished: false }} onCommand={command} />));
    expect(host.querySelector('[role="status"]').textContent).toContain("Titre 2 sur 3 : Titre courant");
    await act(async () => host.querySelectorAll("button").forEach((button) => button.click()));
    expect(command.mock.calls.map(([text]) => text)).toEqual([
      "titre précédent du bulletin", "titre suivant du bulletin", "développe le titre 2 du bulletin", "reprends le bulletin",
    ]);
    await act(async () => root.render(<BulletinNavigation navigation={{ count: 1, position: 0, title: "Seul titre", previousAt: null, nextAt: null, finished: true }} onCommand={command} />));
    expect([...host.querySelectorAll("button")].map((button) => button.disabled)).toEqual([true, true, false, true]);
    await act(async () => root.render(<BulletinNavigation navigation={null} onCommand={command} />));
    expect(host.textContent).toBe("");
  } finally { await act(async () => root.unmount()); }
});

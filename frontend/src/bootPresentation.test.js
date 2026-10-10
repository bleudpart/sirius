import { generateBootPresentation } from "./bootPresentation";
import { requestConversation } from "./services/assistantApi";

jest.mock("./services/assistantApi", () => ({ requestConversation: jest.fn() }));

test("generates from bounded facts, preserving the scope of each check", async () => {
  requestConversation.mockResolvedValue({ ok: true, data: { answer: "Je présente les informations disponibles." } });
  const signal = new AbortController().signal;
  const text = await generateBootPresentation({
    checks: [{ label: "API micro", state: true, success: "Présente", scope: "Capture non testée." }],
    signal,
  });
  expect(text).toBe("Je présente les informations disponibles.");
  const payload = JSON.parse(requestConversation.mock.calls[0][0]);
  expect(payload.text).toContain("Capture non testée.");
  expect(payload.profile).toEqual({});
  expect(payload.memory).toEqual([]);
  expect(requestConversation.mock.calls[0][1].signal).toBe(signal);
});

test("does not substitute a fake presentation when generation fails", async () => {
  requestConversation.mockResolvedValue({ ok: false, data: null });
  await expect(generateBootPresentation({ checks: [], signal: new AbortController().signal }))
    .rejects.toThrow("Présentation personnalisée indisponible");
});

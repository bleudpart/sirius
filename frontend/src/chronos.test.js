import { agendaPayload, chronosConfirmation, chronosRequest, isChronosCommand, localDateTime, localTimeCandidates, newChronosRequestId } from "./chronos";

test("DST repeated times preserve original instants and require an explicit occurrence on creation", () => {
  const { execFileSync } = require("child_process");
  const script = `
    const localDateTime = ${localDateTime.toString()};
    const localTimeCandidates = ${localTimeCandidates.toString()};
    const agendaPayload = ${agendaPayload.toString()};
    const assert = require("node:assert/strict");
    const original = {start:"2026-10-25T02:30:00+01:00",end:"2026-10-25T03:30:00+01:00"};
    const form = {title:"Client",start:"2026-10-25T02:30",end:"2026-10-25T03:30",notes:""};
    assert.equal(localTimeCandidates(form.start).length,2);
    assert.equal(agendaPayload(form,"Europe/Paris",original).start,original.start);
    assert.throws(()=>agendaPayload(form,"Europe/Paris"),/deux fois/);
    assert.equal(agendaPayload({...form,startOccurrence:"1"},"Europe/Paris").start,original.start);
    assert.equal(localTimeCandidates("2026-03-29T02:30").length,0);
  `;
  execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: "Europe/Paris" } });
});

test("idempotency keys stay UUID-compatible without randomUUID", () => {
  const original = global.crypto;
  global.crypto = { getRandomValues: (bytes) => require("crypto").randomFillSync(bytes) };
  try {
    expect(newChronosRequestId()).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(newChronosRequestId()).not.toBe(newChronosRequestId());
  } finally { global.crypto = original; }
});

test.each([
  "Ajoute un rendez-vous client demain de 14 h à 15 h",
  "Qu'ai-je dans mon agenda aujourd'hui ?",
  "Décale ma réunion à demain",
  "confirme agenda abcdef123456",
])("routes agenda requests to Chronos: %s", (text) => expect(isChronosCommand(text)).toBe(true));

test.each(["Ouvre Outlook agenda", "Ajoute un rendez-vous Google", "ouvre chronos", "quel temps fait-il ?"])(
  "does not steal explicit external tools or module navigation: %s", (text) => expect(isChronosCommand(text)).toBe(false),
);

test("confirmation is exact and requires a server-issued token", () => {
  expect(chronosConfirmation("Oui, je confirme !", "abcdef123456")).toBe("confirme agenda abcdef123456");
  expect(chronosConfirmation("non", "abcdef123456")).toBe("annule agenda abcdef123456");
  expect(chronosConfirmation("oui mais change aussi l'heure", "abcdef123456")).toBeNull();
  expect(chronosConfirmation("oui", null)).toBeNull();
});

test("payload validates times and preserves explicit local offsets", () => {
  const start = "2026-10-17T14:00";
  const end = "2026-10-17T15:00";
  const payload = agendaPayload({ title: " Client ", start, end, notes: " note ", allow_conflicts: false }, "UTC");
  expect(payload.title).toBe("Client");
  expect(new Date(payload.start).getTime()).toBe(new Date(start).getTime());
  expect(localDateTime(payload.end)).toBe(end);
  expect(payload.notes).toBe("note");
  expect(payload.allow_conflicts).toBe(false);
  expect(() => agendaPayload({ title: "test", start, end: start, notes: "" }, "UTC")).toThrow(/horaires/);
  expect(() => agendaPayload({ title: " ", start, end, notes: "" }, "UTC")).toThrow();
});

test("API keeps credentials and exposes structured conflicts", async () => {
  const originalFetch = global.fetch;
  global.fetch = jest.fn(async () => ({ ok: false, status: 409,
    json: async () => ({ detail: { message: "Chevauchement", conflicts: [{ title: "Client" }] } }) }));
  try {
    await expect(chronosRequest("/events", { method: "POST" })).rejects.toMatchObject({
      message: "Chevauchement", status: 409, conflicts: [{ title: "Client" }],
    });
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/chronos/events"),
      expect.objectContaining({ credentials: "include", method: "POST" }));
  } finally { global.fetch = originalFetch; }
});

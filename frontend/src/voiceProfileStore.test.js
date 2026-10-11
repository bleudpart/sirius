import { createVoiceProfileStore, voiceProfileAccount } from "./voiceProfileStore";

function memoryFactory() {
  const entries = [];
  const request = (value) => {
    const result = { result: value };
    Promise.resolve().then(() => result.onsuccess?.());
    return result;
  };
  return {
    open() {
      return request({
        close() {},
        transaction() {
          const tx = { abort: () => tx.onabort?.(), objectStore: () => store };
          const store = {
            transaction: tx,
            index: () => ({
              getAll: (account) => request(entries.filter((e) => e.account === account)),
              count: (account) => request(entries.filter((e) => e.account === account).length),
              openKeyCursor(account) {
                const matches = entries.filter((e) => e.account === account);
                let index = 0;
                const cursorRequest = {};
                const advance = () => {
                  const entry = matches[index++];
                  cursorRequest.result = entry ? { primaryKey: [entry.account, entry.id], continue: advance } : null;
                  Promise.resolve().then(() => cursorRequest.onsuccess?.());
                };
                advance();
                return cursorRequest;
              },
            }),
            add: (entry) => entries.push(entry),
            delete: ([account, id]) => {
              const index = entries.findIndex((e) => e.account === account && e.id === id);
              if (index >= 0) entries.splice(index, 1);
            },
          };
          setTimeout(() => tx.oncomplete?.(), 0);
          return tx;
        },
      });
    },
  };
}

const sample = () => ({ text: "Ma phrase exacte.", audio: new Blob(["audio"], { type: "audio/webm" }), duration: 1 });

test("uses stable authenticated identity and rejects anonymous shared profiles", () => {
  expect(voiceProfileAccount({ user_id: "stable", email: "changed" })).toBe("stable");
  expect(() => voiceProfileAccount(null)).toThrow(/Connectez/);
});

test("stores Blob locally with account partition, scoped deletion and profile erasure", async () => {
  const store = createVoiceProfileStore(memoryFactory());
  const a = await store.save("A", sample());
  await store.save("B", sample());
  expect((await store.list("A"))[0].audio).toBeInstanceOf(Blob);
  expect(await store.list("A")).toHaveLength(1);
  await store.remove("B", a.id);
  expect(await store.list("A")).toHaveLength(1);
  await store.clear("A");
  expect(await store.list("A")).toHaveLength(0);
  expect(await store.list("B")).toHaveLength(1);
});

test("rejects unsupported storage, invalid audio and unconfirmed text", async () => {
  await expect(createVoiceProfileStore(null).list("A")).rejects.toThrow(/indisponible/);
  const store = createVoiceProfileStore(memoryFactory());
  await expect(store.save("A", { ...sample(), text: "" })).rejects.toThrow(/transcription/);
  await expect(store.save("A", { ...sample(), duration: 16 })).rejects.toThrow(/invalide/);
  await expect(store.save("A", { ...sample(), audio: new Blob(["image"], { type: "image/png" }) })).rejects.toThrow(/invalide/);
});

test("caps the total local audio collection per account", async () => {
  const store = createVoiceProfileStore(memoryFactory());
  for (let i = 0; i < 20; i += 1) await store.save("A", sample());
  await expect(store.save("A", sample())).rejects.toThrow(/20 extraits/);
  await expect(store.save("B", sample())).resolves.toMatchObject({ account: "B" });
});

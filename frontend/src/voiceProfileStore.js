export const VOICE_SAMPLE_MAX_BYTES = 2 * 1024 * 1024;
export const VOICE_SAMPLE_MAX_SECONDS = 15;
const MAX_SAMPLES = 20;

export function voiceProfileAccount(user) {
  const id = user?.user_id || user?.id || user?._id || user?.email;
  if (!id) throw new Error("Connectez-vous pour conserver votre profil vocal sur cet appareil.");
  return String(id);
}

export function createVoiceProfileStore(factory = globalThis.indexedDB) {
  const open = () => new Promise((resolve, reject) => {
    if (!factory) { reject(new Error("Stockage audio local indisponible sur cet appareil.")); return; }
    const request = factory.open("sirius-voice-profile-v1", 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("samples", { keyPath: ["account", "id"] });
      store.createIndex("account", "account");
    };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("Fermez les autres fenêtres du profil vocal puis réessayez.")); };
  });
  const transact = async (account, mode, operation) => {
    if (!account) throw new Error("Compte vocal non défini.");
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("samples", mode);
      let result;
      let failure;
      try {
        operation(transaction.objectStore("samples"), (value) => { result = value; }, (error) => { failure = error; transaction.abort(); });
      } catch (error) {
        transaction.abort();
        db.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => { db.close(); resolve(result); };
      transaction.onabort = transaction.onerror = () => { db.close(); reject(failure || transaction.error || new Error("Stockage vocal impossible.")); };
    });
  };
  const list = (account) => transact(account, "readonly", (store, done) => {
    const request = store.index("account").getAll(account);
    request.onsuccess = () => done(request.result.sort((a, b) => b.createdAt - a.createdAt));
  });
  return {
    list,
    async save(account, sample) {
      const text = String(sample.text || "").trim();
      if (!text || text.length > 1000) throw new Error("Saisissez la transcription exacte (1 à 1 000 caractères).");
      if (!(sample.audio instanceof Blob) || !sample.audio.size || sample.audio.size > VOICE_SAMPLE_MAX_BYTES
        || !/^audio\//.test(sample.audio.type) || !Number.isFinite(sample.duration)
        || sample.duration <= 0 || sample.duration > VOICE_SAMPLE_MAX_SECONDS) {
        throw new Error("Extrait invalide : audio de 15 secondes et 2 Mo maximum.");
      }
      return transact(account, "readwrite", (store, done, fail) => {
        const count = store.index("account").count(account);
        count.onsuccess = () => {
          if (count.result >= MAX_SAMPLES) { fail(new Error("20 extraits maximum. Supprimez un extrait avant d’en conserver un nouveau.")); return; }
          const entry = { account, id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
            text, audio: sample.audio, duration: sample.duration, createdAt: Date.now() };
          store.add(entry);
          done(entry);
        };
      });
    },
    remove: (account, id) => transact(account, "readwrite", (store) => { store.delete([account, id]); }),
    clear: (account) => transact(account, "readwrite", (store) => {
      const request = store.index("account").openKeyCursor(account);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); }
      };
    }),
  };
}

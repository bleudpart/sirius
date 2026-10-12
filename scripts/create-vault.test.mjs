import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPortableVault } from "./create-vault.mjs";

const source = await readFile(new URL("../frontend/src/configurationVault.js", import.meta.url), "utf8");
const { parseVault, decryptVault } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("portable vault imports in SIRIUS without plaintext secrets or overwrite", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sirius-vault-test-"));
  const output = path.join(directory, "test.vault");
  try {
    await createPortableVault({ cerebras: "test-secret-not-real", groq_key: "test-voice-not-real" }, "test-password-123", output);
    const content = await readFile(output, "utf8");
    assert.equal(content.includes("test-secret-not-real"), false);
    assert.deepEqual(await decryptVault(parseVault(content), "test-password-123"), {
      cerebras: "test-secret-not-real", groq_key: "test-voice-not-real",
    });
    await assert.rejects(decryptVault(parseVault(content), "wrong-password-123"), /incorrect/);
    await assert.rejects(createPortableVault({ cerebras: "replacement" }, "test-password-123", output), { code: "EEXIST" });
    assert.equal(await readFile(output, "utf8"), content);
  } finally {
    await rm(output, { force: true });
    await rmdir(directory);
  }
});

test("empty keys and weak passwords cannot create a vault", async () => {
  await assert.rejects(createPortableVault({}, "test-password-123", "unused.vault"), /au moins/);
  await assert.rejects(createPortableVault({ cerebras: "test" }, "short", "unused.vault"), /12/);
});

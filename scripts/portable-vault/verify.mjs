import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = await readFile(new URL("../../frontend/src/configurationVault.js", import.meta.url), "utf8");
const { parseVault, decryptVault } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const executable = fileURLToPath(new URL("../../dist/portable-vault/SIRIUS-Coffre-Portable.exe", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "sirius-exe-test-"));
const output = path.join(directory, "test.vault");
try {
  await promisify(execFile)(executable, ["--test-fixture", output], { timeout: 120000 });
  const text = await readFile(output, "utf8");
  assert.equal(text.includes("test-secret-not-real"), false);
  assert.deepEqual(await decryptVault(parseVault(text), "test-password-123"), {
    cerebras: "test-secret-not-real", groq_key: "test-voice-not-real",
  });
  await assert.rejects(decryptVault(parseVault(text), "wrong-password-123"), /incorrect/);
  const envelope = parseVault(text);
  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 1;
  await assert.rejects(decryptVault({ ...envelope, ciphertext: bytes.toString("base64") }, "test-password-123"), /altéré/);
  await assert.rejects(promisify(execFile)(executable, ["--test-fixture", output]));
  assert.equal(await readFile(output, "utf8"), text);
  console.log("OK : coffre EXE importable dans SIRIUS, mauvais mot de passe et alteration refuses, aucun ecrasement.");
} finally {
  await rm(output, { force: true });
  await rmdir(directory);
}

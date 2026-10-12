import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const source = await readFile(new URL("../frontend/src/configurationVault.js", import.meta.url), "utf8");
const { encryptVault, decryptVault } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

export async function createPortableVault(keys, password, output) {
  if (!Object.values(keys).some((value) => typeof value === "string" && value.trim())) {
    throw new Error("Ajoutez au moins une cle.");
  }
  const envelope = await encryptVault(keys, password);
  await decryptVault(envelope, password);
  await writeFile(output, JSON.stringify(envelope), { flag: "wx", mode: 0o600 });
}

function hiddenPrompt(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    let value = "";
    process.stdout.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    const cleanup = () => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (text) => {
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Creation annulee."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Ouvrez un terminal interactif pour saisir les secrets sans les afficher.");
  }
  if (process.argv.length > 3) throw new Error("Usage : node scripts\\create-vault.mjs [chemin-du-coffre]");
  const output = path.resolve(process.argv[2] || "sirius.vault");
  console.log("Coffre SIRIUS local : aucune transmission reseau, aucune cle en clair sur disque.");
  console.log("Laissez un service vide pour l'ignorer. Les saisies de secrets sont masquees.");
  const keys = {};
  for (const [name, label] of [
    ["cerebras", "Cerebras"], ["groq_key", "Groq (voix)"], ["serp", "SerpAPI"],
    ["fal", "fal.ai"], ["gmaps", "Google Maps"], ["alphavantage", "Alpha Vantage"],
    ["google_tts", "Google TTS"], ["gemini_tts", "Gemini TTS"],
  ]) {
    const value = (await hiddenPrompt(`${label} (Entree pour ignorer) : `)).trim();
    if (value) keys[name] = value;
  }
  const password = await hiddenPrompt("Mot de passe du coffre (12 caracteres minimum) : ");
  const confirmation = await hiddenPrompt("Confirmez le mot de passe : ");
  if (password !== confirmation) throw new Error("Les mots de passe ne correspondent pas.");
  await createPortableVault(keys, password, output);
  console.log(`Coffre chiffre cree : ${output}`);
  console.log("Transportez ce fichier, et conservez le mot de passe separement.");
  console.log("Dans SIRIUS : Cles API et services > Avance > Restaurer une sauvegarde.");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.code === "EEXIST" ? "Ce fichier existe deja : choisissez un autre nom, il n'a pas ete ecrase." : error.message);
    process.exitCode = 1;
  });
}

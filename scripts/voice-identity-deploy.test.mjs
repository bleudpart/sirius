import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bash = process.env.SIRIUS_TEST_BASH
  || (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash");
const digest = "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012";
const posix = value => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
const temporary = [];
afterEach(() => {
  for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), "sirius-voice-deploy-"));
  temporary.push(folder);
  const app = path.join(folder, "app");
  const config = path.join(folder, "config");
  const data = path.join(folder, "data");
  const bin = path.join(folder, "bin");
  const log = path.join(folder, "calls");
  const model = path.join(folder, "model.onnx");
  for (const dir of [bin, config, data, path.join(app, "backend"), path.join(app, ".venv", "bin"),
    path.join(app, "deploy", "hetzner")]) mkdirSync(dir, { recursive: true });
  for (const name of ["prepare-voice-identity.sh", "install-voice-identity-runtime.sh"]) {
    copyFileSync(path.join(root, "deploy", "hetzner", name), path.join(app, "deploy", "hetzner", name));
  }
  writeFileSync(path.join(app, "backend", "voice_identity_worker.py"), "# test placeholder\n");
  writeFileSync(path.join(app, "backend", "requirements-voice-identity.txt"), "sherpa-onnx==2.0.0\n");
  writeFileSync(path.join(config, "sirius.env"), "UNCHANGED=yes\nSIRIUS_VOICE_IDENTITY_ENABLED=0\n");
  writeFileSync(model, "Mock model: hashes and inference are stubbed, never production evidence.\n");
  const stub = (name, body) => writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  stub("id", 'echo "${TEST_UID:-0}"');
  stub("ffmpeg", "exit 0");
  stub("sha256sum", 'if [[ "${TEST_BAD_COPY:-0}" == 1 && "$1" == *"/.model."* ]]; then echo "wrong  $1"; else echo "${TEST_DIGEST}  $1"; fi');
  stub("sudo", '[[ "$1" == "-u" && "$2" == sirius ]]; shift 2; exec "$@"');
  stub("systemctl", 'echo "FORBIDDEN_SYSTEMCTL" >> "$TEST_LOG"; exit 91');
  stub("install", `
echo install >> "$TEST_LOG"
directory=0
while [[ "$1" == -* ]]; do
  case "$1" in
    -d) directory=1; shift ;;
    -o|-g|-m) shift 2 ;;
    *) exit 92 ;;
  esac
done
if [[ "$directory" == 1 ]]; then mkdir -p "$@"; else cp "$1" "$2"; fi`);
  writeFileSync(path.join(app, ".venv", "bin", "python"), `#!/usr/bin/env bash
set -eu
echo "python $*" >> "$TEST_LOG"
if [[ "$1" == "-m" ]]; then
  [[ "\${TEST_PIP_FAIL:-0}" != 1 ]] || exit 93
  if [[ "$3" == show && "\${TEST_PIP_SHOW_FAIL:-0}" == 1 ]]; then exit 95; fi
  exit 0
fi
cat >/dev/null
[[ "\${TEST_SMOKE_FAIL:-0}" != 1 ]] || exit 94
echo "Mock model loading succeeded"
`, { mode: 0o755 });
  const env = {
    ...process.env, TEST_BIN: posix(bin), TEST_LOG: posix(log), TEST_DIGEST: digest,
    SIRIUS_APP_DIR: posix(app), SIRIUS_DATA_DIR: posix(data), SIRIUS_CONFIG_DIR: posix(config),
  };
  const run = (mode, extra = {}, source = posix(model)) => spawnSync(bash, [
    "--noprofile", "--norc", "-c",
    'export PATH="$TEST_BIN:$PATH"; exec bash "$SIRIUS_APP_DIR/deploy/hetzner/prepare-voice-identity.sh" "$@"',
    "test", mode, source,
  ], { env: { ...env, ...extra }, encoding: "utf8" });
  return {
    folder, app, config, data, model, run,
    calls: () => existsSync(log) ? readFileSync(log, "utf8") : "",
    approved: () => existsSync(path.join(config, "voice-identity.prepared")),
    configuration: () => readFileSync(path.join(config, "sirius.env"), "utf8"),
  };
}

test("all deployment shell scripts parse with Bash", () => {
  for (const script of ["prepare-voice-identity.sh", "install-voice-identity-runtime.sh", "deploy.sh", "setup.sh"]) {
    const result = spawnSync(bash, ["-n", posix(path.join(root, "deploy", "hetzner", script))], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("check is read-only and never installs or approves a runtime", () => {
  const f = fixture();
  const result = f.run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls(), "");
  assert.equal(f.approved(), false);
});

test("unknown options and relative model paths are rejected before changes", () => {
  const f = fixture();
  assert.equal(f.run("--activate").status, 2);
  assert.equal(f.run("--prepare", {}, "model.onnx").status, 1);
  assert.equal(f.calls(), "");
});

test("wrong source checksum refuses installation before any side effect", () => {
  const f = fixture();
  const result = f.run("--prepare", { TEST_DIGEST: "wrong" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Empreinte/);
  assert.equal(f.calls(), "");
  assert.equal(f.approved(), false);
});

test("the real SHA-256 command also rejects an untrusted model", () => {
  const f = fixture();
  rmSync(path.join(f.folder, "bin", "sha256sum"));
  const result = f.run("--prepare");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Empreinte/);
  assert.equal(f.calls(), "");
});

test("missing backend is refused before touching the environment", () => {
  const f = fixture();
  rmSync(path.join(f.app, "backend", "voice_identity_worker.py"));
  assert.equal(f.run("--prepare").status, 1);
  assert.equal(f.calls(), "");
});

test("preparation refuses non-root while read-only checks remain available", () => {
  const f = fixture();
  assert.equal(f.run("--check", { TEST_UID: "1000" }).status, 0);
  assert.equal(f.run("--prepare", { TEST_UID: "1000" }).status, 1);
  assert.equal(f.calls(), "");
});

test("successful mocked preparation approves runtime but never activates or restarts", () => {
  const f = fixture();
  const before = f.configuration();
  const result = f.run("--prepare");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.approved(), true);
  assert.equal(f.configuration(), before);
  assert.match(f.calls(), /-m pip install -r/);
  assert.match(f.calls(), /python - .*voice_identity_worker.py/);
  assert.doesNotMatch(f.calls(), /FORBIDDEN_SYSTEMCTL/);
  const installed = path.join(f.data, "models", "voice-identity", "wespeaker_en_voxceleb_resnet34_LM.onnx");
  assert.equal(readFileSync(installed, "utf8"), readFileSync(f.model, "utf8"));
});

test("a second preparation rechecks model loading without reinstalling unchanged requirements", () => {
  const f = fixture();
  assert.equal(f.run("--prepare").status, 0);
  assert.equal(f.run("--prepare").status, 0);
  assert.equal((f.calls().match(/-m pip install -r/g) || []).length, 1);
  assert.equal((f.calls().match(/python - .*voice_identity_worker.py/g) || []).length, 2);
});

test("a changed optional dependency manifest triggers installation again", () => {
  const f = fixture();
  assert.equal(f.run("--prepare").status, 0);
  // La commande de hash est simulée : changer sa sortie simule un nouveau manifeste.
  const hashStub = path.join(f.folder, "bin", "sha256sum");
  writeFileSync(hashStub, `#!/usr/bin/env bash
if [[ "$1" == *requirements-voice-identity.txt ]]; then echo "new-manifest $1"; else echo "${digest} $1"; fi
`, { mode: 0o755 });
  assert.equal(f.run("--prepare").status, 0);
  assert.equal((f.calls().match(/-m pip install -r/g) || []).length, 2);
});

test("a stale runtime marker cannot conceal a missing package", () => {
  const f = fixture();
  assert.equal(f.run("--prepare").status, 0);
  const result = f.run("--prepare", { TEST_PIP_SHOW_FAIL: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Moteur sherpa-onnx absent/);
  assert.equal((f.calls().match(/python - .*voice_identity_worker.py/g) || []).length, 1);
});

test("pip failure does not approve preparation or modify the service configuration", () => {
  const f = fixture();
  const before = f.configuration();
  assert.notEqual(f.run("--prepare", { TEST_PIP_FAIL: "1" }).status, 0);
  assert.equal(f.approved(), false);
  assert.equal(f.configuration(), before);
});

test("copied model checksum is verified again before publication", () => {
  const f = fixture();
  assert.equal(f.run("--prepare", { TEST_BAD_COPY: "1" }).status, 1);
  assert.equal(f.approved(), false);
  assert.equal(existsSync(path.join(f.data, "models", "voice-identity", "wespeaker_en_voxceleb_resnet34_LM.onnx")), false);
});

test("native model loading failure does not approve preparation", () => {
  const f = fixture();
  const before = f.configuration();
  assert.notEqual(f.run("--prepare", { TEST_SMOKE_FAIL: "1" }).status, 0);
  assert.equal(f.approved(), false);
  assert.equal(f.configuration(), before);
  assert.doesNotMatch(f.calls(), /FORBIDDEN_SYSTEMCTL/);
});

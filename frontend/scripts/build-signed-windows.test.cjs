const assert = require("node:assert/strict");
const { test } = require("node:test");
const { checkEnvironment, invokeSigning, signedConfig } = require("./build-signed-windows.cjs");

const env = {
  SIRIUS_SIGNTOOL_PATH: "C:\\Windows SDK\\signtool.exe",
  SIRIUS_SIGNING_THUMBPRINT: "A".repeat(40),
  SIRIUS_SIGNING_PUBLISHER: "SIRIUS Publisher",
};

test("signature obligatoire sans certificat ou sur une autre plateforme", () => {
  assert.throws(() => checkEnvironment({}, "win32"), /absente/);
  assert.throws(() => checkEnvironment(env, "linux"), /Windows/);
  assert.throws(() => checkEnvironment({ ...env, SIRIUS_SIGNING_THUMBPRINT: "bad" }, "win32"), /invalide/);
  checkEnvironment(env, "win32");
});

test("ne fournit que les surcharges de signature et laisse l'exe principal a electron-builder", async () => {
  const manifest = require("../package.json");
  const calls = [];
  const config = signedConfig(env, (...args) => calls.push(args));
  assert.equal(config.forceCodeSigning, true);
  // package.json "build" est fusionne par electron-builder : le repeter casse "publish".
  assert.equal(config.publish, undefined);
  assert.equal(config.win.target, undefined);
  assert.deepEqual(manifest.build.win.target, ["nsis", "portable"]);
  assert.equal(config.win.verifyUpdateCodeSignature, true);
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, ["sha256"]);
  assert.equal(config.win.signtoolOptions.publisherName, env.SIRIUS_SIGNING_PUBLISHER);
  await config.afterPack({ appOutDir: "C:\\app\\win-unpacked", packager: { appInfo: { productFilename: "ΣIRIUS" } } });
  await config.win.signtoolOptions.sign({ path: "C:\\app\\uninstall.exe" });
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ["Sign", "C:\\app\\win-unpacked"], ["Sign", "C:\\app\\uninstall.exe"],
  ]);
  assert.deepEqual(calls[0][5], ["ΣIRIUS.exe"]);
});

test("SignTool et erreurs de lancement ne peuvent pas donner un faux succes", () => {
  assert.throws(() => invokeSigning("Sign", "app.exe", env, () => ({ status: 1 })), /echouee/);
  assert.throws(() => invokeSigning("Sign", "app.exe", env, () => ({ status: null })), /echouee/);
  assert.throws(() => invokeSigning("Sign", "app.exe", env, () => ({ error: new Error("SDK absent") })), /SDK absent/);
  const calls = [];
  invokeSigning("Verify", "C:\\app path\\app.exe", env, (...args) => {
    calls.push(args);
    return { status: 0 };
  }, "C:\\report.json");
  assert.equal(calls[0][0], "powershell.exe");
  assert.ok(calls[0][1].includes("C:\\app path\\app.exe"));
  assert.ok(calls[0][1].includes("-ReportPath"));
  assert.ok(!calls[0][1].includes("-Exclude"));
  invokeSigning("Sign", "C:\\app", env, (...args) => {
    calls.push(args);
    return { status: 0 };
  }, undefined, ["ΣIRIUS.exe"]);
  assert.deepEqual(calls[1][1].slice(-2), ["-Exclude", "ΣIRIUS.exe"]);
  assert.equal(calls[0][2].env, env);
  assert.ok(!calls[0][1].includes(env.SIRIUS_SIGNING_THUMBPRINT));
});

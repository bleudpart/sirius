const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.NODE_ENV = "development";

const webpack = require("webpack");
const WebpackDevServer = require("webpack-dev-server");
const { prepareProxy } = require("react-dev-utils/WebpackDevServerUtils");
const createDevServerConfig = require("react-scripts/config/webpackDevServer.config");
const { devServer } = require("../craco.config");

test("preserves explicit host restrictions and rejects other invalid values", () => {
  for (const allowedHosts of ["all", "auto", ["192.0.2.10"], [null]]) {
    assert.deepEqual(devServer({ allowedHosts, https: false }).allowedHosts, allowedHosts);
  }
});

test("starts on loopback with a protected host and working CRA proxy", { timeout: 45000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sirius-dev-server-test-"));
  const entry = path.join(directory, "entry.js");
  fs.writeFileSync(entry, "console.log('test');\n");

  const backend = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ url: request.url, origin: request.headers.origin }));
  });
  let server;
  let started = false;
  const compiler = webpack({
    mode: "development",
    entry,
    output: { path: path.join(directory, "dist"), filename: "bundle.js", publicPath: "/" },
    infrastructureLogging: { level: "error" },
    stats: "errors-only",
  });

  t.after(async () => {
    try {
      if (started) await server.stop();
      else await new Promise((resolve, reject) => compiler.close((error) => error ? reject(error) : resolve()));
    } finally {
      if (backend.listening) {
        await new Promise((resolve, reject) => backend.close((error) => error ? reject(error) : resolve()));
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  await new Promise((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(0, "127.0.0.1", resolve);
  });
  const target = `http://127.0.0.1:${backend.address().port}`;
  const proxy = prepareProxy(target, path.resolve(__dirname, "../public"), "/");
  const config = devServer(createDevServerConfig(proxy, undefined));
  assert.equal(config.allowedHosts, "auto");

  Object.assign(config, {
    host: "127.0.0.1",
    port: 0,
    client: false,
    hot: false,
    liveReload: false,
    setupExitSignals: false,
  });
  server = new WebpackDevServer(config, compiler);
  await server.start();
  started = true;
  const url = `http://127.0.0.1:${server.server.address().port}`;

  const response = await fetch(`${url}/api/sirius-dev-probe`, {
    headers: { Accept: "application/json", Origin: url },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "/api/sirius-dev-probe", origin: target });

  const invalidHost = await new Promise((resolve, reject) => {
    const request = http.get(`${url}/api/sirius-dev-probe`, {
      headers: { Accept: "application/json", Host: "attacker.invalid" },
    }, (result) => {
      result.resume();
      result.once("end", () => resolve(result));
    });
    request.once("error", reject);
  });
  assert.equal(invalidHost.statusCode, 403);

  const shutdown = await fetch(`${url}/__sirius/shutdown`);
  assert.equal(shutdown.status, 405);

  const unauthorizedShutdown = await fetch(`${url}/__sirius/shutdown`, {
    method: "POST",
    headers: { Origin: "http://attacker.invalid", "X-Sirius-Shutdown": "1" },
  });
  assert.equal(unauthorizedShutdown.status, 403);
});

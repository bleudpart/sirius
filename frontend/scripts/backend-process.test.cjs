const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

function harness(readyAt) {
  let now = 0;
  const source = fs.readFileSync(path.join(__dirname, "../public/electron/backend_process.js"), "utf8");
  const context = {
    module: { exports: {} },
    Date: { now: () => now },
    setTimeout: (callback, delay) => { now += delay; callback(); },
    require: (name) => {
      if (name !== "http") return require(name);
      return {
        get: (_url, _options, callback) => {
          const request = new EventEmitter();
          queueMicrotask(() => {
            if (now < readyAt) { request.emit("error", new Error("Not ready")); return; }
            const response = new EventEmitter();
            response.statusCode = 200;
            response.setEncoding = () => {};
            callback(response);
            response.emit("data", JSON.stringify({ service: "sirius-backend" }));
            response.emit("end");
          });
          return request;
        },
      };
    },
  };
  vm.runInNewContext(source, context);
  return { ...context.module.exports, elapsed: () => now };
}

test("packaged backend may take more than 30 seconds to become ready", async () => {
  const backend = harness(45000);
  await backend.waitForHealth({ exitCode: null });
  assert.ok(backend.elapsed() >= 45000);
  assert.ok(backend.elapsed() < 120000);
});

test("startup timeout stays bounded at two minutes", async () => {
  const backend = harness(Infinity);
  await assert.rejects(backend.waitForHealth({ exitCode: null }), /délai prévu/);
  assert.ok(backend.elapsed() >= 120000);
  assert.ok(backend.elapsed() < 122000);
});

test("a backend that exits fails immediately instead of waiting", async () => {
  const backend = harness(Infinity);
  await assert.rejects(backend.waitForHealth({ exitCode: 1 }), /code 1/);
  assert.equal(backend.elapsed(), 0);
});

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const HEALTH_URL = "http://127.0.0.1:8001/health";
const HEALTH_TIMEOUT_MS = 30000;
let backendProcess = null;

function readHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const request = http.get(HEALTH_URL, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          const data = JSON.parse(body);
          resolve(response.statusCode === 200 && data.service === "sirius-backend");
        } catch {
          resolve(false);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function waitForHealth(child, timeoutMs = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Le backend SIRIUS s'est arrêté avec le code ${child.exitCode}.`);
    }
    if (await readHealth()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Le backend SIRIUS n'a pas répondu dans le délai prévu.");
}

async function startBackend({ resourcesPath, userDataPath }) {
  if (await readHealth()) return { reused: true };

  const executable = path.join(resourcesPath, "backend", "sirius-backend.exe");
  if (!fs.existsSync(executable)) {
    throw new Error(`Backend SIRIUS introuvable : ${executable}`);
  }

  fs.mkdirSync(userDataPath, { recursive: true });
  const logDescriptor = fs.openSync(path.join(userDataPath, "backend.log"), "a");
  backendProcess = spawn(executable, [], {
    cwd: userDataPath,
    env: {
      ...process.env,
      SIRIUS_DATA_DIR: userDataPath,
      SIRIUS_BACKEND_PORT: "8001",
      SIRIUS_PACKAGED: "1",
    },
    detached: false,
    windowsHide: true,
    stdio: ["ignore", logDescriptor, logDescriptor],
  });
  fs.closeSync(logDescriptor);

  try {
    await waitForHealth(backendProcess);
    return { reused: false, pid: backendProcess.pid };
  } catch (error) {
    stopBackend();
    throw error;
  }
}

function stopBackend() {
  if (!backendProcess || backendProcess.exitCode !== null) {
    backendProcess = null;
    return;
  }
  backendProcess.kill();
  backendProcess = null;
}

module.exports = {
  readHealth,
  startBackend,
  stopBackend,
  waitForHealth,
};

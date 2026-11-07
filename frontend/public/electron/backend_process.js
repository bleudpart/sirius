const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const HEALTH_URL = "http://127.0.0.1:8001/health";
const HEALTH_TIMEOUT_MS = 120000;
const HEALTH_POLL_MIN_MS = 120;
const HEALTH_POLL_MAX_MS = 1200;
const VOICE_MODEL_SHA256 = "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012";
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
  let delayMs = HEALTH_POLL_MIN_MS;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Le backend ΣIRIUS s'est arrêté avec le code ${child.exitCode}.`);
    }
    if (await readHealth()) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(HEALTH_POLL_MAX_MS, Math.round(delayMs * 1.6));
  }
  throw new Error("Le backend ΣIRIUS n'a pas répondu dans le délai prévu.");
}

async function startBackend({ resourcesPath, userDataPath }) {
  if (await readHealth()) return { reused: true };

  const executable = path.join(resourcesPath, "backend", "sirius-backend.exe");
  const voiceRuntime = path.join(resourcesPath, "backend", "_internal", "voice-runtime");
  const voiceModelPath = path.join(voiceRuntime, "model", "wespeaker_en_voxceleb_resnet34_LM.onnx");
  const ffmpegPath = path.join(voiceRuntime, "ffmpeg", "ffmpeg.exe");
  if (!fs.existsSync(executable)) {
    throw new Error(`Backend ΣIRIUS introuvable : ${executable}`);
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
      SIRIUS_VOICE_IDENTITY_MODEL_PATH: voiceModelPath,
      SIRIUS_VOICE_IDENTITY_MODEL_SHA256: VOICE_MODEL_SHA256,
      SIRIUS_VOICE_IDENTITY_FFMPEG: ffmpegPath,
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

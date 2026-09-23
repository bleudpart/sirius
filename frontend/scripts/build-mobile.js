const { spawnSync } = require("child_process");

const result = spawnSync("npm run build", {
  shell: true,
  stdio: "inherit",
  env: {
    ...process.env,
    REACT_APP_BACKEND_URL: "https://api.sirius-assistant.fr",
    REACT_APP_WS_URL: "wss://api.sirius-assistant.fr/api/ws",
  },
});

if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
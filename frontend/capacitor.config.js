const { CapacitorConfig } = require("@capacitor/cli");

/** @type {CapacitorConfig} */
const config = {
  appId: "fr.sirius_assistant.app",
  appName: "ΣIRIUS",
  webDir: "build",
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
};

module.exports = config;

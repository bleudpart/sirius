const { CapacitorConfig } = require("@capacitor/cli");

/** @type {CapacitorConfig} */
const config = {
  appId: "sh.techenclair.sirius",
  appName: "SIRIUS",
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

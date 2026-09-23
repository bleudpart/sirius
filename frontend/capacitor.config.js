const { CapacitorConfig } = require("@capacitor/cli");

/** @type {CapacitorConfig} */
const config = {
  appId: "sh.techenclair.sirius",
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

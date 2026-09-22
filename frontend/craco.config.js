// craco.config.js
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config();

// Electron charge le bundle via file:// : les URLs /api relatives ne peuvent
// pas passer par le proxy CRA. Une variable d'environnement explicite garde
// la surcharge de déploiement tout en donnant un backend local au bundle.
process.env.REACT_APP_BACKEND_URL ||= "http://127.0.0.1:8001";

// Check if we're in development/preview mode (not production build)
// Craco sets NODE_ENV=development for start, NODE_ENV=production for build
const isDevServer = process.env.NODE_ENV !== "production";

// Environment variable overrides
const config = {
  enableHealthCheck: process.env.ENABLE_HEALTH_CHECK === "true",
};

const LOCAL_SHUTDOWN_PATH = "/__sirius/shutdown";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SHUTDOWN_SCRIPT = path.resolve(__dirname, "..", "scripts", "stop-sirius.ps1");
const webpackDevServerMajor = Number(require("webpack-dev-server/package.json").version.split(".")[0]);

function isTrustedLocalShutdownRequest(req) {
  if (req.headers["x-sirius-shutdown"] !== "1") return false;

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;

  try {
    const originUrl = new URL(origin);
    return LOCAL_HOSTNAMES.has(originUrl.hostname) && originUrl.host === host;
  } catch {
    return false;
  }
}

function getBackendPort() {
  const backendUrl = new URL(process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001");
  if (backendUrl.port) return Number(backendUrl.port);
  return backendUrl.protocol === "https:" ? 443 : 80;
}

function addLocalShutdownMiddleware(middlewares) {
  middlewares.unshift({
    name: "sirius-local-shutdown",
    middleware: (req, res, next) => {
      if ((req.url || "").split("?")[0] !== LOCAL_SHUTDOWN_PATH) {
        return next();
      }

      if (req.method !== "POST") {
        res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Méthode non autorisée." }));
        return;
      }

      if (!isTrustedLocalShutdownRequest(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Requête d'arrêt locale non autorisée." }));
        return;
      }

      if (!fs.existsSync(SHUTDOWN_SCRIPT)) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Contrôleur d'arrêt SIRIUS introuvable." }));
        return;
      }

      let backendPort;
      try {
        backendPort = getBackendPort();
      } catch (error) {
        console.error("Configuration du backend SIRIUS invalide.", error);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Configuration du backend SIRIUS invalide." }));
        return;
      }

      const shutdownProcess = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          SHUTDOWN_SCRIPT,
          "-FrontendProcessId",
          String(process.pid),
          "-BackendPort",
          String(backendPort),
        ],
        { stdio: "ignore", windowsHide: true },
      );
      shutdownProcess.once("error", (error) => {
        console.error("Impossible de lancer le contrôleur d'arrêt SIRIUS.", error);
      });

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "stopping" }));
    },
  });

  return middlewares;
}

function makeDevServerV5Compatible(devServerConfig) {
  const {
    https,
    onAfterSetupMiddleware,
    onBeforeSetupMiddleware,
    onListening,
    setupMiddlewares,
    ...compatibleConfig
  } = devServerConfig;

  compatibleConfig.server =
    typeof https === "object"
      ? { type: "https", options: https }
      : https
        ? "https"
        : "http";
  compatibleConfig.headers = {
    ...compatibleConfig.headers,
    "Cross-Origin-Resource-Policy": "same-origin",
  };

  if (onBeforeSetupMiddleware || setupMiddlewares) {
    compatibleConfig.setupMiddlewares = (middlewares, devServer) => {
      if (onBeforeSetupMiddleware) {
        onBeforeSetupMiddleware(devServer);
      }

      return setupMiddlewares
        ? setupMiddlewares(middlewares, devServer)
        : middlewares;
    };
  }

  compatibleConfig.onListening = (devServer) => {
    devServer.close ??= (callback) => devServer.stopCallback(callback);

    if (onListening) {
      onListening(devServer);
    }
    if (onAfterSetupMiddleware) {
      onAfterSetupMiddleware(devServer);
    }
  };

  return compatibleConfig;
}

// Conditionally load health check modules only if enabled
let WebpackHealthPlugin;
let setupHealthEndpoints;
let healthPluginInstance;

if (config.enableHealthCheck) {
  WebpackHealthPlugin = require("./plugins/health-check/webpack-health-plugin");
  setupHealthEndpoints = require("./plugins/health-check/health-endpoints");
  healthPluginInstance = new WebpackHealthPlugin();
}

let webpackConfig = {
  eslint: {
    configure: {
      extends: ["plugin:react-hooks/recommended"],
      rules: {
        "react-hooks/rules-of-hooks": "error",
        "react-hooks/exhaustive-deps": "warn",
      },
    },
  },
  webpack: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    configure: (webpackConfig) => {
      // Add ignored patterns to reduce watched directories
        webpackConfig.watchOptions = {
          ...webpackConfig.watchOptions,
          ignored: [
            '**/node_modules/**',
            '**/.git/**',
            '**/build/**',
            '**/dist/**',
            '**/coverage/**',
            '**/public/**',
        ],
      };

      // Add health check plugin to webpack if enabled
      if (config.enableHealthCheck && healthPluginInstance) {
        webpackConfig.plugins.push(healthPluginInstance);
      }
      return webpackConfig;
    },
  },
  jest: {
    configure: {
      // Aligne Jest sur l'alias webpack '@' → src
      moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/src/$1",
      },
    },
  },
};

webpackConfig.devServer = (devServerConfig) => {
  const originalSetupMiddlewares = devServerConfig.setupMiddlewares;

  devServerConfig.setupMiddlewares = (middlewares, devServer) => {
    if (originalSetupMiddlewares) {
      middlewares = originalSetupMiddlewares(middlewares, devServer) || middlewares;
    }

    if (config.enableHealthCheck && setupHealthEndpoints && healthPluginInstance) {
      setupHealthEndpoints(devServer, healthPluginInstance);
    }

    return isDevServer ? addLocalShutdownMiddleware(middlewares) : middlewares;
  };

  return devServerConfig;
};

// Compatibilité dev server v5
const configureDevServer = webpackConfig.devServer;
webpackConfig.devServer = (devServerConfig) =>
  webpackDevServerMajor >= 5
    ? makeDevServerV5Compatible(configureDevServer(devServerConfig))
    : configureDevServer(devServerConfig);

module.exports = webpackConfig;

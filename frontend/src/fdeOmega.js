const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const REPORT_THROTTLE_MS = 120000;

const EMPTY_METRICS = Object.freeze({
  active: false,
  cls: 0,
  layoutShiftCount: 0,
  longTaskCount: 0,
  worstLongTaskMs: 0,
  updatedAt: null,
});

let metrics = EMPTY_METRICS;
let cleanupCurrent = null;
const lastReport = { layout: 0, longTask: 0 };
const reported = { layout: false, longTask: false };

export function accumulateFdeMetrics(current, entries) {
  let cls = current.cls || 0;
  let layoutShiftCount = current.layoutShiftCount || 0;
  let longTaskCount = current.longTaskCount || 0;
  let worstLongTaskMs = current.worstLongTaskMs || 0;

  entries.forEach((entry) => {
    if (entry.entryType === "layout-shift" && !entry.hadRecentInput) {
      cls += Number(entry.value) || 0;
      layoutShiftCount += 1;
    } else if (entry.entryType === "longtask") {
      longTaskCount += 1;
      worstLongTaskMs = Math.max(worstLongTaskMs, Number(entry.duration) || 0);
    }
  });

  return {
    active: true,
    cls: Number(cls.toFixed(4)),
    layoutShiftCount,
    longTaskCount,
    worstLongTaskMs: Math.round(worstLongTaskMs),
    updatedAt: new Date().toISOString(),
  };
}

function reportPerformanceIssue(kind, message) {
  if (reported[kind]) return;
  const now = Date.now();
  if (now - lastReport[kind] < REPORT_THROTTLE_MS) return;
  lastReport[kind] = now;
  reported[kind] = true;
  fetch(`${API}/argus/report`, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "fde_omega", message }),
  }).catch((error) => {
    console.warn("FDE_OMEGA: rapport de performance non transmis.", error);
  });
}

function publish(nextMetrics) {
  metrics = Object.freeze({ ...nextMetrics });
  window.__siriusFdeOmega = metrics;
  window.dispatchEvent(new CustomEvent("sirius:fde-metrics", { detail: metrics }));
  // Formulation volontairement neutre (sans « error »/« échec ») : ARGUS classe la sévérité
  // par simple présence de mots-clés dans le message (voir omega_engine.py::_severity). Un
  // franchissement de seuil de performance n'est qu'une mesure informative, pas une panne —
  // avec le mot « error », il était classé « sévère » et déclenchait à tort une annonce
  // vocale + une alerte modale à chaque petit ralentissement ponctuel du rendu 3D.
  if (metrics.cls >= 0.25) {
    reportPerformanceIssue("layout", `Frontend : décalage visuel notable détecté (CLS ${metrics.cls}).`);
  }
  if (metrics.worstLongTaskMs >= 500) {
    reportPerformanceIssue(
      "longTask",
      `Frontend : ralentissement ponctuel du rendu, tâche principale occupée ${metrics.worstLongTaskMs} ms.`,
    );
  }
}

export function getFdeMetrics() {
  return metrics;
}

export function reportFdeCrash(error, componentStack = "") {
  const message = error?.message || String(error || "Crash React inconnu");
  fetch(`${API}/argus/report`, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "fde_omega",
      message: `Frontend fatal crash: ${message}`.slice(0, 300),
      stack: `${error?.stack || ""}\n${componentStack}`.slice(0, 500),
    }),
  }).catch((reportError) => {
    console.warn("FDE_OMEGA: crash non transmis à ARGUS.", reportError);
  });
}

export function initFdeOmega() {
  if (cleanupCurrent) return cleanupCurrent;
  const observers = [];
  publish({ ...EMPTY_METRICS, active: true, updatedAt: new Date().toISOString() });

  if (typeof PerformanceObserver !== "undefined") {
    const supported = PerformanceObserver.supportedEntryTypes || [];
    ["layout-shift", "longtask"].forEach((type) => {
      if (!supported.includes(type)) return;
      const observer = new PerformanceObserver((list) => {
        publish(accumulateFdeMetrics(metrics, list.getEntries()));
      });
      observer.observe({ type, buffered: true });
      observers.push(observer);
    });
  }

  document.documentElement.dataset.fdeOmega = "active";
  cleanupCurrent = () => {
    observers.forEach((observer) => observer.disconnect());
    delete document.documentElement.dataset.fdeOmega;
    cleanupCurrent = null;
  };
  return cleanupCurrent;
}

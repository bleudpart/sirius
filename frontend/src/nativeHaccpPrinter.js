import { Capacitor, registerPlugin } from "@capacitor/core";

export const androidHaccpPrinter = registerPlugin("SiriusHaccpPrinter");
export const isAndroidHaccp = () => Capacitor.getPlatform() === "android";
export const hasAndroidHaccpPrinter = () => isAndroidHaccp() && Capacitor.isPluginAvailable("SiriusHaccpPrinter");

export function validateAndroidPrinter(config) {
  const parts = typeof config.ip === "string" ? config.ip.split(".") : [];
  const ip = parts.map(Number);
  if (parts.length !== 4 || parts.some((p, i) => !/^(0|[1-9]\d{0,2})$/.test(p) || ip[i] > 255)
      || !(ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168))
      || ip[3] === 0 || ip[3] === 255) {
    throw new Error("Indiquez une IPv4 privée LAN (10.x, 172.16–31.x ou 192.168.x), sans URL.");
  }
  if (config.model !== "QL-820NWB" || config.roll !== "DK-22205" || config.widthMm !== 62 || config.heightMm !== 50) {
    throw new Error("Seuls Brother QL-820NWB, rouleau DK-22205 et format 62 × 50 mm sont pris en charge.");
  }
  return config;
}

export async function printAndroidOpening(labelId, request) {
  if (!hasAndroidHaccpPrinter()) throw new Error("Pont Brother absent : une nouvelle compilation Android est nécessaire.");
  const config = validateAndroidPrinter(await androidHaccpPrinter.getConfig());
  if (!config.enabled) throw new Error("Configurez et activez d’abord l’imprimante Android.");
  if (config.networkGranted === false) throw new Error("Autorisez l’accès au réseau local dans la configuration Android avant impression.");
  const identity = { device_id: config.deviceId };
  const state = await request("/android/demandes", { ...identity, label_id: labelId, reviewed: true });
  if (state.transport !== "android" || state.status !== "pending") return state;
  const claimed = await request(`/android/demandes/${state.id}/prise`, identity);
  if (!claimed.job) return claimed.state || { ...state, status: "uncertain" };
  if (claimed.job.id !== state.id || claimed.job.labelId !== labelId) {
    throw new Error("Demande serveur incohérente. Aucun envoi à l’imprimante.");
  }
  let result;
  try {
    result = await androidHaccpPrinter.printJob({ job: claimed.job });
  } catch (failure) {
    result = { accepted: false, detail: failure.message || "Pont Brother non confirmé." };
  }
  try {
    return await request(`/android/demandes/${state.id}/confirmation`, {
      ...identity, status: result?.accepted === true ? "accepted" : "uncertain",
      detail: String(result?.detail || "Résultat natif non confirmé.").slice(0, 500),
    });
  } catch (failure) {
    throw new Error(`Confirmation serveur perdue : vérifiez le papier, ne réimprimez pas. ${failure.message}`);
  }
}

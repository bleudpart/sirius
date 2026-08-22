import { isHudVideoModule } from "./hud_video";

function assertOpenableMediaModule(mediaModule) {
  if (!mediaModule || typeof mediaModule.url !== "string" || !mediaModule.url.startsWith("https://")) {
    throw new Error("Le module multimédia ne fournit pas d'adresse sécurisée.");
  }
}

export function getHudMediaActionLabel(mediaModule) {
  return isHudVideoModule(mediaModule) ? "OUVRIR LA PLATEFORME VIDÉO" : "OUVRIR LE SERVICE AUDIO";
}

export function openHudMediaModule(mediaModule) {
  assertOpenableMediaModule(mediaModule);
  const openedWindow = window.open(mediaModule.url, "_blank");

  if (!openedWindow) {
    throw new Error("L'ouverture de la plateforme a été bloquée par le navigateur.");
  }

  openedWindow.opener = null;
}

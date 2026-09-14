// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Logique pure du HUD : états visuels, réponses locales instantanées,
// détection d'intention, météo WMO et bip talkie-walkie.
import { Sun, Cloud, CloudRain, CloudSnow, CloudFog, CloudLightning } from "lucide-react";

import { formatLocalDate, formatLocalTime } from "@/dateTime";

export const STATES = {
  idle: { label: "EN VEILLE", color: "#91e6f2", glow: "#0ea5b7" },
  listening: { label: "À L'ÉCOUTE", color: "#38bdf8", glow: "#0284c7" },
  thinking: { label: "RÉFLEXION", color: "#d8b875", glow: "#d97706" },
  speaking: { label: "EN RÉPONSE", color: "#5eead4", glow: "#14b8a6" },
};

// Réponses locales instantanées (heure / date exactes uniquement)
export const CLOUD_RETRY_MSG = "Mon cerveau cloud est momentanément injoignable. Je n'ai exécuté aucune action distante. Réessaie dans un instant.";

export const isLocalTimeQuestion = (command) => {
  const normalized = String(command || "")
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’']/g, " ");
  const asksTime = /\b(quelle heure|donne moi l heure|heure actuelle|il est quelle heure|il est combien|heure il est)\b/.test(normalized);
  const asksForeignTime = /\bheure(?:\s+est il)?\s+a\s+\S+/.test(normalized);
  return asksTime && !asksForeignTime;
};

export function localAnswer(c) {
  const command = String(c || "").trim();
  const normalized = command
    .toLocaleLowerCase("fr-FR")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’']/g, " ");
  const nowLocal = new Date();
  const timeLocal = formatLocalTime(nowLocal);
  if (isLocalTimeQuestion(command)) return `Il est ${timeLocal}.`;
  if (/(quel jour|quelle date|on est le|on est quel)/.test(normalized))
    return `Nous sommes le ${formatLocalDate(nowLocal)}.`;
  if (/(bonjour|bonsoir|salut|coucou|hello)/.test(normalized)) return `Bonjour. Tous mes systèmes sont en ligne.`;
  if (/(ca va|comment vas|comment tu vas|tu vas bien)/.test(normalized)) return `Je fonctionne parfaitement. Merci de demander.`;
  if (/(merci)/.test(normalized)) return `Je vous en prie. C'est un plaisir.`;
  if (/(ton nom|qui es tu|comment tu t appelles|c est quoi ton nom)/.test(normalized)) return `Je suis Sirius, votre assistant personnel.`;
  if (/(ton createur|qui t a cree|qui ta cree)/.test(normalized)) return `J'ai été créé par Partel.`;
  if (/(au revoir|a bientot|bonne nuit)/.test(normalized)) return `À ton service. À très bientôt.`;
  if (/(arrete|stop|silence|tais toi|coupe la musique)/.test(normalized)) return `Je n'ai pas pu joindre le cerveau distant, mais aucune action n'a été envoyée.`;
  if (/(envoie|envoyer|ecris|mail|email|courriel)/.test(normalized)) return `Je n'ai pas pu préparer cet e-mail : le cerveau distant est indisponible. Aucun message n'a été envoyé.`;
  if (/(contact|numero de telephone|adresse email)/.test(normalized)) return `Je n'ai pas pu charger les contacts : le cerveau distant est indisponible.`;
  if (/(calendrier|agenda|rendez vous|evenement)/.test(normalized)) return `Je n'ai pas pu consulter le calendrier : le cerveau distant est indisponible.`;
  if (/(eteins|allume|lumiere|salon|chambre|cuisine|prise|volet)/.test(normalized)) return `Je n'ai pas pu joindre la domotique. Aucune commande n'a été exécutée.`;
  if (/(meteo|temps qu il fait|il fait quel temps)/.test(normalized)) return `Je n'ai pas pu consulter la météo en temps réel.`;
  return `${CLOUD_RETRY_MSG} Demande reçue : ${command || "commande vide"}.`;
}

// Détection d'intention pour afficher la bonne carte holographique
export function detectIntent(c) {
  // Heure locale uniquement — « quelle heure à Tokyo » part vers l'IA (fuseau étranger)
  if (/(quelle heure|l'heure|il est combien|heure il est)/.test(c) && !/heure\s+(est[- ]il\s+)?[àa]\s+\S/.test(c)) return "time";
  if (/(quel jour|quelle date|on est le|on est quel|date du jour)/.test(c)) return "date";
  if (/(m[ée]t[ée]o|temps qu'il fait|il fait quel temps|quel temps|temp[ée]rature dehors|il fait combien)/.test(c)) return "weather";
  if (/(cpu|processeur|ram|m[ée]moire|syst[èe]me|performance|diagnostic)/.test(c)) return "system";
  return null;
}

// Code météo WMO → libellé + icône lucide
export function weatherInfo(code) {
  if (code === 0) return { label: "Ciel dégagé", Icon: Sun };
  if (code >= 1 && code <= 3) return { label: "Partiellement nuageux", Icon: Cloud };
  if (code === 45 || code === 48) return { label: "Brouillard", Icon: CloudFog };
  if (code >= 51 && code <= 67) return { label: "Pluie", Icon: CloudRain };
  if (code >= 71 && code <= 77) return { label: "Neige", Icon: CloudSnow };
  if (code >= 80 && code <= 82) return { label: "Averses", Icon: CloudRain };
  if (code >= 95) return { label: "Orage", Icon: CloudLightning };
  return { label: "Couvert", Icon: Cloud };
}

// Bip talkie-walkie : chirp montant à l'activation, descendant à la release
export function pttBeep(release) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.05, t);
    if (release) {
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(320, t + 0.13);
    } else {
      o.frequency.setValueAtTime(520, t);
      o.frequency.setValueAtTime(1040, t + 0.07);
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
    o.start(t);
    o.stop(t + 0.19);
    o.onended = () => { try { ctx.close(); } catch (e) {} };
  } catch (e) {}
}

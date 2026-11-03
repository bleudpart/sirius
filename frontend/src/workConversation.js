import { isChronosCommand } from "./chronos";

export function isHaccpActivityCommand(command) {
  const text = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'").toLowerCase().trim();
  return /\betiquettes?\b/.test(text)
    && (/\b(?:combien|nombre|total)(?:\s+total)?\s+(?:(?:d[' ]|des?\s+)(?:(?:mes|nos|les)\s+)?)?etiquettes?\b/.test(text)
      || /\b(?:compteurs?|comptage|statistiques?|stats|bilan|rapport)\b/.test(text)
      || /\bcombien\b.*\b(?:edite\w*|imprime\w*|enregistre\w*|cree\w*)\b.*\betiquettes?\b/.test(text)
      || /\bcompte\s+(?:les|mes|nos|toutes les)\s+etiquettes?\b/.test(text))
    && !/\b(?:prix|couts?|coute\w*)\b|\bcombien\s+(?:de\s+)?(?:temps|jours?|heures?)\b/.test(text);
}

export function isHaccpClosingCommand(command) {
  const text = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'").toLowerCase().trim();
  return /\b(?:bilan|rapport|point|cloture)\b.*\b(?:fin de service|fermeture|cloture)\b/.test(text)
    || /\b(?:fais|faites|faire|prepare|preparer)\s+(?:le\s+)?point\s+(?:avant|de)\s+(?:la\s+)?(?:fermeture|fin de service)\b/.test(text)
    || /\b(?:bilan|rapport)\s+haccp\s+(?:du jour|journalier|quotidien)\b/.test(text);
}

const HACCP_ACTIVITY_DATE = "(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4})";
const HACCP_ACTIVITY_PERIOD_REPLY = new RegExp(
  `^(?:(?:pour|sur|et)\\s+)?(?:aujourd[' ]?hui|hier|avant[- ]hier|ce jour|du jour|cette semaine|(?:la\\s+)?semaine derniere|ce mois(?:[- ]ci)?|(?:le\\s+)?mois dernier|(?:les?\\s+)?(?:\\d+|sept|quatorze|quinze|trente)\\s+derniers?\\s+jours?|du\\s+${HACCP_ACTIVITY_DATE}\\s+au\\s+${HACCP_ACTIVITY_DATE}|(?:le\\s+)?${HACCP_ACTIVITY_DATE})(?:\\s+(?:merci|svp|s[' ]il (?:te|vous) plait))?[\\s.!?]*$`,
);

export function haccpActivityFollowup(command, pending) {
  if (typeof pending !== "string" || !pending.trim()) return null;
  const text = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'").toLowerCase().trim();
  return HACCP_ACTIVITY_PERIOD_REPLY.test(text) ? `${pending} ${String(command).trim()}` : null;
}

export function isFinanceConversationCommand(command) {
  const text = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'").toLowerCase().trim();
  if (/^(?:confirme finance|suivi financier|reprends analyse) [a-f0-9]{32}[.!? ]*$/.test(text)) return true;
  const namedAsset = /\b(?:apple|microsoft|nvidia|tesla)\b/.test(text)
    && /\b(?:analys\w*|compare|cours|action|bourse|alerte|surveille|previens|avertis|pourquoi|achete|vends|vaut|prix|dettes?|benefices?|dividendes?|resultats|rentable|capitalisation|fondamentaux)\b/.test(text);
  const referencedAsset = /\b(?:compare|pourquoi|cours)\b.*\b(?:cette action|ces (?:trois )?actions)\b/.test(text);
  return !/\b(?:ouvre|ouvrir|ferme|fermer)\b/.test(text)
    && (/\b(?:portus|nummarius|portefeuille|financieres?|boursieres?|boursier|aapl|msft|nvda|tsla)\b/.test(text) || namedAsset || referencedAsset);
}

export function isWorkConversationCommand(command) {
  if (isFinanceConversationCommand(command)) return true;
  const text = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'").toLowerCase().trim();
  if (/^(?:(?:suivi|reprends|arrete|confirme) parcours\b|prepare le parcours de relance\b)/.test(text)
    || /^rappelle[- ]moi\b/.test(text)
    || /^(?:montre |affiche )?(?:mes resultats de travail|mes parcours a traiter|mes rappels sirius)[.!?]*$/.test(text)) return true;
  if (/\b(?:liste|montre|affiche)\b.*\benregistrements\b.*\bbrouillons\b/.test(text)) return true;
  if (/\b(?:enregistre|enregistrer)\b.*\b(?:brouillons?|preparations?|relances?)\b/.test(text)) return true;
  if (/\b(?:confirme|reprends|reprendre|etat|suivi)\b.*\benregistrement\b/.test(text)) return true;
  if (/^(?:confirme|annule) la previsualisation de relance[\s.!?]*$/.test(text)) return true;
  if (/^(?:oublie|efface) (?:le contexte de |le contexte du )?(?:ce dossier|dossier courant)[.!?]*$/.test(text)) return true;
  if (/\b(?:ouvre|ouvrir|ferme|fermer)\b/.test(text)) return false;
  return /\b(?:prepare|preparer)\s+(?:la|une)\s+relance\b/.test(text)
    || /\b(?:ou en (?:est|sont)|resume|resumer|compare|comparer|fais le point|prepare|preparer|retrouve|rechercher|cherche|explique|pourquoi|envoie|envoyer|supprime|supprimer|cree|creer|transforme|surveille|planifie|relance)\b.*\b(?:dossiers?|clients?|factures?|devis|propositions?)\b/.test(text)
    || /\b(?:qu'est[- ]ce qui|ce qui|quels changements|montre les changements)\b.*\b(?:change|visite|dossier)\b/.test(text)
    || /\b(?:ce dossier|ce client|cette facture|ce devis|le dernier devis|ces propositions)\b/.test(text)
    || /\b(?:mes|les|quels|liste|affiche|montre)\b.*\bdossiers\b/.test(text)
    || /\b(?:a traiter|dois[- ]je traiter|dois traiter|mes priorites|mes validations|en attente de validation)\b/.test(text);
}

export function workPreviewFollowup(command, pending) {
  if (!pending) return null;
  const text = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'").toLowerCase().trim();
  if (/^(?:oui(?:[, ]+je confirme)?|je confirme|confirme|vas-y|envoie(?:-la|-les| tout| les relances)?)[\s.!?]*$/.test(text)) {
    return "Confirme la prévisualisation de relance";
  }
  if (/^(?:non|annule|laisse tomber)[\s.!?]*$/.test(text)) return "Annule la prévisualisation de relance";
  return null;
}

export const isOperationalCommand = (command) => isHaccpClosingCommand(command) || isHaccpActivityCommand(command) || isChronosCommand(command) || isWorkConversationCommand(command);

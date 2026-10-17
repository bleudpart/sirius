import { isChronosCommand } from "./chronos";

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

export const isOperationalCommand = (command) => isChronosCommand(command) || isWorkConversationCommand(command);

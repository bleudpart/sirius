import { isChronosCommand } from "./chronos";

export function isWorkConversationCommand(command) {
  const text = String(command || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/’/g, "'").toLowerCase().trim();
  if (/^(?:oublie|efface) (?:le contexte de |le contexte du )?(?:ce dossier|dossier courant)[.!?]*$/.test(text)) return true;
  if (/\b(?:ouvre|ouvrir|ferme|fermer)\b/.test(text)) return false;
  return /\b(?:ou en (?:est|sont)|resume|resumer|compare|comparer|fais le point|prepare|preparer|retrouve|rechercher|cherche|explique|pourquoi|envoie|envoyer|supprime|supprimer|cree|creer|transforme|surveille|planifie|relance)\b.*\b(?:dossiers?|clients?|factures?|devis|propositions?)\b/.test(text)
    || /\b(?:qu'est[- ]ce qui|ce qui|quels changements|montre les changements)\b.*\b(?:change|visite|dossier)\b/.test(text)
    || /\b(?:ce dossier|ce client|cette facture|ce devis|le dernier devis|ces propositions)\b/.test(text)
    || /\b(?:mes|les|quels|liste|affiche|montre)\b.*\bdossiers\b/.test(text)
    || /\b(?:a traiter|dois[- ]je traiter|dois traiter|mes priorites|mes validations|en attente de validation)\b/.test(text);
}

export const isOperationalCommand = (command) => isChronosCommand(command) || isWorkConversationCommand(command);

import { useState } from "react";

export default function AgentMissionForm({ disabled, onPrepare }) {
  const [objective, setObjective] = useState("");
  const [context, setContext] = useState("");
  const [roles, setRoles] = useState(["documents", "messagerie", "planning"]);
  return <fieldset disabled={disabled}>
    <legend>SIRIUS · délégation à des sous-agents IA</legend>
    <p>Cerebras uniquement : jusqu'à trois spécialistes en parallèle puis une synthèse SIRIUS.
      Quatre appels maximum, aucune relance automatique, 30 secondes par mission.
      Les quotas et tarifs de votre compte s'appliquent : ce n'est pas le laboratoire à 0 €.</p>
    <p>Une boucle locale contrôle chaque réponse en deux passes maximum : normalisation des fins de ligne et espaces,
      refus d'un texte vide, trop long, de balises internes ou d'un bloc de code non fermé.
      Aucun appel IA de correction supplémentaire et aucune garantie sur l'exactitude des faits.</p>
    <p>Seuls l'objectif et le contexte ci-dessous seront transmis. Ne saisissez ni secret ni donnée sensible.
      Aucun accès automatique à vos documents, mails ou agenda ; aucune action exécutée.
      Objectif, contexte et résultats seront conservés dans le journal de votre compte.</p>
    <label>Objectif de la mission <input maxLength={1000} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
    <label>Contexte volontairement fourni <textarea rows={5} maxLength={12000} value={context}
      onChange={(event) => setContext(event.target.value)} /></label>
    {[["documents", "THOT · analyse du texte"], ["messagerie", "HERMÈS · brouillon de message"],
      ["planning", "CHRONOS · proposition de planning"]].map(([id, label]) => <label key={id}>
      <input type="checkbox" checked={roles.includes(id)} onChange={(event) =>
        setRoles((previous) => event.target.checked ? [...previous, id] : previous.filter((role) => role !== id))} />{label}
    </label>)}
    <button type="button" disabled={!objective.trim() || !roles.length} onClick={() => onPrepare({
      title: objective.trim().slice(0, 300), steps: [{ id: "delegation", action: "agents.mission",
        inputs: { objective: objective.trim(), context, specialists: roles } }],
    })}>Préparer cette délégation sans appel IA</button>
    <p>Après préparation, relisez les entrées et autorisez l'étape « delegation » pour lancer les appels.
      L'arrêt du parcours bloque les appels non engagés, sans garantir l'annulation ni le remboursement d'un appel déjà parti.</p>
  </fieldset>;
}

import { useState } from "react";

export default function MicroToolForm({ disabled, onPrepare }) {
  const [objective, setObjective] = useState("");
  const [data, setData] = useState('"  Bonjour  "');
  const [examples, setExamples] = useState('[{"input":"  exemple  ","expected":"exemple"}]');
  const [error, setError] = useState("");
  const prepare = () => {
    try {
      const parsedData = JSON.parse(data);
      const tests = JSON.parse(examples);
      if (!objective.trim() || !Array.isArray(tests) || !tests.length || tests.length > 5 ||
          tests.some((item) => !item || Array.isArray(item) || typeof item !== "object" ||
            !Object.hasOwn(item, "input") || !Object.hasOwn(item, "expected") ||
            Object.keys(item).some((key) => !["input", "expected"].includes(key))))
        throw new Error("Un objectif et un à cinq exemples JSON avec input et expected sont requis.");
      onPrepare({ title: objective.trim().slice(0, 300), steps: [{
        id: "micro_outil", action: "microtools.compile",
        inputs: { objective: objective.trim(), data: parsedData, examples: tests },
      }] });
      setError("");
    } catch (cause) {
      setError(cause instanceof SyntaxError ? "Données ou exemples JSON illisibles ; rien n'a été préparé." : cause.message);
    }
  };
  return <fieldset disabled={disabled}>
    <legend>Micro-outils · planifier, compiler, vérifier</legend>
    <p>Un programme JSON fermé, pas un script Python/JavaScript ni un bac à sable système.
      Opérations : strip, lower, upper, lines, split/join, replace littéral, unique, sort,
      column, filter_equals, sum et count. Pipeline linéaire : douze étapes maximum.
      Aucun fichier, réseau, shell, installation ou modification de SIRIUS.</p>
    <p>Après votre autorisation dans le parcours : planificateur, codeur, tests sur vos exemples,
      une correction maximum si nécessaire, puis vérificateur avant application aux données.
      Cerebras uniquement, trois appels normalement, quatre maximum, trente secondes au total.
      Aucune relance fournisseur automatique ; quotas et tarifs de votre compte applicables.</p>
    <p>Fournissez des exemples représentatifs et leurs résultats attendus : ils ne seront pas changés par les agents.
      Les tests ne prouvent pas une correction générale. Les calculs décimaux ne sont pas un moteur comptable exact.</p>
    <p>Objectif, données et exemples sont transmis à Cerebras après confirmation et conservés dans votre journal ARIANE.
      Ne fournissez ni secrets ni données sensibles. Limites par valeur : 16 000 octets JSON UTF-8,
      8 000 caractères de texte, 200 éléments par liste, quatre niveaux.</p>
    <label>Objectif du micro-outil <input maxLength={1000} value={objective} onChange={(event) => setObjective(event.target.value)} /></label>
    <label>Données JSON à traiter <textarea rows={4} maxLength={16000} value={data} onChange={(event) => setData(event.target.value)} /></label>
    <label>Exemples JSON attendus <textarea rows={5} maxLength={60000} value={examples} onChange={(event) => setExamples(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={!objective.trim()} onClick={prepare}>Préparer ce micro-outil sans appel IA</button>
    <p>Cette préparation remplit seulement le formulaire. Démarrez le parcours puis relisez les entrées et autorisez
      uniquement l'étape « micro_outil ». Arrêter le parcours empêche les phases suivantes, sans annuler un appel déjà engagé.</p>
  </fieldset>;
}

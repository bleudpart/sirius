export function explainStartupDiagnostic(report) {
  if (!report?.checks?.length) return "Je n'ai pas de résultat de contrôle du démarrage pour cette session. Je ne peux pas attribuer une cause sans mesure.";
  const rows = report.checks.map(({ label, state, success, scope }) =>
    `${label} : ${state === true ? success || "contrôle réussi" : state === false ? "indisponible" : "non vérifié"}. ${scope || ""}`);
  const failures = report.checks.filter(({ state }) => state === false);
  return [
    `Voici les contrôles de ma présentation, relevés à ${report.measuredAt}.`,
    ...rows,
    report.presentationError || "",
    failures.length ? "Ces contrôles constatent une indisponibilité, pas sa cause exacte. Vérifiez la connexion pour le serveur et les permissions pour le micro ; cela reste à confirmer par un nouveau test."
      : "Aucun échec n'a été relevé dans ces contrôles limités. Cela ne garantit pas que toutes les fonctions marchent.",
  ].filter(Boolean).join("\n");
}

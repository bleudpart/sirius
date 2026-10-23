import { escapeDocumentText as escape } from "./haccpDocuments";
import { formatDocumentDate } from "./dateTime";

export const riskPriority = (risk) => {
  const score = Number(risk.gravite) * Number(risk.probabilite);
  return { score, label: score >= 12 ? "Haute" : score >= 6 ? "Moyenne" : "Basse" };
};
export const DUERP_STATUS = { a_faire: "À faire", en_cours: "En cours", realisee: "Réalisée (déclarée)" };

export function duerpPrintHtml(document) {
  const cell = (value) => escape(value || "À compléter").replace(/\n/g, "<br>");
  const date = (value) => cell(value ? formatDocumentDate(value) : "");
  const rows = document.risques.length ? document.risques : Array.from({ length: 6 }, () => ({}));
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>DUERP — ${escape(document.etablissement)}</title>
<style>
@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font:11px Arial,sans-serif;color:#111;background:#fff}
h1{font-size:20px}h2{font-size:14px}p{line-height:1.5}table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{border:1px solid #444;padding:5px;vertical-align:top;overflow-wrap:anywhere;white-space:normal}
th{background:#eee}thead{display:table-header-group}tr{break-inside:avoid}.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.signature{margin-top:20px;min-height:45px}.note{font-size:10px}
</style></head><body>
<h1>Document unique d'évaluation des risques professionnels (DUERP)</h1>
<div class="meta"><div><b>Établissement :</b> ${cell(document.etablissement)}</div>
<div><b>Employeur / responsable :</b> ${cell(document.employeur)}</div>
<div><b>Adresse :</b> ${cell(document.adresse)}</div><div><b>Effectif :</b> ${document.effectif == null ? "À compléter" : escape(document.effectif)}</div>
<div><b>Date d'évaluation :</b> ${date(document.date_evaluation)}</div>
<div><b>Participants à l'évaluation :</b> ${cell(document.participants)}</div></div>
<p><b>Motif de création / révision :</b> ${cell(document.motif_revision)}<br>
<b>Version enregistrée :</b> ${cell(document.id)} · enregistrée le ${date(document.created_at)}</p>
<h2>Évaluation par unité de travail et plan d'actions de prévention</h2>
<p class="note">Gravité : 1 faible, 2 significative, 3 grave, 4 très grave. Probabilité : 1 peu probable,
2 possible, 3 probable, 4 très probable. Score = gravité × probabilité.
Priorité : 1–5 basse, 6–11 moyenne, 12–16 haute. Grille interne indicative, non réglementaire.
La cotation tient compte des mesures existantes ; l'efficacité des actions futures reste à réévaluer.</p>
<table><thead><tr>${["Unité / poste et personnes exposées", "Situation, danger et dommages", "Mesures existantes",
    "Cotation", "Actions de prévention", "Responsable / échéance", "Suivi déclaré"].map((t) => `<th>${t}</th>`).join("")}</tr></thead>
<tbody>${rows.map((risk) => {
    const priority = riskPriority(risk);
    return `<tr><td>${cell(risk.unite)}<br>${cell(risk.personnes)}</td>
<td><b>${cell(risk.situation)}</b><br>Danger : ${cell(risk.danger)}<br>Dommages : ${cell(risk.dommages)}</td>
<td>${cell(risk.mesures_existantes)}</td><td>${risk.gravite && risk.probabilite
      ? `G ${escape(risk.gravite)} × P ${escape(risk.probabilite)} = ${priority.score}<br>${priority.label}` : "À compléter"}</td>
<td>${cell(risk.action)}</td><td>${cell(risk.responsable)}<br>${date(risk.echeance)}</td>
<td>${cell(DUERP_STATUS[risk.statut])}</td></tr>`;
  }).join("")}</tbody></table>
<p class="signature">Validation de l'employeur / responsable : ____________________ Date : __________ Signature : ____________________</p>
<p class="note">Document de travail à compléter et à valider avec les personnes concernées.
Les mentions « À compléter » signalent des informations absentes. L'absence de risques saisis ne signifie pas une absence de risques.
Distinct du PMS et de l'audit HACCP : aucune conformité réglementaire ou efficacité des mesures n'est certifiée par SIRIUS.
Conserver les versions et organiser leur mise à jour, leur accès et leur archivage selon les obligations applicables.</p>
</body></html>`;
}

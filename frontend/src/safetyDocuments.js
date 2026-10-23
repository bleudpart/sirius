import { formatDocumentDate, getLocalDateKey } from "./dateTime";
import { escapeDocumentText } from "./haccpDocuments";

const progress = { a_faire: "À faire", en_cours: "En cours", realisee: "Réalisée (déclarée)" };
const field = (key, label, type = "text", required = false, choices) => ({ key, label, type, required, choices });
const actionFields = [
  field("action", "Action corrective / de prévention", "textarea"),
  field("echeance", "Échéance de l'action", "date"),
  field("statut", "Avancement déclaré", "select", false, progress),
];
const shiftFields = [
  field("personne", "Membre du personnel", "text", true), field("poste", "Poste / fonction", "text", true),
  field("date_service", "Date du service", "date", true), field("debut", "Début", "time", true),
  field("fin", "Fin", "time", true), field("lendemain", "Fin le lendemain", "select", false, { non: "Non", oui: "Oui" }),
  field("pause_minutes", "Pause non travaillée (minutes)", "number"),
  field("observations", "Service / observations", "textarea"),
];

export const SAFETY_SECTIONS = [
  {
    key: "accueil", title: "Cahier d'accueil du personnel",
    note: "Suivi de l'accueil et des consignes remises, pas un registre unique du personnel réglementaire. Ne saisissez ni données médicales ni données administratives sensibles.",
    fields: [
      field("personne", "Personne accueillie", "text", true), field("poste", "Poste / unité", "text", true),
      field("date_accueil", "Date d'accueil", "date", true), field("accueillant", "Personne chargée de l'accueil"),
      field("consignes_remises", "Consignes et documents remis", "textarea"), field("observations", "Observations", "textarea"),
    ],
  },
  {
    key: "formations", title: "Cahier des formations",
    note: "Les formations et les références de justificatifs sont déclarées par l'utilisateur ; elles ne constituent pas une habilitation vérifiée.",
    fields: [
      field("personne", "Participant", "text", true), field("formation", "Formation / sensibilisation", "text", true),
      field("date_formation", "Date de formation", "date", true), field("organisme", "Formateur / organisme"),
      field("preuve", "Référence du justificatif"), field("renouvellement", "Renouvellement prévu", "date"),
      field("observations", "Observations", "textarea"),
    ],
  },
  {
    key: "incendie", title: "Consignes de sécurité incendie",
    note: "À renseigner selon l'établissement et à faire valider par la personne compétente. Ce formulaire n'est pas une procédure d'intervention ni un plan d'évacuation certifié.",
    single: true,
    fields: [
      field("responsable", "Responsable sécurité / coordonnées utiles"),
      field("alerte", "Alerte : moyens, contacts et consignes validés sur site", "textarea"),
      field("evacuation", "Consignes d'évacuation validées sur site", "textarea"),
      field("point_rassemblement", "Point de rassemblement"),
      field("accueil_secours", "Accès et accueil des secours", "textarea"),
      field("assistance", "Organisation de l'assistance aux personnes, sans données de santé", "textarea"),
      field("references_plans", "Références et emplacement des plans / consignes affichées", "textarea"),
      field("valide_par", "Validation déclarée par"), field("date_validation", "Date de validation déclarée", "date"),
    ],
  },
  {
    key: "evacuations", title: "Cahier des exercices d'évacuation",
    note: "Consignez les exercices réellement réalisés, les difficultés constatées et leurs suites. La fréquence doit être fixée selon les règles applicables à votre établissement.",
    fields: [
      field("date_exercice", "Date de l'exercice", "date", true), field("scenario", "Scénario / périmètre", "text", true),
      field("responsable", "Responsable de l'exercice"), field("participants", "Participants / équipes"),
      field("observations", "Déroulement, durée observée et difficultés", "textarea"),
      field("pilote_action", "Pilote de l'action"), ...actionFields,
    ],
  },
  {
    key: "verifications", title: "Cahier des vérifications de sécurité",
    note: "Suivi des contrôles et des rapports, pas une attestation de conformité. Les périodicités et qualifications requises dépendent de l'équipement et du site.",
    fields: [
      field("equipement", "Équipement / installation / zone", "text", true),
      field("type_verification", "Nature de la vérification", "text", true),
      field("date_verification", "Date de vérification", "date", true), field("intervenant", "Intervenant / organisme"),
      field("resultat", "Résultat déclaré", "select", false, {
        non_verifie: "Non vérifié / à préciser", sans_observation: "Sans observation déclarée", avec_observations: "Avec observations",
      }),
      field("reference_rapport", "Référence et emplacement du rapport"),
      field("observations", "Observations / anomalies", "textarea"),
      field("prochaine_date", "Prochaine vérification prévue", "date"), field("responsable", "Responsable du suivi"),
      ...actionFields,
    ],
  },
  ...[["planning_cuisine", "Planning du personnel de cuisine"], ["planning_salle", "Planning du personnel de salle"]].map(([key, title]) => ({
    key, title, planning: true, fields: shiftFields,
    note: "Horaires prévisionnels par service, regroupés par semaine à l'impression. Les pauses sont déduites du total indicatif ; ce planning n'est ni un relevé d'heures réalisées ni une validation des règles de repos et de durée du travail.",
  })),
];

export const emptySafetyEntry = (section) => Object.fromEntries(section.fields.map((item) =>
  [item.key, item.type === "select" ? Object.keys(item.choices)[0] : item.type === "number" ? 0 : ""]));

export function shiftMinutes(row) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.debut) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.fin)) return null;
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const duration = minutes(row.fin) - minutes(row.debut) + (row.lendemain === "oui" ? 1440 : 0);
  const pause = Number(row.pause_minutes);
  return Number.isInteger(pause) && pause >= 0 && duration > 0 && duration < 1440 && pause < duration ? duration - pause : null;
}
const durationText = (minutes) => `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
const mondayKey = (date) => {
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return monday.toISOString().slice(0, 10);
};

export function planningTotals(rows) {
  const totals = new Map();
  for (const row of rows) {
    const minutes = shiftMinutes(row);
    if (minutes === null || !/^\d{4}-\d{2}-\d{2}$/.test(row.date_service) || !row.personne.trim()) continue;
    const week = mondayKey(row.date_service);
    const key = JSON.stringify([week, row.personne.trim()]);
    const previous = totals.get(key);
    totals.set(key, { semaine: week, personne: row.personne.trim(), minutes: (previous?.minutes || 0) + minutes });
  }
  return [...totals.values()].sort((a, b) => a.semaine.localeCompare(b.semaine) || a.personne.localeCompare(b.personne, "fr"));
}

export function planningWeekTables(rows) {
  const escape = escapeDocumentText;
  const weeks = [...new Set(rows.map((row) => mondayKey(row.date_service)))].sort();
  const headings = ["Personnel / poste", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche", "Total hors pauses"];
  if (!weeks.length) {
    return `<h2>Planning hebdomadaire — semaine du : ____ / ____ / ________</h2><table class="planning-grid"><thead><tr>${headings.map((h) =>
      `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${Array.from({ length: 6 }, () =>
      `<tr>${headings.map(() => "<td>&nbsp;<br>&nbsp;<br>&nbsp;</td>").join("")}</tr>`).join("")}</tbody></table>`;
  }
  return weeks.map((week) => {
    const inWeek = rows.filter((row) => mondayKey(row.date_service) === week);
    const employees = [...new Set(inWeek.map((row) => JSON.stringify([row.personne, row.poste])))];
    return `<h2>Planning de la semaine du lundi ${formatDocumentDate(week)}</h2><table class="planning-grid"><thead><tr>${headings.map((h) =>
      `<th>${escape(h)}</th>`).join("")}</tr></thead><tbody>${employees.map((identity) => {
      const [person, role] = JSON.parse(identity);
      const shifts = inWeek.filter((row) => row.personne === person && row.poste === role);
      return `<tr><td>${escape(person)}<br>${escape(role)}</td>${Array.from({ length: 7 }, (_, index) =>
        `<td>${shifts.filter((row) => (new Date(`${row.date_service}T00:00:00Z`).getUTCDay() + 6) % 7 === index)
          .sort((a, b) => a.debut.localeCompare(b.debut)).map((row) =>
            `${escape(row.debut)}–${escape(row.fin)}${row.lendemain === "oui" ? " (+1 jour)" : ""}<br>Pause ${escape(row.pause_minutes)} min`
          ).join("<hr>") || "—"}</td>`).join("")}<td>${durationText(shifts.reduce((sum, row) => sum + (shiftMinutes(row) || 0), 0))}</td></tr>`;
    }).join("")}</tbody></table>`;
  }).join("");
}

export const emptySafetyDossier = () => ({
  etablissement: "", adresse: "", responsable: "", date_document: getLocalDateKey(), motif_revision: "",
  ...Object.fromEntries(SAFETY_SECTIONS.map((section) => [section.key, section.single ? emptySafetyEntry(section) : []])),
});

export function editableSafetyDocument(document) {
  const empty = emptySafetyDossier();
  return Object.fromEntries(Object.keys(empty).map((key) => {
    const section = SAFETY_SECTIONS.find((item) => item.key === key);
    if (!section) return [key, document[key] ?? empty[key]];
    const clean = (row) => Object.fromEntries(section.fields.map((item) => [item.key, row[item.key] ?? ""]));
    return [key, section.single ? clean(document[key] || empty[key]) : (document[key] || []).map(clean)];
  }));
}

export function safetyPayload(form) {
  return {
    ...form,
    ...Object.fromEntries(SAFETY_SECTIONS.map((section) => {
      const convert = (row) => Object.fromEntries(section.fields.map((item) =>
        [item.key, item.type === "date" && !row[item.key] ? null
          : item.type === "number" ? Number(row[item.key]) : row[item.key]]));
      return [section.key, section.single ? convert(form[section.key]) : form[section.key].map(convert)];
    })),
  };
}

export function safetyPrintHtml(document, selected = "all") {
  const escape = escapeDocumentText;
  const text = (value) => escape(value || "À compléter").replace(/\n/g, "<br>");
  const sections = SAFETY_SECTIONS.filter((section) => selected === "all" || section.key === selected);
  if (!sections.length) throw new Error("Cahier à imprimer inconnu.");
  const title = selected === "all" ? "Personnel & sécurité — dossier de prévention" : sections[0].title;
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>@page{size:A4 ${sections.every((section) => section.planning) ? "landscape" : "portrait"};margin:15mm}
@page planning{size:A4 landscape;margin:12mm}.chapter.planning{page:planning}
body{font:12px Arial,sans-serif;color:#111;background:#fff}
h1{font-size:20px}h2{font-size:17px}p{line-height:1.5}table{width:100%;border-collapse:collapse;table-layout:fixed;margin:10px 0}
th,td{border:1px solid #555;padding:7px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{width:35%;background:#eee}
tr{break-inside:avoid}.chapter+.chapter{break-before:page}.signature{min-height:45px;margin-top:16px}
.note{font-size:10px}.entry{margin-bottom:20px}h3{break-after:avoid}.planning-grid th{width:auto;font-size:10px}
.planning-grid td{font-size:10px}.planning-grid thead{display:table-header-group}</style></head><body>
${sections.map((section) => {
    const entries = section.single ? [document[section.key]] : (document[section.key] || []);
    const ordered = section.planning ? [...entries].sort((a, b) =>
      a.date_service.localeCompare(b.date_service) || a.debut.localeCompare(b.debut)) : entries;
    const printable = ordered.length ? ordered : [emptySafetyEntry(section)];
    return `<section class="chapter${section.planning ? " planning" : ""}"><h1>${escape(section.title)}</h1>
<p><b>Établissement :</b> ${text(document.etablissement)}<br><b>Adresse :</b> ${text(document.adresse)}<br>
<b>Responsable :</b> ${text(document.responsable)}<br><b>Date du document :</b> ${text(formatDocumentDate(document.date_document))}<br>
<b>Version :</b> ${text(document.id)} · enregistrée le ${text(formatDocumentDate(document.created_at))}<br>
<b>Motif de création / révision :</b> ${text(document.motif_revision)}</p>
<p>${escape(section.note)}</p>${entries.length || section.single ? "" : "<p>Aucune entrée enregistrée : modèle vierge à compléter, aucune vérification ou formation attestée.</p>"}
${section.planning ? planningWeekTables(entries) : ""}
${section.planning && entries.length ? `<h2>Totaux prévisionnels par personne et semaine</h2><table><thead><tr><th>Semaine du lundi</th><th>Personnel</th><th>Durée hors pauses</th></tr></thead><tbody>${planningTotals(entries).map((total) =>
      `<tr><td>${text(formatDocumentDate(total.semaine))}</td><td>${text(total.personne)}</td><td>${durationText(total.minutes)}</td></tr>`).join("")}</tbody></table>
<p class="note">Totaux propres à ce planning uniquement. Vérifier aussi les services de l'autre équipe et les obligations applicables ; les services de nuit sont affectés à leur date de début.</p>` : ""}
${printable.map((entry, index) => `<div class="entry">${section.single ? "" : `<h3>${section.planning ? "Service" : "Entrée"} ${index + 1}</h3>`}
<table><tbody>${section.fields.map((item) => `<tr><th>${escape(item.label)}</th><td>${text(
      item.choices ? item.choices[entry[item.key]] : item.type === "number" ? String(entry[item.key] ?? "") : item.type === "date" && entry[item.key]
        ? formatDocumentDate(entry[item.key]) : entry[item.key])}</td></tr>`).join("")}</tbody></table>
${section.planning && shiftMinutes(entry) !== null ? `<p>Durée prévisionnelle hors pause : ${durationText(shiftMinutes(entry))}</p>` : ""}
<p class="signature">${section.key === "accueil" ? "Signature personne accueillie / accueillant" : section.key === "formations"
      ? "Signature participant / formateur" : "Date et signature du responsable"} : ____________________________</p></div>`).join("")}
<p class="note">Les données et validations sont déclaratives. Les mentions « À compléter » signalent des informations manquantes.
Ce cahier ne remplace ni les registres obligatoires applicables, ni les rapports professionnels, ni le DUERP.
Faire valider sur site et conserver les versions et justificatifs selon les obligations applicables.</p></section>`;
  }).join("")}</body></html>`;
}

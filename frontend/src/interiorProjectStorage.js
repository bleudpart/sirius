import { API_BASE_URL } from "./lib/api";

export const INTERIOR_PROJECT_FOLDER = "Architecture - Avant-Apres";
const PREFIX = "sirius-architecture-";

async function checked(response) {
  if (!response.ok) {
    const data = await response.json();
    throw new Error(typeof data.detail === "string" ? data.detail : `Erreur HTTP ${response.status}`);
  }
  return response;
}

export function validateInteriorProject(project) {
  const validPlan = (plan) => Array.isArray(plan?.pieces) && plan.pieces.length > 0 && plan.pieces.length <= 100
    && plan.pieces.every((room) => typeof room.nom === "string"
      && ["x", "y", "l", "p"].every((key) => Number.isFinite(room[key]))
      && room.l > 0 && room.p > 0)
    && (plan.mobilier === undefined || (Array.isArray(plan.mobilier)
      && plan.mobilier.every((item) => typeof item.nom === "string"
        && ["x", "y", "l", "p"].every((key) => Number.isFinite(item[key])))))
    && (plan.ouvertures === undefined || Array.isArray(plan.ouvertures));
  if (project?.format !== "sirius-interior-project" || project.version !== 1
    || typeof project.name !== "string" || !project.name.trim()
    || !validPlan(project.before?.plan) || !validPlan(project.after?.plan)
    || !Array.isArray(project.after?.proposal?.conseils)
    || !project.after.proposal.conseils.every((tip) => typeof tip === "string")
    || !Array.isArray(project.after?.proposal?.mobilier)
    || (project.request !== undefined && typeof project.request !== "string")
    || (project.after.proposal.eclairage !== undefined && typeof project.after.proposal.eclairage !== "string")
    || (project.after.proposal.achats !== undefined && (!Array.isArray(project.after.proposal.achats)
      || !project.after.proposal.achats.every((item) => typeof item.article === "string"
        && (item.quantite === undefined || Number.isFinite(item.quantite)))))) {
    throw new Error("Ce fichier n'est pas un projet Architecture avant/après compatible.");
  }
  const photo = project.before.photo;
  if (photo && (typeof photo.dataUrl !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(photo.dataUrl))) {
    throw new Error("La photo avant du projet est invalide.");
  }
  return project;
}

export async function saveInteriorProject(project) {
  validateInteriorProject(project);
  const fileName = `${PREFIX}${Date.now()}-${project.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 60)}.json`;
  const form = new FormData();
  const blob = new Blob([JSON.stringify(project)], { type: "application/json" });
  if (blob.size > 20 * 1048576) throw new Error("Projet trop volumineux : 20 Mo maximum.");
  form.append("file", blob, fileName);
  const file = await (await checked(await fetch(`${API_BASE_URL}/files/upload`, { method: "POST", body: form }))).json();
  if (!file.id) throw new Error("Le stockage n'a pas confirmé l'identifiant du fichier.");
  try {
    await checked(await fetch(`${API_BASE_URL}/files/${encodeURIComponent(file.id)}/dossier`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dossier: INTERIOR_PROJECT_FOLDER }),
    }));
  } catch (error) {
    window.dispatchEvent(new Event("sirius-files-updated"));
    throw new Error(`Fichier conservé dans Médiathèque > ${file.dossier || "Documents"} > ${fileName}, mais classement dans le dossier Architecture impossible : ${error.message}`);
  }
  window.dispatchEvent(new Event("sirius-files-updated"));
  return { ...file, dossier: INTERIOR_PROJECT_FOLDER };
}

export async function listInteriorProjects() {
  const data = await (await checked(await fetch(`${API_BASE_URL}/files`))).json();
  if (!Array.isArray(data)) throw new Error("La liste des fichiers reçue est invalide.");
  return data.filter((file) => file.dossier === INTERIOR_PROJECT_FOLDER
    || file.original_filename?.startsWith(PREFIX));
}

export async function readInteriorProject(id) {
  const response = await checked(await fetch(`${API_BASE_URL}/files/${encodeURIComponent(id)}/download`));
  return validateInteriorProject(await response.json());
}

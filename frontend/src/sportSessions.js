export const EXERCISES = {
  chairSquat: {
    name: "Assis-debout contrôlé", group: "Jambes", equipment: "chaise",
    steps: ["Pose une chaise stable derrière toi, pieds à largeur confortable.", "Descends lentement jusqu'à toucher la chaise, puis relève-toi sans élan.", "Garde un appui stable ; réduis l'amplitude si le mouvement est inconfortable."],
    caution: "Ne force pas dans la douleur. Garde la chaise contre un mur si elle peut glisser.",
    illustration: "chairSquat",
  },
  wallPush: {
    name: "Poussée au mur", group: "Haut du corps", equipment: "mur",
    steps: ["Place les mains sur un mur stable, à hauteur de poitrine.", "Fléchis les bras en gardant le corps aligné.", "Repousse le mur sans bloquer la respiration."],
    caution: "Éloigne ou rapproche les pieds pour ajuster la difficulté sans douleur.",
    illustration: "wallPush",
  },
  bandRow: {
    name: "Tirage avec élastique", group: "Dos", equipment: "élastique",
    steps: ["Fixe l'élastique selon les instructions du fabricant et vérifie son ancrage.", "Tire les coudes vers l'arrière en gardant les épaules relâchées.", "Reviens lentement sans laisser l'élastique claquer."],
    caution: "N'utilise jamais un ancrage instable ou un élastique abîmé.",
    illustration: "bandRow",
  },
  dumbbellRow: {
    name: "Tirage léger avec haltère", group: "Dos", equipment: "haltère",
    steps: ["Appuie une main sur une surface solide, dos dans une position confortable.", "Ramène doucement l'haltère près du flanc.", "Redescends avec contrôle ; change de côté."],
    caution: "Commence avec une charge que tu contrôles et arrête en cas de douleur.",
    illustration: "dumbbellRow",
  },
  bridge: {
    name: "Pont de hanches au sol", group: "Hanches", equipment: "tapis",
    steps: ["Allonge-toi sur le dos, genoux fléchis et pieds posés.", "Soulève légèrement le bassin sans cambrer excessivement.", "Redescends doucement en respirant normalement."],
    caution: "Utilise une amplitude confortable et évite si la position provoque une douleur.",
    illustration: "bridge",
  },
  birdDog: {
    name: "Équilibre à quatre pattes", group: "Tronc", equipment: "tapis",
    steps: ["Place-toi à quatre pattes sur une surface stable.", "Allonge un bras, puis éventuellement la jambe opposée, sans perdre l'équilibre.", "Reviens et change de côté à ton rythme."],
    caution: "Garde les mains au sol si la variante complète est inconfortable.",
    illustration: "birdDog",
  },
  walk: {
    name: "Marche à allure confortable", group: "Endurance", equipment: "aucun",
    steps: ["Commence à une allure qui te permet de parler.", "Adapte la durée à ton ressenti et à ton environnement.", "Ralentis progressivement avant de t'arrêter."],
    caution: "Choisis un trajet accessible et sûr ; arrête en cas de malaise.",
    illustration: "walk",
  },
};

export const SPORT_GOALS = [
  ["mobilite", "Remise en mouvement"],
  ["force", "Renforcement général"],
  ["masse", "Prise de masse : régularité"],
];

export const SPORT_EQUIPMENT = [
  ["aucun", "Sans matériel (chaise et mur)"],
  ["elastique", "Avec élastique"],
  ["halteres", "Avec haltères légers"],
];

export const SPORT_ADAPTATIONS = [
  ["gentle", "Douce"],
  ["short", "Courte"],
  ["usual", "Habituelle"],
];

export const SPORT_COMFORT = [
  ["confortable", "Confortable"],
  ["a_ajuster", "Je préfère alléger les mouvements"],
];

const SPORT_EFFORT = ["facile", "modere", "difficile"];
const validAdaptation = (adaptation) => (
  adaptation && typeof adaptation === "object" && !Array.isArray(adaptation)
  && Object.keys(adaptation).length === 3
  && SPORT_ADAPTATIONS.some(([id]) => id === adaptation.choice)
  && SPORT_COMFORT.some(([id]) => id === adaptation.comfort)
  && SPORT_EFFORT.includes(adaptation.effort)
);

export function suggestSportAdaptation({ goal, comfort, effort, history }) {
  if (!SPORT_GOALS.some(([id]) => id === goal)
      || !SPORT_COMFORT.some(([id]) => id === comfort)
      || !SPORT_EFFORT.includes(effort)) {
    throw new Error("Ressenti ou objectif invalide.");
  }
  validateSportHistory(history);
  const recent = history.filter((entry) => entry.goal === goal && entry.exercises.length > 0)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 3);
  const historyCount = recent.length;
  if (comfort === "a_ajuster" || effort === "difficile") {
    return { choice: "gentle", historyCount, reason: "Tu souhaites alléger les mouvements ou tu indiques un effort difficile." };
  }
  if (recent.some((entry) => entry.effort === "difficile")) {
    return { choice: "gentle", historyCount, reason: "Une des dernières séances enregistrées pour cet objectif a été notée difficile." };
  }
  return {
    choice: "usual", historyCount,
    reason: historyCount
      ? "Les derniers ressentis enregistrés pour cet objectif ne signalent pas d'effort difficile. Aucune augmentation n'est proposée."
      : "Aucune séance avec mouvement effectué pour cet objectif : le format habituel reste disponible, sans augmentation.",
  };
}

export function buildSportSession({ goal, equipment, minutes, adaptation }) {
  if (!SPORT_GOALS.some(([id]) => id === goal)
      || !SPORT_EQUIPMENT.some(([id]) => id === equipment)
      || ![15, 25, 40].includes(Number(minutes))) {
    throw new Error("Paramètres de séance invalides.");
  }
  if (adaptation !== undefined && !validAdaptation(adaptation)) {
    throw new Error("Choix d'adaptation invalide.");
  }
  const duration = Number(minutes);
  const choice = adaptation?.choice || "usual";
  const pull = equipment === "elastique" ? "bandRow" : equipment === "halteres" ? "dumbbellRow" : null;
  const strength = ["chairSquat", "wallPush", ...(pull ? [pull] : []), "bridge", "birdDog", "walk"];
  const ids = goal === "mobilite"
    ? ["walk", "chairSquat", "birdDog", "bridge", "wallPush"]
    : strength;
  const count = choice === "short" ? (duration === 15 ? 2 : 3)
    : duration === 15 ? 3 : duration === 25 ? 4 : ids.length;
  return {
    goal, equipment, minutes: choice === "short" ? (duration === 15 ? 10 : 15) : duration,
    ...(adaptation ? { adaptation: { ...adaptation } } : {}),
    warmup: "Commence par 3 à 5 minutes de mouvements doux et progressifs, adaptés à tes capacités.",
    exercises: ids.slice(0, count).map((id) => ({
      id, ...EXERCISES[id],
      suggestion: choice === "gentle"
        ? id === "walk"
          ? "Marche doucement, avec des pauses libres et une allure où tu peux parler."
          : "Une seule série douce, avec une amplitude confortable et des pauses libres ; ne cherche pas à forcer."
        : id === "walk"
          ? "Quelques minutes à une allure où tu peux encore parler."
          : goal === "mobilite"
            ? "Une série confortable, sans chercher à forcer."
            : "Une ou deux séries de mouvements contrôlés ; adapte les répétitions à ton ressenti.",
    })),
    cooldown: "Termine en ralentissant quelques minutes et note comment tu te sens.",
  };
}

export function sportStorageKey(user) {
  return `sirius_sport_v1_${user?.id || user?._id || user?.email || "local"}`;
}

export function readSportHistory(storage, user) {
  const raw = storage.getItem(sportStorageKey(user));
  if (!raw) return [];
  const entries = JSON.parse(raw);
  validateSportHistory(entries);
  return entries;
}

function validateSportHistory(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => (
    !entry || typeof entry !== "object" || typeof entry.id !== "string"
    || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))
    || !SPORT_GOALS.some(([id]) => id === entry.goal)
    || !Array.isArray(entry.exercises)
    || entry.exercises.some((id) => typeof id !== "string" || !EXERCISES[id])
    || !SPORT_EFFORT.includes(entry.effort)
    || (entry.adaptation !== undefined && !validAdaptation(entry.adaptation))
  ))) throw new Error("Historique local illisible ; aucune donnée n'a été écrasée.");
}

export function saveSportHistory(storage, user, entries) {
  validateSportHistory(entries);
  storage.setItem(sportStorageKey(user), JSON.stringify(entries));
}

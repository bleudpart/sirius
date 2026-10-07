export const WORK_MODULES = [
  { id: "workflows", label: "ARIANE", description: "Parcours et actions", icon: "Workflow", image: "/api/mythos/img/ariane.jpg" },
  { id: "pricing", label: "PLUTOS", description: "Prix et fournisseurs", icon: "Tags", image: "/api/mythos/img/plutos.jpg" },
  { id: "dossiers", label: "MNÉMOSYNE", description: "Dossiers et archives", icon: "FolderOpen", image: "/api/mythos/img/mnemosyne.jpg" },
  { id: "audit", label: "NÉMÉSIS", description: "Audit et traçabilité", icon: "ScrollText", image: "/api/mythos/img/nemesis.jpg" },
  { id: "documents", label: "THOT", description: "Lecture et classement", icon: "FileText", image: "/api/mythos/img/thot.jpg" },
  { id: "planning", label: "CHRONOS", description: "Planning et échéances", icon: "CalendarDays", image: "/api/mythos/img/chronos.jpg" },
];

// Compatibilite avec les anciens libelles portant un suffixe de marque.
export const workModuleName = (label) => String(label || "").replace(/#$/, "");

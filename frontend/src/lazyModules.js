// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Chargement différé des modules (code-splitting) : le HUD démarre léger,
// chaque module n'est téléchargé et interprété qu'à sa première ouverture.
import { lazy, memo, Suspense } from "react";
import FdeErrorBoundary from "@/FdeErrorBoundary";

function ModuleFallback() {
  return <div className="fde-module-loading" role="status">CHARGEMENT DU MODULE…</div>;
}

const wrap = (loader) => {
  const C = lazy(loader);
  const W = memo((props) => (
    <FdeErrorBoundary module>
      <Suspense fallback={<ModuleFallback />}>
        <C {...props} />
      </Suspense>
    </FdeErrorBoundary>
  ));
  W.displayName = "LazySiriusModule";
  return W;
};

export const ArchitectPanel = wrap(() => import("@/Architect").then((m) => ({ default: m.ArchitectPanel })));
export const SpectatorView = wrap(() => import("@/Architect").then((m) => ({ default: m.SpectatorView })));
export const FilesPanel = wrap(() => import("@/FilesPanel"));
export const DevCompanion = wrap(() => import("@/DevCompanion"));
export const ZeusCortex = wrap(() => import("@/ZeusCortex"));
export const SiriusPrime = wrap(() => import("@/SiriusPrime"));
export const OracleDivin = wrap(() => import("@/OracleDivin"));
export const PantheonSystem = wrap(() => import("@/PantheonSystem"));
export const NexusCeleste = wrap(() => import("@/NexusCeleste"));
export const SiriusDisplay = wrap(() => import("@/SiriusDisplay"));
export const FloorPlanPanel = wrap(() => import("@/FloorPlan"));
export const Photo3DPanel = wrap(() => import("@/Photo3D"));
export const EuropeanaViewer = wrap(() => import("@/EuropeanaViewer"));
export const HaccpModule = wrap(() => import("@/HaccpModule"));
export const KeysStatus = wrap(() => import("@/KeysStatus"));
export const KeraunosPanel = wrap(() => import("@/KeraunosPanel"));
export const AboutPanel = wrap(() => import("@/AboutPanel"));
export const EspacePanel = wrap(() => import("@/EspacePanel"));
export const ArchiveGallery = wrap(() => import("@/ArchiveGallery"));
export const MemoryManager = wrap(() => import("@/MemoryManager"));
export const InstallWizard = wrap(() => import("@/InstallWizard"));
export const ScriptInstaller = wrap(() => import("@/ScriptInstaller"));
export const LocusPanel = wrap(() => import("@/LocusPanel"));
export const AtlasPanel = wrap(() => import("@/AtlasPanel"));
export const HeraclesPanel = wrap(() => import("@/HeraclesPanel"));
export const HephaistosPanel = wrap(() => import("@/HephaistosPanel"));
export const MythosGallery = wrap(() => import("@/MythosGallery"));
export const ConsultPanel = wrap(() => import("@/ConsultPanel"));
export const PrometheePanel = wrap(() => import("@/PrometheePanel"));
export const CalliopePanel = wrap(() => import("@/CalliopePanel"));
export const CalendarPanel = wrap(() => import("@/CalendarPanel"));
export const FaceIdPanel = wrap(() => import("@/FaceIdPanel"));
export const PythagorePanel = wrap(() => import("@/PythagorePanel"));
export const PackagerPanel = wrap(() => import("@/PackagerPanel"));
export const TrailerGallery = wrap(() => import("@/TrailerGallery"));
export const SiriusSetup = wrap(() => import("@/SiriusSetup"));
export const PromoPanel = wrap(() => import("@/PromoPanel"));
export const ThemisPanel = wrap(() => import("@/ThemisPanel"));
export const AdminPanel = wrap(() => import("@/AdminPanel"));
export const PortusNummarius = wrap(() => import("@/PortusNummarius"));
export const AgoraPipeline = wrap(() => import("@/AgoraPipeline"));
export const NewsPanel = wrap(() => import("@/NewsPanel"));
export const ReveilPanel = wrap(() => import("@/ReveilPanel"));
export const SpotifyPanel = wrap(() => import("@/SpotifyPanel"));
export const MediaHUD = wrap(() => import("@/components/MediaHUD"));
export const ProductivityPanel = wrap(() => import("@/ProductivityPanel"));
export const ConnectionsPanel = wrap(() => import("@/ConnectionsPanel"));

import { Home, LayoutGrid, MessageCircle, SlidersHorizontal, Activity } from "lucide-react";
import "./MobileNavigation.css";

const destinations = [
  { id: "home", label: "Accueil", Icon: Home },
  { id: "info", label: "Infos", Icon: Activity },
  { id: "assistant", label: "Assistant", Icon: MessageCircle, primary: true },
  { id: "modules", label: "Modules", Icon: LayoutGrid },
  { id: "profile", label: "Profil", Icon: SlidersHorizontal },
];

export default function MobileNavigation({ active, onNavigate }) {
  return (
    <nav className="mobile-navigation" aria-label="Navigation principale">
      {destinations.map(({ id, label, Icon, primary }) => (
        <button
          key={id}
          type="button"
          className={`mobile-navigation-item ${primary ? "primary" : ""} ${active === id ? "active" : ""}`}
          onClick={() => onNavigate(id)}
          aria-current={active === id ? "page" : undefined}
          data-testid={`mobile-nav-${id}`}
        >
          <span className="mobile-navigation-icon"><Icon size={primary ? 22 : 20} /></span>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
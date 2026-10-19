import { useRef, useState } from "react";
import { Home, LayoutGrid, MessageCircle, SlidersHorizontal, Activity } from "lucide-react";
import "./MobileNavigation.css";

const destinations = [
  { id: "home", label: "Accueil", Icon: Home },
  { id: "info", label: "Infos", Icon: Activity },
  { id: "assistant", label: "Assistant", Icon: MessageCircle, primary: true },
  { id: "modules", label: "Modules", Icon: LayoutGrid },
  { id: "profile", label: "Réglages", Icon: SlidersHorizontal },
];

export default function MobileNavigation({ active, onNavigate }) {
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState(null);
  const drawerRef = useRef(null);
  const gesture = useRef(null);
  const suppressClick = useRef(false);

  const startDrag = (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const drawer = drawerRef.current;
    const style = getComputedStyle(drawer);
    const horizontal = style.getPropertyValue("--mobile-nav-axis").trim() === "x";
    const dimension = horizontal ? "width" : "height";
    const handleSize = event.currentTarget.getBoundingClientRect()[dimension];
    const safeInset = parseFloat(horizontal ? style.paddingLeft : style.paddingBottom) || 0;
    const travel = Math.max(0, drawer.getBoundingClientRect()[dimension] - handleSize - safeInset);
    gesture.current = { id: event.pointerId, origin: horizontal ? event.clientX : event.clientY, horizontal, travel, moved: false };
    suppressClick.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.id) return;
    const delta = current.horizontal ? current.origin - event.clientX : event.clientY - current.origin;
    current.moved ||= Math.abs(delta) > 6;
    if (current.moved) {
      setDragOffset(Math.max(0, Math.min(current.travel, (expanded ? 0 : current.travel) + delta)));
    }
  };

  const finishDrag = (event, cancelled = false) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.id) return;
    gesture.current = null;
    suppressClick.current = current.moved;
    if (!cancelled && current.moved) {
      const delta = current.horizontal ? current.origin - event.clientX : event.clientY - current.origin;
      if (Math.abs(delta) >= 24) setExpanded(delta < 0);
    }
    setDragOffset(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <nav ref={drawerRef}
      className={`mobile-navigation ${expanded ? "is-expanded" : "is-collapsed"} ${dragOffset !== null ? "is-dragging" : ""}`}
      style={dragOffset === null ? undefined : { "--mobile-nav-offset": `${dragOffset}px` }}
      aria-label="Navigation principale">
      <button type="button" className="mobile-navigation-handle"
        aria-label={expanded ? "Masquer la navigation" : "Afficher la navigation"}
        aria-expanded={expanded} aria-controls="mobile-navigation-destinations"
        onPointerDown={startDrag} onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={(event) => finishDrag(event, true)}
        onLostPointerCapture={(event) => finishDrag(event, true)}
        onClick={(event) => {
          if (event.detail !== 0 && suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          setExpanded((value) => !value);
        }}>
        <span className="mobile-navigation-grip" aria-hidden="true" />
        <span>Menu</span>
      </button>
      <div id="mobile-navigation-destinations" className="mobile-navigation-destinations">
      {destinations.map(({ id, label, Icon, primary }) => (
        <button
          key={id}
          type="button"
          className={`mobile-navigation-item ${primary ? "primary" : ""} ${active === id ? "active" : ""}`}
          onClick={() => {
            onNavigate(id);
            setExpanded(false);
          }}
          aria-current={active === id ? "page" : undefined}
          data-testid={`mobile-nav-${id}`}
        >
          <span className="mobile-navigation-icon"><Icon size={primary ? 22 : 20} /></span>
          <span>{label}</span>
        </button>
      ))}
      </div>
    </nav>
  );
}
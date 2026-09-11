// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useEffect, useCallback } from "react";
import { Canvas } from "@react-three/fiber";
import Hand from "./Hand";
import Cortex from "./Cortex";
import Lightning from "./Lightning";

// Gère le feedback holographique sur les panneaux 2D existants ([data-hud-panel]).
function useHudFeedback() {
  const hoveredEl = useRef(null);
  const rippleLayer = useRef(null);

  useEffect(() => {
    const layer = document.createElement("div");
    layer.className = "hud-ripple-layer";
    document.body.appendChild(layer);
    rippleLayer.current = layer;
    return () => { try { document.body.removeChild(layer); } catch (e) {} };
  }, []);

  // Appelé chaque frame avec la position écran du bout du doigt (main droite)
  const onFingertip = useCallback((x, y) => {
    const els = document.elementsFromPoint(x, y);
    const panel = els.find((e) => e.hasAttribute && e.hasAttribute("data-hud-panel"));
    if (panel !== hoveredEl.current) {
      if (hoveredEl.current) hoveredEl.current.classList.remove("hud-panel-hover");
      if (panel) panel.classList.add("hud-panel-hover");
      hoveredEl.current = panel || null;
    }
  }, []);

  // Press (clic) : highlight + ripple centré sur le doigt
  const press = useCallback((x, y) => {
    const el = hoveredEl.current;
    if (el) {
      el.classList.add("hud-panel-active");
      setTimeout(() => el.classList.remove("hud-panel-active"), 350);
    }
    const layer = rippleLayer.current;
    if (layer) {
      const r = document.createElement("span");
      r.className = "hud-ripple";
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      layer.appendChild(r);
      setTimeout(() => { try { layer.removeChild(r); } catch (e) {} }, 650);
    }
  }, []);

  return { onFingertip, press, hoveredEl };
}

// Scène 3D transparente superposée au HUD 2D : Cortex + 2 mains holographiques.
export default function HandsScene({ pulseRef, active }) {
  const cortexRef = useRef(0.3);
  const hoverRef = useRef(false);
  const pressRef = useRef(false);
  const fingerPos = useRef({ x: 0, y: 0 });
  const { onFingertip, press, hoveredEl } = useHudFeedback();

  const handleFinger = useCallback((x, y) => {
    fingerPos.current = { x, y };
    onFingertip(x, y);
    hoverRef.current = !!hoveredEl.current;
  }, [onFingertip, hoveredEl]);

  // Clic global = press holographique (déclenche flash + ripple + highlight)
  useEffect(() => {
    const onDown = () => {
      pressRef.current = true;
      press(fingerPos.current.x, fingerPos.current.y);
      setTimeout(() => { pressRef.current = false; }, 120);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [press]);

  return (
    <div className="hands-scene" data-testid="hands-scene">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 0, 7], fov: 50 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      >
        <ambientLight intensity={0.6} />
        <Cortex pulseRef={pulseRef} cortexRef={cortexRef} active={active} />
        <Lightning pulseRef={pulseRef} />
        <Hand side="left" pulseRef={pulseRef} cortexRef={cortexRef} hoverRef={hoverRef} pressRef={pressRef} />
        <Hand side="right" pulseRef={pulseRef} cortexRef={cortexRef} hoverRef={hoverRef} pressRef={pressRef} onFingertip={handleFinger} />
      </Canvas>
    </div>
  );
}

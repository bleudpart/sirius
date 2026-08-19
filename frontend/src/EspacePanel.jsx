// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useMemo, useRef, useState, useEffect } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { X, Globe2, Crosshair, Pause, Play } from "lucide-react";
import "./Espace.css";

const CAM_HOME = { theta: 0.6, phi: 1.15, radius: 42 };

function Starfield() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = 1600;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 120 + Math.random() * 260;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.cos(p);
      pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  return (
    <points geometry={geo}>
      <pointsMaterial size={0.7} color="#9fd3e8" transparent opacity={0.8} sizeAttenuation />
    </points>
  );
}

function Sun() {
  const glow = useRef();
  useFrame(({ clock }) => {
    if (glow.current) {
      const s = 7.2 + Math.sin(clock.elapsedTime * 1.4) * 0.5;
      glow.current.scale.set(s, s, s);
    }
  });
  const glowTex = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, "rgba(255,225,140,0.9)");
    g.addColorStop(0.4, "rgba(245,197,66,0.35)");
    g.addColorStop(1, "rgba(245,197,66,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }, []);
  return (
    <group>
      <mesh>
        <sphereGeometry args={[3.2, 48, 48]} />
        <meshBasicMaterial color="#ffd76b" />
      </mesh>
      <mesh>
        <sphereGeometry args={[3.35, 32, 32]} />
        <meshBasicMaterial color="#f5c542" wireframe transparent opacity={0.35} />
      </mesh>
      <sprite ref={glow}>
        <spriteMaterial map={glowTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <pointLight intensity={260} distance={200} color="#ffe2a0" />
    </group>
  );
}

function EarthMoon({ paused }) {
  const orbit = useRef();
  const earth = useRef();
  const moonOrbit = useRef();
  useFrame((_, dt) => {
    if (paused.current) return;
    if (orbit.current) orbit.current.rotation.y += dt * 0.12;
    if (earth.current) earth.current.rotation.y += dt * 0.5;
    if (moonOrbit.current) moonOrbit.current.rotation.y += dt * 0.65;
  });
  return (
    <group ref={orbit}>
      <group position={[18, 0, 0]}>
        <group ref={earth}>
          <mesh>
            <sphereGeometry args={[2.1, 48, 48]} />
            <meshStandardMaterial color="#0d4f79" roughness={0.55} metalness={0.15} emissive="#062c47" emissiveIntensity={0.55} />
          </mesh>
          <mesh>
            <sphereGeometry args={[2.16, 24, 24]} />
            <meshBasicMaterial color="#22d3ee" wireframe transparent opacity={0.3} />
          </mesh>
          <mesh>
            <sphereGeometry args={[2.45, 32, 32]} />
            <meshBasicMaterial color="#22d3ee" transparent opacity={0.06} side={THREE.BackSide} />
          </mesh>
        </group>
        <group ref={moonOrbit}>
          <mesh position={[4.6, 0.5, 0]}>
            <sphereGeometry args={[0.62, 32, 32]} />
            <meshStandardMaterial color="#b8bcc4" roughness={0.9} emissive="#3a3d44" emissiveIntensity={0.35} />
          </mesh>
          <mesh rotation={[Math.PI / 2 - 0.11, 0, 0]}>
            <ringGeometry args={[4.55, 4.62, 96]} />
            <meshBasicMaterial color="#9fd3e8" transparent opacity={0.14} side={THREE.DoubleSide} />
          </mesh>
        </group>
      </group>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[17.94, 18.06, 128]} />
        <meshBasicMaterial color="#f5c542" transparent opacity={0.16} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

// Caméra orbitale manuelle + recentrage automatique sur la scène
function OrbitCamera({ ctrl }) {
  const { camera, gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    let drag = false, px = 0, py = 0;
    const down = (e) => { drag = true; px = e.clientX; py = e.clientY; };
    const up = () => { drag = false; };
    const move = (e) => {
      if (!drag) return;
      ctrl.current.theta -= (e.clientX - px) * 0.006;
      ctrl.current.phi = Math.min(2.9, Math.max(0.25, ctrl.current.phi - (e.clientY - py) * 0.006));
      px = e.clientX; py = e.clientY;
    };
    const wheel = (e) => {
      e.preventDefault();
      ctrl.current.radius = Math.min(110, Math.max(10, ctrl.current.radius + e.deltaY * 0.03));
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointermove", move);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointermove", move);
      el.removeEventListener("wheel", wheel);
    };
  }, [gl, ctrl]);
  useFrame(() => {
    const { theta, phi, radius } = ctrl.current;
    camera.position.set(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.cos(phi),
      radius * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export default function EspacePanel({ onClose }) {
  const ctrl = useRef({ ...CAM_HOME });
  const paused = useRef(false);
  const [isPaused, setIsPaused] = useState(false);

  return (
    <div className="esp-panel" data-testid="espace-panel">
      <div className="esp-bar">
        <Globe2 size={14} />
        <span className="esp-title">ESPACE — SYSTÈME SOLAIRE HOLOGRAPHIQUE</span>
        <button className="esp-btn" onClick={() => { paused.current = !paused.current; setIsPaused(paused.current); }} data-testid="espace-pause-btn">
          {isPaused ? <Play size={12} /> : <Pause size={12} />} {isPaused ? "REPRENDRE" : "PAUSE"}
        </button>
        <button className="esp-btn" onClick={() => { ctrl.current = { ...CAM_HOME }; }} title="Recentrer la caméra" data-testid="espace-recenter-btn">
          <Crosshair size={12} /> RECENTRER
        </button>
        <button className="esp-btn" onClick={onClose} data-testid="espace-close-btn"><X size={14} /></button>
      </div>
      <div className="esp-canvas" data-testid="espace-canvas">
        <Canvas camera={{ position: [24, 16, 24], fov: 50, near: 0.1, far: 600 }} dpr={[1, 1.75]}>
          <ambientLight intensity={0.25} />
          <Starfield />
          <Sun />
          <EarthMoon paused={paused} />
          <OrbitCamera ctrl={ctrl} />
        </Canvas>
        <div className="esp-legend">
          <span><i className="dot gold" /> Soleil</span>
          <span><i className="dot cyan" /> Terre</span>
          <span><i className="dot grey" /> Lune</span>
          <span className="esp-hint">Glisser : orbite · Molette : zoom</span>
        </div>
      </div>
    </div>
  );
}

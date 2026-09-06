// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useMemo, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { X, Boxes, MousePointer2 } from "lucide-react";
import "./Analysis3D.css";

const GOLD = "#d8b875";
const CYAN = "#91e6f2";

function makeTextTexture(title, text) {
  const W = 1024;
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  ctx.font = "500 30px Rajdhani, sans-serif";
  const words = (text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (ctx.measureText(t).width > W - 110) { lines.push(line); line = w; }
    else line = t;
    if (lines.length >= 26) break;
  }
  if (line && lines.length < 26) lines.push(line);
  const H = Math.max(360, 170 + lines.length * 40);
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.fillStyle = "rgba(2, 14, 24, 0.92)";
  x.fillRect(0, 0, W, H);
  x.strokeStyle = "rgba(216,184,117,0.85)";
  x.lineWidth = 4;
  x.strokeRect(6, 6, W - 12, H - 12);
  x.strokeStyle = "rgba(145,230,242,0.4)";
  x.lineWidth = 2;
  x.strokeRect(16, 16, W - 32, H - 32);
  x.fillStyle = GOLD;
  x.font = "700 34px Orbitron, sans-serif";
  x.fillText("ANALYSE SIRIUS", 46, 74);
  x.fillStyle = "rgba(159,211,232,0.85)";
  x.font = "500 24px Rajdhani, sans-serif";
  x.fillText((title || "").slice(0, 60).toUpperCase(), 46, 112);
  x.fillStyle = "#c9eefb";
  x.font = "500 30px Rajdhani, sans-serif";
  lines.forEach((l, i) => x.fillText(l, 46, 165 + i * 40));
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return { tex, aspect: H / W };
}

function DataSlab({ title, text, imageUrl }) {
  const { tex, aspect } = useMemo(() => makeTextTexture(title, text), [title, text]);
  const [imgTex, setImgTex] = useState(null);
  const [imgAspect, setImgAspect] = useState(0.6);
  useEffect(() => {
    if (!imageUrl) { setImgTex(null); return; }
    const loader = new THREE.TextureLoader();
    loader.load(imageUrl, (t) => {
      if (t.image && t.image.width) setImgAspect(t.image.height / t.image.width);
      setImgTex(t);
    });
  }, [imageUrl]);
  const W = 6.4;
  const textH = W * aspect;
  const imgH = imgTex ? Math.min(3.4, W * 0.62 * imgAspect) : 0;
  const gap = imgTex ? 0.35 : 0;
  const total = textH + imgH + gap;
  return (
    <group>
      {imgTex && (
        <mesh position={[0, total / 2 - imgH / 2, 0]}>
          <planeGeometry args={[W * 0.62, imgH]} />
          <meshBasicMaterial map={imgTex} side={THREE.DoubleSide} transparent opacity={0.96} />
        </mesh>
      )}
      <mesh position={[0, -total / 2 + textH / 2, 0]}>
        <planeGeometry args={[W, textH]} />
        <meshBasicMaterial map={tex} side={THREE.DoubleSide} transparent opacity={0.94} />
      </mesh>
    </group>
  );
}

function HoloRig({ children }) {
  const grp = useRef();
  const rot = useRef({ x: -0.08, y: 0.35, dragging: false });
  const { gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    let px = 0, py = 0;
    const down = (e) => { rot.current.dragging = true; px = e.clientX; py = e.clientY; };
    const move = (e) => {
      if (!rot.current.dragging) return;
      rot.current.y += (e.clientX - px) * 0.008;
      rot.current.x = Math.max(-1.2, Math.min(1.2, rot.current.x + (e.clientY - py) * 0.006));
      px = e.clientX; py = e.clientY;
    };
    const up = () => { rot.current.dragging = false; };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [gl]);
  useFrame((_, dt) => {
    if (!grp.current) return;
    if (!rot.current.dragging) rot.current.y += dt * 0.12;
    grp.current.rotation.y += (rot.current.y - grp.current.rotation.y) * 0.12;
    grp.current.rotation.x += (rot.current.x - grp.current.rotation.x) * 0.12;
  });
  return <group ref={grp}>{children}</group>;
}

function HoloDecor() {
  const ringA = useRef();
  const ringB = useRef();
  const scan = useRef();
  const wire = useRef();
  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    if (ringA.current) ringA.current.rotation.z += dt * 0.5;
    if (ringB.current) ringB.current.rotation.z -= dt * 0.34;
    if (wire.current) wire.current.rotation.y += dt * 0.18;
    if (scan.current) {
      scan.current.position.y = Math.sin(t * 0.7) * 3.1;
      scan.current.material.opacity = 0.32 + 0.18 * Math.sin(t * 2.2);
    }
  });
  return (
    <group>
      <mesh ref={ringA} rotation={[Math.PI / 2.25, 0, 0]}>
        <torusGeometry args={[5.4, 0.035, 12, 120]} />
        <meshBasicMaterial color={GOLD} transparent opacity={0.9} />
      </mesh>
      <mesh ref={ringB} rotation={[Math.PI / 1.8, 0.4, 0]}>
        <torusGeometry args={[6.1, 0.02, 12, 120]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.55} />
      </mesh>
      <mesh ref={wire}>
        <icosahedronGeometry args={[7.1, 1]} />
        <meshBasicMaterial color={CYAN} wireframe transparent opacity={0.08} />
      </mesh>
      <mesh ref={scan} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[4.6, 4.75, 90]} />
        <meshBasicMaterial color={GOLD} transparent opacity={0.4} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -4.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.4, 5.6, 90, 1]} />
        <meshBasicMaterial color={CYAN} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

function Particles() {
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const n = 260;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 6 + Math.random() * 8;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.cos(p);
      pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  const ref = useRef();
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.y += dt * 0.05; });
  return (
    <points ref={ref} geometry={geo}>
      <pointsMaterial size={0.09} color={GOLD} transparent opacity={0.65} sizeAttenuation />
    </points>
  );
}

function Zoom() {
  const { camera, gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    const wheel = (e) => {
      e.preventDefault();
      camera.position.z = Math.max(7, Math.min(24, camera.position.z + e.deltaY * 0.012));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [camera, gl]);
  return null;
}

export default function Analysis3D({ title, text, imageUrl, onClose }) {
  return createPortal(
    <div className="an3d-overlay" data-testid="analysis-3d-panel" onPointerDown={(e) => e.stopPropagation()} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <div className="an3d-bar">
        <Boxes size={14} />
        <span className="an3d-title">PROJECTION 3D — ANALYSE SIRIUS</span>
        <span className="an3d-hint"><MousePointer2 size={11} /> glissez pour pivoter à 360° · molette pour zoomer</span>
        <button className="an3d-close" onClick={onClose} data-testid="analysis-3d-close-btn"><X size={15} /></button>
      </div>
      <div className="an3d-canvas" data-testid="analysis-3d-canvas">
        <Canvas camera={{ position: [0, 0, 13], fov: 45 }} gl={{ antialias: true, alpha: true }}>
          <Zoom />
          <HoloRig>
            <DataSlab title={title} text={text} imageUrl={imageUrl} />
            <HoloDecor />
            <Particles />
          </HoloRig>
        </Canvas>
        <div className="an3d-scan" />
      </div>
    </div>,
    document.body
  );
}

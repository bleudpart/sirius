// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

const GLOW = new THREE.Color("#00AFFF");
const LAVA = new THREE.Color("#ff7a1a");

// Matériau holographique commun (semi-transparent, additif, luminescent)
function holoMaterial() {
  return new THREE.MeshBasicMaterial({
    color: GLOW,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// Un doigt = phalanges (petits cylindres) empilées
function buildFinger(len, radius, joints) {
  const g = new THREE.Group();
  let y = 0;
  const seg = len / joints;
  for (let i = 0; i < joints; i++) {
    const r = radius * (1 - i * 0.12);
    const geo = new THREE.CapsuleGeometry(r, seg * 0.7, 4, 8);
    const mesh = new THREE.Mesh(geo);
    mesh.position.y = y + seg / 2;
    g.add(mesh);
    y += seg;
  }
  return { group: g, tip: y };
}

// Main stylisée procédurale (paume + 5 doigts), orientée, holographique
export default function Hand({ side = "right", pulseRef, cortexRef, hoverRef, pressRef, onFingertip }) {
  const root = useRef();
  const scaleRef = useRef(1);
  const tipRef = useRef();
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    color: LAVA,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }), []);
  const wireMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: GLOW, wireframe: true, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }), []);

  // Construit la géométrie de la main une seule fois
  const hand = useMemo(() => {
    const g = new THREE.Group();
    // Paume
    const palm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.3, 0.35), mat);
    palm.geometry = new THREE.BoxGeometry(1.1, 1.3, 0.35);
    g.add(palm);
    const palmWire = new THREE.Mesh(palm.geometry, wireMat);
    g.add(palmWire);
    // 4 doigts alignés en haut de la paume
    const fingerDefs = [
      { x: -0.42, len: 1.15, r: 0.12 },
      { x: -0.14, len: 1.35, r: 0.13 },
      { x: 0.14, len: 1.28, r: 0.13 },
      { x: 0.42, len: 1.05, r: 0.11 },
    ];
    const tips = [];
    fingerDefs.forEach((f) => {
      const { group, tip } = buildFinger(f.len, f.r, 3);
      group.position.set(f.x, 0.65, 0);
      group.traverse((m) => { if (m.isMesh) m.material = mat; });
      g.add(group);
      tips.push({ x: f.x, y: 0.65 + tip });
    });
    // Pouce (incliné)
    const thumb = buildFinger(0.9, 0.14, 3);
    thumb.group.position.set(side === "right" ? -0.6 : 0.6, -0.1, 0.1);
    thumb.group.rotation.z = side === "right" ? 0.9 : -0.9;
    thumb.group.traverse((m) => { if (m.isMesh) m.material = mat; });
    g.add(thumb.group);
    // Repère du bout du majeur (pour le raycasting/feedback)
    const tip = new THREE.Object3D();
    tip.position.set(-0.14, 0.65 + 1.35, 0);
    g.add(tip);
    g.userData.tip = tip;
    return g;
  }, [mat, wireMat, side]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const g = root.current;
    if (!g) return;
    const pulse = pulseRef?.current ?? 0.5;         // 0..1 synchronisé avec le réacteur 2D
    const cortex = cortexRef?.current ?? 0.3;       // intensité d'activité du Cortex
    const hovered = hoverRef?.current;
    const pressed = pressRef?.current;

    // Idle : léger va-et-vient vers le centre (respiration) + rotation subtile
    const dir = side === "right" ? 1 : -1;
    g.position.x = base + dir * Math.sin(t * 0.8) * 0.15;
    g.position.y = -0.3 + Math.sin(t * 0.9 + (side === "right" ? 0 : Math.PI)) * 0.12;
    g.rotation.y = baseRotY + Math.sin(t * 0.6) * 0.12;

    // Scale cible : hover 1.05, press 0.95, sinon 1 (lissage)
    const target = pressed ? 0.95 : hovered ? 1.05 : 1;
    scaleRef.current += (target - scaleRef.current) * 0.2;
    g.scale.setScalar(scaleRef.current);

    // Glow holographique : pulsation + activité Cortex + hover
    const glow = 0.3 + pulse * 0.22 + cortex * 0.15 + (hovered ? 0.2 : 0) + (pressed ? 0.35 : 0);
    mat.opacity = Math.min(0.7, glow);
    wireMat.opacity = Math.min(0.5, glow * 0.55);

    // Position écran du bout du doigt -> feedback sur panneaux 2D
    if (onFingertip && hand.userData.tip) {
      const world = new THREE.Vector3();
      hand.userData.tip.getWorldPosition(world);
      world.project(state.camera);
      const x = (world.x * 0.5 + 0.5) * state.size.width;
      const y = (-world.y * 0.5 + 0.5) * state.size.height;
      onFingertip(x, y);
    }
  });

  // Mains orientées vers le centre (les doigts pointent vers l'intérieur)
  const base = side === "right" ? 4.3 : -4.3;
  const baseRotY = side === "right" ? -0.5 : 0.5;
  const rotZ = side === "right" ? -Math.PI / 2 : Math.PI / 2; // doigts (+y) -> pointent vers le centre
  return (
    <group ref={root} position={[base, -0.3, 0.4]} rotation={[0.15, baseRotY, rotZ]} scale={0.9}>
      <primitive object={hand} ref={tipRef} />
    </group>
  );
}

// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

const PALETTE = ["#ff7a1a", "#ff2d55", "#ff3ba7", "#2dff6a", "#91e6f2", "#a06bff"];
const SEGS = 9;

// Un éclair jagged entre un point de départ (main) et le centre (triangle)
function Bolt({ from, to, color, seed }) {
  const ref = useRef();
  const mat = useMemo(() => new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.85,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }), [color]);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SEGS + 1) * 3), 3));
    return g;
  }, []);
  const start = useMemo(() => new THREE.Vector3(...from), [from]);
  const end = useMemo(() => new THREE.Vector3(...to), [to]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pos = geo.attributes.position.array;
    for (let i = 0; i <= SEGS; i++) {
      const a = i / SEGS;
      const x = start.x + (end.x - start.x) * a;
      const y = start.y + (end.y - start.y) * a;
      const z = start.z + (end.z - start.z) * a;
      const j = a > 0 && a < 1 ? 0.35 : 0;
      pos[i * 3] = x + Math.sin(t * 22 + seed + i) * j;
      pos[i * 3 + 1] = y + Math.cos(t * 26 + seed * 2 + i * 1.7) * j;
      pos[i * 3 + 2] = z;
    }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = 0.35 + Math.abs(Math.sin(t * 8 + seed)) * 0.55; // scintillement
  });

  return <line ref={ref} geometry={geo} material={mat} />;
}

// Faisceau d'éclairs multicolores reliant les deux mains au triangle central
export default function Lightning({ pulseRef }) {
  const grp = useRef();
  const bolts = useMemo(() => {
    const arr = [];
    const centers = [[3.4, -0.1, 0.3], [-3.4, -0.1, 0.3]]; // proche de chaque main
    centers.forEach((c, si) => {
      for (let k = 0; k < 3; k++) {
        arr.push({
          from: [c[0], c[1] + (k - 1) * 0.5, c[2]],
          to: [0, 0.4, 0],
          color: PALETTE[(si * 3 + k) % PALETTE.length],
          seed: si * 10 + k * 3.3,
        });
      }
    });
    return arr;
  }, []);

  useFrame(() => {
    const p = pulseRef?.current ?? 0.5;
    if (grp.current) grp.current.visible = p > 0.12; // s'estompe en veille profonde
  });

  return (
    <group ref={grp}>
      {bolts.map((b, i) => <Bolt key={i} {...b} />)}
    </group>
  );
}

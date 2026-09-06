// © 2026 Daniel Partel – SIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useRef, useMemo } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

// Triangle du Cortex holographique (nested triangles) — face caméra, bleu lumineux.
function triangleLine(size) {
  const h = size * Math.sqrt(3) / 2;
  const pts = [
    new THREE.Vector3(0, h * 0.66, 0),
    new THREE.Vector3(-size / 2, -h * 0.34, 0),
    new THREE.Vector3(size / 2, -h * 0.34, 0),
    new THREE.Vector3(0, h * 0.66, 0),
  ];
  return new THREE.BufferGeometry().setFromPoints(pts);
}

export default function Cortex({ pulseRef, cortexRef, active = false }) {
  const grp = useRef();
  const coreMat = useMemo(() => new THREE.LineBasicMaterial({
    color: "#bfefff", transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }), []);
  const midMat = useMemo(() => new THREE.LineBasicMaterial({
    color: "#91e6f2", transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }), []);
  const fillMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: "#0af0ff", transparent: true, opacity: 0.18,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: "#00afff", transparent: true, opacity: 0.1,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }), []);

  const g1 = useMemo(() => triangleLine(2.2), []);
  const g2 = useMemo(() => triangleLine(1.5), []);
  const g3 = useMemo(() => triangleLine(0.85), []);
  const fillGeo = useMemo(() => {
    const s = 2.0, h = s * Math.sqrt(3) / 2;
    const shape = new THREE.Shape();
    shape.moveTo(0, h * 0.66); shape.lineTo(-s / 2, -h * 0.34); shape.lineTo(s / 2, -h * 0.34); shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }, []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pulse = pulseRef?.current ?? 0.5;
    if (grp.current) {
      const s = 1 + pulse * 0.12 + (active ? 0.06 * Math.sin(t * 6) : 0);
      grp.current.scale.setScalar(s);
      grp.current.rotation.z = Math.sin(t * 0.4) * 0.08;
    }
    coreMat.opacity = 0.7 + pulse * 0.3;
    fillMat.opacity = 0.12 + pulse * 0.18;
    glowMat.opacity = 0.06 + pulse * 0.12;
    if (cortexRef) cortexRef.current = 0.25 + pulse * 0.5 + (active ? 0.25 : 0);
  });

  return (
    <group ref={grp} position={[0, 0.4, -0.5]}>
      <mesh geometry={fillGeo} material={glowMat} scale={1.4} />
      <mesh geometry={fillGeo} material={fillMat} />
      <line geometry={g1} material={midMat} />
      <line geometry={g2} material={coreMat} />
      <line geometry={g3} material={coreMat} />
    </group>
  );
}

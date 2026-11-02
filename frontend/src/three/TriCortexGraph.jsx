import React, { useEffect, useMemo } from "react";
import { Canvas } from "@react-three/fiber";
import * as THREE from "three";

const POSITIONS = {
  brain_1: [-2.4, 1.05, 0.2], brain_2: [-2.4, -1.05, -0.2], brain_3: [0.9, 0, 0],
  vision: [2.4, 0, 0.15], sanitary_guard: [0.9, 1.5, -0.15],
  margin_audit: [-0.6, 0, 0.15], archivist: [0.9, -1.5, -0.15],
};
const SHORT = { brain_1: "B1", brain_2: "B2", brain_3: "B3", vision: "VIS", sanitary_guard: "SAN", margin_audit: "MAR", archivist: "ARC" };
const COLORS = { brain_1: "#7fb2d4", brain_2: "#d8b875", brain_3: "#70c5b4", vision: "#8d8fc4", sanitary_guard: "#77b18b", margin_audit: "#d29f68", archivist: "#b783a4" };
const LINKS = [
  ["brain_1", "brain_2"], ["brain_1", "brain_3"], ["brain_2", "brain_3"],
  ["brain_3", "vision"], ["brain_3", "sanitary_guard"], ["brain_3", "margin_audit"], ["brain_3", "archivist"],
];

function Label({ text }) {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Étiquettes 3D indisponibles.");
    context.font = "bold 34px sans-serif";
    context.fillStyle = "#eff8ff";
    context.textAlign = "center";
    context.fillText(text, 80, 46);
    return new THREE.CanvasTexture(canvas);
  }, [text]);
  useEffect(() => () => texture.dispose(), [texture]);
  return <sprite position={[0, 0.48, 0]} scale={[0.8, 0.32, 1]}>
    <spriteMaterial map={texture} transparent depthTest={false} />
  </sprite>;
}

function Connection({ source, target, active = false }) {
  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...POSITIONS[source]), new THREE.Vector3(...POSITIONS[target]),
  ]), [source, target]);
  const arrow = useMemo(() => {
    const from = new THREE.Vector3(...POSITIONS[source]);
    const direction = new THREE.Vector3(...POSITIONS[target]).sub(from);
    return {
      position: from.add(direction.clone().multiplyScalar(0.7)),
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()),
    };
  }, [source, target]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <>
    <line geometry={geometry}>
      <lineBasicMaterial color={active ? "#ffe6a3" : "#54707f"} transparent opacity={active ? 1 : 0.3} />
    </line>
    {active && <mesh position={arrow.position} quaternion={arrow.quaternion}>
      <coneGeometry args={[0.055, 0.16, 8]} /><meshBasicMaterial color="#ffe6a3" />
    </mesh>}
  </>;
}

function Scene({ frame }) {
  const nodes = [...frame.nodes, ...frame.satellites];
  return <>
    <ambientLight intensity={0.75} />
    <directionalLight position={[-3, 5, 6]} intensity={1.6} />
    <mesh position={POSITIONS.brain_3}>
      <torusGeometry args={[1.5, 0.009, 8, 100]} />
      <meshBasicMaterial color="#54707f" transparent opacity={0.45} />
    </mesh>
    {LINKS.map(([source, target]) => <Connection key={`${source}:${target}`} source={source} target={target} />)}
    {frame.edge_flows.map((flow) => <Connection key={`${flow.source}:${flow.target}:active`}
      source={flow.source} target={flow.target} active />)}
    {nodes.map((node) => <group position={POSITIONS[node.id]} key={node.id}>
      <mesh scale={1 + node.pulse_level * 0.35}>
        <icosahedronGeometry args={[node.parent ? 0.19 : 0.32, 2]} />
        <meshStandardMaterial color={["failed", "degraded"].includes(node.status) ? "#db7770" : COLORS[node.id]}
          emissive={COLORS[node.id]} emissiveIntensity={node.pulse_level * 0.7} roughness={0.35} metalness={0.45} />
      </mesh>
      <Label text={SHORT[node.id]} />
    </group>)}
  </>;
}

export default function TriCortexGraph({ frame }) {
  return <div className="tri-graph" role="img" aria-label="Graphe 3D : trois cerveaux et quatre satellites autour de Sentinel">
    <Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ position: [0, 0, 8], fov: 40 }}
      gl={{ antialias: true, powerPreference: "low-power" }} fallback={<p>Graphe 3D indisponible.</p>}>
      <Scene frame={frame} />
    </Canvas>
  </div>;
}

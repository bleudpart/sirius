// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés. Toute reproduction, modification, distribution ou utilisation non autorisée est strictement interdite. Logiciel protégé par le droit d'auteur (Code de la propriété intellectuelle – France).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { X, Boxes, UploadCloud, Download, Loader2, RotateCw, ImagePlus, History } from "lucide-react";
import "./Photo3D.css";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";
const MIN_PHOTOS = 3;
const MAX_PHOTOS = 40;
const POLL_MS = 900;

// --- Contrôles orbitaux (glisser pour pivoter, molette pour zoomer) ---
function Controls() {
  const { camera, gl } = useThree();
  useEffect(() => {
    const controls = new OrbitControls(camera, gl.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 1.2;
    controls.maxDistance = 12;
    return () => controls.dispose();
  }, [camera, gl]);
  return null;
}

// --- Chargement du modèle .obj (+ .mtl optionnel) reçu du backend ---
function Model({ objUrl, mtlUrl }) {
  const [object, setObject] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const applyObject = (obj) => {
      if (cancelled) return;
      // Recentre et normalise l'échelle pour un rendu cohérent quel que soit le sujet
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      box.getSize(size);
      const center = new THREE.Vector3();
      box.getCenter(center);
      obj.position.sub(center);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const scale = 3.2 / maxDim;
      obj.scale.setScalar(scale);
      obj.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = false;
          child.receiveShadow = false;
          if (!child.material || !child.material.map) {
            child.material = new THREE.MeshStandardMaterial({
              color: 0xd8b875,
              metalness: 0.25,
              roughness: 0.55,
            });
          }
        }
      });
      setObject(obj);
    };

    const loadModel = async () => {
      try {
        let materials;
        if (mtlUrl) {
          const mtlResponse = await fetch(mtlUrl, { credentials: "include" });
          if (mtlResponse.ok) {
            materials = new MTLLoader().parse(await mtlResponse.text(), "");
            materials.preload();
          }
        }
        const objResponse = await fetch(objUrl, { credentials: "include" });
        if (!objResponse.ok) throw new Error("Modèle 3D inaccessible.");
        const loader = new OBJLoader();
        if (materials) loader.setMaterials(materials);
        applyObject(loader.parse(await objResponse.text()));
      } catch (error) {
        if (!cancelled) setObject(null);
      }
    };
    loadModel();
    return () => { cancelled = true; };
  }, [objUrl, mtlUrl]);

  if (!object) return null;
  return <primitive object={object} />;
}

function Viewer({ objUrl, mtlUrl }) {
  return (
    <Canvas camera={{ position: [3.4, 2.2, 3.4], fov: 42 }} gl={{ antialias: true }}>
      <ambientLight intensity={0.65} />
      <directionalLight position={[4, 6, 4]} intensity={1.1} />
      <directionalLight position={[-4, -2, -3]} intensity={0.35} color="#91e6f2" />
      <Controls />
      <Model objUrl={objUrl} mtlUrl={mtlUrl} />
      <gridHelper args={[8, 16, "#3a4a55", "#233038"]} position={[0, -1.8, 0]} />
    </Canvas>
  );
}

export default function Photo3D({ onClose, onSpeak }) {
  const [files, setFiles] = useState([]); // [{file, preview}]
  const [dragOver, setDragOver] = useState(false);
  const [job, setJob] = useState(null); // {job_id, status, progress, message, obj_url, mtl_url}
  const [error, setError] = useState("");
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const inputRef = useRef(null);
  const pollRef = useRef(null);

  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
    if (!incoming.length) return;
    setFiles((prev) => {
      const next = [...prev, ...incoming.map((file) => ({ file, preview: URL.createObjectURL(file) }))];
      return next.slice(0, MAX_PHOTOS);
    });
    setError("");
  }, []);

  const removeFile = useCallback((idx) => {
    setFiles((prev) => {
      const next = [...prev];
      const [removed] = next.splice(idx, 1);
      if (removed) URL.revokeObjectURL(removed.preview);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    files.forEach((f) => URL.revokeObjectURL(f.preview));
    setFiles([]);
    setJob(null);
    setError("");
  }, [files]);

  // --- Polling de la progression pendant le calcul en arrière-plan ---
  useEffect(() => {
    if (!job || job.status === "termine" || job.status === "erreur") {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${API}/photo3d/jobs/${job.job_id}`, { credentials: "include" });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.detail || "Suivi du job impossible");
        setJob(data);
        if (data.status === "termine" && onSpeak) {
          onSpeak("Votre modèle 3D est prêt, généré localement à partir de vos photos.");
        }
        if (data.status === "erreur") setError(data.message || "La reconstruction 3D a échoué.");
      } catch (e) {
        setError(e.message || "Suivi du job impossible");
      }
    }, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, [job, onSpeak]);

  const launch = useCallback(async () => {
    if (files.length < MIN_PHOTOS) {
      setError(`Ajoutez au moins ${MIN_PHOTOS} photos (idéalement 12 à 24, prises tout autour de l'objet).`);
      return;
    }
    setError("");
    const form = new FormData();
    files.forEach(({ file }) => form.append("files", file));
    try {
      setJob({ job_id: "", status: "en_cours", progress: 1, message: "Envoi des photos…" });
      const resp = await fetch(`${API}/photo3d/jobs`, { method: "POST", body: form, credentials: "include" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Lancement impossible");
      setJob(data);
    } catch (e) {
      setError(e.message || "Lancement impossible");
      setJob(null);
    }
  }, [files]);

  const objUrl = job?.obj_url ? `${API}${job.obj_url}` : null;
  const mtlUrl = job?.mtl_url ? `${API}${job.mtl_url}` : null;

  const downloadObj = useCallback(() => {
    if (!objUrl) return;
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = "sirius-model.obj";
    a.click();
  }, [objUrl]);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch(`${API}/photo3d/history`, { credentials: "include" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Historique indisponible.");
      setHistory(data.jobs || []);
      setShowHistory(true);
    } catch (e) { setError(e.message || "Historique indisponible."); }
  }, []);

  const loadProject = useCallback((item) => {
    if (item.obj_url) {
      setJob(item);
      setShowHistory(false);
      setError("");
    }
  }, []);

  const busy = job && job.status !== "termine" && job.status !== "erreur";
  const progressPct = useMemo(() => Math.max(0, Math.min(100, job?.progress || 0)), [job]);

  return (
    <div className="p3d-overlay" role="dialog" aria-label="PHOTO3D — reconstruction 3D locale" data-hud-panel>
      <div className="p3d-panel">
        <header className="p3d-bar">
          <Boxes size={16} />
          <span className="p3d-title">PHOTO3D# — PHOTOS → OBJET 3D (LOCAL)</span>
          <button className="p3d-close" onClick={onClose} data-testid="photo3d-close-btn"><X size={16} /></button>
        </header>

        <div className="p3d-body">
          {!objUrl && (
            <div
              className={`p3d-dropzone${dragOver ? " drag" : ""}`}
              data-testid="photo3d-dropzone"
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                data-testid="photo3d-file-input"
                onChange={(e) => addFiles(e.target.files)}
              />
              <UploadCloud size={30} />
              <p>Glissez-déposez vos photos ici, ou cliquez pour en choisir.</p>
              <p className="p3d-hint">Tournez autour de l'objet et prenez une photo tous les 15-30° (12 à 24 photos recommandées).</p>
            </div>
          )}

          {files.length > 0 && !objUrl && (
            <div className="p3d-thumbs" data-testid="photo3d-thumbs">
              {files.map((f, idx) => (
                <div className="p3d-thumb" key={idx}>
                  <img src={f.preview} alt={`photo ${idx + 1}`} />
                  <button onClick={() => removeFile(idx)} aria-label="Retirer"><X size={11} /></button>
                </div>
              ))}
              <div className="p3d-thumb-count"><ImagePlus size={13} /> {files.length}/{MAX_PHOTOS}</div>
            </div>
          )}

          {job && (
            <div className="p3d-progress-wrap" data-testid="photo3d-progress">
              <div className="p3d-progress-bar">
                <div className="p3d-progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="p3d-progress-label">
                {busy && <Loader2 size={13} className="p3d-spin" />}
                <span>{job.message} {busy ? `(${progressPct}%)` : ""}</span>
              </div>
            </div>
          )}

          {error && <div className="p3d-error">{error}</div>}

          {showHistory && <div className="p3d-history" data-testid="photo3d-history"><div className="p3d-progress-label"><History size={13} /> Projets précédents</div>{history.length === 0 && <p>Aucun projet enregistré.</p>}{history.map((item) => <button type="button" className="p3d-history-item" key={item.job_id} onClick={() => loadProject(item)} disabled={!item.obj_url}><span>{new Date(item.created_at).toLocaleString("fr-FR")}</span><span>{item.status} · {item.n_photos || 0} photos</span></button>)}</div>}

          {objUrl && (
            <div className="p3d-viewer" data-testid="photo3d-viewer">
              <Viewer objUrl={objUrl} mtlUrl={mtlUrl} />
            </div>
          )}
        </div>

        <footer className="p3d-footer">
          <button className="p3d-btn" onClick={loadHistory} title="Voir les projets précédents"><History size={14} /> Historique</button>
          {!objUrl ? (
            <button className="p3d-btn primary" onClick={launch} disabled={busy || files.length < MIN_PHOTOS} data-testid="photo3d-launch-btn">
              {busy ? <Loader2 size={14} className="p3d-spin" /> : <Boxes size={14} />} Générer l'objet 3D
            </button>
          ) : (
            <>
              <button className="p3d-btn" onClick={downloadObj} data-testid="photo3d-download-btn"><Download size={14} /> Télécharger (.obj)</button>
              <button className="p3d-btn" onClick={reset} data-testid="photo3d-restart-btn"><RotateCw size={14} /> Nouveau modèle</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

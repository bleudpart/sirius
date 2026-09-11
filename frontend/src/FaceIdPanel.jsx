// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Reconnaissance faciale 100 % locale (face-api.js) : rien ne quitte l'appareil.
import { useEffect, useRef, useState, useCallback } from "react";
import { X, ScanFace, UserCheck, Trash2, Camera } from "lucide-react";
import * as faceapi from "@vladmandic/face-api";

const STORE_KEY = "sirius_faceid";
const MATCH_THRESHOLD = 0.5;

const loadProfile = () => {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY));
    return p && p.descriptor ? { ...p, descriptor: new Float32Array(p.descriptor) } : null;
  } catch { return null; }
};

let modelsReady = false;
async function ensureModels() {
  if (modelsReady) return;
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri("/models"),
    faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
    faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
  ]);
  modelsReady = true;
}

export default function FaceIdPanel({ onClose, onRecognized, userName }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const loopRef = useRef(null);
  const greetedRef = useRef(false);
  const [state, setState] = useState("init"); // init | nocam | ready | error
  const [message, setMessage] = useState("Initialisation du module…");
  const [profile, setProfile] = useState(loadProfile);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null); // { match: bool, distance }

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setMessage("Chargement des modèles neuronaux locaux…");
        await ensureModels();
        if (!mounted) return;
        setMessage("Recherche d'une caméra…");
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
        if (!mounted) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        setState("ready");
        setMessage("");
      } catch (e) {
        if (!mounted) return;
        if (String(e.name).match(/NotFoundError|OverconstrainedError|NotReadableError/)) {
          setState("nocam");
        } else if (String(e.name) === "NotAllowedError") {
          setState("error");
          setMessage("Caméra refusée. Autorisez la caméra via le cadenas de la barre d'adresse.");
        } else {
          setState("nocam");
        }
      }
    })();
    return () => {
      mounted = false;
      clearInterval(loopRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const detect = useCallback(async () => {
    if (!videoRef.current || videoRef.current.readyState < 2) return null;
    return faceapi
      .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
  }, []);

  // Boucle de reconnaissance (uniquement si un visage est enregistré)
  useEffect(() => {
    if (state !== "ready" || !profile) return;
    loopRef.current = setInterval(async () => {
      try {
        const det = await detect();
        if (!det) { setLive(null); return; }
        const distance = faceapi.euclideanDistance(det.descriptor, profile.descriptor);
        const match = distance < MATCH_THRESHOLD;
        setLive({ match, distance: +distance.toFixed(2) });
        if (match && !greetedRef.current) {
          greetedRef.current = true;
          onRecognized && onRecognized(profile.name);
        }
      } catch { /* détection silencieuse */ }
    }, 1600);
    return () => clearInterval(loopRef.current);
  }, [state, profile, detect, onRecognized]);

  const enroll = async () => {
    setBusy(true); setMessage("");
    try {
      const det = await detect();
      if (!det) { setMessage("Aucun visage détecté. Placez-vous face à la caméra, bien éclairé."); setBusy(false); return; }
      const p = { name: userName || "Utilisateur", descriptor: Array.from(det.descriptor), created_at: new Date().toISOString() };
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
      setProfile({ ...p, descriptor: det.descriptor });
      greetedRef.current = false;
      setMessage(`Visage de ${p.name} enregistré. Sirius vous reconnaîtra désormais.`);
    } catch (e) {
      setMessage("Enregistrement impossible : " + e.message);
    }
    setBusy(false);
  };

  const forget = () => {
    localStorage.removeItem(STORE_KEY);
    setProfile(null); setLive(null); greetedRef.current = false;
    setMessage("Visage oublié. Toutes les données locales ont été effacées.");
  };

  return (
    <div className="prime-screen" data-testid="faceid-panel">
      <header className="zeus-head">
        <div className="zeus-title font-divine"><ScanFace size={20} /> FACE ID — RECONNAISSANCE LOCALE</div>
        <button className="setup-close zeus-close" onClick={onClose} data-testid="faceid-close-btn"><X size={18} /></button>
      </header>

      <div className="faceid-body">
        <p className="faceid-privacy">100 % local : votre visage est analysé dans votre navigateur, rien n'est envoyé sur Internet.</p>

        {state === "nocam" && (
          <div className="faceid-nocam" data-testid="faceid-nocam">
            <Camera size={36} />
            <b>Aucune caméra détectée</b>
            <p>Ce n'est pas grave : tout est prêt. Branchez une caméra (ou utilisez un appareil qui en a une) et rouvrez ce module — l'enregistrement de votre visage prendra 5 secondes.</p>
          </div>
        )}

        {state === "error" && <div className="gcal-error" data-testid="faceid-error">{message}</div>}
        {state === "init" && <div className="gcal-empty">{message}</div>}

        {state === "ready" && (
          <>
            <div className="faceid-videowrap">
              <video ref={videoRef} autoPlay muted playsInline className="faceid-video" data-testid="faceid-video" />
              {live && (
                <span className={`faceid-badge ${live.match ? "ok" : "ko"}`} data-testid="faceid-live-badge">
                  {live.match ? `✓ ${profile.name} reconnu` : "Visage non reconnu"}
                </span>
              )}
            </div>
            <div className="faceid-actions">
              <button className="cmd-send" onClick={enroll} disabled={busy} data-testid="faceid-enroll-btn">
                <UserCheck size={14} /> {profile ? "RÉENREGISTRER MON VISAGE" : "ENREGISTRER MON VISAGE"}
              </button>
              {profile && (
                <button className="file-btn danger" onClick={forget} data-testid="faceid-forget-btn">
                  <Trash2 size={13} /> OUBLIER MON VISAGE
                </button>
              )}
            </div>
            {profile && !live && <div className="gcal-empty">Recherche de votre visage…</div>}
          </>
        )}

        {message && state === "ready" && <div className="faceid-msg" data-testid="faceid-message">{message}</div>}
        {profile && state !== "ready" && (
          <div className="faceid-msg">Visage enregistré : <b>{profile.name}</b> (prêt dès qu'une caméra sera disponible)</div>
        )}
      </div>
    </div>
  );
}

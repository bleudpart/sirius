// © 2026 Daniel Partel – ΣIRIUS Assistant. Tous droits réservés.
// Reconnaissance faciale 100 % locale (face-api.js) : rien ne quitte l'appareil.
import { useEffect, useRef, useState, useCallback } from "react";
import { X, ScanFace, UserCheck, Trash2, Camera, Activity, ShieldCheck, Cpu, RotateCw, CircleAlert, ScanLine } from "lucide-react";
import * as faceapi from "@vladmandic/face-api";

const STORE_KEY = "sirius_faceid";
const MATCH_THRESHOLD = 0.5;

const loadProfile = () => {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY));
    const descriptor = Array.isArray(p?.descriptor) ? p.descriptor : null;
    if (!descriptor || descriptor.length !== 128 || !descriptor.every(Number.isFinite)) return null;
    return { ...p, descriptor: new Float32Array(descriptor) };
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
  const mountedRef = useRef(false);
  const scanBusyRef = useRef(false);
  const onRecognizedRef = useRef(onRecognized);
  const [state, setState] = useState("init"); // init | connecting | nocam | ready | error
  const [message, setMessage] = useState("Chargement des modèles locaux…");
  const [profile, setProfile] = useState(loadProfile);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(null); // { faceDetected, match, distance }

  useEffect(() => { onRecognizedRef.current = onRecognized; }, [onRecognized]);

  const stopCamera = useCallback(() => {
    clearInterval(loopRef.current);
    loopRef.current = null;
    scanBusyRef.current = false;
    if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("error");
      setMessage("La caméra nécessite un contexte sécurisé HTTPS ou localhost.");
      return false;
    }
    stopCamera();
    setState("connecting");
    setMessage("Demande d'accès à la caméra…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      streamRef.current = stream;
      setLive(null);
      setState("ready");
      setMessage("Caméra active. Placez votre visage dans le cadre.");
      return true;
    } catch (error) {
      if (!mountedRef.current) return false;
      if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
        setState("nocam");
        setMessage("Aucune caméra compatible n'a été détectée.");
      } else if (error.name === "NotAllowedError" || error.name === "SecurityError") {
        setState("error");
        setMessage("Accès caméra refusé. Autorisez la caméra dans le navigateur puis réessayez.");
      } else if (error.name === "NotReadableError") {
        setState("error");
        setMessage("La caméra est déjà utilisée par une autre application.");
      } else {
        setState("error");
        setMessage(`Ouverture de la caméra impossible${error.message ? ` : ${error.message}` : "."}`);
      }
      return false;
    }
  }, [stopCamera]);

  const retrySetup = async () => {
    setState("init");
    setMessage("Vérification des modèles locaux…");
    try {
      await ensureModels();
      if (mountedRef.current) await startCamera();
    } catch (error) {
      if (!mountedRef.current) return;
      setState("error");
      setMessage(`Chargement des modèles impossible${error.message ? ` : ${error.message}` : "."}`);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        await ensureModels();
        if (!mountedRef.current) return;
        setMessage("Modèles locaux prêts. Connexion à la caméra…");
        await startCamera();
      } catch (error) {
        if (!mountedRef.current) return;
        setState("error");
        setMessage(`Chargement des modèles impossible${error.message ? ` : ${error.message}` : "."}`);
      }
    })();
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  // The video element is rendered only in the ready state; attach the stream after that commit.
  useEffect(() => {
    const video = videoRef.current;
    if (state !== "ready" || !video || !streamRef.current) return undefined;
    video.srcObject = streamRef.current;
    video.play().catch(() => {
      if (mountedRef.current) setMessage("La caméra est active, mais la prévisualisation n'a pas démarré. Relancez la caméra.");
    });
    return () => {
      if (video.srcObject === streamRef.current) video.srcObject = null;
    };
  }, [state]);

  const detect = useCallback(async () => {
    if (!videoRef.current || videoRef.current.readyState < 2) return null;
    return faceapi
      .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
  }, []);

  // Scan live even before enrollment so opening the camera never depends on a saved face.
  useEffect(() => {
    if (state !== "ready") return undefined;
    loopRef.current = setInterval(async () => {
      if (scanBusyRef.current) return;
      scanBusyRef.current = true;
      try {
        const det = await detect();
        if (!det) {
          setLive((current) => current?.faceDetected ? { faceDetected: false, match: false } : current);
          greetedRef.current = false;
          return;
        }
        if (!profile) {
          setLive({ faceDetected: true, match: null });
          return;
        }
        if (!profile.descriptor || profile.descriptor.length !== det.descriptor.length) {
          setLive({ faceDetected: true, match: false, invalidProfile: true });
          return;
        }
        const distance = faceapi.euclideanDistance(det.descriptor, profile.descriptor);
        const match = distance < MATCH_THRESHOLD;
        setLive({ faceDetected: true, match, distance: +distance.toFixed(2) });
        if (match && !greetedRef.current) {
          greetedRef.current = true;
          onRecognizedRef.current && onRecognizedRef.current(profile.name);
        }
      } catch {
        if (mountedRef.current) setMessage("Le scan local a rencontré une erreur. Vous pouvez relancer la caméra.");
      } finally {
        scanBusyRef.current = false;
      }
    }, 850);
    return () => {
      clearInterval(loopRef.current);
      loopRef.current = null;
    };
  }, [state, profile, detect]);

  const enroll = async () => {
    setBusy(true); setMessage("Analyse locale du visage…");
    try {
      const det = await detect();
      if (!det) { setMessage("Aucun visage détecté. Placez-vous face à la caméra, bien éclairé, puis réessayez."); setBusy(false); return; }
      const p = { name: userName || "Utilisateur", descriptor: Array.from(det.descriptor), created_at: new Date().toISOString() };
      localStorage.setItem(STORE_KEY, JSON.stringify(p));
      setProfile({ ...p, descriptor: det.descriptor });
      greetedRef.current = false;
      setMessage(`Visage de ${p.name} enregistré. Sirius vous reconnaîtra désormais.`);
    } catch (error) {
      setMessage("Enregistrement impossible : " + error.message);
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
        <div className="faceid-overview">
          <div>
            <span className="faceid-kicker"><Activity size={13} /> BIOMÉTRIE LOCALE · TEMPS RÉEL</span>
            <h2>IDENTIFICATION FACIALE</h2>
            <p>Détection et comparaison exécutées sur cet appareil. Aucun flux vidéo ni descripteur n'est envoyé au serveur.</p>
          </div>
          <div className="faceid-privacy"><ShieldCheck size={16} /> TRAITEMENT LOCAL</div>
        </div>

        <div className="faceid-workspace">
          <section className="faceid-camera-card" aria-label="Prévisualisation de la caméra">
            <div className="faceid-card-head">
              <span><Camera size={15} /> CAPTURE EN DIRECT</span>
              <span className={`faceid-state ${state}`}><i />{state === "ready" ? "CAMÉRA ACTIVE" : state === "connecting" ? "CONNEXION" : state === "init" ? "INITIALISATION" : state === "nocam" ? "CAMÉRA ABSENTE" : "À VÉRIFIER"}</span>
            </div>
            <div className="faceid-stage" data-testid="faceid-stage">
              <video ref={videoRef} autoPlay muted playsInline className="faceid-video" data-testid="faceid-video" style={{ display: state === "ready" ? "block" : "none" }} />
              {state === "ready" && <div className="faceid-reticle" aria-hidden="true"><ScanLine size={34} /></div>}
              {state !== "ready" && (
                <div className={`faceid-stage-state ${state}`}>
                  {state === "nocam" ? <Camera size={32} /> : state === "error" ? <CircleAlert size={32} /> : <Cpu size={30} />}
                  <strong>{state === "nocam" ? "Aucune caméra détectée" : state === "error" ? "Vérification requise" : message}</strong>
                  {(state === "nocam" || state === "error") && <span>{message}</span>}
                </div>
              )}
              {state === "ready" && (
                <span className={`faceid-badge ${live?.faceDetected ? (live.match ? "ok" : "scan") : "idle"}`} data-testid="faceid-live-badge">
                  {!live?.faceDetected ? "RECHERCHE D'UN VISAGE" : live.invalidProfile ? "PROFIL À RÉENREGISTRER" : !profile ? "VISAGE DÉTECTÉ · ENREGISTREMENT REQUIS" : live.match ? `IDENTITÉ CONFIRMÉE · ${profile.name}` : "VISAGE DÉTECTÉ · NON RECONNU"}
                </span>
              )}
            </div>
            <div className="faceid-camera-foot"><span>{message}</span><span><ShieldCheck size={13} /> VIDÉO NON STOCKÉE</span></div>
          </section>

          <aside className="faceid-side-panel">
            <div className="faceid-stat"><span><Cpu size={14} /> MOTEUR LOCAL</span><b>{state === "init" ? "CHARGEMENT" : "FACE-API · 128D"}</b></div>
            <div className="faceid-stat"><span><ScanFace size={14} /> ÉTAT DU PROFIL</span><b>{profile ? "ENREGISTRÉ" : "NON ENREGISTRÉ"}</b></div>
            <div className="faceid-profile">
              <span>IDENTITÉ LOCALE</span>
              <strong>{profile ? profile.name : "Aucune identité"}</strong>
              <small>{profile ? `Enregistrée le ${new Date(profile.created_at).toLocaleDateString("fr-FR")}` : "La caméra peut être ouverte avant tout enregistrement."}</small>
            </div>
            <div className="faceid-actions">
              <button className="cmd-send" onClick={enroll} disabled={busy || state !== "ready"} data-testid="faceid-enroll-btn">
                <UserCheck size={14} /> {busy ? "ANALYSE…" : profile ? "RÉENREGISTRER MON VISAGE" : "ENREGISTRER MON VISAGE"}
              </button>
              {state !== "ready" && state !== "init" && (
                <button className="file-btn" onClick={retrySetup} data-testid="faceid-retry-camera-btn"><RotateCw size={13} /> RÉESSAYER LA CONNEXION</button>
              )}
              {profile && <button className="file-btn danger" onClick={forget} data-testid="faceid-forget-btn"><Trash2 size={13} /> EFFACER L'IDENTITÉ LOCALE</button>}
            </div>
          </aside>
        </div>

        <div className="faceid-statusline" data-testid="faceid-message">
          <span className={live?.faceDetected ? "active" : ""}><i />{live?.faceDetected ? "VISAGE DANS LE CADRE" : "EN ATTENTE DE VISAGE"}</span>
          {live?.distance != null && <span>ÉCART BIOMÉTRIQUE <b>{live.distance.toFixed(2)}</b></span>}
          <span>SEUIL DE CORRESPONDANCE <b>{MATCH_THRESHOLD.toFixed(2)}</b></span>
        </div>
      </div>
    </div>
  );
}

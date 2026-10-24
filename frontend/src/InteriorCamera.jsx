import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import "./InteriorCamera.css";

export default function InteriorCamera({ onCapture, onClose }) {
  const video = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let stream;
    const stop = () => stream?.getTracks().forEach((track) => track.stop());
    const closeHidden = () => {
      if (document.hidden || video.current?.closest(".holo-minimized")) {
        active = false; stop(); close.current();
      }
    };
    const observer = new MutationObserver(closeHidden);
    for (let ancestor = video.current?.parentElement; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ["class"] });
    }
    document.addEventListener("visibilitychange", closeHidden);
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Caméra indisponible. Utilisez une photo depuis votre galerie.");
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 }, height: { ideal: 1200 } },
        });
        if (!active) { stop(); return; }
        video.current.srcObject = stream;
        await video.current.play();
        if (active) setReady(true);
      } catch (err) {
        stop();
        if (active) setError(err.name === "NotAllowedError"
          ? "Accès caméra refusé. Autorisez la caméra dans les réglages ou importez une photo."
          : err.message || "Ouverture de la caméra impossible.");
      }
    };
    start();
    return () => { active = false; stop(); observer.disconnect(); document.removeEventListener("visibilitychange", closeHidden); };
  }, []);
  const capture = () => {
    const source = video.current;
    if (!ready || !source?.videoWidth || !source.videoHeight) {
      setError("L'image n'est pas encore prête. Attendez puis réessayez.");
      return;
    }
    try {
      const scale = Math.min(1, 1600 / Math.max(source.videoWidth, source.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(source.videoWidth * scale);
      canvas.height = Math.round(source.videoHeight * scale);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Capture indisponible. Importez une photo du lieu.");
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
      if (!dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("Capture photo impossible. Réessayez.");
      onCapture({ dataUrl, name: "Prise de vue du lieu.jpg", pdf: false, realPlace: true });
    } catch (err) { setError(err.message); }
  };
  return <section className="interior-camera" aria-label="Caméra du lieu à aménager">
    <header><h3>Photographier le lieu</h3><button type="button" onClick={onClose} aria-label="Fermer la caméra du lieu"><X size={18} /></button></header>
    <p>Cadrez la pièce, ses ouvertures et le mobilier. Aucune vidéo n'est envoyée. La photo sera jointe à votre demande uniquement après votre appui sur Proposer un aménagement.</p>
    <video ref={video} autoPlay muted playsInline onLoadedData={() => setReady(true)} aria-label="Aperçu du lieu" />
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={!ready} onClick={capture}><Camera size={18} />Prendre la photo du lieu</button>
  </section>;
}

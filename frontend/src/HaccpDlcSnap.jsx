import { useEffect, useRef, useState } from "react";
import { Camera, Check, CircleAlert, LoaderCircle, RotateCcw, X } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import { compressPhoto } from "./haccpPhotoCompress";
import "./HaccpDlcSnap.css";

const newCaptureId = () => (crypto.randomUUID ? crypto.randomUUID()
  : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));
const clock = (value) => new Date(value).toLocaleTimeString("fr-FR", {
  timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

export default function HaccpDlcSnap({
  establishmentName = "",
  kitchenToken = "",
  operation = "reception",
  onCaptureSaved,
}) {
  const [step, setStep] = useState("idle");
  const [photo, setPhoto] = useState(null);
  const [savedAt, setSavedAt] = useState("");
  const input = useRef(null);
  const captureId = useRef(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  const reset = () => {
    setPhoto(null);
    setSavedAt("");
    captureId.current = null;
    setStep("idle");
    if (input.current) input.current.value = "";
  };

  const picked = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setStep("busy");
    try {
      const blob = await compressPhoto(file);
      if (!mounted.current) return;
      captureId.current = newCaptureId();
      setPhoto({ blob, url: URL.createObjectURL(blob) });
      setStep("preview");
    } catch {
      if (mounted.current) setStep("error");
    }
  };

  const send = async () => {
    if (!photo || step === "busy") return;
    setStep("busy");
    const body = new FormData();
    body.append("file", photo.blob, "etiquette.jpg");
    body.append("restaurant_name", establishmentName.trim() || "Restaurant");
    body.append("operation", JSON.stringify({ type_operation: operation }));
    body.append("capture_id", captureId.current);
    if (!kitchenToken) body.append("operateur_compte", "true");
    let record;
    try {
      record = await haccpFetch(`${API_BASE_URL}/haccp/etiquettes/scan`, {
        method: "POST", body,
        ...(kitchenToken ? { headers: { "X-Sirius-Cuisine": kitchenToken } } : {}),
      }, async (response) => (await checkHaccpResponse(response)).json());
      if (!mounted.current) return;
      setSavedAt(record.created_at || new Date().toISOString());
      setStep("done");
    } catch {
      if (mounted.current) setStep("retry");
      return;
    }
    try { await onCaptureSaved?.(record); } catch { /* la photo est déjà archivée */ }
  };

  return <section className="dlc-snap" aria-label="Photo étiquette DLC" data-step={step}>
    <input ref={input} className="dlc-snap-input" type="file" accept="image/*" capture="environment"
      onChange={picked} aria-hidden="true" tabIndex={-1} data-testid="dlc-snap-input" />

    {step === "idle" && <button type="button" className="dlc-snap-big dlc-snap-camera"
      onClick={() => input.current?.click()} aria-label="Prendre une photo" data-testid="dlc-snap-camera">
      <Camera size={96} strokeWidth={1.6} aria-hidden="true" />
    </button>}

    {step === "busy" && <div className="dlc-snap-big dlc-snap-wait" role="status" aria-label="Envoi en cours">
      <LoaderCircle size={96} className="dlc-snap-spin" aria-hidden="true" />
    </div>}

    {(step === "preview" || step === "retry") && photo && <>
      <img className="dlc-snap-preview" src={photo.url} alt="Aperçu de l’étiquette" />
      {step === "retry" && <CircleAlert className="dlc-snap-alert" size={56} aria-label="Échec de l’envoi" />}
      <div className="dlc-snap-actions">
        <button type="button" className="dlc-snap-round dlc-snap-retake" onClick={reset}
          aria-label="Reprendre la photo" data-testid="dlc-snap-retake">
          <RotateCcw size={40} aria-hidden="true" />
        </button>
        <button type="button" className="dlc-snap-round dlc-snap-ok" onClick={send}
          aria-label="Valider et envoyer" data-testid="dlc-snap-send">
          <Check size={72} strokeWidth={3} aria-hidden="true" />
        </button>
      </div>
    </>}

    {step === "done" && <button type="button" className="dlc-snap-big dlc-snap-done" onClick={reset}
      aria-label="Photo enregistrée, nouvelle photo" data-testid="dlc-snap-done">
      <Check size={96} strokeWidth={3} aria-hidden="true" />
      <time dateTime={savedAt} translate="no">{clock(savedAt)}</time>
    </button>}

    {step === "error" && <button type="button" className="dlc-snap-big dlc-snap-error" onClick={reset}
      aria-label="Photo illisible, recommencer" data-testid="dlc-snap-error">
      <X size={96} strokeWidth={3} aria-hidden="true" />
    </button>}
  </section>;
}

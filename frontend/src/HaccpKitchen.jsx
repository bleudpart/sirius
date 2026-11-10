import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, ImageIcon, LoaderCircle, RotateCcw, Search, Settings, X } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import "./HaccpWorkspace.css";

const API = `${API_BASE_URL}/haccp`;
const shortDate = (value) => value ? new Date(value).toLocaleString("fr-FR", {
  timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
}) : "";
const PARIS = { timeZone: "Europe/Paris" };
const dayKey = (value) => new Date(value).toLocaleDateString("fr-CA", PARIS);
const recordDate = (record) => record.date_reception || record.date_fabrication || record.date_ouverture;
const shortTime = (value) => value ? new Date(value).toLocaleTimeString("fr-FR", { ...PARIS, hour: "2-digit", minute: "2-digit" }) : "";
export function dayLabel(value, now = Date.now()) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "Sans date";
  const key = dayKey(value);
  if (key === dayKey(now)) return "Aujourd'hui";
  if (key === dayKey(now - 86400000)) return "Hier";
  const label = new Date(value).toLocaleDateString("fr-FR", { ...PARIS, weekday: "long", day: "numeric", month: "long" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}
const daysAgo = (days) => {
  const date = new Date(Date.now() - days * 86400000);
  return date.toISOString().slice(0, 10);
};
const FIELD_WORDS = {
  nom_produit: "produit", numero_lot: "lot", dlc_ou_ddm: "date", type_date: "date",
  fournisseur_ou_marque: "marque", agrement_sanitaire: "agrément", temperature_stockage: "température",
  origines: "origine", poids_net: "poids", allergenes: "allergènes", traces_allergenes: "allergènes",
  mentions_traces: "allergènes", allergenes_lecture: "allergènes",
};
const plain = (text) => (text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Raison courte du sigle « À vérifier », lisible d'un coup d'œil en cuisine.
export function kitchenReason(record) {
  if (!record || record.conforme_reception) return "";
  const comment = plain(record.commentaire_anomalie);
  if (/dlc[^.]*depass/.test(comment)) return "DLC dépassée";
  const unreadable = [record.nom_produit, record.numero_lot].some((value) => plain(value) === "illisible");
  if (unreadable || comment.includes("illisible")) return "Produit ou lot illisible";
  if (record.type_operation !== "preparation" && (!record.dlc_ou_ddm || record.type_date === "inconnue")) return "Date pas lue";
  const fields = [...new Set((record.champs_incertains || []).map((name) => FIELD_WORDS[name]).filter(Boolean))];
  if (fields.length) return `Mal lu : ${fields.slice(0, 2).join(", ")}`;
  if (record.allergenes_lecture === "partielle") return "Allergènes à vérifier";
  return "À vérifier";
}

// Écran cuisine : photo → analyse → enregistrement automatique, sans formulaire ni confirmation.
export default function HaccpKitchen({ establishmentName = "", onCaptureSaved, onFullMode, kitchenToken = "" }) {
  const auth = useMemo(() => kitchenToken ? { headers: { "X-Sirius-Cuisine": kitchenToken } } : {}, [kitchenToken]);
  const [view, setView] = useState("camera");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [term, setTerm] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [photo, setPhoto] = useState(null);
  const video = useRef(null);
  const canvas = useRef(null);
  const fileInput = useRef(null);
  const pendingFile = useRef(null);
  const captureId = useRef(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const photoUrl = useRef(null);
  const listRequest = useRef(0);
  const section = useRef(null);

  const clearPhoto = useCallback(() => {
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = null;
    setPhoto(null);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
    };
  }, []);

  useEffect(() => {
    if (view !== "camera") return undefined;
    let active = true;
    let cameraStream = null;
    const activeVideo = video.current;
    const start = async () => {
      setCameraReady(false); setCameraError("");
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("Caméra indisponible.");
        return;
      }
      try {
        cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
        });
        if (!active) { cameraStream.getTracks().forEach((track) => track.stop()); return; }
        if (activeVideo) { activeVideo.srcObject = cameraStream; await activeVideo.play(); }
        if (active) setCameraReady(true);
      } catch {
        if (active) setCameraError("Caméra bloquée. Autorisez la caméra.");
      }
    };
    void start();
    return () => {
      active = false;
      cameraStream?.getTracks().forEach((track) => track.stop());
      if (activeVideo) activeVideo.srcObject = null;
    };
  }, [view, cameraAttempt]);

  const send = async (file) => {
    if (pending.current) return;
    if (!establishmentName.trim()) { setError("Restaurant non choisi."); return; }
    pending.current = true; setBusy(true); setError(""); setResult(null);
    pendingFile.current = file;
    if (!captureId.current) captureId.current = crypto.randomUUID();
    const body = new FormData();
    body.append("file", file);
    body.append("operateur", "Cuisine");
    body.append("restaurant_name", establishmentName.trim());
    body.append("operation", JSON.stringify({ type_operation: "reception" }));
    body.append("capture_id", captureId.current);
    try {
      const record = await haccpFetch(`${API}/etiquettes/scan`, { ...auth, method: "POST", body },
        async (response) => (await checkHaccpResponse(response)).json());
      pendingFile.current = null; captureId.current = null;
      if (mounted.current) setResult(record);
      try { await onCaptureSaved?.(record); } catch { /* la fiche est déjà enregistrée */ }
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Envoi impossible.");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const takePhoto = async () => {
    if (pending.current) return;
    if (!cameraReady) { fileInput.current?.click(); return; }
    try {
      const activeVideo = video.current;
      const activeCanvas = canvas.current;
      if (!activeVideo?.videoWidth || !activeCanvas) throw new Error("Caméra pas prête. Réessayez.");
      activeCanvas.width = activeVideo.videoWidth;
      activeCanvas.height = activeVideo.videoHeight;
      activeCanvas.getContext("2d").drawImage(activeVideo, 0, 0, activeCanvas.width, activeCanvas.height);
      const blob = await new Promise((resolve, reject) => activeCanvas.toBlob(
        (image) => image ? resolve(image) : reject(new Error("Photo ratée. Réessayez.")), "image/jpeg", 0.94));
      captureId.current = null;
      await send(new File([blob], "etiquette.jpg", { type: "image/jpeg" }));
    } catch (failure) {
      setError(failure.message);
    }
  };
  const pickFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) { captureId.current = null; void send(file); }
  };

  const loadList = useCallback(async (query) => {
    const request = ++listRequest.current;
    setListBusy(true); setListError("");
    const params = new URLSearchParams();
    if (query) params.set("terme", query);
    else params.set("date_debut", daysAgo(30));
    try {
      const records = await haccpFetch(`${API}/registre/recherche?${params}`, auth,
        async (response) => (await checkHaccpResponse(response)).json());
      if (!Array.isArray(records)) throw new Error("Réponse invalide.");
      if (mounted.current && request === listRequest.current) setItems(records.slice(0, 60));
    } catch (failure) {
      if (mounted.current && request === listRequest.current) setListError(failure.message);
    } finally {
      if (mounted.current && request === listRequest.current) setListBusy(false);
    }
  }, [auth]);
  // La recherche part toute seule pendant la frappe : pas de bouton à viser avec des gants.
  useEffect(() => {
    if (view !== "find") return undefined;
    const query = term.trim();
    if (!query) { void loadList(""); return undefined; }
    const timer = setTimeout(() => void loadList(query), 400);
    return () => clearTimeout(timer);
  }, [view, term, loadList]);
  const groups = useMemo(() => items.reduce((days, record) => {
    const label = dayLabel(recordDate(record));
    const last = days[days.length - 1];
    if (last?.label === label) last.records.push(record);
    else days.push({ label, records: [record] });
    return days;
  }, []), [items]);
  const openFind = () => { setItems([]); setView("find"); };
  const openPhoto = async (record) => {
    clearPhoto(); setListError("");
    section.current?.scrollIntoView?.({ block: "start" });
    if (record.type_operation === "preparation") { setPhoto({ record, src: null }); return; }
    try {
      const blob = await haccpFetch(`${API}/registre/${record.id}/photo`, auth, async (response) => {
        await checkHaccpResponse(response);
        if (!response.headers.get("content-type")?.startsWith("image/")) throw new Error("Photo introuvable.");
        return response.blob();
      });
      if (!mounted.current) return;
      photoUrl.current = URL.createObjectURL(blob);
      setPhoto({ record, src: photoUrl.current });
    } catch (failure) {
      if (mounted.current) setListError(failure.message);
    }
  };

  const ok = result?.conforme_reception;
  return <section ref={section} className="haccp-ui haccp-simple" aria-label="Cuisine — photo des étiquettes">
    {view === "camera" && <>
      <div className={`haccp-simple-camera${busy ? " is-busy" : ""}`}>
        <video ref={video} autoPlay playsInline muted aria-label="Caméra" />
        <canvas ref={canvas} hidden />
        {busy && <p className="haccp-simple-overlay" role="status"><LoaderCircle className="haccp-loading" size={56} aria-hidden="true" />Analyse…</p>}
        {!busy && cameraError && <p className="haccp-simple-overlay">{cameraError}</p>}
      </div>
      <input ref={fileInput} type="file" accept="image/*" capture="environment" hidden onChange={pickFile} data-testid="photo-fichier" />
      <button type="button" className="haccp-simple-shoot" disabled={busy} onClick={takePhoto} aria-label="Prendre la photo">
        <Camera size={56} aria-hidden="true" /><span>PHOTO</span>
      </button>
      {cameraError && <button type="button" className="haccp-simple-small" onClick={() => setCameraAttempt((n) => n + 1)}>
        <RotateCcw size={20} aria-hidden="true" />Caméra
      </button>}
      {result && <div className={`haccp-simple-result ${ok ? "is-ok" : "is-warning"}`} role="status">
        {ok ? <CheckCircle2 size={64} aria-hidden="true" /> : <AlertTriangle size={64} aria-hidden="true" />}
        <div>
          <strong>{ok ? "OK ✔ Enregistré" : "⚠ Enregistré — appeler le chef"}</strong>
          {!ok && <p className="haccp-simple-reason">{kitchenReason(result)}</p>}
          <p>{result.nom_produit}</p>
          {result.dlc_ou_ddm && <p>{result.type_date || "Date"} : {result.dlc_ou_ddm}</p>}
        </div>
      </div>}
      {error && <div className="haccp-simple-result is-error" role="alert">
        <X size={56} aria-hidden="true" />
        <div><strong>Pas enregistré</strong><p>{error}</p></div>
        {pendingFile.current && <button type="button" className="haccp-simple-small" disabled={busy}
          onClick={() => void send(pendingFile.current)}><RotateCcw size={22} aria-hidden="true" />Encore</button>}
      </div>}
      <button type="button" className="haccp-simple-find" onClick={openFind}>
        <Search size={40} aria-hidden="true" /><span>RETROUVER</span>
      </button>
    </>}
    {view === "find" && <>
      <button type="button" className="haccp-simple-back" onClick={() => { clearPhoto(); setView("camera"); }}>
        <ArrowLeft size={36} aria-hidden="true" /><Camera size={36} aria-hidden="true" /><span>PHOTO</span>
      </button>
      {photo ? <div className="haccp-simple-photo" role="dialog" aria-modal="true" aria-label={photo.record.nom_produit}>
        <button type="button" className="haccp-simple-small" onClick={clearPhoto} aria-label="Fermer">
          <ArrowLeft size={28} aria-hidden="true" />LISTE
        </button>
        {photo.src ? <img src={photo.src} alt={photo.record.nom_produit} /> : <p>Préparation · pas de photo</p>}
        <strong>{photo.record.nom_produit}</strong>
        {!photo.record.conforme_reception && <p className="haccp-simple-reason">⚠ {kitchenReason(photo.record)}</p>}
        <p>Lot {photo.record.numero_lot} · {shortDate(recordDate(photo.record))}</p>
        {photo.record.dlc_ou_ddm && <p>{photo.record.type_date || "Date"} : {photo.record.dlc_ou_ddm}</p>}
      </div> : <>
        <form className="haccp-simple-search" role="search"
          onSubmit={(event) => { event.preventDefault(); void loadList(term.trim()); }}>
          <input value={term} maxLength={255} placeholder="🔍 nom ou lot" aria-label="Produit ou lot"
            enterKeyHint="search" onChange={(event) => setTerm(event.target.value)} />
          {term && <button type="button" aria-label="Effacer" onClick={() => setTerm("")}><X size={30} aria-hidden="true" /></button>}
        </form>
        {listBusy && <p role="status"><LoaderCircle className="haccp-loading" size={32} aria-hidden="true" /></p>}
        {listError && <p role="alert">{listError}</p>}
        {groups.map((group) => <div key={group.label} className="haccp-simple-day">
          <h3>{group.label}</h3>
          <ul className="haccp-simple-list">{group.records.map((record) => <li key={record.id}>
            <button type="button" onClick={() => void openPhoto(record)}>
              {record.conforme_reception ? <CheckCircle2 size={32} className="is-ok" aria-label="OK" />
                : <AlertTriangle size={32} className="is-warning" aria-label="À vérifier" />}
              <span><strong>{record.nom_produit}</strong>
                <small>{shortTime(recordDate(record))} · Lot {record.numero_lot}</small>
                {!record.conforme_reception && <small className="haccp-simple-reason">{kitchenReason(record)}</small>}</span>
              <ImageIcon size={30} aria-hidden="true" />
            </button>
          </li>)}</ul>
        </div>)}
        {!listBusy && !listError && items.length === 0 && <p>{term.trim() ? `Rien trouvé pour « ${term.trim()} ».` : "Rien depuis 30 jours."}</p>}
      </>}
    </>}
    {onFullMode && <button type="button" className="haccp-simple-full" onClick={onFullMode}>
      <Settings size={16} aria-hidden="true" />Mode complet (chef)
    </button>}
  </section>;
}

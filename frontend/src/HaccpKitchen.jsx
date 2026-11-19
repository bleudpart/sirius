import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, ClipboardList, CookingPot, FileText, ImageIcon, LoaderCircle, PackageCheck, RotateCcw, Scissors, Search, Settings, X } from "lucide-react";
import HaccpLabelCapture from "./HaccpLabelCapture";
import HaccpPreparation from "./HaccpPreparation";
import HaccpReleves from "./HaccpReleves";
import HaccpEntries, { formatReceivedQuantity, validReceivedQuantity } from "./HaccpEntries";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import { HACCP_CATEGORIES, HACCP_CATEGORY_LABELS } from "./haccpCategories";
import "./HaccpWorkspace.css";

const API = `${API_BASE_URL}/haccp`;
const MOBILE_PRINT_SETTING = "sirius-cuisine-impression-mobile";
const shortDate = (value) => value ? new Date(value).toLocaleString("fr-FR", {
  timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
}) : "";
const PARIS = { timeZone: "Europe/Paris" };
const dayKey = (value) => new Date(value).toLocaleDateString("fr-CA", PARIS);
const recordDate = (record) => record.date_reception || record.date_fabrication || record.date_ouverture;
const documentName = (record) => record.type_document === "facture" ? "Facture" : record.type_document === "bon_livraison" ? "Bon de livraison" : "Document non reconnu";
const validDocument = (record) => record && ["facture", "bon_livraison", "inconnu"].includes(record.type_document)
  && typeof record.id === "string" && /^[0-9a-f-]{36}$/i.test(record.id)
  && typeof record.restaurant_name === "string" && Array.isArray(record.lignes)
  && record.lignes.every((line) => line && (line.produit === null || typeof line.produit === "string")
    && (line.lot === null || typeof line.lot === "string")
    && (line.categorie === undefined || HACCP_CATEGORIES.includes(line.categorie))
    && (line.quantite === undefined || validReceivedQuantity(line.quantite))
    && (line.unite == null || typeof line.unite === "string"))
  && Array.isArray(record.incertitudes) && record.incertitudes.every((value) => typeof value === "string");
function DocumentDetails({ record }) {
  const groups = HACCP_CATEGORIES.map((category) => ({
    category, lines: record.lignes.filter((line) => (line.categorie || "Non classé") === category),
  })).filter((group) => group.lines.length);
  return <>
    <strong>{documentName(record)} · {record.reference || "Référence non lue"}</strong>
    <p>{record.fournisseur || "Fournisseur non lu"} · Établissement : {record.restaurant_name}</p>
    {groups.map((group) => <div key={group.category}>
      <h4>{HACCP_CATEGORY_LABELS[group.category]}</h4>
      <ul>{group.lines.map((line, index) => <li key={index}>
        {line.produit || "Produit non lu"} · Quantité : {formatReceivedQuantity(line.quantite)} {line.unite || ""}
        {" · "}Lot : {line.lot || "Absent ou illisible"}
      </li>)}</ul>
    </div>)}
    {record.incertitudes.map((message, index) => <p className="haccp-simple-reason" key={index}>{message}</p>)}
    <p>Lecture documentaire uniquement : réception physique, quantités et température non vérifiées. Aucun mouvement de stock ni écriture comptable.</p>
  </>;
}
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
  if (record.type_operation !== "preparation" && (!record.dlc_ou_ddm || record.type_date === "inconnue")) return "Date à vérifier";
  const fields = [...new Set((record.champs_incertains || []).map((name) => FIELD_WORDS[name]).filter(Boolean))];
  if (fields.length) return `Mal lu : ${fields.slice(0, 2).join(", ")}`;
  if (record.allergenes_lecture === "partielle") return "Allergènes à vérifier";
  return "À vérifier";
}

// Écran cuisine : photo → analyse → enregistrement automatique, sans formulaire ni confirmation.
export default function HaccpKitchen({ establishmentName = "", onCaptureSaved, onFullMode, onRelevesDirtyChange, kitchenToken = "" }) {
  const auth = useMemo(() => kitchenToken ? { headers: { "X-Sirius-Cuisine": kitchenToken } } : {}, [kitchenToken]);
  const [mobilePrinting, setMobilePrinting] = useState(false);
  const [printerSettingMessage, setPrinterSettingMessage] = useState("");
  const [view, setView] = useState("camera");
  const [source, setSource] = useState("etiquette");
  const [documents, setDocuments] = useState([]);
  const [relevesDirty, setRelevesDirty] = useState(false);
  const [relevesSaving, setRelevesSaving] = useState(false);
  const reportRelevesDirty = useMemo(() => (value) => {
    setRelevesDirty(value);
    onRelevesDirtyChange?.(value);
  }, [onRelevesDirtyChange]);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [cameraNotice, setCameraNotice] = useState("");
  const [cameraAttempt, setCameraAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const openingResult = result?.type_operation === "ouverture";
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [term, setTerm] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [photo, setPhoto] = useState(null);
  const [openingPreview, setOpeningPreview] = useState("");
  const video = useRef(null);
  const canvas = useRef(null);
  const fileInput = useRef(null);
  const pendingFile = useRef(null);
  const pendingSource = useRef(null);
  const captureId = useRef(null);
  const pending = useRef(false);
  const takingPhoto = useRef(false);
  const mounted = useRef(true);
  const photoUrl = useRef(null);
  const openingPhotoUrl = useRef(null);
  const listRequest = useRef(0);
  const section = useRef(null);

  useEffect(() => {
    if (!kitchenToken) return;
    try {
      setMobilePrinting(localStorage.getItem(MOBILE_PRINT_SETTING) === "mobile");
    } catch (failure) {
      setPrinterSettingMessage(`Réglage de l’imprimante inaccessible : ${failure.message}`);
    }
  }, [kitchenToken]);

  const configureMobilePrinting = (enabled) => {
    try {
      localStorage.setItem(MOBILE_PRINT_SETTING, enabled ? "mobile" : "windows");
      setMobilePrinting(enabled);
      setPrinterSettingMessage("Réglage enregistré sur ce téléphone.");
    } catch (failure) {
      setPrinterSettingMessage(`Réglage non enregistré : ${failure.message}`);
    }
  };

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
      if (openingPhotoUrl.current) URL.revokeObjectURL(openingPhotoUrl.current);
    };
  }, []);

  useEffect(() => {
    if (view !== "camera" || openingResult) return undefined;
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
          video: { facingMode: "environment", width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false,
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
  }, [view, cameraAttempt, openingResult]);

  const send = async (file) => {
    if (pending.current) return;
    if (!establishmentName.trim()) { setError("Restaurant non choisi."); return; }
    pending.current = true; setBusy(true); setError(""); setResult(null);
    pendingFile.current = file;
    if (!pendingSource.current) pendingSource.current = source;
    if (!captureId.current) captureId.current = crypto.randomUUID();
    const body = new FormData();
    body.append("file", file);
    body.append("operateur", "Cuisine");
    body.append("restaurant_name", establishmentName.trim());
    body.append("operation", JSON.stringify({ type_operation: pendingSource.current === "ouverture" ? "ouverture" : "reception" }));
    if (pendingSource.current === "ouverture") body.append("ouverture_automatique", "true");
    if (!kitchenToken && pendingSource.current !== "document") body.append("operateur_compte", "true");
    body.append("capture_id", captureId.current);
    let previewUrl = null;
    try {
      const document = pendingSource.current === "document";
      if (pendingSource.current === "ouverture") previewUrl = URL.createObjectURL(file);
      const record = await haccpFetch(`${API}/${document ? "receptions/documents" : "etiquettes/scan"}`, { ...auth, method: "POST", body },
        async (response) => (await checkHaccpResponse(response)).json());
      if (document && !validDocument(record)) throw new Error("Réponse documentaire invalide. Vérifiez les documents reçus avant de refaire la photo.");
      if (mounted.current && record.type_operation === "ouverture" && previewUrl) {
        if (openingPhotoUrl.current) URL.revokeObjectURL(openingPhotoUrl.current);
        openingPhotoUrl.current = previewUrl;
        previewUrl = null;
        setOpeningPreview(openingPhotoUrl.current);
      }
      pendingFile.current = null; captureId.current = null; pendingSource.current = null;
      if (mounted.current) setResult(record);
      if (!document) {
        try { await onCaptureSaved?.(record); } catch { /* la fiche est déjà enregistrée */ }
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message || "Envoi impossible.");
    } finally {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const takePhoto = async () => {
    if (pending.current || takingPhoto.current) return;
    if (!cameraReady) { fileInput.current?.click(); return; }
    takingPhoto.current = true;
    setBusy(true); setCameraNotice("");
    try {
      const activeVideo = video.current;
      const activeCanvas = canvas.current;
      if (!activeVideo?.videoWidth || !activeCanvas) throw new Error("Caméra pas prête. Réessayez.");
      const track = activeVideo.srcObject?.getVideoTracks?.()[0];
      let blob;
      if (track && typeof window.ImageCapture === "function") {
        try {
          blob = await new window.ImageCapture(track).takePhoto({ imageWidth: 3840, imageHeight: 2160 });
          if (!blob?.size || !["image/jpeg", "image/png", "image/webp"].includes(blob.type)) {
            throw new Error("Format de photo non pris en charge.");
          }
        } catch (failure) {
          blob = null;
          console.warn("[HACCP] Photo haute résolution indisponible :", failure);
          if (mounted.current) setCameraNotice("Photo haute résolution indisponible : utilisation de l’aperçu.");
        }
      }
      if (!blob) {
        activeCanvas.width = activeVideo.videoWidth;
        activeCanvas.height = activeVideo.videoHeight;
        const context = activeCanvas.getContext("2d");
        if (!context) throw new Error("Capture de la caméra indisponible.");
        context.drawImage(activeVideo, 0, 0, activeCanvas.width, activeCanvas.height);
        blob = await new Promise((resolve, reject) => activeCanvas.toBlob(
          (image) => image ? resolve(image) : reject(new Error("Photo ratée. Réessayez.")), "image/jpeg", 0.94));
      }
      captureId.current = null; pendingSource.current = null;
      const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      await send(new File([blob], `etiquette.${extension}`, { type: blob.type }));
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      takingPhoto.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const pickFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) { captureId.current = null; pendingSource.current = null; void send(file); }
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
  useEffect(() => {
    if (view !== "documents") return undefined;
    let active = true;
    setListBusy(true); setListError("");
    haccpFetch(`${API}/receptions/documents?${new URLSearchParams({ restaurant_name: establishmentName })}`, auth,
      async (response) => (await checkHaccpResponse(response)).json())
      .then((records) => {
        if (!Array.isArray(records) || !records.every(validDocument)) throw new Error("Réponse documentaire invalide.");
        if (active) setDocuments(records);
      })
      .catch((failure) => { if (active) setListError(failure.message); })
      .finally(() => { if (active) setListBusy(false); });
    return () => { active = false; };
  }, [view, establishmentName, auth]);
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
      const path = record.type_document ? `receptions/documents/${record.id}/photo` : `registre/${record.id}/photo`;
      const blob = await haccpFetch(`${API}/${path}`, auth, async (response) => {
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
    {view === "camera" && !openingResult && <>
      <div className="haccp-simple-modes" role="group" aria-label="Type d’opération">
        <button type="button" disabled={busy} aria-pressed={source === "etiquette"} onClick={() => { setSource("etiquette"); setResult(null); }}>
          <PackageCheck size={26} aria-hidden="true" /><span>Réception</span>
        </button>
        <button type="button" disabled={busy} aria-pressed={source === "ouverture"} onClick={() => { setSource("ouverture"); setResult(null); }}>
          <Scissors size={26} aria-hidden="true" /><span>Ouverture produit</span>
        </button>
        <button type="button" disabled={busy} aria-pressed={source === "document"} onClick={() => { setSource("document"); setResult(null); }}>
          <FileText size={26} aria-hidden="true" /><span>Facture / Bon de livraison</span>
        </button>
      </div>
      {kitchenToken && <details className="haccp-mobile-setup">
        <summary>Imprimante Brother Wi-Fi · réglage du téléphone</summary>
        <p>Connectez le téléphone au même Wi-Fi que la Brother QL-820NWBc. Sur iPhone, utilisez AirPrint.
          Sur Android, installez et activez une fois le <a href="https://play.google.com/store/apps/details?id=com.brother.printservice"
            target="_blank" rel="noopener noreferrer">service d’impression Brother</a>.</p>
        <label className="haccp-check"><input type="checkbox" checked={mobilePrinting}
          onChange={(event) => configureMobilePrinting(event.target.checked)} />
          Imprimer depuis ce téléphone, sans PC
        </label>
        <p>Rouleau DK-22205, bande continue 62 mm. Sélectionnez la Brother et vérifiez le format, la lisibilité et la coupe sur papier.</p>
        {printerSettingMessage && <p role="status">{printerSettingMessage}</p>}
      </details>}
      {source === "ouverture" && <p>Photographiez aussi la consigne après ouverture.</p>}
      {result?.type_document && <div className="haccp-simple-result" role="status">
        <FileText size={48} aria-hidden="true" /><div><p>Document archivé dans le dossier de l’établissement</p><DocumentDetails record={result} /></div>
      </div>}
      {result && !result.type_document && <div className={`haccp-simple-result ${ok ? "is-ok" : "is-warning"}`} role="status">
        {ok ? <CheckCircle2 size={64} aria-hidden="true" /> : <AlertTriangle size={64} aria-hidden="true" />}
        <div>
          <strong>{ok ? "OK ✔ Enregistré" : "⚠ Enregistré — appeler le chef"}</strong>
          {!ok && <p className="haccp-simple-reason">{kitchenReason(result)}</p>}
          <p translate="no">{result.nom_produit}</p>
          {result.numero_lot && <p><span>Lot</span> : <span translate="no">{result.numero_lot}</span></p>}
          {result.dlc_ou_ddm && <p>{result.type_date || "Date"} : <span translate="no">{result.dlc_ou_ddm}</span></p>}
        </div>
      </div>}
      {error && <div className="haccp-simple-result is-error" role="alert">
        <X size={56} aria-hidden="true" />
        <div><strong>Pas enregistré</strong><p>{error}</p></div>
        {pendingFile.current && <button type="button" className="haccp-simple-small" disabled={busy}
          onClick={() => void send(pendingFile.current)}><RotateCcw size={22} aria-hidden="true" />Encore</button>}
      </div>}
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
      {cameraNotice && <p role="status">{cameraNotice}</p>}
      <button type="button" className="haccp-simple-find" disabled={busy} onClick={() => setView("preparation")}>
        <CookingPot size={40} aria-hidden="true" /><span>PRÉPARATION</span>
      </button>
      <button type="button" className="haccp-simple-find" disabled={busy} onClick={openFind}>
        <Search size={40} aria-hidden="true" /><span>RETROUVER</span>
      </button>
      <button type="button" className="haccp-simple-find" disabled={busy} onClick={() => setView("releves")}>
        <ClipboardList size={40} aria-hidden="true" /><span>RELEVÉS</span>
      </button>
      <button type="button" className="haccp-simple-find" disabled={busy} onClick={() => { clearPhoto(); setView("documents"); }}>
        <FileText size={40} aria-hidden="true" /><span>DOCUMENTS REÇUS</span>
      </button>
      <button type="button" className="haccp-simple-find" disabled={busy} onClick={() => setView("entrees")}>
        <ClipboardList size={40} aria-hidden="true" /><span>STOCK · ENTRÉES</span>
      </button>
    </>}
    {view === "camera" && openingResult && <>
      <HaccpLabelCapture savedRecord={result} kitchenMode kitchenToken={kitchenToken} mobilePrinting={mobilePrinting} originalPhotoUrl={openingPreview}
        onScanAgain={() => {
          if (openingPhotoUrl.current) URL.revokeObjectURL(openingPhotoUrl.current);
          openingPhotoUrl.current = null; setOpeningPreview(""); setResult(null);
        }} />
    </>}
    {view === "preparation" && <>
      <button type="button" className="haccp-simple-back" onClick={() => setView("camera")}>
        <ArrowLeft size={36} aria-hidden="true" /><Camera size={36} aria-hidden="true" /><span>PHOTO</span>
      </button>
      <HaccpPreparation kitchenToken={kitchenToken} mobilePrinting={mobilePrinting} establishmentName={establishmentName} sessionReady />
    </>}
    {view === "releves" && <HaccpReleves establishmentName={establishmentName} kitchenToken={kitchenToken}
      onBack={() => setView("camera")} onDirtyChange={reportRelevesDirty} onSavingChange={setRelevesSaving} />}
    {view === "entrees" && <HaccpEntries key={`${kitchenToken}:${establishmentName}`}
      establishmentName={establishmentName} kitchenToken={kitchenToken} onBack={() => setView("camera")} />}
    {view === "documents" && <>
      <button type="button" className="haccp-simple-back" onClick={() => { clearPhoto(); setView("camera"); }}>
        <ArrowLeft size={36} aria-hidden="true" />PHOTO
      </button>
      {listBusy && <p role="status">Chargement des documents…</p>}
      {listError && <p role="alert">{listError}</p>}
      {photo ? <div className="haccp-simple-photo">
        <button type="button" className="haccp-simple-small" onClick={clearPhoto}>LISTE</button>
        <img src={photo.src} alt={documentName(photo.record)} />
        <DocumentDetails record={photo.record} />
      </div> : <ul className="haccp-simple-list">{documents.map((record) => <li key={record.id}>
        <button type="button" onClick={() => void openPhoto(record)}>
          <FileText size={32} aria-hidden="true" /><span>{documentName(record)} · {record.reference || "Sans référence"}<small>{record.fournisseur || "Fournisseur non lu"} · {shortDate(record.created_at)}</small></span>
        </button>
      </li>)}</ul>}
      {!listBusy && !listError && !documents.length && <p>Aucun document reçu.</p>}
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
    {onFullMode && <button type="button" className="haccp-simple-full" disabled={busy || relevesSaving} onClick={() => {
      if (view === "releves" && relevesDirty && !window.confirm("Quitter cette saisie sans l'enregistrer ?")) return;
      onFullMode();
    }}>
      <Settings size={16} aria-hidden="true" />Mode complet (chef)
    </button>}
  </section>;
}

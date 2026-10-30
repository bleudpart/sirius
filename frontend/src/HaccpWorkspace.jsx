import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Camera, ClipboardList, QrCode, ShieldCheck, Search, Download, Image, X, Utensils } from "lucide-react";
import HaccpLabelCapture from "./HaccpLabelCapture";
import { API_BASE_URL } from "./lib/api";
import { haccpFetch } from "./haccpRequest";
import "./HaccpWorkspace.css";

const ROOT = `${API_BASE_URL}/haccp/registre`;
export const HACCP_CAPTURE_URL = "https://sirius-assistant.fr/haccp";
const CATEGORIES = ["Viandes", "Poissons", "Produits Laitiers", "Fruits & Légumes", "Épicerie", "Non classé"];

async function checked(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `Registre indisponible (${response.status}).`);
  }
  return response;
}

export default function HaccpWorkspace({ standalone = false, captureRequest = 0 }) {
  const [tab, setTab] = useState("capture");
  useEffect(() => {
    if (captureRequest > 0) setTab("capture");
  }, [captureRequest]);
  const [filters, setFilters] = useState({ terme: "", categorie: "", date_debut: "", date_fin: "", non_conforme_seul: false });
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [wakeLockStatus, setWakeLockStatus] = useState("");
  const [establishmentOptions, setEstablishmentOptions] = useState([]);
  const [activeEstablishment, setActiveEstablishment] = useState("");
  const [establishmentDraft, setEstablishmentDraft] = useState("");
  const [establishmentLoading, setEstablishmentLoading] = useState(true);
  const [establishmentError, setEstablishmentError] = useState("");
  const [dossier, setDossier] = useState(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [dossierError, setDossierError] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const photoRef = useRef(null);
  const controller = useRef(null);
  const dossierRequest = useRef(0);
  const requestNumber = useRef(0);
  const activeEstablishmentRef = useRef(activeEstablishment);
  activeEstablishmentRef.current = activeEstablishment;
  const mounted = useRef(true);
  const clearPhoto = useCallback(() => {
    if (photoRef.current) URL.revokeObjectURL(photoRef.current);
    photoRef.current = null;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); clearPhoto(); };
  }, [clearPhoto]);
  const loadDossier = useCallback(async (name, preserveSession = false) => {
    if (!mounted.current) return;
    const normalizedName = name.trim();
    if (!normalizedName) return;
    const request = ++dossierRequest.current;
    setDossierLoading(true);
    setDossierError("");
    if (!preserveSession) {
      setDossier(null);
      setSessionReady(false);
    }
    try {
      const params = new URLSearchParams({ restaurant_name: normalizedName });
      const data = await haccpFetch(`${API_BASE_URL}/haccp/receptions/dossier?${params}`, {},
        async (response) => (await checked(response)).json());
      if (!data || typeof data.restaurant_slug !== "string" || typeof data.directory_existed !== "boolean" || !Array.isArray(data.items)) {
        throw new Error("La réponse du dossier d’établissement est invalide.");
      }
      if (mounted.current && request === dossierRequest.current
        && activeEstablishmentRef.current === normalizedName) {
        setDossier(data);
        if (!preserveSession) setSessionReady(!data.directory_existed);
      }
    } catch (failure) {
      if (mounted.current && request === dossierRequest.current
        && activeEstablishmentRef.current === normalizedName) {
        setDossier(null);
        setSessionReady(false);
        setDossierError(failure.message);
      }
    } finally {
      if (mounted.current && request === dossierRequest.current) setDossierLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    const loadEstablishments = async () => {
      setEstablishmentLoading(true);
      setEstablishmentError("");
      let companyName = "";
      try {
        const context = await haccpFetch(`${API_BASE_URL}/enterprise/context`, {},
          async (response) => (await checked(response)).json());
        companyName = context?.company?.name?.trim() || "";
        const sitesResponse = context?.company
          ? await haccpFetch(`${API_BASE_URL}/enterprise/sites`, {},
            async (response) => (await checked(response)).json())
          : { items: [] };
        const sites = (Array.isArray(sitesResponse.items) ? sitesResponse.items : [])
          .filter((site) => site.active && typeof site.name === "string" && site.name.trim());
        const remembered = localStorage.getItem("sirius.haccp.establishment") || "";
        let selected = "";
        let options = [];
        if (sites.length) {
          options = sites;
          selected = sites.find((site) => site.name === remembered)?.name
            || (sites.length === 1 ? sites[0].name : "");
        } else {
          selected = companyName || remembered;
        }
        if (!active) return;
        setEstablishmentOptions(options);
        setEstablishmentDraft(selected);
        setActiveEstablishment(selected);
      } catch (failure) {
        if (active) {
          setEstablishmentError(failure.message);
          setEstablishmentOptions([]);
          setEstablishmentDraft(localStorage.getItem("sirius.haccp.establishment") || companyName);
        }
      } finally {
        if (active) setEstablishmentLoading(false);
      }
    };
    void loadEstablishments();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!activeEstablishment) {
      dossierRequest.current += 1;
      setDossier(null);
      setSessionReady(false);
      setDossierError("");
      return undefined;
    }
    localStorage.setItem("sirius.haccp.establishment", activeEstablishment);
    void loadDossier(activeEstablishment);
    return undefined;
  }, [activeEstablishment, loadDossier]);
  const openManualDossier = (event) => {
    event.preventDefault();
    const name = establishmentDraft.trim();
    if (!name) {
      setEstablishmentError("Indiquez le nom du restaurant actif.");
      return;
    }
    setEstablishmentError("");
    if (name === activeEstablishment) void loadDossier(name);
    else setActiveEstablishment(name);
  };
  const refreshDossier = useCallback(() => {
    if (activeEstablishment) return loadDossier(activeEstablishment, true);
    return Promise.resolve();
  }, [activeEstablishment, loadDossier]);
  useEffect(() => {
    if (!standalone) return undefined;
    if (!navigator.wakeLock?.request) {
      setWakeLockStatus("Ce navigateur ne permet pas de garder l’écran allumé.");
      return undefined;
    }
    let active = true;
    let lock = null;
    let requesting = false;
    const requestLock = async () => {
      if (!active || document.visibilityState !== "visible" || lock || requesting) return;
      requesting = true;
      try {
        const nextLock = await navigator.wakeLock.request("screen");
        if (!active || document.visibilityState !== "visible") {
          await nextLock.release();
          return;
        }
        lock = nextLock;
        setWakeLockStatus("Écran maintenu allumé pendant le service.");
        nextLock.addEventListener("release", () => {
          if (lock === nextLock) {
            lock = null;
            if (active) setWakeLockStatus("Verrou d’écran libéré ; il sera redemandé au retour dans l’application.");
          }
        }, { once: true });
      } catch (failure) {
        if (active) setWakeLockStatus(`Maintien de l’écran indisponible : ${failure.message}`);
      } finally {
        requesting = false;
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void requestLock();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void requestLock();
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (lock) {
        const heldLock = lock;
        lock = null;
        heldLock.release().catch((failure) => {
          console.error("HACCP : libération du verrou d’écran impossible.", failure);
        });
      }
    };
  }, [standalone]);
  function params(exporting = false) {
    const result = new URLSearchParams();
    Object.entries(filters).forEach(([name, value]) => {
      if (value && (!exporting || ["date_debut", "date_fin"].includes(name))) result.set(name, String(value));
    });
    return result;
  }
  async function load(event) {
    event?.preventDefault();
    const number = ++requestNumber.current;
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true); setError(""); setItems([]);
    try {
      const records = await haccpFetch(`${ROOT}/recherche?${params()}`, { signal: next.signal },
        async (response) => (await checked(response)).json());
      if (!Array.isArray(records)) throw new Error("Réponse du registre invalide.");
      if (mounted.current && number === requestNumber.current) setItems(records);
    } catch (failure) {
      if (failure.name !== "AbortError" && mounted.current && number === requestNumber.current) setError(failure.message);
    } finally {
      if (mounted.current && number === requestNumber.current) setBusy(false);
    }
  }
  async function exportCsv() {
    setError(""); setBusy(true);
    try {
      const blob = await haccpFetch(`${ROOT}/export-csv?${params(true)}`, {},
        async (response) => (await checked(response)).blob());
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `registre-haccp-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function showPhoto(record) {
    setError(""); setBusy(true); clearPhoto(); setPhoto(null);
    try {
      // L'URL provient toujours de l'API configuree, jamais d'un lien arbitraire du resultat.
      const blob = await haccpFetch(`${ROOT}/${record.id}/photo`, {}, async (response) => {
        await checked(response);
        if (!response.headers.get("content-type")?.startsWith("image/")) throw new Error("La preuve reçue n’est pas une image.");
        return response.blob();
      });
      if (mounted.current) {
        photoRef.current = URL.createObjectURL(blob);
        setPhoto({ src: photoRef.current, product: record.nom_produit, record });
      }
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Registre de réception et ouverture ΣIRIUS" className={`haccp-ui haccp-workspace${standalone ? " haccp-standalone" : ""}`}>
    <header className="haccp-heading">
      <div className="haccp-emblem" aria-hidden="true"><ShieldCheck size={30} /></div>
      <div><p className="haccp-kicker">ΣIRIUS · HACCP</p><h2>ΣIRIUS · Étiquettes cuisine</h2><p>De la réception à l’ouverture, gardez la preuve.</p></div>
    </header>
    <nav className="haccp-navigation" aria-label="Parcours des étiquettes">
      <button type="button" aria-pressed={tab === "capture"} onClick={() => setTab("capture")}><Camera size={19} aria-hidden="true" />Réception / Ouverture</button>
      <button type="button" aria-pressed={tab === "kitchen"} onClick={() => setTab("kitchen")}><Utensils size={19} aria-hidden="true" />Cuisine simplifiée</button>
      <button type="button" aria-pressed={tab === "registre"} onClick={() => setTab("registre")}><ClipboardList size={19} aria-hidden="true" />Registre / Contrôle</button>
      <button type="button" aria-pressed={tab === "qr"} onClick={() => setTab("qr")}><QrCode size={19} aria-hidden="true" />QR code réserve</button>
    </nav>
    {standalone && wakeLockStatus && <p className="haccp-wake-lock" role="status">{wakeLockStatus}</p>}
    {(tab === "capture" || tab === "kitchen") && <section className="haccp-card haccp-establishment" aria-label="Dossier de l’établissement">
      <p className="haccp-kicker">Établissement actif</p>
      {establishmentLoading && <p role="status">Recherche de l’établissement…</p>}
      {!establishmentLoading && establishmentOptions.length > 1 && <label>Restaurant actif
        <select value={activeEstablishment} onChange={(event) => setActiveEstablishment(event.target.value)}>
          <option value="">Choisir un établissement</option>
          {establishmentOptions.map((site) => <option key={site.id} value={site.name}>{site.name}</option>)}
        </select>
      </label>}
      {!establishmentLoading && establishmentOptions.length === 1 && activeEstablishment
        && <p className="haccp-establishment-name">{activeEstablishment}</p>}
      {!establishmentLoading && establishmentOptions.length === 0 && <form className="haccp-establishment-form" onSubmit={openManualDossier}>
        <label>Nom du restaurant actif
          <input value={establishmentDraft} maxLength={160} onChange={(event) => setEstablishmentDraft(event.target.value)} />
        </label>
        <button type="submit" disabled={!establishmentDraft.trim() || dossierLoading}>Ouvrir le dossier</button>
      </form>}
      {establishmentError && <p role="alert">{establishmentError}</p>}
      {dossierLoading && <p role="status">Ouverture du dossier…</p>}
      {dossierError && <p role="alert">{dossierError}</p>}
      {dossier && <>
        <p className="haccp-establishment-name">Dossier en cours : <strong>{dossier.restaurant_slug}</strong></p>
        {dossier.directory_existed && !sessionReady && <div className="haccp-establishment-resume">
          <p>Un dossier existe déjà. Reprenez-le pour ajouter de nouveaux scans sans écraser les documents.</p>
          <button type="button" disabled={dossierLoading} onClick={() => setSessionReady(true)}>Reprendre / Continuer</button>
        </div>}
        {!dossier.directory_existed && <p role="status">Nouveau dossier créé et prêt pour les scans.</p>}
        {!!dossier.items.length && <details className="haccp-establishment-files">
          <summary>Documents du dossier ({dossier.items.length})</summary>
          <ul>{dossier.items.map((item) => <li key={item.name}>{item.name}</li>)}</ul>
        </details>}
      </>}
    </section>}
    {tab === "capture" && <HaccpLabelCapture
      establishmentName={activeEstablishment}
      sessionReady={sessionReady}
      onCaptureSaved={refreshDossier}
    />}
    {tab === "kitchen" && <HaccpLabelCapture kitchenMode
      establishmentName={activeEstablishment}
      sessionReady={sessionReady}
      onCaptureSaved={refreshDossier}
    />}
    {tab === "qr" && <section className="workspace-surface haccp-card haccp-qr" aria-label="QR code de capture">
      <p className="haccp-kicker">Accès cuisine</p>
      <h3>Ouvrir la capture sur le téléphone</h3>
      <div className="haccp-qr-code"><QRCodeSVG value={HACCP_CAPTURE_URL} size={200} marginSize={4} /></div>
      <p><a href={HACCP_CAPTURE_URL}>{HACCP_CAPTURE_URL}</a></p>
      <p>À afficher dans la réserve. Ce QR code ne contient aucun secret et ne donne aucun accès sans connexion. Utiliser un compte autorisé du même établissement.</p>
      <p>Il ouvre le registre du serveur Internet, pas les archives locales d’un PC. Connexion Internet requise.</p>
    </section>}
    {tab === "registre" && <section className="workspace-surface haccp-card" aria-label="Contrôle sanitaire">
      <p className="haccp-kicker">Archives & preuves</p>
      <h3>Retrouver une étiquette</h3>
      <form className="haccp-filters" onSubmit={load}>
        <label className="haccp-search">Lot, produit, fournisseur ou agrément<input value={filters.terme} maxLength={255} onChange={(e) => setFilters({ ...filters, terme: e.target.value })} /></label>
        <label>Catégorie<select value={filters.categorie} onChange={(e) => setFilters({ ...filters, categorie: e.target.value })}>
          <option value="">Toutes les catégories</option>
          {CATEGORIES.map((name) => <option key={name} value={name}>{name}</option>)}
        </select></label>
        <label>Du<input type="date" value={filters.date_debut} onChange={(e) => setFilters({ ...filters, date_debut: e.target.value })} /></label>
        <label>Au<input type="date" value={filters.date_fin} onChange={(e) => setFilters({ ...filters, date_fin: e.target.value })} /></label>
        <label className="haccp-check haccp-search"><input type="checkbox" checked={filters.non_conforme_seul} onChange={(e) => setFilters({ ...filters, non_conforme_seul: e.target.checked })} /> Anomalies uniquement</label>
        <button className="haccp-primary" type="submit" disabled={busy}><Search size={18} aria-hidden="true" />Rechercher</button>
        <button type="button" disabled={busy} onClick={exportCsv}><Download size={18} aria-hidden="true" />Exporter le registre CSV de la période</button>
      </form>
      <p>Dates d’archivage en UTC, fin de journée incluse. L’export couvre toute la période, indépendamment du terme, de la catégorie et du filtre d’anomalie.</p>
      {busy && <p role="status">Chargement…</p>}
      {error && <p role="alert">{error}</p>}
      <ul className="haccp-records">{items.map((record) => <li key={record.id}>
        <strong>{record.nom_produit}</strong> · Lot {record.numero_lot} · {record.type_operation === "ouverture" ? "Ouverture" : "Réception"}
        <p>Catégorie : {record.categorie || "Non classé"}</p>
        <p>{record.fournisseur_ou_marque || "Fournisseur non lu"} · {record.type_date} {record.dlc_ou_ddm || "Non lue"} · {record.conforme_reception ? "Étiquette à vérifier" : "Anomalie à vérifier"}</p>
        {record.commentaire_anomalie && <p>{record.commentaire_anomalie}</p>}
        {record.dlc_secondaire && <p>DLC secondaire : {new Date(record.dlc_secondaire).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} (Europe/Paris)</p>}
        <button type="button" disabled={busy} onClick={() => showPhoto(record)}><Image size={18} aria-hidden="true" />Voir la preuve / imprimer — {record.numero_lot}</button>
      </li>)}</ul>
      {!busy && items.length === 0 && <p>Aucune fiche affichée. Lancez une recherche ; un résultat vide ne prouve pas une absence de réception.</p>}
      {photo && <div className="haccp-proof" role="dialog" aria-label="Photo originale de l’étiquette" aria-modal="true">
        <button onClick={() => { clearPhoto(); setPhoto(null); }}><X size={18} aria-hidden="true" />Fermer la preuve</button>
        <img src={photo.src} alt={`Étiquette originale — ${photo.product}`} style={{ maxWidth: "100%", height: "auto" }} />
        <HaccpLabelCapture key={photo.record.id} savedRecord={photo.record} />
      </div>}
    </section>}
  </section>;
}

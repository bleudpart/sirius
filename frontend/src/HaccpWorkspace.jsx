import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, ClipboardCheck, ClipboardList, QrCode, ShieldCheck, Search, Download, FileDown, Image, X, Utensils } from "lucide-react";
import HaccpKitchen from "./HaccpKitchen";
import HaccpKitchenLink from "./HaccpKitchenLink";
import HaccpLabelCapture from "./HaccpLabelCapture";
import HaccpPreparation from "./HaccpPreparation";
import HaccpReceptions from "./HaccpReceptions";
import { useHaccpRelevePrintRelay } from "./haccpRelevePrinter";
import { downloadHaccpBlob } from "./haccpDocuments";
import { API_BASE_URL } from "./lib/api";
import { haccpFetch } from "./haccpRequest";
import { HACCP_CATEGORIES } from "./haccpCategories";
import useScreenWakeLock from "./useScreenWakeLock";
import "./HaccpWorkspace.css";

const ROOT = `${API_BASE_URL}/haccp/registre`;
export const HACCP_CAPTURE_URL = "https://sirius-assistant.fr/haccp";
const CATEGORIES = HACCP_CATEGORIES;
const parisToday = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
};

async function checked(response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(typeof body?.detail === "string" ? body.detail : `Registre indisponible (${response.status}).`);
  }
  return response;
}

export default function HaccpWorkspace({ standalone = false, captureRequest = 0, initialTab = "simple", onDirtyChange }) {
  const [tab, setTab] = useState(initialTab);
  const currentTab = useRef(tab);
  const relevesDirty = useRef(false);
  currentTab.current = tab;
  const changeTab = useCallback((next) => {
    if (next !== currentTab.current && relevesDirty.current
      && !window.confirm("Quitter cette saisie sans l'enregistrer ?")) return;
    setTab(next);
  }, []);
  const reportRelevesDirty = useCallback((value) => {
    relevesDirty.current = value;
    onDirtyChange?.(value);
  }, [onDirtyChange]);
  const relevePrintRelay = useHaccpRelevePrintRelay(standalone ? "standalone" : null);
  useEffect(() => {
    if (captureRequest > 0) changeTab("simple");
  }, [captureRequest, changeTab]);
  useEffect(() => {
    if (initialTab) changeTab(initialTab);
  }, [initialTab, changeTab]);
  const [filters, setFilters] = useState({ terme: "", categorie: "", date_debut: "", date_fin: "", non_conforme_seul: false });
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState(null);
  const { message: wakeLockStatus } = useScreenWakeLock(standalone);
  const [establishmentOptions, setEstablishmentOptions] = useState([]);
  const [activeEstablishment, setActiveEstablishment] = useState("");
  const [establishmentDraft, setEstablishmentDraft] = useState("");
  const [establishmentLoading, setEstablishmentLoading] = useState(true);
  const [establishmentError, setEstablishmentError] = useState("");
  const [dossier, setDossier] = useState(null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [dossierError, setDossierError] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const [closingDate, setClosingDate] = useState(parisToday);
  const [closingReport, setClosingReport] = useState(null);
  const [closingError, setClosingError] = useState("");
  const [closingNotice, setClosingNotice] = useState("");
  const [closingManager, setClosingManager] = useState("");
  const [closingConfirmed, setClosingConfirmed] = useState(false);
  const [closingBusy, setClosingBusy] = useState(false);
  const photoRef = useRef(null);
  const controller = useRef(null);
  const dossierRequest = useRef(0);
  const requestNumber = useRef(0);
  const closingRequest = useRef(0);
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
      downloadHaccpBlob(blob, `registre-haccp-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function showPhoto(record) {
    setError(""); setBusy(true); clearPhoto(); setPhoto(null);
    try {
      if (record.type_operation === "preparation") {
        setPhoto({ src: null, product: record.nom_produit, record });
        return;
      }
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
  const loadClosingReport = useCallback(async () => {
    const request = ++closingRequest.current;
    setClosingBusy(true);
    setClosingError("");
    setClosingNotice("");
    try {
      const params = new URLSearchParams({ date: closingDate });
      const report = await haccpFetch(`${ROOT}/cloture?${params}`, {},
        async (response) => (await checked(response)).json());
      if (!report || report.date !== closingDate || !/^[a-f0-9]{64}$/.test(report.revision)
        || !Array.isArray(report.priorites) || !Array.isArray(report.limites)) {
        throw new Error("La réponse du bilan de clôture est invalide.");
      }
      if (mounted.current && request === closingRequest.current) {
        setClosingReport(report);
        setClosingConfirmed(false);
      }
    } catch (failure) {
      if (mounted.current && request === closingRequest.current) {
        setClosingReport(null);
        setClosingError(failure.message);
      }
    } finally {
      if (mounted.current && request === closingRequest.current) setClosingBusy(false);
    }
  }, [closingDate]);
  useEffect(() => {
    if (tab === "closing") void loadClosingReport();
  }, [tab, loadClosingReport]);
  async function openClosingRecord(id) {
    setClosingError("");
    try {
      const record = await haccpFetch(`${ROOT}/${encodeURIComponent(id)}/donnees`, {},
        async (response) => (await checked(response)).json());
      if (!record || String(record.id) !== String(id)) throw new Error("La fiche demandée n'est pas disponible dans ce registre.");
      setTab("registre");
      await showPhoto(record);
    } catch (failure) {
      if (mounted.current) setClosingError(failure.message);
    }
  }
  async function downloadClosingPdf(event) {
    event.preventDefault();
    if (!closingReport || !closingConfirmed || closingManager.trim().length < 2) return;
    setClosingBusy(true);
    setClosingError("");
    setClosingNotice("");
    try {
      const blob = await haccpFetch(`${ROOT}/cloture/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: closingReport.date,
          revision: closingReport.revision,
          nom_responsable: closingManager.trim(),
          confirme_verification_humaine: true,
        }),
      }, async (response) => {
        await checked(response);
        if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/pdf") {
          throw new Error("Le document reçu n'est pas un PDF.");
        }
        return response.blob();
      });
      downloadHaccpBlob(blob, `bilan-cloture-haccp-${closingReport.date}.pdf`);
      if (mounted.current) setClosingNotice("PDF téléchargé après votre validation nominative.");
    } catch (failure) {
      if (mounted.current) setClosingError(failure.message);
    } finally {
      if (mounted.current) setClosingBusy(false);
    }
  }
  const simple = tab === "simple";
  return <section aria-label="Registre de réception, ouverture et préparation ΣIRIUS" className={`haccp-ui haccp-workspace${standalone ? " haccp-standalone" : ""}${simple ? " haccp-workspace-simple" : ""}`}>
    {!simple && <>
    <header className="haccp-heading">
      <div className="haccp-emblem" aria-hidden="true"><ShieldCheck size={30} /></div>
      <div><p className="haccp-kicker">ΣIRIUS · HACCP</p><h2>ΣIRIUS · Étiquettes cuisine</h2><p>Réception, ouverture et préparation : gardez la trace.</p></div>
    </header>
    {relevePrintRelay.error && <p role="alert">Relais Word arrêté : {relevePrintRelay.error} Vérifiez le papier, puis désactivez et réactivez le relais dans les relevés.</p>}
    <nav className="haccp-navigation" aria-label="Parcours des étiquettes">
      <button type="button" aria-pressed={tab === "capture"} onClick={() => changeTab("capture")}><Camera size={19} aria-hidden="true" />Réception / Ouverture</button>
      <button type="button" aria-pressed={tab === "preparation"} onClick={() => changeTab("preparation")}><Utensils size={19} aria-hidden="true" />Préparation / DLC</button>
      <button type="button" aria-pressed={simple} onClick={() => changeTab("simple")}><Camera size={19} aria-hidden="true" />Cuisine simplifiée</button>
      <button type="button" aria-pressed={tab === "registre"} onClick={() => changeTab("registre")}><ClipboardList size={19} aria-hidden="true" />Registre / Contrôle</button>
      <button type="button" aria-pressed={tab === "receptions"} onClick={() => changeTab("receptions")}><ClipboardList size={19} aria-hidden="true" />Réceptions / Lots</button>
      <button type="button" aria-pressed={tab === "closing"} onClick={() => changeTab("closing")}><ClipboardCheck size={19} aria-hidden="true" />Fin de service</button>
      <button type="button" aria-pressed={tab === "qr"} onClick={() => changeTab("qr")}><QrCode size={19} aria-hidden="true" />QR code Cuisine</button>
    </nav>
    {standalone && wakeLockStatus && <p className="haccp-wake-lock" role="status">{wakeLockStatus}</p>}
    </>}
    {(tab === "capture" || tab === "preparation" || tab === "receptions" || tab === "qr"
      || (simple && !establishmentLoading && !activeEstablishment)) && <section className="haccp-card haccp-establishment" aria-label="Dossier de l’établissement">
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
          <p>Un dossier existe déjà. Reprenez-le pour ajouter de nouvelles fiches sans écraser les documents.</p>
          <button type="button" disabled={dossierLoading} onClick={() => setSessionReady(true)}>Reprendre / Continuer</button>
        </div>}
        {!dossier.directory_existed && <p role="status">Nouveau dossier créé et prêt pour les fiches.</p>}
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
    {simple && establishmentLoading && <p role="status">…</p>}
    {simple && <HaccpKitchen
      establishmentName={activeEstablishment}
      onCaptureSaved={refreshDossier}
      onRelevesDirtyChange={reportRelevesDirty}
      onFullMode={() => setTab("capture")}
    />}
    {tab === "preparation" && <HaccpPreparation
      key={activeEstablishment}
      establishmentName={activeEstablishment}
      sessionReady={sessionReady}
    />}
    {tab === "receptions" && <HaccpReceptions key={activeEstablishment} establishmentName={activeEstablishment} />}
    {tab === "qr" && <HaccpKitchenLink establishmentName={activeEstablishment} />}
    {tab === "closing" && <section className="workspace-surface haccp-card haccp-closing" aria-label="Bilan HACCP de fin de service">
      <p className="haccp-kicker">Revue opérationnelle · Responsable</p>
      <h3>Bilan de fin de service</h3>
      <p>Le bilan rassemble les fiches enregistrées et les états d'impression de la journée. Il ne remplace ni le contrôle physique du stock ni les vérifications HACCP du responsable.</p>
      <form className="haccp-closing-date" onSubmit={(event) => { event.preventDefault(); void loadClosingReport(); }}>
        <label>Date du service
          <input type="date" value={closingDate} max={parisToday()} onChange={(event) => setClosingDate(event.target.value)} />
        </label>
        <button className="haccp-primary" type="submit" disabled={closingBusy || !closingDate}><Search size={18} aria-hidden="true" />Actualiser le bilan</button>
      </form>
      {closingBusy && <p role="status">Lecture du registre HACCP…</p>}
      {closingError && <p className="haccp-closing-error" role="alert">{closingError}</p>}
      {closingNotice && <p className="haccp-closing-notice" role="status">{closingNotice}</p>}
      {closingReport && <>
        <p className="haccp-closing-generated">État du registre au {new Date(closingReport.genere_le).toLocaleString("fr-FR", { timeZone: "Europe/Paris", timeZoneName: "short" })}.</p>
        <div className="haccp-closing-metrics" aria-label="Compteurs du service">
          <div><strong>{closingReport.etiquettes_enregistrees}</strong><span>Étiquettes enregistrées</span></div>
          <div><strong>{closingReport.impressions_confirmees}</strong><span>Envois confirmés au poste / SDK</span></div>
          {closingReport.impressions_sans_date > 0 && <div><strong>{closingReport.impressions_sans_date}</strong><span>Anciennes confirmations sans date</span></div>}
        </div>
        {closingReport.priorites.length > 0 ? <div className="haccp-closing-priorities">
          <h4><AlertTriangle size={18} aria-hidden="true" />Points à vérifier ({closingReport.priorites.length})</h4>
          {closingReport.priorites.map((priority, index) => <article className={`haccp-closing-priority haccp-closing-${priority.niveau}`} key={priority.code}>
            <p className="haccp-kicker">Priorité {index + 1} · {priority.niveau === "urgent" ? "À examiner en premier" : priority.niveau === "attention" ? "À vérifier" : "Lecture à compléter"} · {priority.total} fiche(s)</p>
            <h4>{priority.titre}</h4>
            <p>{priority.action}</p>
            <ul>{priority.fiches.map((record) => <li key={`${priority.code}-${record.etiquette_id}`}>
              <span><strong>{record.produit}</strong> · Lot {record.lot} · Fiche {record.etiquette_id}
                {record.date_cible ? ` · Date ${new Date(`${record.date_cible}T12:00:00`).toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" })}` : ""}
                {record.statut_impression ? ` · ${record.statut_impression}` : ""}
                <br />{record.motif}
              </span>
              <button type="button" disabled={busy || closingBusy} onClick={() => void openClosingRecord(record.etiquette_id)}>
                <Image size={16} aria-hidden="true" />Ouvrir la fiche
              </button>
            </li>)}</ul>
            {priority.autres_fiches > 0 && <p>{priority.autres_fiches} autre(s) fiche(s) du même type sont à vérifier dans le registre.</p>}
          </article>)}
        </div> : <p className="haccp-closing-notice">Aucune alerte n’est enregistrée pour cette journée. Cela ne prouve pas l’absence de problème ni l’exécution des contrôles physiques.</p>}
        <ul className="haccp-closing-limits">{closingReport.limites.map((limit) => <li key={limit}>{limit}</li>)}</ul>
        <form className="haccp-closing-validation" onSubmit={downloadClosingPdf}>
          <h4><FileDown size={18} aria-hidden="true" />PDF après validation humaine</h4>
          <label>Nom du responsable qui vérifie ce bilan
            <input autoComplete="name" maxLength={100} minLength={2} required value={closingManager}
              onChange={(event) => setClosingManager(event.target.value)} />
          </label>
          <label className="haccp-check">
            <input type="checkbox" required checked={closingConfirmed} onChange={(event) => setClosingConfirmed(event.target.checked)} />
            J’ai vérifié les points affichés et les contrôles physiques avant de valider ce document.
          </label>
          <button className="haccp-primary" type="submit"
            disabled={closingBusy || !closingReport.revision || !closingConfirmed || closingManager.trim().length < 2}>
            <FileDown size={18} aria-hidden="true" />Valider et télécharger le PDF
          </button>
          <p>La validation est une déclaration nominative, pas une signature électronique ou une certification officielle. Toute modification du registre impose de recharger et vérifier le bilan avant le téléchargement.</p>
        </form>
      </>}
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
        <strong>{record.nom_produit}</strong> · Lot {record.numero_lot} · {record.type_operation === "preparation" ? "Préparation" : record.type_operation === "ouverture" ? "Ouverture" : "Réception"}
        <p>Catégorie : {record.categorie || "Non classé"}</p>
        {record.type_operation === "preparation"
          ? <p>Fabrication déclarée : {new Date(record.date_fabrication).toLocaleString("fr-FR", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" })}. Sans photo ni analyse IA.</p>
          : <p>{record.fournisseur_ou_marque || "Fournisseur non lu"} · {record.type_date} {record.dlc_ou_ddm || "Non lue"} · {record.conforme_reception ? "Étiquette à vérifier" : "Anomalie à vérifier"}</p>}
        {record.restaurant_name && <p>Établissement : {record.restaurant_name}</p>}
        {record.commentaire_anomalie && <p>{record.commentaire_anomalie}</p>}
        {record.dlc_secondaire && <p>{record.type_operation === "preparation" ? "DLC de préparation" : "DLC secondaire"} : {new Date(record.dlc_secondaire).toLocaleString("fr-FR", { timeZone: "Europe/Paris", timeZoneName: "shortOffset" })} (Europe/Paris)</p>}
        <button type="button" disabled={busy} onClick={() => showPhoto(record)}><Image size={18} aria-hidden="true" />{record.type_operation === "preparation" ? "Voir la préparation / imprimer" : "Voir la preuve / imprimer"} — {record.numero_lot}</button>
      </li>)}</ul>
      {!busy && items.length === 0 && <p>Aucune fiche affichée. Lancez une recherche ; un résultat vide ne prouve pas une absence de réception.</p>}
      {photo && <div className="haccp-proof" role="dialog" aria-label={photo.record.type_operation === "preparation" ? "Fiche de préparation" : "Photo originale de l’étiquette"} aria-modal="true">
        <button onClick={() => { clearPhoto(); setPhoto(null); }}><X size={18} aria-hidden="true" />Fermer la preuve</button>
        {photo.src && <img src={photo.src} alt={`Étiquette originale — ${photo.product}`} style={{ maxWidth: "100%", height: "auto" }} />}
        <HaccpLabelCapture key={photo.record.id} savedRecord={photo.record} />
      </div>}
    </section>}
  </section>;
}

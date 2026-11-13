import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import { downloadHaccpBlob } from "./haccpDocuments";
import { HACCP_CATEGORIES, HACCP_CATEGORY_LABELS } from "./haccpCategories";

const API = `${API_BASE_URL}/haccp/receptions/entrees`;
const PAGE_SIZE = 25;
const MONTHS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
const SOURCES = { facture: "Facture", bon_livraison: "Bon de livraison", etiquette: "Étiquette" };
export const validReceivedQuantity = (value) => value === null || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) && /[1-9]/.test(value));
const nullableText = (value) => value === null || typeof value === "string";
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const formatReceivedQuantity = (value) => value == null ? "Non lue" : value.replace(".", ",");

function validatePage(data, establishment, year, month, offset) {
  if (!data || data.restaurant_name !== establishment || data.annee !== year || data.mois !== month
      || data.offset !== offset || data.limit !== PAGE_SIZE
      || !Number.isSafeInteger(data.total) || data.total < 0
      || !Array.isArray(data.annees) || !data.annees.includes(year)
      || !data.annees.every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 9999)
      || !Array.isArray(data.items) || data.items.length !== Math.min(PAGE_SIZE, Math.max(0, data.total - offset))
      || !data.items.every((item) => item && typeof item.id === "string" && item.id
        && item.restaurant_name === establishment && validDate(item.date)
        && item.date.slice(0, 4) === String(year).padStart(4, "0")
        && (month === null || item.date.slice(5, 7) === String(month).padStart(2, "0"))
        && ["document", "photo"].includes(item.origine_date)
        && HACCP_CATEGORIES.includes(item.categorie) && Object.prototype.hasOwnProperty.call(SOURCES, item.source)
        && ["produit", "unite", "lot", "reference", "fournisseur"].every((field) => nullableText(item[field]))
        && validReceivedQuantity(item.quantite))) {
    throw new Error("Réponse du registre des entrées invalide. Rechargez avant utilisation.");
  }
  return data;
}

export default function HaccpEntries({ establishmentName = "", kitchenToken = "", onBack }) {
  const [year, setYear] = useState(() => Number(new Intl.DateTimeFormat("en", { timeZone: "Europe/Paris", year: "numeric" }).format(new Date())));
  const [month, setMonth] = useState("");
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(null);
  const [years, setYears] = useState([year]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const pendingExport = useRef(false);
  const mounted = useRef(true);
  const establishment = establishmentName.trim();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!establishment) { setPage(null); setBusy(false); setError(""); return undefined; }
    let active = true;
    const controller = new AbortController();
    const params = new URLSearchParams({ restaurant_name: establishment, annee: year, offset, limit: PAGE_SIZE });
    if (month) params.set("mois", month);
    setPage(null); setBusy(true); setError("");
    haccpFetch(`${API}?${params}`, {
      signal: controller.signal, ...(kitchenToken ? { headers: { "X-Sirius-Cuisine": kitchenToken } } : {}),
    }, async (response) => (await checkHaccpResponse(response)).json())
      .then((data) => {
        const validated = validatePage(data, establishment, year, month ? Number(month) : null, offset);
        if (active) { setPage(validated); setYears(validated.annees); }
      })
      .catch((failure) => { if (active) setError(failure.message); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [establishment, kitchenToken, year, month, offset, attempt]);

  const exportCsv = async () => {
    if (pendingExport.current) return;
    if (!page) { setError("Rechargez le registre avant son export."); return; }
    pendingExport.current = true; setExporting(true); setError("");
    const params = new URLSearchParams({ restaurant_name: establishment, annee: year });
    if (month) params.set("mois", month);
    try {
      const blob = await haccpFetch(`${API}/export-csv?${params}`, {}, async (response) => {
        await checkHaccpResponse(response);
        if (!response.headers.get("content-type")?.startsWith("text/csv")) throw new Error("Le fichier des entrées est invalide.");
        return response.blob();
      });
      if (mounted.current) downloadHaccpBlob(blob, `entrees_${year}${month ? `-${month.padStart(2, "0")}` : ""}.csv`);
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      pendingExport.current = false;
      if (mounted.current) setExporting(false);
    }
  };

  const visible = page?.restaurant_name === establishment && page.annee === year
    && page.mois === (month ? Number(month) : null) && page.offset === offset ? page : null;
  return <section className="haccp-ui workspace-surface haccp-card haccp-entries" aria-label="Registre des entrées">
    {onBack && <button type="button" className="haccp-simple-back" onClick={onBack}>Retour à PHOTO</button>}
    <h3>Stock · Entrées enregistrées</h3>
    <p>Établissement : <strong>{establishment || "Non choisi"}</strong></p>
    <p>Quantités lues sur les pièces, pas stock restant. Date du document si lisible, sinon date de la photo.</p>
    <p className="haccp-notice">Une facture et son bon peuvent décrire la même livraison : aucun total automatique.
      Une photo d’étiquette ne détermine pas la quantité livrée ; son poids net n’est pas compté comme une entrée en kg.</p>
    {!establishment && <p role="status">Choisissez d’abord l’établissement.</p>}
    <div className="haccp-filters">
      <label>Année<select disabled={!establishment || exporting} value={year} onChange={(event) => { setYear(Number(event.target.value)); setOffset(0); }}>
        {[...new Set([...years, year])].sort((a, b) => b - a).map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label>Mois<select disabled={!establishment || exporting} value={month} onChange={(event) => { setMonth(event.target.value); setOffset(0); }}>
        <option value="">Toute l’année</option>
        {MONTHS.map((name, index) => <option key={name} value={String(index + 1)}>{name}</option>)}
      </select></label>
    </div>
    <div className="haccp-actions">
      <button type="button" disabled={!establishment || busy || exporting} onClick={() => { setOffset(0); setAttempt((value) => value + 1); }}>Actualiser</button>
      {!kitchenToken && <button type="button" disabled={!visible || busy || exporting} onClick={exportCsv}>
        {exporting ? "Export…" : "Exporter le tableau (CSV / Excel)"}
      </button>}
    </div>
    {busy && <p role="status">Lecture des entrées…</p>}
    {error && <p role="alert">{error}</p>}
    {visible && <>
      <p>{visible.total} ligne(s) enregistrée(s) · {month ? `${MONTHS[Number(month) - 1]} ` : ""}{year}</p>
      {visible.items.length > 0 ? <div className="haccp-entries-scroll" tabIndex={0} role="region" aria-label="Tableau des entrées">
        <table className="haccp-entries-table">
          <thead><tr>{["Date", "Famille", "Produit", "Quantité", "Unité", "Lot", "Pièce source"].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead>
          <tbody>{visible.items.map((item) => <tr key={item.id}>
            <td>{item.date.split("-").reverse().join("/")}<small>{item.origine_date === "document" ? "Document" : "Photo"}</small></td>
            <td>{HACCP_CATEGORY_LABELS[item.categorie]}</td>
            <td>{item.produit || "Non lu"}</td>
            <td>{formatReceivedQuantity(item.quantite)}</td>
            <td>{item.unite || "Non lue"}</td>
            <td>{item.lot || "Non lu"}</td>
            <td>{SOURCES[item.source]} {item.reference}<small>{item.fournisseur || "Fournisseur non lu"}</small></td>
          </tr>)}</tbody>
        </table>
      </div> : <p role="status">{visible.total === 0 ? "Aucune entrée pour cette période."
        : "Cette page n’a plus de lignes. Actualisez le registre pour revenir au début."}</p>}
      {(visible.total > PAGE_SIZE || offset > 0) && <div className="haccp-actions" aria-label="Pages des entrées">
        <button type="button" disabled={busy || exporting || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Précédent</button>
        <span>{visible.items.length ? `${offset + 1}–${offset + visible.items.length} / ${visible.total}` : `${visible.total} ligne(s)`}</span>
        <button type="button" disabled={busy || exporting || offset + PAGE_SIZE >= visible.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Suivant</button>
      </div>}
    </>}
  </section>;
}

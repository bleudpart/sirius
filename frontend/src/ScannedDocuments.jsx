import { useEffect, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { formatDocumentDate } from "./dateTime";
import DocumentScanner from "./DocumentScanner";

export function downloadScanDraft(file) {
  const url = URL.createObjectURL(new Blob([file.scan.draft], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${file.scan.kind === "sale" ? "brouillon-facture" : "fiche-depense"}-${file.id}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadScanPdf(file) {
  const response = await fetch(`${API_BASE_URL}/document-scans/${file.id}/draft.pdf`);
  if (!response.ok) {
    const data = await response.json();
    throw new Error(typeof data.detail === "string" ? data.detail : `PDF indisponible (HTTP ${response.status}).`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `${file.scan.kind === "sale" ? "brouillon-facture" : "fiche-depense"}-${file.id}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function ScannedDocuments({ dossier, disabled }) {
  const [scanning, setScanning] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    fetch(`${API_BASE_URL}/document-scans?work_dossier_id=${encodeURIComponent(dossier.id)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Erreur HTTP ${response.status}`);
        if (!Array.isArray(data.items)) throw new Error("La liste des documents reçue est invalide.");
        if (active) setDocuments(data.items);
      }).catch((cause) => { if (active) setError(cause.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dossier.id, revision]);
  const download = async (file) => {
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/files/${file.id}/download`);
      if (!response.ok) throw new Error(`Document indisponible (HTTP ${response.status}).`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = file.original_filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause.message); }
  };
  return <section className="work-dossiers-entry" aria-label="Documents scannés">
    <h3>Documents et justificatifs</h3>
    <button type="button" disabled={disabled} onClick={() => setScanning(true)}>Scanner un document</button>
    {message && <p role="status">{message}</p>}
    {loading && <p role="status">Chargement des documents…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => setRevision((value) => value + 1)}>Réessayer</button></p>}
    {!loading && !error && !documents.length && <p>Aucun document scanné dans ce dossier.</p>}
    {documents.map((file) => <article key={file.id}>
      <h4>{file.original_filename}</h4><p>Conservé le {formatDocumentDate(file.created_at)}</p>
      {file.scan.accounting && <p>{file.scan.accounting.supplier || "Fournisseur non renseigné"} ·
        Total TTC : {file.scan.accounting.total_ttc ?? "Non renseigné"} {file.scan.accounting.currency} ·
        TVA : {file.scan.accounting.tva ?? "Non renseignée"}</p>}
      <button type="button" onClick={() => download(file)}>Télécharger le document</button>
      {file.scan.accounting && <button type="button" onClick={() => {
        setError("");
        downloadScanPdf(file).catch((cause) => setError(cause.message));
      }}>Télécharger le PDF A4</button>}
      {file.scan.text && <details><summary>Texte lu</summary><p className="work-dossiers-preserve">{file.scan.text}</p></details>}
      {file.scan.draft && <details><summary>{file.scan.kind === "sale" ? "Brouillon de facture · non émis" : "Fiche de dépense"}</summary>
        <p className="work-dossiers-preserve">{file.scan.draft}</p>
        <button type="button" onClick={() => downloadScanDraft(file)}>Télécharger le brouillon</button></details>}
    </article>)}
    {scanning && <DocumentScanner initialDossier={dossier} onClose={() => setScanning(false)}
      onSaved={() => { setScanning(false); setMessage(`Document enregistré dans « ${dossier.title} ».`); setRevision((value) => value + 1); }} />}
  </section>;
}

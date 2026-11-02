import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "./lib/api";
import { checkHaccpResponse, haccpFetch } from "./haccpRequest";
import HaccpLabelCapture from "./HaccpLabelCapture";
import { checkDistribution, RECEPTION_DESTINATIONS } from "./HaccpReceptionStatus";

const ROOT = `${API_BASE_URL}/haccp/receptions`;
const PAGE_SIZE = 25;
const time = (value) => value ? new Date(value).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }) : "Date inconnue";
const names = (values) => values?.length ? values.join(", ") : "Non détectés — absence non certifiée";
const request = (path, options = {}) => haccpFetch(`${ROOT}${path}`, options,
  async (response) => (await checkHaccpResponse(response)).json());

function validateItems(items, destination) {
  for (const item of items) {
    const id = item?.id ?? item?.reception_id;
    let valid = Number.isSafeInteger(id) && id > 0;
    if (destination === "receptions") {
      valid = valid && typeof item.nom_produit === "string" && typeof item.numero_lot === "string"
        && item.type_operation === "reception" && item.reception_source_id === id;
      if (valid) checkDistribution(item.distribution, id);
    } else if (destination === "traceabilite") {
      valid = valid && typeof item.document?.etiquette?.nom_produit === "string"
        && typeof item.document?.etiquette?.numero_lot === "string"
        && typeof item.entry_hash === "string" && Number.isSafeInteger(item.sequence);
    } else {
      valid = valid && typeof item.product === "string" && (item.supplier == null || typeof item.supplier === "string");
      if (valid && destination === "allergenes") valid = ["allergens", "traces", "new_allergens", "new_traces"]
        .every((field) => Array.isArray(item[field]) && item[field].every((value) => typeof value === "string"));
      if (valid && destination === "achats" && item.net_weight != null) {
        valid = typeof item.net_weight.valeur === "string" && ["kg", "g"].includes(item.net_weight.unite);
      }
    }
    if (!valid) throw new Error("Une fiche de réception est invalide. Rechargez le registre avant toute utilisation.");
  }
}

export function HaccpDeconditionnement({ record }) {
  const [hours, setHours] = useState("72");
  const [reason, setReason] = useState("");
  const [operator, setOperator] = useState("Cuisine");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const attempt = useRef(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const canSubmit = record.type_operation === "reception" && record.reception_source_id === record.id
    && record.conforme_reception && Number.isSafeInteger(Number(hours)) && Number(hours) > 0
    && reason.trim() && operator.trim() && confirmed && !busy && !result;
  const save = async (event) => {
    event.preventDefault();
    if (pending.current) return;
    if (!canSubmit) {
      setError("Vérifiez la réception et confirmez une règle fabricant/PMS adaptée au produit réellement ouvert.");
      return;
    }
    const payload = {
      type_operation: "ouverture", duree_conservation_heures: Number(hours),
      justification_duree: reason.trim(), operateur: operator.trim(),
      regle_confirmee: true, ouverture_effectuee: true,
    };
    const snapshot = JSON.stringify(payload);
    if (attempt.current && attempt.current.snapshot !== snapshot) {
      setError("Une tentative existe déjà. Rétablissez les mêmes données ou vérifiez le registre avant une autre ouverture.");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if (!attempt.current) attempt.current = { id: crypto.randomUUID(), snapshot };
      const saved = await request(`/${record.id}/ouverture`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, capture_id: attempt.current.id }),
      });
      if (saved?.type_operation !== "ouverture" || saved.reception_source_id !== record.id
          || !Number.isSafeInteger(saved.id) || saved.id < 1 || saved.id === record.id
          || !Number.isFinite(Date.parse(saved.date_ouverture)) || !Number.isFinite(Date.parse(saved.dlc_secondaire))
          || saved.conforme_reception !== true || saved.regle_confirmee !== true) {
        throw new Error("Réponse d’ouverture invalide. Vérifiez le registre avant toute nouvelle tentative.");
      }
      if (mounted.current) setResult(saved);
    } catch (failure) {
      if (failure.status === 422) attempt.current = null;
      if (mounted.current) setError(`${failure.message} Aucune impression automatique n’a été demandée.`);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <section className="haccp-deconditionnement" aria-label="Déconditionnement depuis la réception">
    <h4>Ouvrir ou découper ce produit maintenant</h4>
    <p>72 h (J+3) est une suggestion à remplacer selon le fabricant et votre PMS, jamais une durée universellement sûre.
      La DLC d’origine reste une limite maximale. L’heure sera celle de cette déclaration, pas celle de la réception.</p>
    {!result && <form onSubmit={save}>
      <fieldset className="haccp-capture-fields" disabled={busy || !record.conforme_reception}>
        <legend>Règle validée pour ce produit et ses conditions</legend>
        <label>Durée après ouverture (heures entières)
          <input type="number" min="1" step="1" required value={hours}
            onChange={(event) => { setHours(event.target.value); setConfirmed(false); }} />
        </label>
        <label>Référence fabricant / PMS et conditions après ouverture
          <textarea maxLength={500} required value={reason}
            onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} />
        </label>
        <label>Opérateur de l’ouverture
          <input maxLength={100} required value={operator}
            onChange={(event) => { setOperator(event.target.value); setConfirmed(false); }} />
        </label>
        <label className="haccp-check"><input type="checkbox" required checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          Je viens d’ouvrir ou découper ce produit et je confirme la règle et ses conditions de conservation.
        </label>
        <button type="submit" className="haccp-primary" disabled={!canSubmit} aria-busy={busy}>
          {busy ? "Enregistrement de l’ouverture…" : "Enregistrer l’ouverture et calculer la DLC"}
        </button>
      </fieldset>
      {!record.conforme_reception && <p role="alert">Lecture incertaine : reprenez une photo lisible avant toute étiquette d’utilisation.</p>}
    </form>}
    {error && <p role="alert">{error}</p>}
    {result && <HaccpLabelCapture key={result.id} savedRecord={result} />}
  </section>;
}

function Projection({ destination, item }) {
  if (destination === "traceabilite") return <>
    <strong>#{item.reception_id} · {item.document.etiquette.nom_produit}</strong>
    <p>Lot {item.document.etiquette.numero_lot} · Scan {time(item.document.date_scan)} · Inscription {time(item.recorded_at)}</p>
    <details><summary>Preuve source et empreinte #{item.sequence}</summary>
      <pre>{JSON.stringify(item.document, null, 2)}</pre><code>{item.entry_hash}</code>
    </details>
  </>;
  if (destination === "stock") return <>
    <strong>#{item.reception_id} · {item.product} · Lot {item.lot}</strong>
    <p>{item.date_type} : {time(item.deadline)} · Alerte dès {time(item.alert_at)}.</p>
    <p>Poids net déclaré : {item.declared_weight_kg ?? "Non lu"} {item.declared_weight_kg != null && "kg"} · Quantité reçue à confirmer.</p>
    <p>Consigne d’origine : {item.storage || "Non lue"} · Contrôle physique à effectuer.</p>
    {item.alerte && <p role="alert">{item.date_depassee
      ? item.date_type === "DLC" ? "DLC dépassée — ne pas utiliser." : "DDM dépassée — évaluation humaine requise."
      : "Rotation ou vérification à traiter."}</p>}
  </>;
  if (destination === "allergenes") return <>
    <strong>#{item.reception_id} · {item.product} · {item.supplier || "Fournisseur non lu"}</strong>
    <p>Présences : {names(item.allergens)} · Traces : {names(item.traces)}.</p>
    {item.trace_mentions && <p>Mention : {item.trace_mentions}</p>}
    <p>Lecture : {item.reading_status} · Comparaison : {item.baseline_id ? `réception #${item.baseline_id}` : "aucune référence comparable"}.</p>
    {item.review_required && <p role="alert">{item.new_allergens.length || item.new_traces.length
      ? `Nouveaux allergènes présents : ${item.new_allergens.join(", ") || "aucun identifié"} ; nouvelles traces : ${item.new_traces.join(", ") || "aucune identifiée"}.`
      : "Première observation ou lecture non vérifiée : contrôle humain requis."}</p>}
  </>;
  return <>
    <strong>#{item.reception_id} · {item.product} · Lot {item.lot}</strong>
    <p>Fournisseur / marque lu : {item.supplier || "Non lu"} · {time(item.received_at)}</p>
    <p>Poids net déclaré : {item.net_weight ? `${item.net_weight.valeur} ${item.net_weight.unite}` : "Non lu"}.</p>
    <p>À rapprocher du BL et de la facture ; fournisseur commercial, quantité et prix à confirmer.</p>
  </>;
}

export default function HaccpReceptions({ establishmentName }) {
  const [destination, setDestination] = useState("receptions");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(null);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [integrity, setIntegrity] = useState(null);
  const [checking, setChecking] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(true);
  const integrityPending = useRef(false);
  const selectionTrigger = useRef(null);
  const closeDetail = useRef(null);
  const distributionChanged = useCallback((distribution) => {
    setPage((current) => current && {
      ...current,
      items: current.items.map((item) => item.id === distribution.reception_id ? { ...item, distribution } : item),
    });
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (selected) {
      closeDetail.current?.focus({ preventScroll: true });
      closeDetail.current?.scrollIntoView?.({ block: "start" });
    }
  }, [selected]);
  useEffect(() => {
    const controller = new AbortController();
    setPage(null); setError(""); setSelected(null); setBusy(true);
    const load = async () => {
      try {
        const params = new URLSearchParams({ offset, limit: PAGE_SIZE });
        if (establishmentName) params.set("restaurant_name", establishmentName);
        const data = await request(`${destination === "receptions" ? "" : `/destinations/${destination}`}?${params}`,
          { signal: controller.signal });
        if (!Array.isArray(data?.items) || !Number.isSafeInteger(data.total) || data.total < 0
            || data.offset !== offset || data.limit !== PAGE_SIZE
            || (destination !== "receptions" && data.destination !== destination)) throw new Error("Liste des réceptions invalide.");
        validateItems(data.items, destination);
        if (!controller.signal.aborted) setPage({ ...data, destination });
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [destination, offset, establishmentName, reload]);

  const checkIntegrity = useCallback(async () => {
    if (integrityPending.current) return;
    integrityPending.current = true;
    setChecking(true); setError(""); setIntegrity(null);
    try {
      let next = 0, count = 0, report, expectedTotal = null;
      const issues = new Set();
      do {
        report = await request(`/integrite?offset=${next}&limit=20`);
        if (typeof report?.ok !== "boolean" || !Array.isArray(report.erreurs)
            || report.erreurs.some((issue) => typeof issue !== "string")
            || typeof report.derniere_empreinte !== "string" || !/^[a-f0-9]{64}$/.test(report.derniere_empreinte)
            || !Number.isSafeInteger(report.total) || report.total < 0 || report.offset !== next
            || !Number.isSafeInteger(report.verifiees) || report.verifiees < 0 || report.verifiees > 20
            || (report.prochain_offset !== null && report.prochain_offset !== next + report.verifiees)
            || (report.prochain_offset !== null && (report.prochain_offset <= next || report.prochain_offset >= report.total))) {
          throw new Error("Réponse du contrôle d’intégrité invalide.");
        }
        if (expectedTotal !== null && expectedTotal !== report.total) {
          throw new Error("Le journal a changé pendant le contrôle. Relancez une vérification complète.");
        }
        expectedTotal = report.total;
        count += report.verifiees;
        report.erreurs.forEach((issue) => issues.add(issue));
        if (!report.ok && !report.erreurs.length) issues.add("Intégrité non confirmée.");
        next = report.prochain_offset;
      } while (next !== null && mounted.current);
      if (mounted.current) {
        if (count !== expectedTotal) throw new Error("Le contrôle ne couvre pas toutes les entrées du journal.");
        setIntegrity({ ok: !issues.size, count, issues: [...issues], hash: report.derniere_empreinte });
      }
    } catch (failure) {
      if (mounted.current) setError(failure.message);
    } finally {
      integrityPending.current = false;
      if (mounted.current) setChecking(false);
    }
  }, []);

  return <section className="workspace-surface haccp-card haccp-receptions" aria-label="Suivi des réceptions fournisseurs">
    <h3>Réceptions · Distribution et contrôles</h3>
    <p>{establishmentName ? `Établissement : ${establishmentName}` : "Tous les établissements autorisés."}
      {" "}Nouveaux scans uniquement ; les anciennes fiches restent dans « Registre / Contrôle ».</p>
    <div className="haccp-reception-actions">
      <label>Destination à consulter
        <select value={destination} onChange={(event) => { setDestination(event.target.value); setOffset(0); }}>
          <option value="receptions">Réceptions / reprise</option>
          {Object.entries(RECEPTION_DESTINATIONS).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>Actualiser les réceptions</button>
      <button type="button" disabled={checking} onClick={checkIntegrity}>{checking ? "Vérification…" : "Vérifier journal et originaux"}</button>
    </div>
    {destination === "stock" && <p>FEFO (échéance la plus proche), puis FIFO à échéance égale. Alerte 48 h avant l’échéance ;
      dates inconnues à contrôler immédiatement. Cet ordre n’autorise pas l’utilisation d’un lot.</p>}
    {destination === "allergenes" && <p>Observations fournisseurs seulement : aucune recette ni matrice de la carte n’est modifiée.</p>}
    {busy && <p role="status">Chargement…</p>}
    {error && <p role="alert">{error}</p>}
    {integrity && <div role={integrity.ok ? "status" : "alert"}>
      <p>{integrity.ok ? `${integrity.count} entrée(s) vérifiée(s), sans anomalie détectée.` : "Anomalie ou distribution manquante."}</p>
      {integrity.issues.map((issue) => <p key={issue}>{issue}</p>)}
      <p>Empreinte de fin : <code>{integrity.hash}</code></p>
    </div>}
    <p className="haccp-notice">Le contrôle d’intégrité couvre tout le journal du compte ou de l’entreprise, pas seulement cet établissement.
      Append-only applicatif et chaîne SHA-256 : ce n’est ni un archivage WORM certifié ni une protection contre un administrateur qui réécrit l’ensemble.</p>
    {page?.destination === destination && page.offset === offset && <>
      <p>{page.total} fiche(s) dans cette vue.</p>
      <ul className="haccp-records">{page.items.map((item) => <li key={item.id ?? item.reception_id}>
        {destination === "receptions" ? <>
          <strong>#{item.id} · {item.nom_produit} · Lot {item.numero_lot}</strong>
          <p>{time(item.date_reception)} · {item.distribution?.statut === "complete" ? "Quatre destinations enregistrées." : "Distribution à vérifier / reprendre."}</p>
          <button type="button" onClick={(event) => {
            selectionTrigger.current = event.currentTarget;
            setSelected(item);
          }}>Vérifier / déconditionner</button>
        </> : <Projection destination={destination} item={item} />}
      </li>)}</ul>
      <div className="haccp-reception-actions">
        <button type="button" disabled={busy || offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>Page précédente</button>
        <button type="button" disabled={busy || offset + page.items.length >= page.total}
          onClick={() => setOffset((value) => value + PAGE_SIZE)}>Page suivante</button>
      </div>
    </>}
    {destination === "receptions" && selected && <div key={selected.id} className="haccp-reception-detail">
      <button ref={closeDetail} type="button" onClick={() => {
        setSelected(null);
        selectionTrigger.current?.focus();
      }}>Fermer la réception</button>
      <HaccpLabelCapture key={`source-${selected.id}`} savedRecord={selected} onDistributionChange={distributionChanged} />
      <HaccpDeconditionnement key={`opening-${selected.id}`} record={selected} />
    </div>}
  </section>;
}

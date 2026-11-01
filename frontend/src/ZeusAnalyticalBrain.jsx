import { useEffect, useRef, useState } from "react";
import {
  describePeriod, financeRequest, formatDate, formatFinanceValue, formatTimestamp,
  isDate, isDecimalString, MUTATION_TIMEOUT_MESSAGE, withTimeout,
} from "./companyFinance";

const LEVELS = { SAIN: "Repères respectés", VIGILANCE: "Vigilance", CRITIQUE: "Prioritaire", INDETERMINE: "Données insuffisantes" };
const SEVERITIES = { INFO: "Information", WARNING: "À surveiller", CRITICAL: "Prioritaire" };
const STATUSES = { OUVERTE: "Active", ACQUITTEE: "Acquittée", RESOLUE: "Résolue" };
const RUNS = { TERMINEE: "Terminée", INCHANGEE: "État inchangé", ECHEC: "Échec" };
const TRIGGERS = { EVENEMENT: "Écriture validée", SEUIL: "Seuil franchi", PERIODIQUE: "Consolidation", MANUEL: "À la demande" };
const HORIZONS = { IMMEDIAT: "Immédiat", SEMAINE: "Cette semaine", MOIS: "Sous un mois", TRIMESTRE: "Sous trois mois" };
const KINDS = { eur: "money", pct: "percent", pts: "points", jours: "days", ratio: "ratio", ans: "years", nombre: "number" };
const text = (v) => typeof v === "string";
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const decimal = (v, unit = "nombre") => v === null || isDecimalString(v, KINDS[unit]);
const timestamp = (v) => text(v) && !Number.isNaN(Date.parse(v));
const known = (map, key) => Object.prototype.hasOwnProperty.call(map, key);
const strings = (v) => Array.isArray(v) && v.every(text);
const nullableTimestamp = (v) => v === null || timestamp(v);

export function validateAnalyticalView(view) {
  let valid = view && Array.isArray(view.repartition) && Array.isArray(view.echanges)
    && view.repartition.every((r) => text(r.cle) && text(r.libelle) && text(r.detail)
      && ["OPERATIONNEL", "ANALYTIQUE"].includes(r.cerveau))
    && view.echanges.every((r) => text(r.canal) && text(r.detail))
    && (view.message === null || text(view.message));
  const state = view?.etat;
  if (valid && state !== null) {
    const worker = state?.orchestrateur;
    valid = state && text(state.company_id) && /^[a-zA-Z0-9_-]+$/.test(state.company_id)
      && typeof state.synthese_a_jour === "boolean" && nullableTimestamp(state.verifie_le)
      && worker && typeof worker.actif === "boolean"
      && ["en_attente", "evenements_recus", "evenements_rejetes", "analyses_terminees", "analyses_en_echec", "syntheses_ia"]
        .every((key) => count(worker[key]))
      && Array.isArray(state.alertes) && state.alertes.every((row) => count(row.id) && known(STATUSES, row.statut)
        && timestamp(row.derniere_detection) && nullableTimestamp(row.acquittee_le) && nullableTimestamp(row.resolue_le)
        && row.alerte && known(SEVERITIES, row.alerte.severite) && text(row.alerte.libelle_metrique)
        && text(row.alerte.explication) && known(KINDS, row.alerte.unite)
        && decimal(row.alerte.valeur, row.alerte.unite) && decimal(row.alerte.seuil, row.alerte.unite)
        && strings(row.alerte.plan_action))
      && Array.isArray(state.executions) && state.executions.every((run) => count(run.id) && known(RUNS, run.statut)
        && known(TRIGGERS, run.declencheur) && timestamp(run.demarre_le) && count(run.duree_ms) && text(run.detail));
    const snapshot = state.snapshot;
    if (valid && snapshot !== null) {
      valid = snapshot && snapshot.company_id === state.company_id && snapshot.version === "1"
        && text(snapshot.entreprise) && /^[A-Z]{3}$/.test(snapshot.devise) && known(LEVELS, snapshot.niveau)
        && (snapshot.indice === null || (count(snapshot.indice) && snapshot.indice <= 100))
        && text(snapshot.methode_indice) && timestamp(snapshot.calcule_le) && isDate(snapshot.date_analyse)
        && isDate(snapshot.periode?.start_date) && isDate(snapshot.periode?.end_date)
        && Array.isArray(snapshot.indicateurs) && snapshot.indicateurs.every((i) =>
          text(i.cle) && text(i.libelle) && known(KINDS, i.unite) && decimal(i.valeur, i.unite));
      const projection = snapshot.projection;
      if (valid && projection !== null) {
        valid = projection && isDecimalString(projection.solde_depart, "money") && isDate(projection.date_depart)
          && decimal(projection.flux_mensuel_retenu, "eur") && decimal(projection.flux_mensuel_gestion, "eur")
          && decimal(projection.flux_mensuel_bancaire, "eur") && text(projection.methode)
          && [null, "gestion", "bancaire"].includes(projection.source_flux)
          && (projection.jour_rupture === null || count(projection.jour_rupture))
          && (projection.date_rupture === null || isDate(projection.date_rupture))
          && Array.isArray(projection.points) && projection.points.every((p) => count(p.jour)
            && isDate(p.echeance) && isDecimalString(p.solde, "money"));
      }
    }
    const synthesis = state.synthese;
    if (valid && synthesis !== null) {
      valid = synthesis && synthesis.company_id === state.company_id
        && ["IA", "DETERMINISTE"].includes(synthesis.source) && text(synthesis.resume)
        && (synthesis.modele === null || text(synthesis.modele)) && (synthesis.motif_repli === null || text(synthesis.motif_repli))
        && timestamp(synthesis.generee_le) && text(synthesis.avertissement) && strings(synthesis.points_cles)
        && Array.isArray(synthesis.recommandations) && synthesis.recommandations.every((r) =>
          text(r.titre) && text(r.action) && known(HORIZONS, r.horizon));
    }
  }
  if (!valid) throw new Error("Réponse du cerveau analytique incohérente : aucune donnée partielle affichée.");
  return view;
}

export default function ZeusAnalyticalBrain() {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const mutation = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; mutation.current?.abort(); };
  }, []);

  useEffect(() => {
    let alive = true;
    let timer;
    const controller = new AbortController();
    const load = async () => {
      try {
        const data = await withTimeout((signal) => financeRequest("/cortex/analytique", { signal }), { signal: controller.signal });
        const validated = validateAnalyticalView(data);
        if (alive) { setView(validated); setError(""); }
      } catch (e) {
        if (alive && e.name !== "AbortError") {
          setError(e.message);
          // Les droits ont pu changer : ne pas garder des chiffres du compte précédent.
          setView(null);
        }
      } finally {
        if (alive) timer = setTimeout(load, 8000);
      }
    };
    load();
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [refresh]);

  const state = view?.etat;
  const snapshot = state?.snapshot;
  const worker = state?.orchestrateur;
  const synthesis = state?.synthese;
  const projection = snapshot?.projection;
  const currency = snapshot?.devise || "EUR";
  const fmt = (value, unit = "eur") => formatFinanceValue(value, KINDS[unit], currency);

  const act = async (suffix) => {
    if (!state || busy) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true); setMessage("");
    try {
      const result = await withTimeout((signal) => financeRequest(
        `/finance/${encodeURIComponent(state.company_id)}/cerveau/${suffix}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal },
      ), { signal: controller.signal, message: MUTATION_TIMEOUT_MESSAGE });
      if (suffix === "analyse" ? result?.acceptee !== true : result?.statut !== "ACQUITTEE") {
        throw new Error("Confirmation du serveur invalide. Actualisez pour vérifier le résultat avant de réessayer.");
      }
      if (mounted.current) {
        setMessage(suffix === "analyse" ? "Analyse planifiée en arrière-plan." : "Alerte acquittée : aucune écriture financière modifiée.");
        setRefresh((v) => v + 1);
      }
    } catch (e) {
      if (mounted.current && e.name !== "AbortError") setMessage(e.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="zcx-analytical" aria-label="Les deux cerveaux de ΣIRIUS" data-testid="zeus-analytical">
      <div className="zcx-brain-head">
        <div>
          <h2>CERVEAU ANALYTIQUE & STRATÉGIQUE</h2>
          <p>ΣIRIUS · surveillance en arrière-plan · calculs déterministes</p>
        </div>
        {worker && <span className={`zcx-brain-badge ${worker.actif ? "" : "warning"}`}>
          {worker.actif ? worker.en_attente ? "Analyse en cours ou en attente" : "Moteur actif" : "Moteur arrêté"}
        </span>}
        {state && <button type="button" className="zcx-brain-button" onClick={() => act("analyse")}
          disabled={busy || !worker.actif || worker.en_attente > 0}>Relancer l’analyse</button>}
      </div>
      {error && <div role="alert" className="zcx-brain-notice">{error}
        <button type="button" className="zcx-brain-button" onClick={() => setRefresh((v) => v + 1)}>Réessayer</button>
      </div>}
      {message && <p role="status" className="zcx-brain-notice">{message}</p>}
      {view?.message && <p className="zcx-brain-notice">{view.message}</p>}
      {!view && !error && <p role="status" className="zcx-brain-notice">Chargement de l’état analytique…</p>}
      {view && <details className="zcx-brain-roles">
        <summary>Répartition des tâches entre les deux cerveaux</summary>
        <div className="zcx-row zcx-rE">
          {["OPERATIONNEL", "ANALYTIQUE"].map((brain) => <div className="zcx-cell" key={brain}>
            <h3>{brain === "OPERATIONNEL" ? "Cerveau opérationnel · temps réel" : "Cerveau analytique · arrière-plan"}</h3>
            <ul>{view.repartition.filter((r) => r.cerveau === brain).map((r) =>
              <li key={r.cle}><b>{r.libelle}</b><p>{r.detail}</p></li>)}</ul>
          </div>)}
        </div>
        {view.echanges.map((e) => <p key={e.canal}><b>{e.canal} :</b> {e.detail}</p>)}
      </details>}
      {state && !snapshot && <div className="zcx-empty">Aucun état publié. L’analyse ne crée jamais de chiffres fictifs.</div>}
      {snapshot && <>
        <div className="zcx-brain-summary">
          <div><h3>{snapshot.entreprise}</h3><p>{describePeriod(snapshot.periode)}</p>
            <p>Analyse au {formatDate(snapshot.date_analyse)} · vérifiée {formatTimestamp(state.verifie_le)}</p></div>
          <div><span className={`zcx-brain-badge ${snapshot.niveau.toLowerCase()}`}>{LEVELS[snapshot.niveau]}</span>
            <strong className="zcx-brain-score">{snapshot.indice === null ? "Non calculable" : `${snapshot.indice} / 100`}</strong>
            <p>{snapshot.methode_indice}</p></div>
        </div>
        <div className="zcx-brain-metrics">{snapshot.indicateurs.map((i) =>
          <div key={i.cle}><span>{i.libelle}</span><b>{fmt(i.valeur, i.unite)}</b></div>)}</div>
        <div className="zcx-row zcx-rE">
          <div className="zcx-cell">
            <h2>ALERTES ET PLANS D’ACTION</h2>
            <p className="zcx-h2sub">Acquitter signifie « pris en compte », pas « problème résolu ».</p>
            <div className="zcx-brain-alerts">
              {state.alertes.map((row) => <article className={`zcx-brain-alert ${row.alerte.severite.toLowerCase()}`} key={row.id}>
                <div><span className="zcx-brain-badge">{SEVERITIES[row.alerte.severite]}</span>
                  <span className="zcx-brain-badge">{STATUSES[row.statut]}</span></div>
                <h3>{row.alerte.libelle_metrique}</h3>
                <p>{row.alerte.explication}</p>
                {row.alerte.valeur !== null && <p>Valeur : <b>{fmt(row.alerte.valeur, row.alerte.unite)}</b>
                  {row.alerte.seuil !== null && <> · repère : {fmt(row.alerte.seuil, row.alerte.unite)}</>}</p>}
                <ul>{row.alerte.plan_action.map((a, index) => <li key={index}>{a}</li>)}</ul>
                <small>Dernière détection : {formatTimestamp(row.derniere_detection)}</small>
                {row.acquittee_le && <small>Acquittée le {formatTimestamp(row.acquittee_le)}</small>}
                {row.resolue_le && <small>Résolue le {formatTimestamp(row.resolue_le)}</small>}
                {row.statut === "OUVERTE" && <button type="button" className="zcx-brain-button"
                  disabled={busy} onClick={() => act(`alertes/${row.id}/acquitter`)}
                  aria-label={`Acquitter : ${row.alerte.libelle_metrique}`}>Acquitter</button>}
              </article>)}
              {!state.alertes.length && <div className="zcx-empty">Aucune alerte sur les données analysées.</div>}
            </div>
          </div>
          <div className="zcx-cell alt">
            <h2>TRÉSORERIE GLISSANTE</h2>
            {projection ? <>
              <p>Dernier solde reconstitué : <b>{fmt(projection.solde_depart)}</b> au {formatDate(projection.date_depart)}.</p>
              <p>Flux mensuel retenu : <b>{fmt(projection.flux_mensuel_retenu)}</b>
                {projection.source_flux && ` · ${projection.source_flux === "gestion" ? "gestion" : "bancaire"}`}</p>
              {projection.points.length ? <table className="zcx-brain-table">
                <caption>Projection indicative à flux constant</caption>
                <thead><tr><th>Horizon</th><th>Date</th><th>Solde estimé</th></tr></thead>
                <tbody>{projection.points.map((p) => <tr key={p.jour}>
                  <th>J+{p.jour}</th><td>{formatDate(p.echeance)}</td><td>{fmt(p.solde)}</td>
                </tr>)}</tbody>
              </table> : <p>Projection indisponible : aucun flux mensuel exploitable.</p>}
              {projection.date_rupture && <p className="zcx-brain-notice">Premier solde négatif estimé : {formatDate(projection.date_rupture)}.</p>}
              <p className="zcx-h2sub">{projection.methode}</p>
            </> : <div className="zcx-empty">Solde de trésorerie inconnu : saisissez un solde et les mouvements bancaires.</div>}
            <h2>SYNTHÈSE DÉCISIONNELLE</h2>
            {synthesis ? <div className="zcx-brain-synthesis">
              <p><b>{synthesis.source === "IA" ? "Rédaction IA" : "Synthèse déterministe"}</b>
                {synthesis.modele ? ` · ${synthesis.modele}` : ""} · {formatTimestamp(synthesis.generee_le)}</p>
              {!state.synthese_a_jour && <p className="zcx-brain-notice">Cette synthèse porte sur un état antérieur. Une actualisation est nécessaire.</p>}
              {synthesis.motif_repli && <p>{synthesis.motif_repli}</p>}
              <p>{synthesis.resume}</p>
              <ul>{synthesis.points_cles.map((p, i) => <li key={i}>{p}</li>)}</ul>
              {synthesis.recommandations.map((r, i) => <div key={i}>
                <h3>{r.titre} · {HORIZONS[r.horizon]}</h3><p>{r.action}</p>
              </div>)}
              <p className="zcx-h2sub">{synthesis.avertissement}</p>
            </div> : <p>Synthèse en préparation ; les indicateurs restent disponibles.</p>}
          </div>
        </div>
      </>}
      {state && <div className="zcx-cell">
        <h2>JOURNAL DU CERVEAU ANALYTIQUE</h2>
        <p className="zcx-h2sub">Cette entreprise uniquement · {worker.en_attente} en attente · {worker.analyses_terminees} analyse(s)
          {" · "}{worker.analyses_en_echec} échec(s) · {worker.evenements_rejetes} signal(aux) refusé(s) depuis le démarrage</p>
        <div className="zcx-log">
          {state.executions.map((run) => <div key={run.id} className="zcx-brain-run">
            <time>{formatTimestamp(run.demarre_le)}</time>
            <b>{RUNS[run.statut]} · {TRIGGERS[run.declencheur]} · {run.duree_ms} ms</b><p>{run.detail}</p>
          </div>)}
          {!state.executions.length && <p>Aucune exécution enregistrée.</p>}
        </div>
      </div>}
    </section>
  );
}

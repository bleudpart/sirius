import { useEffect, useRef, useState } from "react";
import { matchesSearch, readSearchSource } from "./workspaceSearchData";
import ActionFeedback from "./components/ActionFeedback";
import "./WorkspaceSearch.css";
import { MODULE_ALIASES } from "./moduleCommandRouting";

const LABELS = { dossiers: "Dossiers du service connecté", microsoft: "Contacts, courriels et agenda Microsoft" };
const KINDS = { contact: "Contact", email: "Courriel", event: "Rendez-vous", dossier: "Dossier" };

export default function WorkspaceSearch({ initialQuery = "", modules, microsoftFetch, onDossier, onContact, onConnections, onClose }) {
  const [query, setQuery] = useState(initialQuery);
  const [submitted, setSubmitted] = useState(initialQuery.trim());
  const [sources, setSources] = useState({});
  const [attempt, setAttempt] = useState(0);
  const [stopped, setStopped] = useState(false);
  const controllerRef = useRef(null);
  const dialog = useRef(null);
  const opener = useRef(document.activeElement);
  useEffect(() => {
    dialog.current?.querySelector("input")?.focus();
    const previous = opener.current;
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (!submitted) return undefined;
    const controller = new AbortController();
    controllerRef.current = controller;
    let active = true;
    setStopped(false);
    setSources({ dossiers: { loading: true }, microsoft: { loading: true } });
    const timers = [];
    Object.keys(LABELS).forEach((source) => {
      const sourceController = new AbortController();
      const abort = () => sourceController.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => sourceController.abort(), 12000);
      timers.push(timeout);
      readSearchSource(source, submitted, { signal: sourceController.signal, microsoftFetch })
        .then((result) => {
          if (active && !controller.signal.aborted) setSources((current) => ({ ...current, [source]: { ...result, at: new Date().toLocaleTimeString("fr-FR") } }));
        })
        .catch((error) => {
          if (!active || controller.signal.aborted) return;
          console.error(`Recherche ${source} :`, error);
          setSources((current) => ({ ...current, [source]: { error: error.name === "AbortError" ? "Le délai de réponse a été dépassé." : error.message } }));
        }).finally(() => {
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", abort);
        });
    });
    return () => { active = false; controller.abort(); timers.forEach(clearTimeout); };
  }, [submitted, attempt, microsoftFetch]);
  const stop = () => {
    controllerRef.current?.abort();
    setStopped(true);
    setSources((current) => Object.fromEntries(Object.entries(current).map(([key, value]) =>
      [key, value.loading ? { interrupted: true } : value])));
  };
  const localModules = submitted ? modules.filter((item) => item.id !== "workspace-search" && matchesSearch(submitted, item.label, MODULE_ALIASES[item.id])) : [];
  const loading = Object.values(sources).some((source) => source.loading);
  const trapKeyboard = (event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    const nodes = [...dialog.current.querySelectorAll("button:not(:disabled),input,a[href]")];
    const index = nodes.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); nodes[nodes.length - 1]?.focus(); }
    else if (!event.shiftKey && index === nodes.length - 1) { event.preventDefault(); nodes[0]?.focus(); }
  };
  return <div className="workspace-search-backdrop"><section ref={dialog} className="workspace-search" role="dialog" aria-modal="true" aria-labelledby="workspace-search-title" onKeyDown={trapKeyboard}>
    <header><h2 id="workspace-search-title">Rechercher dans ΣIRIUS</h2><button type="button" onClick={onClose} aria-label="Fermer la recherche">×</button></header>
    <p>Recherche en lecture seule. Aucun envoi ni modification. Les mots saisis sont transmis au service connecté et à Microsoft pour cette recherche.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (query.trim()) { setSubmitted(query.trim()); setAttempt((value) => value + 1); } }}>
      <label htmlFor="workspace-query">Client, dossier, courriel, rendez-vous ou fonction</label>
      <div><input id="workspace-query" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={200} required />
        <button type="submit" disabled={!query.trim()}>Rechercher</button>
        {loading && <button type="button" onClick={stop}>Arrêter la recherche</button>}</div>
    </form>
    <p>Les factures, fichiers, anciennes conversations et listes locales ne sont pas encore indexés ici. Microsoft renvoie au maximum huit résultats par catégorie ; l'agenda couvre les trente prochains jours. Les dossiers sont filtrés sur leur titre, description et catégorie, pas sur le contenu des pièces.</p>
    {stopped && <p role="status">Recherche interrompue. Les résultats déjà reçus sont conservés.</p>}
    {submitted && <section aria-label="Fonctions disponibles sur cet appareil"><h3>Fonctions et réglages</h3>
      {!localModules.length && <p>Aucune fonction correspondante.</p>}
      {localModules.map((item) => <button key={item.id} type="button" onClick={() => { onClose(); item.run(); }}>{item.label}</button>)}
    </section>}
    {Object.entries(LABELS).map(([source, label]) => {
      const state = sources[source];
      if (!state) return null;
      return <section key={source} aria-label={label} aria-busy={!!state.loading}>
        <h3>{label}</h3>
        {state.loading && <p role="status">Recherche en cours… Les autres résultats restent accessibles.</p>}
        {state.error && <ActionFeedback title={state.error} impact={`Cette source n'a pas pu être consultée : son absence de résultat n'est pas une réponse négative.`}
          recovery="Vérifiez la connexion ou reconnectez votre compte, puis réessayez." onRetry={() => setAttempt((value) => value + 1)} busy={loading} />}
        {source === "microsoft" && state.error && <button type="button" onClick={() => { onClose(); onConnections(); }}>Comptes et connexions</button>}
        {state.interrupted && <p>Source interrompue, résultats non vérifiés.</p>}
        {!!state.warnings?.length && <ActionFeedback title="Recherche Microsoft partielle ou non confirmée"
          impact={state.warnings.join(" ")} recovery="Les autres résultats restent utilisables. Reconnectez le compte ou réessayez."
          onRetry={() => setAttempt((value) => value + 1)} busy={loading} />}
        {state.items && <><p role="status">{state.items.length} résultat(s) · consulté à {state.at}</p>
          {state.items.map((item) => <article key={`${item.kind}:${item.id}`}>
            <strong>{KINDS[item.kind]} — {item.title || "Sans titre"}</strong><p>{item.detail}</p>
            {item.kind === "dossier" && <button type="button" onClick={() => { onClose(); onDossier(item.id); }}>Ouvrir ce dossier</button>}
            {item.kind === "contact" && onContact && <button type="button" onClick={() => { onClose(); onContact(item.contact); }}>Préparer un message à ce contact</button>}
          </article>)}</>}
      </section>;
    })}
  </section></div>;
}

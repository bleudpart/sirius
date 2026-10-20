import { useEffect, useRef, useState } from "react";
import { Check, Inbox, Link2, Mail, PenLine, RefreshCw, Search, Send, Volume2, X } from "lucide-react";
import { API_BASE_URL } from "./lib/api";
import { withBackendResponse } from "./lib/backendRequest";
import { formatDocumentDate } from "./dateTime";
import ProviderLogo from "./components/ProviderLogo";
import "./MessagingPanel.css";

const PROVIDERS = {
  google: { label: "Gmail", logo: "gmail", inbox: "/gmail/messages?top=25", send: "/gmail/send" },
  microsoft: { label: "Outlook", logo: "outlook", inbox: "/microsoft/mail?top=25", send: "/microsoft/mail/send" },
};
const emptyDraft = () => ({ to: "", subject: "", body: "" });
const hasContent = (draft) => Object.values(draft).some((value) => value.trim());

export default function MessagingPanel({ onClose, onConnections, onRead, microsoftFetch }) {
  const [provider, setProvider] = useState("google");
  const [attempt, setAttempt] = useState(0);
  const [inbox, setInbox] = useState({ loading: true, mails: [] });
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [drafts, setDrafts] = useState({ google: emptyDraft(), microsoft: emptyDraft() });
  const [review, setReview] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [history, setHistory] = useState([]);
  const [uncertain, setUncertain] = useState(false);
  const dialog = useRef(null);
  const opener = useRef(document.activeElement);
  const sendLock = useRef(false);
  const mounted = useRef(true);
  const draft = drafts[provider];
  const meta = PROVIDERS[provider];

  useEffect(() => {
    mounted.current = true;
    dialog.current?.querySelector("[data-mail-search]")?.focus();
    const previous = opener.current;
    return () => { mounted.current = false; if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setInbox({ loading: true, mails: [] });
    setSelectedId(null);
    const fetchImpl = provider === "microsoft" && microsoftFetch
      ? (url, options) => microsoftFetch(url.slice(API_BASE_URL.length), options)
      : fetch;
    withBackendResponse(PROVIDERS[provider].inbox, {}, async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Lecture ${PROVIDERS[provider].label} impossible (${response.status}).`);
      if (!Array.isArray(data.mails)) throw new Error("La boîte reçue est invalide. Actualisez ou reconnectez le compte.");
      return data.mails;
    }, { signal: controller.signal, timeoutMs: 60000, fetchImpl })
      .then((mails) => {
        if (!controller.signal.aborted) setInbox({ loading: false, mails, at: new Date().toLocaleTimeString("fr-FR") });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error("Lecture de la messagerie :", error);
        setInbox({ loading: false, mails: [], error: error.name === "AbortError" ? "Le délai de lecture a été dépassé. Réessayez." : error.message });
      });
    return () => controller.abort();
  }, [provider, attempt, microsoftFetch]);

  const hasDrafts = Object.values(drafts).some(hasContent);
  useEffect(() => {
    if (!hasDrafts && !sending) return undefined;
    const guard = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasDrafts, sending]);

  const requestClose = (action = onClose) => {
    if (sendLock.current) return;
    if (hasDrafts && !window.confirm("Fermer la messagerie et abandonner les brouillons non envoyés ?")) return;
    action();
  };
  const handleKeyboard = (event) => {
    if (event.key === "Escape") { event.stopPropagation(); requestClose(); }
    if (event.key !== "Tab") return;
    const nodes = [...dialog.current.querySelectorAll("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary")];
    const index = nodes.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); nodes[nodes.length - 1]?.focus(); }
    else if (!event.shiftKey && index === nodes.length - 1) { event.preventDefault(); nodes[0]?.focus(); }
  };
  const changeDraft = (field, value) => {
    setReview(false);
    setDrafts((current) => ({ ...current, [provider]: { ...current[provider], [field]: value } }));
  };
  const mails = inbox.mails.filter((mail) => (!unreadOnly || !mail.lu)
    && `${mail.de || ""} ${mail.de_email || ""} ${mail.sujet || ""} ${mail.apercu || ""}`.toLocaleLowerCase("fr").includes(query.toLocaleLowerCase("fr")));
  const selected = inbox.mails.find((mail) => mail.id === selectedId);

  const send = async () => {
    if (sendLock.current || !review || uncertain) return;
    sendLock.current = true;
    setSending(true);
    setSendError("");
    const snapshot = { to: draft.to.trim(), subject: draft.subject.trim(), body: draft.body.trim() };
    const source = provider;
    const fetchImpl = source === "microsoft" && microsoftFetch
      ? (url, options) => microsoftFetch(url.slice(API_BASE_URL.length), options)
      : fetch;
    let knownRejection = false;
    try {
      await withBackendResponse(PROVIDERS[source].send, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...snapshot, ...(source === "microsoft" ? { confirm: true } : {}) }),
      }, async (response) => {
        knownRejection = response.status >= 400 && response.status < 500;
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : `Envoi refusé (${response.status}).`);
        if (data.ok !== true) throw new Error("Le service n'a pas confirmé l'envoi.");
      }, { timeoutMs: 60000, fetchImpl });
      if (!mounted.current) return;
      setHistory((current) => [{ ...snapshot, provider: source, at: new Date().toLocaleTimeString("fr-FR"), confirmed: true }, ...current]);
      setDrafts((current) => ({ ...current, [source]: emptyDraft() }));
      setReview(false);
    } catch (error) {
      console.error("Envoi de la messagerie :", error);
      if (!mounted.current) return;
      const message = error.name === "AbortError" ? "Le délai d'envoi a été dépassé." : error.message;
      setSendError(`${message} Le brouillon est conservé.${knownRejection ? "" : " L'envoi a peut-être été effectué : vérifiez les messages envoyés chez votre fournisseur avant toute nouvelle tentative."}`);
      setUncertain(!knownRejection);
      setHistory((current) => [{ ...snapshot, provider: source, at: new Date().toLocaleTimeString("fr-FR"), confirmed: false }, ...current]);
    } finally {
      sendLock.current = false;
      if (mounted.current) setSending(false);
    }
  };

  return <section className="messaging-screen" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="messaging-title" onKeyDown={handleKeyboard} data-testid="messaging-panel">
    <header className="messaging-header">
      <div className="messaging-brand"><div><strong>ΣIRIUS</strong><small>VOTRE ESPACE DE TRAVAIL</small></div></div>
      <h1 id="messaging-title"><Mail size={20} /> Messagerie</h1>
      <div className="messaging-header-actions">
        <button type="button" disabled={sending} onClick={() => requestClose(onConnections)}><Link2 size={16} /> Comptes et connexions</button>
        <button type="button" disabled={sending} onClick={() => requestClose()} aria-label="Fermer la messagerie"><X size={20} /></button>
      </div>
    </header>
    <nav className="messaging-providers" aria-label="Compte de messagerie">
      {Object.entries(PROVIDERS).map(([key, item]) => <button type="button" key={key} aria-pressed={provider === key} disabled={sending}
        onClick={() => { setProvider(key); setQuery(""); setUnreadOnly(false); setReview(false); }}>
        <ProviderLogo provider={item.logo} size={22} />{item.label}
      </button>)}
      <span>Consultation en ligne · aucun envoi automatique</span>
    </nav>
    <main className="messaging-columns">
      <section className="messaging-card messaging-inbox" aria-labelledby="messaging-inbox-title">
        <header className="messaging-card-head"><h2 id="messaging-inbox-title"><Inbox size={17} /> Boîte de réception</h2>
          <span className="messaging-count" aria-label="Messages chargés">{inbox.mails.length}</span>
          <button type="button" disabled={inbox.loading} onClick={() => setAttempt((value) => value + 1)} aria-label="Actualiser la réception"><RefreshCw size={16} /></button>
        </header>
        <label className="messaging-search"><Search size={16} /><span className="messaging-sr-only">Rechercher dans les messages chargés</span>
          <input type="search" data-mail-search placeholder="Rechercher un message…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <label className="messaging-filter"><input type="checkbox" checked={unreadOnly} onChange={(event) => setUnreadOnly(event.target.checked)} /> Non lus uniquement</label>
        <p className="messaging-note">{inbox.at ? `Consulté à ${inbox.at} · ` : ""}25 derniers messages maximum. Recherche dans les aperçus chargés.</p>
        {inbox.loading && <p role="status" className="messaging-empty">Chargement de {meta.label}…</p>}
        {inbox.error && <div role="alert" className="messaging-error"><p>{inbox.error}</p><button type="button" onClick={() => requestClose(onConnections)}>Connecter ou vérifier le compte</button></div>}
        {!inbox.loading && !inbox.error && !mails.length && <p className="messaging-empty">{query || unreadOnly ? "Aucun message ne correspond à ces filtres." : "Aucun message renvoyé par le fournisseur."}</p>}
        <ul className="messaging-feed">{mails.map((mail) => <li key={mail.id}>
          <button type="button" className={`messaging-message ${mail.lu ? "" : "is-unread"}`} aria-pressed={selectedId === mail.id} onClick={() => setSelectedId(mail.id)}>
            <span className="messaging-avatar" aria-hidden="true">{(mail.de || mail.de_email || "?").trim().slice(0, 2).toLocaleUpperCase("fr")}</span>
            <span className="messaging-message-copy"><span>{mail.de || mail.de_email || "Expéditeur inconnu"}</span><strong>{mail.sujet || "(sans objet)"}</strong><span>{mail.apercu || "Aucun aperçu disponible."}</span>
              <small>{mail.recu ? formatDocumentDate(mail.recu) : "Date non fournie"}{!mail.lu ? " · Non lu" : ""}</small></span>
          </button>
        </li>)}</ul>
      </section>
      <section className="messaging-card messaging-compose" aria-labelledby="messaging-compose-title">
        <header className="messaging-card-head"><h2 id="messaging-compose-title"><PenLine size={17} /> Nouveau message</h2><span>{meta.label}</span></header>
        {selected && <section className="messaging-preview" aria-label="Aperçu sélectionné">
          <header><strong>{selected.sujet || "(sans objet)"}</strong><button type="button" aria-label="Fermer cet aperçu" onClick={() => setSelectedId(null)}><X size={15} /></button></header>
          <p>{selected.de || selected.de_email} · {selected.recu ? formatDocumentDate(selected.recu) : "Date non fournie"}</p>
          <p className="messaging-preview-text">{selected.apercu || "Aucun aperçu disponible."}</p>
          <small>Aperçu uniquement : le corps complet et les pièces jointes ne sont pas chargés. Cette consultation ne marque pas le message comme lu.</small>
          <div className="messaging-preview-actions">
            <button type="button" disabled={sending || !selected.de_email} onClick={() => changeDraft("to", selected.de_email)}>Écrire à cet expéditeur</button>
            {onRead && <button type="button" onClick={() => onRead(`De ${selected.de || selected.de_email}. Objet : ${selected.sujet || "sans objet"}. Aperçu : ${selected.apercu || "Aucun aperçu."}`)}><Volume2 size={15} /> Écouter l’aperçu</button>}
          </div>
        </section>}
        <form onSubmit={(event) => { event.preventDefault(); if (draft.to.trim() && draft.subject.trim() && draft.body.trim()) { setReview(true); setSendError(""); } }}>
          <fieldset disabled={sending}>
            <label htmlFor="messaging-to">Destinataire</label>
            <input id="messaging-to" type="email" required value={draft.to} placeholder="destinataire@exemple.fr" onChange={(event) => changeDraft("to", event.target.value)} />
            <label htmlFor="messaging-subject">Objet</label>
            <input id="messaging-subject" required value={draft.subject} placeholder="Objet de votre message" onChange={(event) => changeDraft("subject", event.target.value)} />
            <label htmlFor="messaging-body">Message</label>
            <textarea id="messaging-body" required value={draft.body} placeholder="Rédigez votre message…" onChange={(event) => changeDraft("body", event.target.value)} />
          </fieldset>
          <p className="messaging-note">Texte simple · la signature ΣIRIUS est ajoutée par le serveur. Pièces jointes et CC/CCI non disponibles dans cet espace. Brouillons en mémoire uniquement, perdus à la fermeture.</p>
          {sendError && <p role="alert" className="messaging-error">{sendError}</p>}
          {uncertain && <button type="button" disabled={sending} onClick={() => { setUncertain(false); setReview(false); }}>J’ai vérifié les messages envoyés chez le fournisseur</button>}
          {review && <div className="messaging-confirm" role="group" aria-label="Confirmation de l’envoi">
            <p>Envoyer avec <strong>{meta.label}</strong> à <strong>{draft.to.trim()}</strong> ?</p>
            <p>Objet : {draft.subject.trim()}</p>
            <p>Vérifiez le destinataire, le texte ci-dessus et le compte {meta.label} connecté avant de confirmer.</p>
            <button type="button" disabled={sending} onClick={() => setReview(false)}>Revenir à la rédaction</button>
            <button type="button" className="messaging-primary" disabled={sending || uncertain} onClick={send}><Send size={17} />{sending ? "Envoi en cours…" : "Confirmer et envoyer"}</button>
          </div>}
          {!review && <div className="messaging-compose-actions">
            <span>{draft.body.length} caractères</span>
            <button type="submit" className="messaging-primary" disabled={sending || uncertain || !draft.to.trim() || !draft.subject.trim() || !draft.body.trim()}><Send size={17} /> Vérifier avant envoi</button>
          </div>}
        </form>
      </section>
      <section className="messaging-card messaging-sent" aria-labelledby="messaging-sent-title">
        <header className="messaging-card-head"><h2 id="messaging-sent-title"><Send size={17} /> Suivi des envois</h2><span className="messaging-count">{history.length}</span></header>
        <p className="messaging-note">Envois tentés depuis cet écran pendant cette session uniquement. Ce n’est pas votre dossier « Envoyés ».</p>
        {!history.length && <div className="messaging-empty"><Mail size={30} /><p>Aucun envoi dans cette session.</p><small>Vos envois apparaîtront ici après confirmation.</small></div>}
        <ul className="messaging-history" aria-live="polite">{history.map((entry, index) => <li key={index}>
          <strong>{entry.subject}</strong><span>{entry.to}</span><small>{PROVIDERS[entry.provider].label} · {entry.at}</small>
          <span className={`messaging-send-state ${entry.confirmed ? "is-confirmed" : ""}`}>{entry.confirmed && <Check size={14} />}{entry.confirmed ? "Envoi confirmé par le service" : "Envoi non confirmé"}</span>
        </li>)}</ul>
        <p className="messaging-tracking-note">La livraison au destinataire et l’ouverture ne sont pas attestées par les API actuelles.</p>
      </section>
    </main>
    <footer className="messaging-footer"><span>ΣIRIUS</span> · Messagerie connectée · Les commandes vocales existantes restent disponibles.</footer>
  </section>;
}

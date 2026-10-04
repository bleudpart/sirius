import { useEffect, useState } from "react";
import { MAIL_CACHE_PROVIDERS } from "../services/mailCache";
import { formatDocumentDate } from "../dateTime";
import ProviderLogo from "./ProviderLogo";
import { Database, RefreshCw, Search, Volume2 } from "lucide-react";
import "./MailCachePanel.css";

export default function MailCachePanel({ cache, onRead }) {
  const [queries, setQueries] = useState({ google: "", microsoft: "" });
  const [online, setOnline] = useState(navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  return (
    <section className="mail-cache" aria-labelledby="mail-cache-title">
      <h2 id="mail-cache-title">Aperçus mail sur cet appareil</h2>
      <p role="status">{online ? "Réseau détecté : la disponibilité du service reste à vérifier." : "Hors ligne : seuls les aperçus déjà synchronisés sont disponibles."}</p>
      <p>Facultatif : conservez les expéditeurs, objets et aperçus de vos derniers messages, sans corps complet ni pièce jointe. Stockage local non chiffré par SIRIUS, séparé par compte. Effacer désactive aussi la synchronisation.</p>
      <p>Actualisation toutes les 5 minutes lorsque SIRIUS est ouvert, visible et en ligne. Une copie locale peut être ancienne ; recevoir et envoyer nécessitent le réseau. Lire un aperçu à voix haute peut transmettre son texte au serveur et au fournisseur vocal configuré ; ce n'est pas une garantie de voix locale.</p>
      {!cache.account && <p>Connectez votre compte SIRIUS pour utiliser ce cache.</p>}
      <div className="mail-cache-consoles">
      {Object.entries(MAIL_CACHE_PROVIDERS).map(([provider, meta]) => {
        const data = cache.providers[provider];
        const query = queries[provider];
        const mails = (data?.mails || []).filter((mail) => `${mail.de} ${mail.de_email} ${mail.sujet} ${mail.apercu}`.toLocaleLowerCase("fr").includes(query.toLocaleLowerCase("fr")));
        return <article key={provider} className={`mail-console mail-console-${provider}`} aria-labelledby={`mail-console-${provider}-title`}>
          <header className="mail-console-head">
            <ProviderLogo provider={provider === "google" ? "gmail" : "outlook"} size={32} />
            <div><span className="mail-console-eyebrow">COPIES LOCALES · {meta.limit} MAX</span><h3 id={`mail-console-${provider}-title`}>{meta.label}</h3></div>
            <span className={`mail-console-state ${data?.enabled ? "enabled" : ""}`}>{cache.busy[provider] ? "SYNCHRONISATION" : data?.enabled ? "ACTIVÉ" : "DÉSACTIVÉ"}</span>
          </header>
          <p className="mail-console-account">{data?.enabled ? `Activé pour ${data.email}` : "Cache facultatif désactivé"}</p>
          <div className="mail-console-metrics">
            <div><span>CONSERVÉS</span><strong>{data?.mails?.length || 0}<small> / {meta.limit}</small></strong></div>
            <div><span>RÉSULTATS</span><strong>{mails.length}</strong></div>
            <div><span>STOCKAGE</span><strong><Database size={14} /> Cet appareil</strong></div>
          </div>
          <p className="mail-console-sync">{data?.syncedAt ? `Dernière synchronisation : ${formatDocumentDate(data.syncedAt)} à ${new Date(data.syncedAt).toLocaleTimeString("fr-FR")}. Copies locales, pas une boîte en direct.` : "Aucune synchronisation enregistrée."}</p>
          {cache.errors[provider] && <p className="connections-error" role="alert">{cache.errors[provider]} Les aperçus conservés ne sont pas une nouvelle synchronisation.</p>}
          <div className="mail-cache-actions">
            <button type="button" aria-label={`${data?.enabled ? "Synchroniser" : "Activer le cache"} ${meta.label}`} disabled={!online || !cache.account || !!cache.busy[provider] || (!data && !!cache.errors[provider])} onClick={() => cache.run(provider, !data?.enabled)}><RefreshCw size={14} className={cache.busy[provider] ? "spin" : ""} />{cache.busy[provider] ? "Synchronisation…" : data?.enabled ? "Synchroniser maintenant" : "Activer le cache local"}</button>
            <button type="button" disabled={!cache.account} onClick={() => cache.clear(provider)}>Effacer et désactiver {meta.label}</button>
          </div>
          <label className="mail-console-search" htmlFor={`mail-search-${provider}`}><span><Search size={14} /> Rechercher dans les aperçus {meta.label}</span><input id={`mail-search-${provider}`} type="search" value={query} onChange={(event) => setQueries((previous) => ({ ...previous, [provider]: event.target.value }))} /></label>
          <div className="mail-console-feed" role="region" aria-label={`Aperçus locaux ${meta.label}`} tabIndex={0}>
          {!mails.length && <p className="mail-console-empty">{query ? "Aucun aperçu ne correspond à cette recherche." : data?.enabled ? "Aucun aperçu conservé. Synchronisez pour charger vos derniers messages." : "Activez ce cache pour conserver des aperçus sur cet appareil."}</p>}
          <ul>{mails.map((mail) => <li key={mail.id} className={mail.lu ? "" : "mail-preview-unread"}>
            <strong>{mail.sujet || "(sans objet)"}</strong>
            <span>{mail.de || mail.de_email || "Expéditeur inconnu"} · {formatDocumentDate(mail.recu)}</span>
            <p>{mail.apercu}</p>
            {onRead && <button type="button" onClick={() => onRead(`Copie locale ${meta.label}, synchronisée le ${formatDocumentDate(data.syncedAt)}. De ${mail.de || mail.de_email}. Objet : ${mail.sujet}. Aperçu : ${mail.apercu || "Aucun aperçu."}`)}><Volume2 size={14} /> Lire cet aperçu à voix haute</button>}
          </li>)}</ul>
          </div>
        </article>;
      })}
      </div>
    </section>
  );
}

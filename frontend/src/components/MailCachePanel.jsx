import { useEffect, useState } from "react";
import { MAIL_CACHE_PROVIDERS } from "../services/mailCache";
import { formatDocumentDate } from "../dateTime";

export default function MailCachePanel({ cache, onRead }) {
  const [query, setQuery] = useState("");
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
      <label>Rechercher dans les aperçus locaux<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      {Object.entries(MAIL_CACHE_PROVIDERS).map(([provider, meta]) => {
        const data = cache.providers[provider];
        const mails = (data?.mails || []).filter((mail) => `${mail.de} ${mail.de_email} ${mail.sujet} ${mail.apercu}`.toLocaleLowerCase("fr").includes(query.toLocaleLowerCase("fr")));
        return <article key={provider}>
          <h3>{meta.label} — {meta.limit} aperçus maximum</h3>
          <p>{data?.enabled ? `Activé pour ${data.email}` : "Désactivé"}</p>
          <p>{data?.syncedAt ? `Dernière synchronisation : ${formatDocumentDate(data.syncedAt)} à ${new Date(data.syncedAt).toLocaleTimeString("fr-FR")}. Copies locales, pas une boîte en direct.` : "Aucune synchronisation enregistrée."}</p>
          {cache.errors[provider] && <p className="connections-error" role="alert">{cache.errors[provider]} Les aperçus conservés ne sont pas une nouvelle synchronisation.</p>}
          <div className="mail-cache-actions">
            <button type="button" disabled={!online || !cache.account || !!cache.busy[provider] || (!data && !!cache.errors[provider])} onClick={() => cache.run(provider, !data?.enabled)}>{cache.busy[provider] ? "Synchronisation…" : data?.enabled ? "Synchroniser maintenant" : "Activer le cache local"}</button>
            <button type="button" disabled={!cache.account} onClick={() => cache.clear(provider)}>Effacer et désactiver {meta.label}</button>
          </div>
          <p>{data?.mails.length || 0} aperçu(s) conservé(s) · {mails.length} résultat(s)</p>
          <ul>{mails.map((mail) => <li key={mail.id}>
            <strong>{mail.sujet || "(sans objet)"}</strong>
            <span>{mail.de || mail.de_email || "Expéditeur inconnu"} · {formatDocumentDate(mail.recu)}</span>
            <p>{mail.apercu}</p>
            {onRead && <button type="button" onClick={() => onRead(`Copie locale ${meta.label}, synchronisée le ${formatDocumentDate(data.syncedAt)}. De ${mail.de || mail.de_email}. Objet : ${mail.sujet}. Aperçu : ${mail.apercu || "Aucun aperçu."}`)}>Lire cet aperçu à voix haute</button>}
          </li>)}</ul>
        </article>;
      })}
    </section>
  );
}

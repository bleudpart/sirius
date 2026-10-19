import { useEffect, useRef, useState } from "react";
import { Check, ShieldCheck, ArrowRight, Mic, FolderOpen, Mail, UserRound, Zap, Star, Search, ChartNoAxesCombined, FileText } from "lucide-react";
import PublicLegal from "./PublicLegal";
import "./PublicStore.css";
import "./publicPantheon.css";

const API = `${process.env.REACT_APP_BACKEND_URL || "https://api.sirius-assistant.fr"}/api`;

const PLANS = [
  { id: "monthly", cardClass: "card-entreprise", name: "Location", icon: Zap, tagline: "Essayez sans carte, puis choisissez votre abonnement.", price: "10", suffix: " le premier mois", features: ["15 jours gratuits sans carte à la première connexion", "Première location : 10 € le premier mois", "Puis 32 €/mois, renouvellement automatique", "Résiliation depuis le portail Stripe", "Après l'essai, clés IA personnelles nécessaires"] },
  { id: "standard", cardClass: "card-standard", name: "Standard", icon: UserRound, tagline: "Pour organiser votre quotidien personnel.", price: "69", suffix: " paiement unique", features: ["Assistant conversationnel", "Emails et documents", "HUD ΣIRIUS", "Windows et mobile"] },
  { id: "pro", cardClass: "card-pro", name: "Pro", icon: Zap, tagline: "Pour les indépendants et les activités métier.", price: "135", suffix: " paiement unique", featured: true, badge: "RECOMMANDÉ", features: ["Tout Standard", "Automatisations métier", "HACCP et productivité", "Commandes vocales", "Support prioritaire"] },
  { id: "lifetime", cardClass: "card-lifetime", name: "Lifetime", icon: Star, tagline: "Pour un usage durable avec les évolutions incluses.", price: "269", suffix: " paiement unique", badge: "MEILLEURE VALEUR", features: ["Tout Pro", "Mises à jour incluses", "Futurs modules inclus", "Licence à vie"] },
];

const MATRIX_ACTIONS = [
  { icon: FolderOpen, text: "Retrouvez rapidement vos dossiers", detail: "Réunissez documents et notes dans un dossier pour retrouver le contexte enregistré." },
  { icon: FileText, text: "Préparez vos documents", detail: "Obtenez un texte ou un brouillon à relire avant de l'utiliser." },
  { icon: Mail, text: "Organisez vos rendez-vous et échéances", detail: "Les agendas et courriels nécessitent un compte connecté et ses autorisations." },
  { icon: Search, text: "Analysez les informations importantes", detail: "Demandez une synthèse des informations fournies. Vérifiez les conclusions ; un service IA configuré et une connexion réseau sont nécessaires." },
  { icon: Mic, text: "Travaillez à la voix ou par écrit", detail: "Le microphone reste facultatif. Sur Android, la transcription envoie un extrait audio au serveur." },
  { icon: ShieldCheck, text: "Gardez vos actions sous contrôle", detail: "Relisez les propositions et confirmez les actions importantes, notamment l'envoi d'un courriel." },
];

export default function PublicStore() {
  const [mythWindowOpen, setMythWindowOpen] = useState(false);
  const mythDialogRef = useRef(null);
  const mythCloseButtonRef = useRef(null);
  const mythOpenerRef = useRef(null);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [selected, setSelected] = useState("pro");
  const [subscriptionAccepted, setSubscriptionAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [portalBusy, setPortalBusy] = useState(false);
  const [paypalBusy, setPaypalBusy] = useState(false);
  const [paypalStatus, setPaypalStatus] = useState(null);
  const selectedPlan = PLANS.find((plan) => plan.id === selected);
  const checkoutSessionId = new URLSearchParams(window.location.search).get("session_id");
  const paymentSucceeded = new URLSearchParams(window.location.search).get("payment") === "success";

  useEffect(() => {
    if (!mythWindowOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    mythCloseButtonRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setMythWindowOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = event.currentTarget;
      const focusable = dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const dialog = mythDialogRef.current;
    dialog?.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      dialog?.removeEventListener("keydown", onKeyDown);
      mythOpenerRef.current?.focus();
    };
  }, [mythWindowOpen]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("payment") !== "paypal-return") return;
    const orderId = params.get("token");
    if (!orderId) return;
    (async () => {
      try {
        const response = await fetch(`${API}/public/paypal-capture`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_id: orderId }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Le paiement PayPal n'a pas pu être confirmé.");
        setPaypalStatus({ ok: true, tier: data.tier });
      } catch (cause) {
        setPaypalStatus({ ok: false, message: cause.message });
      }
    })();
  }, []);

  if (["/mentions-legales", "/conditions-generales", "/confidentialite"].includes(window.location.pathname)) return <PublicLegal />;

  const checkout = async (event) => {
    event.preventDefault();
    setError("");
    if (selected === "monthly" && !subscriptionAccepted) {
      setError("Acceptez les conditions de renouvellement de la location.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${API}/public/license-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), phone: phone.trim(), tier: selected, origin_url: window.location.origin,
          ...(selected === "monthly" ? { subscription_accepted: subscriptionAccepted } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.checkout_url) throw new Error(data.detail || "Impossible d'ouvrir le paiement.");
      window.location.assign(data.checkout_url);
    } catch (cause) {
      setError(cause.message || "Le paiement est momentanément indisponible.");
      setBusy(false);
    }
  };

  const manageSubscription = async () => {
    if (!checkoutSessionId) return;
    setError("");
    setPortalBusy(true);
    try {
      const response = await fetch(`${API}/public/license-portal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: checkoutSessionId, origin_url: window.location.origin }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.portal_url) throw new Error(data.detail || "Impossible d'ouvrir la gestion d'abonnement.");
      window.location.assign(data.portal_url);
    } catch (cause) {
      setError(cause.message || "La gestion d'abonnement est momentanément indisponible.");
      setPortalBusy(false);
    }
  };

  const checkoutPaypal = async () => {
    if (!email.trim()) { setError("Renseignez votre e-mail avant de payer avec PayPal."); return; }
    setError("");
    setPaypalBusy(true);
    try {
      const response = await fetch(`${API}/public/paypal-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), phone: phone.trim(), tier: selected, origin_url: window.location.origin }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.approve_url) throw new Error(data.detail || "PayPal est momentanément indisponible.");
      window.location.assign(data.approve_url);
    } catch (cause) {
      setError(cause.message || "PayPal est momentanément indisponible.");
      setPaypalBusy(false);
    }
  };

  return (
    <main className="public-store">
      <header className="public-nav">
        <a className="public-brand" href="/"><span className="public-brand-gold">ΣIRIUS</span><span>.</span></a>
        <nav className="public-nav-links" aria-label="Navigation de la boutique">
          <a href="#demonstration">Comment ça marche</a>
          <a href="#offres">Les offres</a>
          <a href="#essayer">Essai gratuit</a>
        </nav>
      </header>
      <div className="public-showcase">
      <section className="public-hero">
        <p className="public-eyebrow">Votre assistant de travail</p>
        <h1>Parlez à ΣIRIUS.<br />Il prépare votre travail.</h1>
        <p className="public-value">Décrivez simplement ce que vous voulez faire. ΣIRIUS retrouve vos informations, rassemble vos dossiers et prépare les prochaines étapes avec vous.</p>
        <ul className="public-request-examples" aria-label="Exemples de demandes">
          <li>« Prépare ma journée. »</li>
          <li>« Retrouve le dossier de ce client. »</li>
          <li>« Rappelle-moi de relancer ce devis vendredi. »</li>
        </ul>
        <p className="public-trial-highlight">15 jours d'essai gratuit des services IA · Sans carte bancaire</p>
        <div className="public-hero-actions"><a className="public-primary-cta" href="#essayer">Essayer gratuitement pendant 15 jours <ArrowRight size={17} /></a><a className="public-demo-text-link" href="#demonstration">Voir comment ΣIRIUS fonctionne</a></div>
      </section>
      <section className="public-hud-preview public-hud-hero" aria-label="Capture d'écran du HUD ΣIRIUS">
        <div className="public-window-bar"><span className="public-window-dot" /> ΣIRIUS · L'espace de travail</div>
        <div className="hud-preview"><img src="/hud-preview.png" alt="HUD ΣIRIUS en situation" loading="eager" /></div>
        <p className="public-preview-caption">Une interface pour vos commandes, vos outils et vos modules.</p>
      </section>
      </div>
      <section className="public-demo public-workflow" id="demonstration" aria-labelledby="public-demo-title">
        <h2 id="public-demo-title" className="public-section-title">Voyez ΣIRIUS en situation</h2>
        <video controls preload="none" poster="/demo/sirius-dossiers.png" aria-label="Démonstration de ΣIRIUS avec des données fictives">
          <source src="/demo/sirius-demo-store.mp4" type="video/mp4" />
          <track kind="subtitles" src="/demo/sirius-demo-store.vtt" srcLang="fr" label="Français" default />
          Votre navigateur ne lit pas cette vidéo. <a href="/demo/sirius-demo-store.mp4">Télécharger la démonstration</a>
        </video>
        <p className="public-function-note">Une minute de démonstration enregistrée : suivi d'activité, factures et préparation d'un courriel. Données fictives, aucun envoi réel. Ce n'est pas une réponse IA en direct ; l'apparence peut différer de la version téléchargée.</p>
      </section>
      <section className="public-founder public-workflow" aria-labelledby="public-founder-title">
        <h2 id="public-founder-title" className="public-section-title">Daniel Partel vous présente ΣIRIUS</h2>
        <p>J'ai créé ΣIRIUS pour celles et ceux qui souhaitent profiter des outils numériques sans avoir à maîtriser l'intelligence artificielle. Vous lui parlez naturellement : il rassemble vos demandes, vos dossiers et vos outils pour vous accompagner dans votre travail.</p>
      </section>
      <section className="public-workflow" aria-labelledby="public-advantage-title">
        <h2 id="public-advantage-title" className="public-section-title">Comment ça fonctionne ?</h2>
        <ol className="public-workflow-steps">
          <li><strong>Vous parlez naturellement</strong><p>À la voix ou au clavier, pas besoin d'apprendre à rédiger des prompts.</p></li>
          <li><strong>ΣIRIUS rassemble ce qu'il vous faut</strong><p>Dossiers, notes, échéances et informations accessibles restent réunis.</p></li>
          <li><strong>Vous gardez le dernier mot</strong><p>Vous vérifiez et validez avant les actions importantes.</p></li>
        </ol>
      </section>
      <section className="public-situations" aria-labelledby="public-situations-title">
        <h2 id="public-situations-title" className="public-section-title">ΣIRIUS en situation</h2>
        <p>Captures de l'application locale avec des données fictives de démonstration. Elles illustrent les dossiers et le planning, pas une réponse IA ni une connexion à un service externe.</p>
        <div className="public-situations-grid">
          <figure>
            <a href="/demo/sirius-dossiers.png" target="_blank" rel="noopener noreferrer" aria-label="Agrandir la capture des dossiers">
              <img src="/demo/sirius-dossiers.png" alt="MNÉMOSYNE : dossier Atelier Horizon avec un client fictif" width="1440" height="1000" loading="lazy" />
            </a>
            <figcaption><strong>Retrouvez le dossier d'un client</strong><span>Son contact et ses informations réunis. Données de démonstration.</span></figcaption>
          </figure>
          <figure>
            <a href="/demo/sirius-planning.png" target="_blank" rel="noopener noreferrer" aria-label="Agrandir la capture du planning">
              <img src="/demo/sirius-planning.png" alt="CHRONOS : échéance de relecture associée au dossier fictif Atelier Horizon" width="1440" height="1000" loading="lazy" />
            </a>
            <figcaption><strong>Gardez vos échéances en vue</strong><span>Une tâche datée associée à un dossier. Données de démonstration.</span></figcaption>
          </figure>
        </div>
      </section>
      <section className="public-control public-workflow" aria-labelledby="public-control-title">
        <h2 id="public-control-title" className="public-section-title">Vos données. Vos décisions.</h2>
        <p>Le microphone est facultatif. Vous choisissez les comptes à connecter et vous confirmez les actions importantes.</p>
        <details><summary>Confidentialité et limites à connaître</summary>
          <p>Les dossiers et outils locaux restent accessibles sans service IA. Une demande adressée à un fournisseur connecté peut lui transmettre les informations nécessaires à son traitement. Sur Android, la transcription vocale envoie un extrait audio au serveur.</p>
          <p>Les résultats peuvent contenir des erreurs : vérifiez-les avant utilisation. Les fonctions de gestion ne remplacent ni un expert-comptable ni un conseil juridique.</p>
          <a href="/confidentialite.html">Lire la politique de confidentialité</a>
        </details>
      </section>
      <section className="public-matrix" id="matrice-demo" aria-label="La matrice de ΣIRIUS">
        <div className="public-section-intro"><span className="public-section-icon"><ChartNoAxesCombined size={21} /></span><div><h2 className="public-section-title">Ce que vous pouvez lui confier</h2><p>Des outils pour préparer votre travail, à votre rythme.</p></div></div>
        <div className="public-matrix-layout">
        <div className="public-core-preview">
          <div className="public-core-window" aria-label="Noyau ΣIRIUS" role="img">
            <div className="public-core-art">
              <img src="/holo/ring-gold.png" alt="" className="public-core-ring public-core-ring-outer" draggable={false} loading="lazy" />
              <img src="/holo/ring-gold.png" alt="" className="public-core-ring public-core-ring-inner" draggable={false} loading="lazy" />
              <div className="public-core-scan-band" aria-hidden="true" />
              <div className="public-core-heart matrix-circle" />
            </div>
          </div>
          <span><strong>Le cœur opérationnel de ΣIRIUS.</strong> Vos outils, vos données et vos actions dans un même espace.</span>
        </div>
        <ul className="public-matrix-actions">
          {MATRIX_ACTIONS.map(({ icon: Icon, text, detail }) => (
            <li key={text}><Icon size={16} /> <span><strong>{text}</strong><details><summary>En pratique</summary><small>{detail}</small></details></span></li>
          ))}
        </ul>
        </div>
        <p className="public-function-note">L'animation illustre le noyau, sans exécuter de commande : pas une démonstration en direct. Les services connectés nécessitent le réseau et leur délai de réponse peut varier.</p>
      </section>
      <section className="public-plans" id="offres" aria-label="Offres ΣIRIUS">
        <h2 className="public-section-title">Choisissez votre formule</h2>
        {PLANS.map((plan) => {
          const PlanIcon = plan.icon;
          return (
            <button key={plan.id} type="button" aria-pressed={selected === plan.id} className={`public-plan public-plan-${plan.id} ${plan.cardClass} ${selected === plan.id ? "selected" : ""} ${plan.featured ? "featured" : ""}`} onClick={() => { setSelected(plan.id); setSubscriptionAccepted(false); }}>
              {plan.badge && <span className={`public-popular ${plan.id === "lifetime" ? "public-popular-alt" : ""}`}>{plan.badge}</span>}
              <span className="public-plan-icon" aria-hidden="true"><PlanIcon size={19} /></span>
              <span className="public-plan-name">{plan.name}</span>
              <span className="public-plan-tagline">{plan.tagline}</span>
              <span className="public-price"><strong>{plan.price} €</strong><small>{plan.suffix}</small></span>
              <span className="public-features">{plan.features.map((feature) => <span key={feature}><Check size={14} /> {feature}</span>)}</span>
              <span className="public-plan-choice">{selected === plan.id ? <><Check size={16} /> Formule sélectionnée</> : <>Choisir cette formule <ArrowRight size={16} /></>}</span>
            </button>
          );
        })}
      </section>
      <section className="public-plan-details public-workflow" aria-labelledby="public-comparison-title">
        <h2 id="public-comparison-title" className="public-section-title">Les différences en un coup d'œil</h2>
        <div className="public-comparison-scroll" tabIndex={0} role="region" aria-label="Comparatif des formules">
          <table>
            <thead><tr><th scope="col">Formule</th><th scope="col">Pour qui ?</th><th scope="col">Paiement</th><th scope="col">L'essentiel</th></tr></thead>
            <tbody>
              <tr><th scope="row">Location</th><td>Découvrir en s'abonnant</td><td>10 € le premier mois*, puis 32 €/mois</td><td>Renouvellement automatique, résiliation via Stripe</td></tr>
              <tr><th scope="row">Standard</th><td>Usage personnel</td><td>69 € une fois</td><td>Assistant, emails et documents</td></tr>
              <tr><th scope="row">Pro</th><td>Indépendants et métier</td><td>135 € une fois</td><td>Standard + métier, HACCP, productivité et support prioritaire</td></tr>
              <tr><th scope="row">Lifetime</th><td>Usage durable</td><td>269 € une fois</td><td>Pro + mises à jour et futurs modules inclus</td></tr>
            </tbody>
          </table>
        </div>
        <p className="public-function-note">* Première location uniquement ; sinon 32 €/mois dès la souscription. Aucun paiement annuel proposé ici.</p>
        <details><summary>Après l'essai : licence obligatoire, clés et frais extérieurs</summary>
          <p>Après les 15 jours d'essai, ΣIRIUS se verrouille tant qu'aucune licence ou location n'est active. Achetez-la avec l'adresse e-mail de votre compte : l'application se débloque automatiquement. Vos données restent conservées, exportables et supprimables.</p>
          <p>Pour toutes les formules, après les 15 jours, les services IA demandent vos propres clés API. Les fournisseurs peuvent facturer leur utilisation ; ces frais ne sont pas inclus dans la licence.</p>
          <p>Lifetime désigne la licence du logiciel à paiement unique, avec les mises à jour et futurs modules annoncés inclus. Ce n'est pas un abonnement à vie aux fournisseurs IA ni une garantie de disponibilité perpétuelle des services externes. Consultez les conditions générales avant l'achat.</p>
          <a href="/conditions-generales">Consulter les conditions générales</a>
        </details>
      </section>
      <section className="public-trial" id="essayer" aria-labelledby="public-trial-title">
        <h2 id="public-trial-title" className="public-section-title">Commencez gratuitement pendant 15 jours</h2>
        <p>Aucune connaissance de l'IA nécessaire. Téléchargez ΣIRIUS, ouvrez l'application, puis créez votre compte.</p>
        <a className="public-primary-cta" href="https://github.com/bleudpart/sirius/releases/download/v1.0.53/sirius-setup-1.0.53.exe">Télécharger pour Windows <ArrowRight size={17} /></a>
        <p className="public-function-note">Version publique Windows 1.0.53. Aucun téléphone demandé sur cette page pour l'essai.</p>
        <details className="public-defender-help" data-testid="public-defender-help"><summary>Windows bloque le téléchargement ou l'installation ?</summary>
          <p>ΣIRIUS est récent : Windows Defender SmartScreen peut le signaler comme « peu téléchargé ». Le fichier provient directement de notre dépôt officiel.</p>
          <ol>
            <li>Dans le navigateur, si le téléchargement est bloqué : ouvrez les téléchargements, cliquez sur <strong>…</strong> à côté de « sirius-setup », puis <strong>Conserver</strong> (puis <strong>Afficher plus</strong> → <strong>Conserver quand même</strong>).</li>
            <li>Au lancement, si « Windows a protégé votre ordinateur » s'affiche : cliquez sur <strong>Informations complémentaires</strong>, puis <strong>Exécuter quand même</strong>.</li>
          </ol>
        </details>
        <p><strong>Sans engagement ni paiement automatique à la fin de l'essai.</strong> Sans carte bancaire, aucun abonnement à annuler.</p>
        <details><summary>Comment fonctionne l'essai ?</summary>
          <p>L'essai commence à votre première connexion activant votre compte. Les services IA autorisés utilisent les clés de SIRIUS, dans la limite des quotas quotidiens.</p>
          <p>À la fin des 15 jours, l'application se verrouille jusqu'à l'achat d'une licence ou d'une location avec l'adresse e-mail de votre compte. Sur PC, l'application est reliée à votre compte ΣIRIUS pour vérifier cet accès.</p>
          <p>Ensuite, la configuration vous guide pour ajouter vos propres clés API chiffrées sur votre appareil. Les fournisseurs peuvent facturer leur utilisation.</p>
          <p>L'essai est distinct de l'achat d'une licence. Une déconnexion ou une réinstallation ne relance pas les 15 jours. Toute souscription volontaire déclenche un paiement immédiat, sans nouvel essai Stripe.</p>
        </details>
      </section>
      <details className="public-purchase" id="commencer">
      <summary>Vous avez déjà choisi votre formule ? Continuer vers l'achat</summary>
      <form className="public-checkout" onSubmit={checkout}>
        <div className="public-checkout-heading">
        <div>
        <p className="public-eyebrow">Votre licence</p>
        <h2 className="public-section-title">Acheter une licence — paiement immédiat</h2>
        </div>
        <p className="public-order-summary" aria-live="polite"><span>{selectedPlan.name}</span><strong>{selectedPlan.price} €</strong><small>{selected === "monthly" ? "Premier mois d'une première location, puis 32 €/mois" : "Paiement unique"}</small></p>
        </div>
        <label htmlFor="public-email">Votre adresse e-mail</label>
        <div className="public-form-row">
          <input id="public-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="vous@exemple.fr" />
          <button type="submit" disabled={busy}>{busy ? "Ouverture..." : "Continuer avec Stripe"} <ArrowRight size={17} /></button>
        </div>
        <label htmlFor="public-phone">Téléphone (optionnel)</label>
        <div className="public-form-row">
          <input id="public-phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="06 12 34 56 78" />
          <a className="public-demo-link" href="#matrice-demo">Voir les fonctions <ArrowRight size={17} /></a>
        </div>
        {selected === "monthly" && <label className="public-subscription-consent">
          <input type="checkbox" checked={subscriptionAccepted} required onChange={(event) => setSubscriptionAccepted(event.target.checked)} />
          J'accepte le paiement immédiat de 10 € pour le premier mois de ma première location, puis le renouvellement automatique à 32 €/mois jusqu'à résiliation. Si j'ai déjà souscrit une location, le tarif est de 32 €/mois dès la souscription. Les clés IA personnelles restent nécessaires après l'essai.
        </label>}
        {selected !== "monthly" && (
          <button type="button" className="public-paypal-btn" onClick={checkoutPaypal} disabled={paypalBusy}>
            <ShieldCheck size={16} /> {paypalBusy ? "Ouverture..." : "Payer avec PayPal"}
          </button>
        )}
        {error && <p className="public-error" role="alert">{error}</p>}
        <p className="public-legal">Le paiement s'ouvre chez Stripe ou PayPal selon votre choix. Vérifiez le montant et les conditions sur la page du prestataire avant de confirmer.</p>
        <small className="public-checkout-note">Consultez les conditions générales avant l'achat. Cette page ne garantit pas que le prestataire est en mode test.</small>
      </form>
      </details>
      {paypalStatus && (
        <p className={paypalStatus.ok ? "public-checkout-note" : "public-error"} role={paypalStatus.ok ? undefined : "alert"}>
          {paypalStatus.ok ? `Paiement PayPal confirmé — licence ${paypalStatus.tier} activée.` : paypalStatus.message}
        </p>
      )}
      {paymentSucceeded && checkoutSessionId && new URLSearchParams(window.location.search).get("tier") === "monthly" && <section className="public-subscription-success">
        <strong>Retour de la souscription Stripe.</strong>
        <span>Gérez ou résiliez votre abonnement depuis le portail Stripe sécurisé.</span>
        <button type="button" onClick={manageSubscription} disabled={portalBusy}>{portalBusy ? "Ouverture..." : "Gérer mon abonnement"}</button>
      </section>}
      <section className="public-odysseia-card" aria-labelledby="public-odysseia-card-title">
        <img src="/Designer%20(16).png" alt="Athéna, illustration de la bibliothèque ODYSSEIA" loading="lazy" />
        <div>
          <p className="public-eyebrow">L'univers de ΣIRIUS</p>
          <h2 id="public-odysseia-card-title" className="public-section-title">L’ère mythologique grecque</h2>
          <p>Des récits du Cosmos aux héros de Troie : découvrez ce que racontent les mythes et ce que l’histoire peut réellement établir.</p>
          <button
            type="button"
            className="public-secondary-cta"
            onClick={(event) => {
              mythOpenerRef.current = event.currentTarget;
              setMythWindowOpen(true);
            }}
          >
            Lire la synthèse <ArrowRight size={17} />
          </button>
        </div>
      </section>
      <footer className="public-footer">
        <p className="public-slogan">ΣIRIUS travaille pour vous.</p>
        <p className="public-footer-secure"><ShieldCheck size={13} /> Paiement via Stripe ou PayPal</p>
        © 2026 ΣIRIUS par Daniel Partel · <a href="/mentions-legales">Mentions légales</a> · <a href="/conditions-generales">Conditions générales</a> · <a href="/confidentialite.html">Confidentialité</a> · <a href="/suppression-compte.html">Suppression du compte</a>
      </footer>
      {mythWindowOpen && (
        <div
          className="public-odysseia-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMythWindowOpen(false);
          }}
        >
          <section
            ref={mythDialogRef}
            className="public-odysseia-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-odysseia-title"
            aria-describedby="public-odysseia-summary"
          >
            <header className="public-odysseia-heading">
              <div>
                <p className="public-eyebrow">ODYSSEIA · Bibliothèque des mythes anciens</p>
                <h2 id="public-odysseia-title">L’ère mythologique grecque</h2>
              </div>
              <button ref={mythCloseButtonRef} className="public-odysseia-close" type="button" onClick={() => setMythWindowOpen(false)} aria-label="Fermer la synthèse">
                ×
              </button>
            </header>
            <div className="public-odysseia-content" id="public-odysseia-summary">
              <img src="/Designer%20(16).png" alt="Athéna, détail de l’illustration ODYSSEIA" />
              <div>
                <p>« L’ère mythologique » n’est pas une période officielle de l’histoire grecque : c’est un temps légendaire où les récits expliquent les origines du monde, des dieux, des humains et des héros.</p>
                <p>Dans la <cite>Théogonie</cite>, Hésiode raconte l’apparition du Cosmos, les générations divines, le conflit des Titans et l’installation de Zeus. D’autres récits évoquent Prométhée, Pandore et les âges de l’humanité. Les dieux olympiens — parmi lesquels Athéna, Apollon et Poséidon — incarnent des puissances et des aspects multiples du monde grec.</p>
                <p>Les traditions héroïques prolongent ce temps fabuleux avec Persée, Héraclès, Thésée, Jason et les récits liés à Troie. L’<cite>Iliade</cite> met en scène une partie de la guerre légendaire ; l’<cite>Odyssée</cite> suit le retour d’Ulysse. Ces poèmes, transmis et façonnés par la tradition orale avant leur mise par écrit, ne sont pas des chroniques contemporaines des événements racontés.</p>
                <p>L’histoire apporte toutefois des repères : la civilisation mycénienne et la cité de Troie à Hisarlık ont bien existé et sont étudiées par l’archéologie. Cela ne prouve pas que les épisodes homériques se sont déroulés tels quels. Il faut donc distinguer le temps du mythe, les sociétés historiques de l’Âge du Bronze et l’époque où les récits ont été composés.</p>
                <h3>Repères de lecture</h3>
                <ul>
                  <li>Hésiode, <cite>Théogonie</cite> et <cite>Les Travaux et les Jours</cite>.</li>
                  <li>Homère, <cite>Iliade</cite> et <cite>Odyssée</cite>.</li>
                  <li>Archéologie égéenne : sites mycéniens et site de Troie/Hisarlık.</li>
                </ul>
                <p className="public-odysseia-note">Cette présentation résume la tradition mythologique et distingue explicitement les récits légendaires des faits historiques documentés.</p>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

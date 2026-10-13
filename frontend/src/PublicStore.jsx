import { useEffect, useRef, useState } from "react";
import { Check, ShieldCheck, ArrowRight, Mic, FolderOpen, Mail, UserRound, Zap, Star, Home, Search, ChartNoAxesCombined, FileText } from "lucide-react";
import PublicLegal from "./PublicLegal";
import "./PublicStore.css";

const API = `${process.env.REACT_APP_BACKEND_URL || "https://api.sirius-assistant.fr"}/api`;

const PLANS = [
  { id: "monthly", cardClass: "card-entreprise", name: "Location", icon: Zap, tagline: "Essayez sans carte, puis choisissez votre abonnement.", price: "10", suffix: " le premier mois", features: ["15 jours gratuits sans carte à la première connexion", "Première location : 10 € le premier mois", "Puis 32 €/mois, renouvellement automatique", "Résiliation depuis le portail Stripe", "Après l'essai, clés IA personnelles nécessaires"] },
  { id: "standard", cardClass: "card-standard", name: "Standard", icon: UserRound, tagline: "L'essentiel pour automatiser votre quotidien.", price: "69", suffix: " unique", features: ["Assistant conversationnel", "Emails et documents", "HUD ΣIRIUS", "Windows et mobile"] },
  { id: "pro", cardClass: "card-pro", name: "Pro", icon: Zap, tagline: "La puissance métier sans friction.", price: "135", suffix: " unique", featured: true, badge: "RECOMMANDÉ", features: ["Tout Standard", "Automatisations métier", "HACCP et productivité", "Commandes vocales", "Support prioritaire"] },
  { id: "lifetime", cardClass: "card-lifetime", name: "Lifetime", icon: Star, tagline: "L'accès complet, pour longtemps.", price: "269", suffix: " unique", badge: "MEILLEURE VALEUR", features: ["Tout Pro", "Mises à jour incluses", "Futurs modules inclus", "Licence à vie"] },
];

const MATRIX_ACTIONS = [
  { icon: FolderOpen, text: "Organiser ses dossiers", detail: "Les six modules métier locaux proposent une sauvegarde JSON et une restauration par fusion." },
  { icon: FileText, text: "Rédaction de documents", detail: "L'IA vous aide à préparer des textes et des brouillons. Relisez et validez le contenu avant de l'utiliser." },
  { icon: Search, text: "Analyse assistée par IA", detail: "Obtenez une synthèse ou une explication des informations fournies. Vérifiez les conclusions ; un service IA configuré et une connexion réseau sont nécessaires." },
  { icon: Mail, text: "Préparer un email", detail: "Les fonctions email nécessitent un compte connecté et les autorisations du fournisseur." },
  { icon: Mic, text: "Dicter une demande", detail: "Le microphone nécessite votre autorisation. La transcription Android envoie un extrait audio au serveur." },
  { icon: Home, text: "Piloter des équipements", detail: "La domotique nécessite une connexion configurée et des équipements compatibles." },
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
          <a href="#matrice-demo">L'interface</a>
          <a href="#offres">Les offres</a>
          <a className="public-nav-cta" href="#commencer">Choisir ma licence <ArrowRight size={15} /></a>
        </nav>
      </header>
      <div className="public-showcase">
      <section className="public-hero">
        <p className="public-eyebrow">ΣIRIUS, conçue pour vous</p>
        <h1>Zirius, sans prompts compliqués : <em>parlez-lui, Il s'occupe de vos tâches.</em></h1>
        <p className="public-value">Conçu pour tous ceux qui ne sont pas à l'aise avec l'IA, Zirius vous aide : vous écoute, vous répond, exécute vos demandes et surveille vos tâches. Parlez-lui naturellement, sans avoir à rédiger de prompts compliqués.</p>
        <p className="public-trial-highlight">15 jours d'essai gratuit des services IA dès votre première connexion.</p>
        <div className="public-benefits"><span>Demandes naturelles</span><span>Réponses rapides</span><span>Plusieurs tâches, un espace</span><span>Suivi des dossiers</span></div>
        <div className="public-hero-actions"><a className="public-primary-cta" href="#offres">Découvrir les offres <ArrowRight size={17} /></a><a className="public-secondary-cta" href="#matrice-demo">Explorer l'interface <ArrowRight size={17} /></a></div>
      </section>
      <section className="public-hud-preview public-hud-hero" aria-label="Capture d'écran du HUD ΣIRIUS">
        <div className="public-window-bar"><span className="public-window-dot" /> ΣIRIUS · L'espace de travail</div>
        <div className="hud-preview"><img src="/hud-preview.png" alt="HUD ΣIRIUS en situation" loading="eager" /></div>
        <p className="public-preview-caption">Une interface pour vos commandes, vos outils et vos modules.</p>
      </section>
      </div>
      <section className="public-workflow" aria-labelledby="public-advantage-title">
        <h2 id="public-advantage-title" className="public-section-title">Moins de temps à expliquer. Plus de temps à avancer.</h2>
        <p>Vous n'avez pas à devenir expert en IA. ΣIRIUS a été conçu pour réunir l'assistance et l'organisation de votre activité, sans reconstruire votre façon de travailler à chaque demande.</p>
        <ol className="public-workflow-steps">
          <li><strong>La simplicité, dès la première demande</strong><p>Dites ce dont vous avez besoin, à la voix ou au clavier. Pas de formule technique à apprendre ni de prompt compliqué à préparer.</p></li>
          <li><strong>La rapidité, sans multiplier les manipulations</strong><p>Préparez un document, retrouvez une information et organisez une tâche dans le même espace. Passez d'une demande à l'autre sans disperser votre travail entre plusieurs interfaces.</p></li>
          <li><strong>La continuité, dossier après dossier</strong><p>Conservez vos documents et vos notes, retrouvez le contexte enregistré et associez vos échéances à vos dossiers. Les rappels configurés vous aident à garder le fil des prochaines actions.</p></li>
        </ol>
        <p>Claude, ChatGPT et d'autres outils peuvent intervenir à certaines étapes. Mais avec ΣIRIUS, vous avez un interlocuteur unique : vous lui parlez et, hop ! Il rassemble vos demandes, vos dossiers et vos outils, puis vous accompagne tout au long de votre travail.</p>
        <p><strong>Essayez Zirius gratuitement.</strong><br />Demandez-lui de rédiger un message, organiser un rendez-vous ou suivre une demande. Parlez-lui simplement. Vous l'adopterez.</p>
        <a className="public-primary-cta" href="#commencer">Découvrir ΣIRIUS <ArrowRight size={17} /></a>
      </section>
      <section className="public-why" aria-labelledby="public-why-title">
        <h2 id="public-why-title" className="public-section-title">Pourquoi ΣIRIUS a-t-il été conçu ?</h2>
        <p>ΣIRIUS a été conçu pour aider les particuliers, les commerçants, les artisans, les indépendants et les entreprises à mieux organiser leur activité au quotidien. Il permet de centraliser les documents, notes, factures, informations comptables, tâches, rendez-vous et projets dans un espace unique. Grâce à ses capacités de classement, de recherche et de synthèse, ΣIRIUS facilite le suivi administratif, l'organisation du travail et la prise de décision.</p>
      </section>
      <section className="public-workflow" aria-labelledby="public-workflow-title">
        <h2 id="public-workflow-title" className="public-section-title">De vos documents au travail préparé</h2>
        <p>Pour un commerçant ou un indépendant, la valeur n'est pas seulement d'obtenir une réponse IA : c'est de retrouver les pièces, préparer le travail et conserver un résultat relu dans le bon dossier.</p>
        <ol className="public-workflow-steps">
          <li><strong>Rassembler dans un dossier</strong><p>Photographiez un ticket ou choisissez une image. La lecture du texte se fait sur l'appareil ; la photo originale est conservée sur le serveur SIRIUS après confirmation.</p></li>
          <li><strong>Préparer et vérifier</strong><p>Relisez les champs proposés et comparez les identifiants fiscaux signalés avec la photo. Une information non identifiée reste à compléter, elle n'est pas inventée.</p></li>
          <li><strong>Conserver un résultat utilisable</strong><p>Classez le justificatif et téléchargez sa fiche de dépense en PDF A4. Une vente reste un brouillon de facture non émis ; vous gardez la main sur sa validation.</p></li>
        </ol>
        <p className="public-function-note">Du document reçu au résultat conservé, ΣIRIUS réunit la capture, la relecture, le classement et le document préparé dans un même parcours.</p>
      </section>
      <section className="public-situations" aria-labelledby="public-situations-title">
        <h2 id="public-situations-title" className="public-section-title">ΣIRIUS en situation</h2>
        <p>Captures de l'application locale avec des données fictives de démonstration. Elles illustrent les dossiers et le planning, pas une réponse IA ni une connexion à un service externe.</p>
        <div className="public-situations-grid">
          <figure>
            <a href="/demo/sirius-dossiers.png" target="_blank" rel="noopener noreferrer" aria-label="Agrandir la capture des dossiers">
              <img src="/demo/sirius-dossiers.png" alt="MNÉMOSYNE : dossier Atelier Horizon avec un client fictif" width="1440" height="1000" loading="lazy" />
            </a>
            <figcaption><strong>MNÉMOSYNE — Dossiers et archives</strong><span>Un dossier, son contact et sa description. Données de démonstration.</span></figcaption>
          </figure>
          <figure>
            <a href="/demo/sirius-planning.png" target="_blank" rel="noopener noreferrer" aria-label="Agrandir la capture du planning">
              <img src="/demo/sirius-planning.png" alt="CHRONOS : échéance de relecture associée au dossier fictif Atelier Horizon" width="1440" height="1000" loading="lazy" />
            </a>
            <figcaption><strong>CHRONOS — Planning et échéances</strong><span>Une tâche datée associée à un dossier. Données de démonstration.</span></figcaption>
          </figure>
        </div>
      </section>
      <section className="public-trial" aria-labelledby="public-trial-title">
        <h2 id="public-trial-title" className="public-section-title">15 jours pour découvrir les services IA</h2>
        <p>L'essai commence à votre première connexion activant votre compte. Pendant 15 jours, les services IA autorisés utilisent les clés de SIRIUS, dans la limite des quotas quotidiens.</p>
        <p><strong>Sans engagement ni paiement automatique à la fin de l'essai.</strong> Vous pouvez arrêter d'utiliser l'essai à tout moment : aucun abonnement à annuler.</p>
        <p>Ensuite, l'assistant de configuration vous guide pour ajouter vos propres clés API qui restent chiffrées sur votre appareil. Les outils et dossiers locaux restent accessibles ; les fournisseurs peuvent facturer l'utilisation de vos clés.</p>
        <p>Sans carte bancaire pour l'essai. Pour continuer en location, souscrivez volontairement : 10 € le premier mois pour une première location, puis 32 €/mois. Le renouvellement est automatique après souscription, pas après l'essai gratuit.</p>
        <small>L'essai des services IA est distinct de l'achat d'une licence présenté ci-dessous. Une déconnexion ou une réinstallation ne relance pas les 15 jours. Souscrire avant la fin de l'essai déclenche le premier paiement immédiatement, sans nouvel essai Stripe.</small>
      </section>
      <section className="public-matrix" id="matrice-demo" aria-label="La matrice de ΣIRIUS">
        <div className="public-section-intro"><span className="public-section-icon"><ChartNoAxesCombined size={21} /></span><div><h2 className="public-section-title">Découvrez les fonctionnalités de ΣIRIUS</h2><p>Une présentation des usages et de leurs prérequis, pas une démonstration en direct.</p></div></div>
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
            <li key={text}><Icon size={16} /> <span><strong>{text}</strong><small>{detail}</small></span></li>
          ))}
        </ul>
        </div>
        <p className="public-function-note">La capture d'écran ci-dessus présente le HUD. L'animation du noyau illustre son apparence, sans exécuter de commande. Les fonctions IA et les services connectés nécessitent une connexion réseau ; leur délai de réponse peut varier.</p>
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
      <form className="public-checkout" id="commencer" onSubmit={checkout}>
        <div className="public-checkout-heading">
        <div>
        <p className="public-eyebrow">Votre licence</p>
        <h2 className="public-section-title">Commencer avec ΣIRIUS</h2>
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
          <p className="public-eyebrow">ODYSSEIA · Mythes et histoire</p>
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
        <p className="public-slogan">ZIRIUS travaille pour vous.</p>
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

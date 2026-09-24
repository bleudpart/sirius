import { useEffect, useState } from "react";
import { Check, ShieldCheck, ArrowRight, PlayCircle, Mic, Boxes, Radio, UserRound, Zap, Crown, Home, BrainCircuit, Workflow, ChartNoAxesCombined, Quote } from "lucide-react";
import PublicLegal from "./PublicLegal";
import "./PublicStore.css";

const API = `${process.env.REACT_APP_BACKEND_URL || "https://api.sirius-assistant.fr"}/api`;

const PLANS = [
  { id: "standard", cardClass: "card-standard", name: "Standard", icon: UserRound, tagline: "L'essentiel pour automatiser votre quotidien.", price: "79", suffix: " unique", features: ["Assistant conversationnel", "Emails et documents", "HUD ΣIRIUS", "Windows et mobile"] },
  { id: "pro", cardClass: "card-pro", name: "Pro", icon: Zap, tagline: "La puissance métier sans friction.", price: "149", suffix: " unique", featured: true, badge: "RECOMMANDÉ", features: ["Tout Standard", "Automatisations métier", "HACCP et productivité", "Commandes vocales", "Support prioritaire"] },
  { id: "lifetime", cardClass: "card-lifetime", name: "Lifetime", icon: Crown, tagline: "L'accès complet, pour longtemps.", price: "299", suffix: " unique", badge: "MEILLEURE VALEUR", features: ["Tout Pro", "Mises à jour incluses", "Futurs modules inclus", "Licence à vie"] },
];

const MATRIX_ACTIONS = [
  { icon: Mic, text: "Envoie le devis à Martin" },
  { icon: Boxes, text: "Mets à jour le stock" },
  { icon: Radio, text: "Relance les factures" },
  { icon: Home, text: "Allume le salon" },
];

const WHY_DIFFERENT = [
  { title: "AUTOMATISE", text: "Exécute vos tâches à votre place.", icon: Workflow },
  { title: "ANALYSE", text: "Comprend votre contexte métier.", icon: BrainCircuit },
  { title: "AGIT", text: "Pilote outils, applications et domotique.", icon: Zap },
];

const TESTIMONIALS = [
  ["L’automatisation vocale change ma manière de travailler.", "Consultant indépendant"],
  ["L’assistant exécute mes tâches sans intervention.", "Responsable opérationnel"],
  ["La matrice holographique est intuitive et rapide.", "Gérant de restaurant"],
];

export default function PublicStore() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [selected, setSelected] = useState("pro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [portalBusy, setPortalBusy] = useState(false);
  const [paypalBusy, setPaypalBusy] = useState(false);
  const [paypalStatus, setPaypalStatus] = useState(null);
  const checkoutSessionId = new URLSearchParams(window.location.search).get("session_id");
  const paymentSucceeded = new URLSearchParams(window.location.search).get("payment") === "success";

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
    setBusy(true);
    try {
      const response = await fetch(`${API}/public/license-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), phone: phone.trim(), tier: selected, origin_url: window.location.origin }),
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
      </header>
      <section className="public-hero">
        <h1>Votre espace de travail<br /><em>prend vie</em></h1>
        <p className="public-value">L'assistant IA qui exécute réellement vos tâches.</p>
        <div className="public-benefits"><span>Emails</span><span>Documents</span><span>Automatisation métier</span><span>Domotique</span></div>
        <div className="public-hero-actions"><a className="public-primary-cta" href="#commencer">Commencer gratuitement <ArrowRight size={17} /></a><a className="public-secondary-cta" href="#matrice-demo"><PlayCircle size={17} /> Voir la démo</a></div>
      </section>
      <section className="public-hud-preview public-hud-hero" aria-label="Capture d'écran du HUD ΣIRIUS">
        <div className="hud-preview"><img src="/hud-preview.png" alt="HUD ΣIRIUS en situation" loading="eager" /></div>
      </section>
      <section className="public-metrics" aria-label="Repères ΣIRIUS">
        <div><strong>+12 000</strong><span>tâches exécutées</span></div><div><strong>24h/24</strong><span>disponible</span></div><div><strong>Windows · Android · iOS</strong><span>sur vos appareils</span></div><div><strong>Instantané</strong><span>temps de réponse</span></div>
      </section>
      <section className="public-matrix" id="matrice-demo" aria-label="La matrice de ΣIRIUS">
        <div className="public-section-intro"><span className="public-section-icon"><ChartNoAxesCombined size={21} /></span><div><h2 className="public-section-title">La matrice de ΣIRIUS</h2><p>Une commande, une action réelle.</p></div></div>
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
          {MATRIX_ACTIONS.map(({ icon: Icon, text }) => (
            <li key={text}><Icon size={16} /> <span>{text}</span></li>
          ))}
        </ul>
        <div className="sirius-video-preview public-matrix-video" aria-label="Aperçu vidéo de l'interface réactive">
          <video className="public-matrix-video-el" controls muted loop playsInline preload="none" poster="/hud-preview.png">
          </video>
          <span className="public-matrix-video-badge"><PlayCircle size={14} /> Aperçu de l'interface réactive (5-7s)</span>
        </div>
      </section>
      <section className="public-plans" aria-label="Offres ΣIRIUS">
        <h2 className="public-section-title">Choisissez votre formule</h2>
        {PLANS.map((plan) => {
          const PlanIcon = plan.icon;
          return (
            <button key={plan.id} type="button" className={`public-plan public-plan-${plan.id} ${plan.cardClass} ${selected === plan.id ? "selected" : ""} ${plan.featured ? "featured" : ""}`} onClick={() => setSelected(plan.id)}>
              {plan.badge && <span className={`public-popular ${plan.id === "lifetime" ? "public-popular-alt" : ""}`}>{plan.badge}</span>}
              <span className="public-plan-icon" aria-hidden="true"><PlanIcon size={19} /></span>
              <span className="public-plan-name">{plan.name}</span>
              <span className="public-plan-tagline">{plan.tagline}</span>
              <span className="public-price"><strong>{plan.price} €</strong><small>{plan.suffix}</small></span>
              <span className="public-features">{plan.features.map((feature) => <span key={feature}><Check size={14} /> {feature}</span>)}</span>
            </button>
          );
        })}
      </section>
      <form className="public-checkout" id="commencer" onSubmit={checkout}>
        <h2 className="public-section-title">Commencer avec ΣIRIUS</h2>
        <label htmlFor="public-email">Votre adresse e-mail</label>
        <div className="public-form-row">
          <input id="public-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="vous@exemple.fr" />
          <button type="submit" disabled={busy}>{busy ? "Ouverture..." : "Commencer gratuitement"} <ArrowRight size={17} /></button>
        </div>
        <label htmlFor="public-phone">Téléphone (optionnel)</label>
        <div className="public-form-row">
          <input id="public-phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="06 12 34 56 78" />
          <a className="public-demo-link" href="#matrice-demo"><PlayCircle size={17} /> Voir une démo</a>
        </div>
        {selected !== "monthly" && (
          <button type="button" className="public-paypal-btn" onClick={checkoutPaypal} disabled={paypalBusy}>
            <ShieldCheck size={16} /> {paypalBusy ? "Ouverture..." : "Payer avec PayPal"}
          </button>
        )}
        {error && <p className="public-error" role="alert">{error}</p>}
        <p className="public-legal">Vous serez redirigé vers Stripe. Aucun paiement réel en mode test. Aucun engagement.</p>
      </form>
      <small className="public-checkout-note">Aucun engagement. Mode test Stripe, aucun débit réel.</small>
      {paypalStatus && (
        <p className={paypalStatus.ok ? "public-checkout-note" : "public-error"} role={paypalStatus.ok ? undefined : "alert"}>
          {paypalStatus.ok ? `Paiement PayPal confirmé — licence ${paypalStatus.tier} activée.` : paypalStatus.message}
        </p>
      )}
      {paymentSucceeded && checkoutSessionId && <section className="public-subscription-success">
        <strong>Paiement confirmé.</strong>
        <span>Gérez ou résiliez votre abonnement depuis le portail Stripe sécurisé.</span>
        <button type="button" onClick={manageSubscription} disabled={portalBusy}>{portalBusy ? "Ouverture..." : "Gérer mon abonnement"}</button>
      </section>}
      <section className="public-trust" aria-label="Confiance">
        <h2>Ils utilisent ΣIRIUS</h2>
        <div className="public-testimonials">
          {TESTIMONIALS.map(([quote, author]) => (
            <blockquote key={quote} className="public-testimonial">
              <Quote size={18} /><p>« {quote} »</p>
              <cite>{author}</cite>
            </blockquote>
          ))}
        </div>
      </section>
      <section className="public-why" aria-label="Pourquoi ΣIRIUS">
        <h2 className="public-section-title">Pourquoi ΣIRIUS</h2>
        <div className="public-why-grid">{WHY_DIFFERENT.map(({ title, text, icon: Icon }) => <article key={title}><Icon size={22} /><h3>{title}</h3><p>{text}</p></article>)}</div>
      </section>
      <footer className="public-footer">
        <p className="public-slogan">ΣIRIUS. Le travail, automatisé.</p>
        <p className="public-footer-secure"><ShieldCheck size={13} /> Paiement sécurisé 256 bits</p>
        © 2026 ΣIRIUS par Daniel Partel · <a href="/mentions-legales">Mentions légales</a> · <a href="/conditions-generales">Conditions générales</a> · <a href="/confidentialite">Confidentialité</a>
      </footer>
    </main>
  );
}

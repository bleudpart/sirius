import { useState } from "react";
import { Check, ShieldCheck, Sparkles, ArrowRight, PlayCircle, Mic, Boxes, Radio, Building2, UserRound, Zap, Crown, Home } from "lucide-react";
import PublicLegal from "./PublicLegal";
import "./PublicStore.css";

const API = `${process.env.REACT_APP_BACKEND_URL || "https://api.sirius-assistant.fr"}/api`;

const PLANS = [
  { id: "monthly", name: "Abonnement Entreprise", icon: Building2, tagline: "Automatisation complète pour votre structure.", price: "35", suffix: "/ mois", note: "7 jours d'essai gratuit", featured: true, badge: "LE PLUS CHOISI", features: ["Fiches clients centralisées, zéro tableur", "Relances de facturation envoyées seules", "Stocks à jour à la seconde près", "Dictez la réponse, ΣIRIUS envoie le mail", "Un service cloud entièrement personnalisable", "Module complet de gestion comptable", "Résiliable à tout moment depuis le portail Stripe"], reassurance: ["Compatible avec vos outils actuels (ERP, CRM, etc.)", "Sécurité des paiements assurée par Stripe", "Support prioritaire dédié", "Intégration possible en moins de 24 heures"] },
  { id: "standard", name: "Standard", icon: UserRound, tagline: "Usage personnel, sans superflu.", price: "79", suffix: " unique", features: ["À vous, pour toujours — aucun renouvellement", "Un HUD digne d'un poste de commandement", "L'essentiel, sans superflu"] },
  { id: "pro", name: "Pro", icon: Zap, tagline: "Pour les métiers exigeants, modules avancés.", price: "149", suffix: " unique", features: ["Les modules que vos concurrents n'ont pas", "HACCP et productivité pilotés d'une voix", "Une ligne directe vers le support"] },
  { id: "lifetime", name: "Lifetime", icon: Crown, tagline: "Investissement long terme, tous les futurs modules inclus.", price: "299", suffix: " unique", badge: "LE PLUS COMPLET", features: ["Payez une fois, gardez ΣIRIUS à vie", "Chaque futur module, déjà inclus", "Le sommet de la gamme, sans compromis"] },
];

const MATRIX_ACTIONS = [
  { icon: Mic, text: "Dictez : « Envoie le devis à Martin » → ΣIRIUS prépare et envoie le mail." },
  { icon: Boxes, text: "Dictez : « Mets à jour le stock du plat du jour » → ΣIRIUS ajuste les stocks." },
  { icon: Radio, text: "Dictez : « Relance les factures en retard » → ΣIRIUS envoie les relances." },
  { icon: Home, text: "Dites : « Allume la lumière du salon » — ΣIRIUS contrôle votre domotique." },
];

const WHY_DIFFERENT = [
  "Automatisation réelle des tâches — pas seulement des réponses.",
  "Intégration avec vos outils métier existants.",
  "Contrôle vocal et interface matricielle holographique.",
  "Intégration domotique complète (Home Assistant, lumières, volets, capteurs).",
];

export default function PublicStore() {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [selected, setSelected] = useState("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [portalBusy, setPortalBusy] = useState(false);
  const checkoutSessionId = new URLSearchParams(window.location.search).get("session_id");
  const paymentSucceeded = new URLSearchParams(window.location.search).get("payment") === "success";

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

  return (
    <main className="public-store">
      <header className="public-nav">
        <a className="public-brand" href="/"><span className="public-brand-gold">ΣIRIUS</span><span>.</span></a>
      </header>
      <section className="public-hero">
        <h1>Votre espace de travail<br /><em>prend vie.</em></h1>
        <p className="public-value">ΣIRIUS automatise votre travail et exécute vos tâches à votre place.</p>
        <p className="public-kicker"><Sparkles size={14} /> <span className="public-kicker-gold">ΣIRIUS</span> — ASSISTANT PROFESSIONNEL NUMÉRIQUE INTELLIGENT ET AUTONOME</p>
        <p className="public-promise">Dites-lui quoi faire, il s'occupe de tout : l'assistant personnel intelligent et indispensable qui vous facilite la vie.</p>
        <p className="public-lead">ΣIRIUS fusionne vos données, vos outils métier et une IA contextuelle pour automatiser vos tâches et vous guider au quotidien. Vous donnez le cap, ΣIRIUS analyse, orchestre vos outils métier et exécute chaque action avec précision.</p>
        <p className="public-platforms">Disponible sur Windows, Android, iPhone, iPad et tablette.</p>
      </section>
      <section className="public-matrix" id="matrice-demo" aria-label="La matrice de ΣIRIUS">
        <h2 className="public-section-title">La matrice de ΣIRIUS</h2>
        <div className="public-core-preview">
          <div className="public-core-window" aria-label="Noyau ΣIRIUS" role="img">
            <div className="public-core-art">
              <img src="/holo/ring-gold.png" alt="" className="public-core-ring public-core-ring-outer" draggable={false} loading="lazy" />
              <img src="/holo/ring-gold.png" alt="" className="public-core-ring public-core-ring-inner" draggable={false} loading="lazy" />
              <div className="public-core-scan-band" aria-hidden="true" />
              <div className="public-core-heart" />
            </div>
          </div>
          <span><strong>La matrice de ΣIRIUS</strong> ΣIRIUS, le cœur réactif. Son interface matricielle holographique et son intelligence augmentée.</span>
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
      <section className="public-home-automation" aria-label="Domotique intelligente">
        <h2 className="public-section-title">DOMOTIQUE INTELLIGENTE</h2>
        <p>ΣIRIUS contrôle votre maison : lumières, volets, prises, capteurs, scènes.</p>
        <strong>Compatible Home Assistant.</strong>
      </section>
      <section className="public-plans" aria-label="Offres ΣIRIUS">
        <h2 className="public-section-title">Choisissez votre formule</h2>
        {PLANS.map((plan) => {
          const PlanIcon = plan.icon;
          return (
            <button key={plan.id} type="button" className={`public-plan public-plan-${plan.id} ${selected === plan.id ? "selected" : ""} ${plan.featured ? "featured" : ""}`} onClick={() => setSelected(plan.id)}>
              {plan.badge && <span className={`public-popular ${plan.id === "lifetime" ? "public-popular-alt" : ""}`}>{plan.badge}</span>}
              <span className="public-plan-icon" aria-hidden="true"><PlanIcon size={19} /></span>
              <span className="public-plan-name">{plan.name}</span>
              <span className="public-plan-tagline">{plan.tagline}</span>
              <span className="public-price"><strong>{plan.price} €</strong><small>{plan.suffix}</small></span>
              {plan.note && <span className="public-note">{plan.note}</span>}
              <span className="public-features">{plan.features.map((feature) => <span key={feature}><Check size={14} /> {feature}</span>)}</span>
              {plan.reassurance && (
                <span className="public-reassurance">
                  {plan.reassurance.map((line) => <span key={line}><ShieldCheck size={13} /> {line}</span>)}
                </span>
              )}
            </button>
          );
        })}
      </section>
      <form className="public-checkout" onSubmit={checkout}>
        <p className="public-checkout-secure"><ShieldCheck size={15} /> Paiement sécurisé Stripe</p>
        <h2 className="public-section-title">Commencer avec ΣIRIUS</h2>
        <label htmlFor="public-email">Votre adresse e-mail</label>
        <div className="public-form-row">
          <input id="public-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="vous@exemple.fr" />
          <button type="submit" disabled={busy}>{busy ? "Ouverture..." : "Commencer"} <ArrowRight size={17} /></button>
        </div>
        <label htmlFor="public-phone">Téléphone (optionnel)</label>
        <div className="public-form-row">
          <input id="public-phone" type="tel" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="06 12 34 56 78" />
          <a className="public-demo-link" href="#matrice-demo"><PlayCircle size={17} /> Voir une démo</a>
        </div>
        {error && <p className="public-error" role="alert">{error}</p>}
        <p className="public-legal">Vous serez redirigé vers Stripe. Aucun paiement réel en mode test. Aucun engagement.</p>
      </form>
      {paymentSucceeded && checkoutSessionId && <section className="public-subscription-success">
        <strong>Paiement confirmé.</strong>
        <span>Gérez ou résiliez votre abonnement depuis le portail Stripe sécurisé.</span>
        <button type="button" onClick={manageSubscription} disabled={portalBusy}>{portalBusy ? "Ouverture..." : "Gérer mon abonnement"}</button>
      </section>}
      <section className="public-hud-preview" aria-label="Capture d'écran du HUD ΣIRIUS">
        <h2 className="public-section-title">Le HUD ΣIRIUS en situation</h2>
        <div className="hud-preview">
          <img src="/hud-preview.png" alt="HUD ΣIRIUS" loading="lazy" />
        </div>
      </section>
      <section className="public-trust" aria-label="Confiance">
        <h2>Ils utilisent ΣIRIUS</h2>
        <p className="public-trust-platforms">Windows · Android · iOS · Tablette</p>
        <div className="public-testimonials">
          {[1, 2, 3].map((slot) => (
            <blockquote key={slot} className="public-testimonial">
              <p>« Témoignage client à venir. »</p>
              <cite>Client ΣIRIUS</cite>
            </blockquote>
          ))}
        </div>
        <div className="public-why">
          <h3>Pourquoi ΣIRIUS est différent ?</h3>
          <ul>
            {WHY_DIFFERENT.map((point) => <li key={point}><Check size={14} /> {point}</li>)}
          </ul>
        </div>
      </section>
      <footer className="public-footer">
        <p className="public-slogan">ΣIRIUS. Le travail, automatisé.</p>
        © 2026 ΣIRIUS par Daniel Partel · <a href="/mentions-legales">Mentions légales</a> · <a href="/conditions-generales">Conditions générales</a> · <a href="/confidentialite">Confidentialité</a>
      </footer>
    </main>
  );
}

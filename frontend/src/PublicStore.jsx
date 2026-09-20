import { useState } from "react";
import { Check, ShieldCheck, Sparkles, ArrowRight } from "lucide-react";
import "./PublicStore.css";

const API = `${process.env.REACT_APP_BACKEND_URL || "https://api.sirius-assistant.fr"}/api`;

const PLANS = [
  { id: "monthly", name: "Abonnement Entreprise", price: "35", suffix: "/ mois", note: "7 jours d'essai gratuit", featured: true, features: ["Fiches clients centralisées, zéro tableur", "Relances de facturation envoyées seules", "Stocks à jour à la seconde près", "Dictez la réponse, ΣIRIUS envoie le mail", "Un service cloud entièrement personnalisable", "Module complet de gestion comptable"] },
  { id: "standard", name: "Standard", price: "79", suffix: " unique", features: ["À vous, pour toujours — aucun renouvellement", "Un HUD digne d'un poste de commandement", "L'essentiel, sans superflu"] },
  { id: "pro", name: "Pro", price: "149", suffix: " unique", features: ["Les modules que vos concurrents n'ont pas", "HACCP et productivité pilotés d'une voix", "Une ligne directe vers le support"] },
  { id: "lifetime", name: "Lifetime", price: "299", suffix: " unique", features: ["Payez une fois, gardez ΣIRIUS à vie", "Chaque futur module, déjà inclus", "Le sommet de la gamme, sans compromis"] },
];

export default function PublicStore() {
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState("monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const checkout = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`${API}/public/license-checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), tier: selected, origin_url: window.location.origin }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.checkout_url) throw new Error(data.detail || "Impossible d'ouvrir le paiement.");
      window.location.assign(data.checkout_url);
    } catch (cause) {
      setError(cause.message || "Le paiement est momentanément indisponible.");
      setBusy(false);
    }
  };

  return (
    <main className="public-store">
      <header className="public-nav">
        <a className="public-brand" href="/"><span className="public-brand-gold">ΣIRIUS</span><span>.</span></a>
        <span className="public-secure"><ShieldCheck size={15} /> Paiement sécurisé Stripe</span>
      </header>
      <section className="public-hero">
        <p className="public-kicker"><Sparkles size={14} /> <span className="public-kicker-gold">ΣIRIUS</span> — ASSISTANT PROFESSIONNEL NUMÉRIQUE INTELLIGENT ET AUTONOME</p>
        <h1>Votre espace de travail<br /><em>prend vie.</em></h1>
        <p className="public-lead">ΣIRIUS fusionne vos données, vos outils métier et une IA contextuelle pour automatiser vos tâches et vous guider au quotidien. Vous donnez le cap, ΣIRIUS analyse, orchestre vos outils métier et exécute chaque action avec précision.</p>
        <p className="public-platforms">Disponible sur Windows, Android, iPhone, iPad et tablette.</p>
      </section>
      <section className="public-plans" aria-label="Offres ΣIRIUS">
        {PLANS.map((plan) => (
          <button key={plan.id} type="button" className={`public-plan ${selected === plan.id ? "selected" : ""} ${plan.featured ? "featured" : ""}`} onClick={() => setSelected(plan.id)}>
            {plan.featured && <span className="public-popular">LE PLUS CHOISI</span>}
            <span className="public-plan-name">{plan.name}</span>
            <span className="public-price"><strong>{plan.price} €</strong><small>{plan.suffix}</small></span>
            {plan.note && <span className="public-note">{plan.note}</span>}
            <span className="public-features">{plan.features.map((feature) => <span key={feature}><Check size={14} /> {feature}</span>)}</span>
          </button>
        ))}
      </section>
      <form className="public-checkout" onSubmit={checkout}>
        <label htmlFor="public-email">Votre adresse e-mail</label>
        <div className="public-form-row">
          <input id="public-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="vous@exemple.fr" />
          <button type="submit" disabled={busy}>{busy ? "Ouverture..." : "Commencer"} <ArrowRight size={17} /></button>
        </div>
        {error && <p className="public-error" role="alert">{error}</p>}
        <p className="public-legal">Vous serez redirigé vers Stripe. Aucun paiement réel en mode test.</p>
      </form>
      <footer className="public-footer">© 2026 ΣIRIUS par Daniel Partel · Licence et confidentialité</footer>
    </main>
  );
}

import "./PublicLegal.css";
import privacyPolicy from "./privacyPolicy.json";

const CONTACT_EMAIL = "danielsirius.pro2026@gmail.com";

const CONTENT = {
  "/mentions-legales": {
    title: "Mentions légales",
    sections: [
      ["Éditeur", "Le site ΣIRIUS est édité par Daniel Partel. Adresse de contact : " + CONTACT_EMAIL + "."],
      ["Hébergement", "Le site public est hébergé par Render Services, Inc. Les paiements sont traités par Stripe selon leurs propres conditions de sécurité et de confidentialité."],
      ["Propriété intellectuelle", "ΣIRIUS, ses interfaces, modules, contenus et code sont protégés. Toute reproduction, décompilation, redistribution ou revente non autorisée est interdite."],
      ["Informations à compléter avant vente réelle", "Ajoutez ici votre adresse professionnelle, votre statut juridique et votre numéro SIREN ou SIRET, ainsi que le numéro de TVA intracommunautaire lorsqu'il est applicable."],
    ],
  },
  "/conditions-generales": {
    title: "Conditions générales de vente",
    sections: [
      ["Offres et paiement", "Les tarifs et fonctionnalités affichés sur la boutique constituent les offres en vigueur. Le paiement est réalisé de manière sécurisée via Stripe."],
      ["Abonnement Entreprise", "L'abonnement est mensuel après la période d'essai affichée lors de la commande. Sa gestion et sa résiliation sont accessibles depuis le portail client Stripe."],
      ["Résiliation et facturation en cours", "La résiliation peut être demandée à tout moment depuis le portail Stripe. La date d'effet, le maintien de l'accès et l'éventuel calcul au prorata du mois en cours sont appliqués selon la configuration Stripe du service et le droit applicable ; ils sont indiqués au client avant confirmation."],
      ["Licences à paiement unique", "Les offres Standard, Pro et Lifetime sont facturées une seule fois. Elles donnent accès aux fonctions indiquées au moment de l'achat, selon les limites de la licence."],
      ["Droit de rétractation", "Pour un contenu ou service numérique fourni avant la fin du délai légal, le client est invité à donner son accord exprès au démarrage immédiat et à reconnaître la perte éventuelle de son droit de rétractation, selon le cadre légal applicable."],
      ["Limites du service", "ΣIRIUS est un outil d'assistance. Les fonctions de suivi comptable, de gestion et de conformité ne remplacent pas un expert-comptable, une obligation déclarative, un conseil juridique ou une validation réglementaire."],
    ],
  },
  "/confidentialite": privacyPolicy,
};

export default function PublicLegal() {
  const page = CONTENT[window.location.pathname] || CONTENT["/mentions-legales"];
  return <main className="public-legal-page">
    <header className="public-legal-nav"><a href="/">ΣIRIUS<span>.</span></a><a href="/">Retour à la boutique</a></header>
    <article className="public-legal-content">
      <p>ΣIRIUS</p>
      <h1>{page.title}</h1>
      {page.sections.map(([heading, text]) => <section key={heading}><h2>{heading}</h2><p>{text}</p></section>)}
      <p className="public-legal-updated">Dernière mise à jour : {page.updated || "20 septembre 2026"}.</p>
    </article>
  </main>;
}
import { useState } from "react";
import { AuthScreen } from "./AuthGate";
import "./PublicAccount.css";

export default function PublicAccount() {
  const [user, setUser] = useState(null);
  return (
    <main className="public-account">
      <a className="public-account-back" href="/">← Retour à la boutique</a>
      <p className="public-account-notice">
        Créer un compte est gratuit et ne nécessite aucun paiement.
        La création du compte ne vaut pas achat ni activation d’un abonnement.
        Utilisez ce même compte dans l’application SIRIUS.
      </p>
      {user ? (
        <section className="public-account-success" aria-labelledby="public-account-title">
          <h1 id="public-account-title">Votre compte SIRIUS est prêt</h1>
          <p role="status">Connexion réussie{user.name ? `, ${user.name}` : ""}.</p>
          <p>Connectez-vous dans l’application avec la même adresse e-mail et le même mot de passe.
            Les fonctions disponibles dépendent de vos droits d’accès.</p>
          <a href="/#essayer">Télécharger l’application</a>
          <p>Aucun achat ni abonnement n’a été déclenché sur cette page.</p>
        </section>
      ) : <AuthScreen onAuth={setUser} accountOnly />}
    </main>
  );
}

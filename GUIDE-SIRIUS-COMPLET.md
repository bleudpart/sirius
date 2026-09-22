..# ΣIRIUS Assistant - guide complet

## Adresses officielles

- Boutique : https://sirius-assistant.fr
- Boutique avec www : https://www.sirius-assistant.fr
- API : https://api.sirius-assistant.fr
- Etat de l'API : https://api.sirius-assistant.fr/health

## Grille tarifaire

| Offre | Prix | Paiement | Comprend |
|---|---:|---|---|
| Abonnement | 35 EUR / mois | Recurrent | HUD complet, mises a jour, memoire et proactivite |
| Standard | 79 EUR | Unique | Licence permanente, HUD professionnel, modules essentiels |
| Pro | 149 EUR | Unique | Modules metiers avances, productivite, HACCP, support prioritaire |
| Lifetime | 299 EUR | Unique | Acces a vie, toutes les fonctions Pro, evolutions futures |

L'Abonnement propose 7 jours d'essai gratuit avant la facturation mensuelle,
selon la configuration Stripe active. Les paiements publics passent par Stripe.

## Connexion locale

L'adresse locale actuellement configuree est :

    danielpartel@hotmail.com

Le mot de passe ne doit pas etre inscrit dans ce document ni partage par
message. La connexion administrateur est reservee a la machine locale.

Pour definir ou modifier le mot de passe, ouvrir ΣIRIUS localement, saisir
l'adresse ci-dessus, cliquer sur « Mot de passe oublie ? », choisir un mot de
passe d'au moins 8 caracteres, puis se reconnecter.

L'adresse utilisee pour acheter une licence peut etre differente de cette
adresse administrateur.

## Acheter une licence

1. Ouvrir https://sirius-assistant.fr.
2. Selectionner une offre.
3. Saisir l'adresse e-mail qui recevra la licence.
4. Cliquer sur « Commencer ».
5. Completer le paiement dans Stripe.
6. Conserver l'adresse e-mail utilisee et la confirmation de paiement.

Pour les tests Stripe, utiliser la carte `4242 4242 4242 4242`, une date future
et n'importe quel CVC. Cette carte ne doit jamais etre utilisee en production.

## Installer sous Windows

Le paquet de developpement contient les sources, mais aucun installateur EXE
n'est present dans cette archive. Pour generer l'installateur :

1. Installer Node.js 18 ou plus recent et Python 3.10 ou plus recent.
2. Ouvrir `CREER-INSTALLATEUR-SIRIUS.bat` a la racine du projet.
3. Attendre la fin de la compilation.
4. Ouvrir `frontend\\dist`.
5. Lancer l'installateur ΣIRIUS genere.
6. Autoriser le microphone au premier demarrage.

L'application installee lance son backend local sur `127.0.0.1:8001`. Aucun
serveur Python, Node.js ou MongoDB n'est necessaire pour l'utilisateur final.

## Mode developpeur

Backend :

    cd backend
    pip install -r requirements-local.txt
    uvicorn server:app --host 127.0.0.1 --port 8001 --no-proxy-headers

Frontend, dans un autre terminal :

    cd frontend
    npm install
    npm start

Le HUD est alors disponible sur http://localhost:3000. Chrome ou Edge sont
recommandes pour la reconnaissance vocale.

## Connexions externes

### Microsoft / Outlook

Dire « Connecte Outlook » dans ΣIRIUS, cliquer sur la connexion Microsoft,
s'authentifier, puis accepter les autorisations. Cette connexion permet les
e-mails, le calendrier et les contacts selon les droits accordes.

### Google / Gmail

Dire « Connecte Google », s'authentifier dans Google et accepter les droits
Gmail et Agenda. Tester ensuite avec « Lis mes derniers e-mails ».

### Spotify

Ouvrir le module Spotify, s'authentifier et autoriser l'acces. Tester ensuite
avec « Quelle musique est en cours ? ».

Chaque service utilise son propre compte et son propre mot de passe.

## Verification rapide

1. La boutique doit afficher les quatre offres.
2. Le formulaire doit ouvrir Stripe.
3. L'API doit repondre avec `status: ok`.
4. L'etat MongoDB doit afficher `mongo: ok`.
5. Le paiement test doit apparaitre dans Stripe en mode Test.

## Securite

Ne jamais partager ni committer les cles Render, Stripe, MongoDB Atlas,
GitHub, Google, Microsoft ou Spotify. Les fichiers `.env`, les mots de passe,
les tokens et les donnees clients sont volontairement exclus du paquet.

Le paquet ne contient pas les secrets de production et ne constitue pas une
licence client signee. Le contrat fourni doit etre complete avec le nom du
client, la ville, la date, le nombre de postes et les signatures.

## Fonctionnalites principales

- Assistant vocal avec HUD ΣIRIUS
- Memoire locale et proactivite
- HACCP et outils metiers
- THÉMIS pour devis, factures et suivi financier
- Outlook, Gmail, calendrier et contacts
- Spotify et modules multimedia
- Plans 2D/3D, fichiers, notes, taches et rapports
- Modules PANTHEON, NEXUS, ORACLE, SIRIUS PRIME et ZEUS CORTEX

Voir `README.md`, `INSTALL-SIRIUS.md` et `MODULES_SIRIUS.txt` pour les details
techniques et la liste des modules.
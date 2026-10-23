# SIRIUS : WhatsApp Cloud API et Google Workspace

## Statut et décisions

Boilerplate backend intégré et testé avec transports simulés. Aucune application
Meta/Google créée, aucun webhook enregistré, aucun compte connecté ni message
réel envoyé par l'installation du code. Il reste une recette réelle sur un
service HTTPS avant activation. Aucun nouvel écran de gestion n'est livré :
les routes authentifiées ci-dessous sont les points de branchement pour un HUD.

Choix retenu : **réception et synchronisation en lecture ; tout envoi WhatsApp,
Gmail ou création Calendar de cette intégration exige un aperçu puis une
confirmation explicite dans SIRIUS**. Un message reçu n'est jamais une
autorisation d'agir. Aucun agent IA n'analyse ou n'exécute son contenu.

Les fonctionnalités Gmail/Calendar déjà utilisées dans l'application restent
disponibles. La nouvelle barrière aperçu/confirmation concerne ce connecteur,
pas un verrou global ajouté rétroactivement aux anciennes routes d'envoi.

## Architecture et frontières de confiance

```text
WhatsApp utilisateur → numéro professionnel Meta configuré
  → GET vérification du webhook (verify token)
  → POST notification, signature HMAC SHA-256 sur les octets bruts
       → WABA + phone_number_id attendus uniquement
       → expéditeur prouvé par code à usage unique émis dans SIRIUS
       → boîte persistante du compte lié, message ID dédupliqué
       → aucun appel IA, téléchargement média ni exécution

SIRIUS → OAuth Google existant, state serveur + PKCE S256
  → jetons chiffrés au repos, renouvellement partagé
  → lecture Gmail INBOX / Calendar principal
       → instantané borné, consultable par le seul compte

Google Calendar → channel ID + token secret + resource ID
Gmail → Cloud Pub/Sub push, JWT OIDC Google vérifié + subscription exacte
  → marqueur dirty, aucune donnée entrante exécutée
  → boucle de lecture, instantané remplacé après succès complet

Utilisateur authentifié SIRIUS
  → prépare un contenu exact (réponse WhatsApp / e-mail / événement)
  → aperçu + empreinte + échéance 10 minutes
  → confirme la même empreinte
  → revalidation compte/licence/connexion/destinataire
  → claim atomique PREVIEW → EXECUTING → SUCCEEDED ou UNCERTAIN
```

Code :
- [OAuth et routes Google existants](../../backend/google_calendar.py).
- [Stockage et renouvellement des jetons partagés](../../backend/google_connection.py).
- [Synchronisation et notifications Workspace](../../backend/workspace_channels.py).
- [WhatsApp, préparations, confirmations et routes](../../backend/messaging_integrations.py).
- [Tests locaux](../../backend/tests/test_messaging_integrations.py).

Les collections MongoDB ou le docstore SQLite local existant sont réutilisés.
Un déploiement mono-processus est conseillé pour ce socle : les écritures
externes sont protégées par CAS, mais le worker de synchronisation n'est pas un
système de jobs distribué à haute disponibilité. Pas de promesse exactly-once
fournisseur ni de latence garantie.

## 1. Configurer WhatsApp Cloud API

Dans Meta for Developers, configurer une application professionnelle autorisée,
un WABA et un numéro Cloud API. Utiliser un access token adapté à la production,
avec les permissions de messagerie WhatsApp nécessaires et accès à ce numéro.
Le secret de l'application signe les webhooks ; ce n'est pas l'access token.
Consulter les politiques Meta de consentement, de tarification et de templates.

Le modèle [backend/.env.example](../../backend/.env.example) contient :

```dotenv
SIRIUS_WHATSAPP_ENABLED=0
META_APP_SECRET=
META_WEBHOOK_VERIFY_TOKEN=
META_WABA_ID=
META_PHONE_NUMBER_ID=
META_ACCESS_TOKEN=
META_GRAPH_VERSION=
```

Ne passer `SIRIUS_WHATSAPP_ENABLED` à `1` qu'après configuration. Secret et verify
token : 32 caractères minimum. Choisir explicitement une version Graph encore
supportée par l'application (forme `vNN.0`), sans version codée en dur en production.
Stocker ces secrets dans l'environnement serveur, jamais dans le frontend.

URL de callback publique HTTPS :
`/api/integrations/whatsapp/webhook`, champ Meta `messages`.

- GET : `hub.mode=subscribe`, `hub.verify_token`, renvoi texte de `hub.challenge`.
- POST : `X-Hub-Signature-256=sha256=<HMAC des octets bruts>`, comparaison en
  temps constant ; 401 si signature incorrecte, 413 au-delà de 256 Kio.
- Vérifie `object`, WABA et numéro métier ; ignore les autres périmètres.
- Les événements `statuses` sont acquittés mais ne sont pas utilisés comme
  preuve de livraison : `SUCCEEDED` signifie **accepté avec ID fournisseur**,
  pas lu ni livré au destinataire.
- Texte de 4 000 caractères maximum. Médias : seule l'existence et le type du
  message sont notés, pas téléchargés ni transcrits. Type non pris en charge
  visible dans l'inbox ; aucune réponse automatique de secours.
- Expéditeur inconnu : pas de conservation du texte, pas de réponse.
- Corps incorrect signé : 422, pas de faux succès ; Meta peut le représenter.

### Liaison d'un utilisateur

1. Dans une session SIRIUS valide, `POST /api/integrations/whatsapp/link`.
2. Le serveur retourne `SIRIUS LINK <code aléatoire>` valable cinq minutes.
3. L'utilisateur envoie ce texte, depuis son WhatsApp, au numéro professionnel.
4. Le webhook vérifié consomme atomiquement le code et lie le **vrai `from`
   Meta** au `user_id` ayant demandé le code.
5. Consulter `GET /api/integrations/whatsapp/inbox` pour vérifier la liaison.

Ce mécanisme prouve le contrôle du compte WhatsApp, pas une identité civile.
Le code est un secret : ne pas le partager. Une nouvelle demande remplace le
code précédent. Cinq numéros maximum par compte ; admission non conçue comme
quota distribué strict. Un numéro déjà lié à un autre compte ne peut pas être
réaffecté par un nouveau code. Le propriétaire précédent doit d'abord délier.
Les refus sont journalisés sans numéro ni code.

Un seul WABA/numéro professionnel est configuré par déploiement. Les utilisateurs
SIRIUS sont routés par leur propre numéro prouvé. Ce n'est pas une plateforme
multi-WABA où chaque client apporte les tokens de son entreprise.

Seuls les messages datés après la liaison sont retenus : les timestamps Meta
étant à la seconde, un texte envoyé immédiatement dans la même seconde que la
liaison peut être ignoré par précaution. Attendre la liaison affichée avant
d'envoyer le premier texte. Les IDs Meta servent d'anti-doublon persistant.

`DELETE /api/integrations/whatsapp/link` retire les liaisons et codes du compte,
pas l'historique. Les anciennes préparations ne peuvent plus être confirmées.
Une nouvelle liaison a une nouvelle génération ; aucun ancien aperçu n'est
réactivé. Aucun webhook ne choisit lui-même un `user_id`.

### Réponse WhatsApp

`POST /api/integrations/whatsapp/replies/preview` :

```json
{
  "request_id": "00000000-0000-4000-8000-000000000001",
  "message_id": "wamid.ID_D_UN_MESSAGE_RECU",
  "text": "Réponse à relire puis confirmer."
}
```

Le destinataire est dérivé du message possédé par le compte et de la liaison,
pas d'un numéro libre fourni par l'appelant. La fenêtre Meta de 24 heures est
vérifiée à la préparation ET à l'exécution d'après le dernier message reçu.
Hors fenêtre : 409, aucun template ni paiement contournant la restriction.
Il faudrait un autre parcours de consentement et de confirmation pour les
templates approuvés ; il n'est pas implémenté.

## 2. Google OAuth 2.0 et jetons

Réutilise les credentials Google existants :
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.
Activer Gmail et Calendar APIs dans le projet, configurer l'écran de consentement
et enregistrer exactement l'URI de retour, par exemple
`https://VOTRE-SERVICE/api/oauth/calendar/callback`.

- Login existant : `GET /api/oauth/calendar/login`.
- Option de moindre privilège : `?workspace_readonly=true` demande seulement
  `calendar.events.readonly`, `gmail.readonly` et `userinfo.email`.
- Le mode existant par défaut conserve ses droits Calendar/Gmail/envoi/contacts
  pour ne pas casser le HUD. Les fonctions de ce nouveau connecteur vérifient
  le scope effectivement accordé ; un compte lecture seule ne peut pas envoyer.
- `state` opaque lié au compte et à expiration dix minutes, consommé une fois.
- PKCE `S256`, verifier conservé côté serveur ; URI de retour figée dans le state.
- Callback vérifie que le compte existe encore et n'est pas désactivé avant
  l'échange. La liaison locale historique, si utilisée, reste celle du système
  existant ; les nouvelles routes Workspace exigent un vrai compte authentifié.
- Refresh/access tokens chiffrés par Fernet, clé dérivée du secret serveur stable
  `SIRIUS_AUTH_SECRET` et d'un contexte propre à Google.
- Les anciennes lignes en clair sont lues pour compatibilité, puis migrées au
  prochain accès au jeton. Une reconnexion écrit directement au format chiffré.
  Les sauvegardes anciennes peuvent encore contenir des tokens en clair.
- Le refresh est partagé avec les anciennes routes Google ; conserve le refresh
  token si Google ne le renouvelle pas. Un compte déconnecté/reconnecté pendant
  le refresh n'est pas restauré par une ancienne réponse réseau.
- Rotation/perte du secret serveur : reconnecter Google, pas de déchiffrement
  silencieux ni nouveau compte inventé.
- La déconnexion existante `POST /api/calendar/disconnect` supprime les credentials
  locaux ; ce n'est pas une révocation distante Google de toutes les permissions.

Gmail en lecture est un scope restreint : selon la distribution et les données
traitées, Google peut exiger validation OAuth et évaluation de sécurité. Le
statut Testing, les test users et l'expiration des refresh tokens doivent être
vérifiés dans le projet réel. Aucune délégation de domaine/service account donnant
accès à toutes les boîtes de l'entreprise : chaque personne connecte son compte.

## 3. Synchronisation Google : contrat borné

`POST /api/integrations/workspace/{gmail|calendar}/sync` est une lecture explicite.
`GET .../{gmail|calendar}/snapshot` restitue seulement le snapshot de la
connexion courante du compte.

- Calendar principal : jusqu'à 50 événements sur les 30 prochains jours.
  ID, titre, début, fin, statut ; pas de participants, description ni pièces jointes.
- Gmail INBOX : jusqu'à 20 messages, métadonnées From/Subject/Date, labels,
  identifiants et date interne ; pas de corps, snippet ni pièces jointes.
- `truncated=true` si Google annonce une page suivante ; aucune troncature
  présentée comme une synchronisation complète.
- Remplacement du snapshot entier seulement si toutes les lectures réussissent.
  Les éléments supprimés/sortis de la fenêtre disparaissent au snapshot suivant.
- Les snapshots sont des données non fiables à afficher comme du texte, jamais
  comme instructions, HTML exécutable ou commandes pour un agent.

Il s'agit d'une **vue récente synchronisée**, pas d'une réplication complète.
Pas de parcours de toutes les pages, de `history.list`, de `syncToken` Calendar
ou de détection exhaustive des tombstones dans ce boilerplate. Pour évoluer :
implémenter un journal paginé avec checkpoint atomique, resynchronisation
complète après 404 history/410 syncToken, et une politique de conservation.

### Calendar push

Renseigner `SIRIUS_CALENDAR_PUSH_URL` avec l'URL HTTPS publique exacte
`/api/integrations/workspace/calendar/webhook`.
`POST /api/integrations/workspace/calendar/watch` crée explicitement le watch.

Canal préenregistré STARTING avant l'appel Google pour recevoir le `sync` initial.
UUID de canal, token aléatoire haché au repos, ressource fournie par Google,
expiration effective retournée par Google. Demande une journée de validité.
Le callback vérifie ID, secret, resource ID lorsqu'il est connu, état et expiration.
Le premier `sync` peut précéder la réponse watch ; le secret reste obligatoire.
Pas de `user_id` dans l'URL publique ni dans le secret.

### Gmail push / Cloud Pub/Sub

Préparer le topic et la subscription push dans le projet Google Cloud :

- Donner le rôle Publisher sur le topic à
  `gmail-api-push@system.gserviceaccount.com`.
- Configurer une subscription push **authentifiée OIDC**, avec un service account
  dédié et l'audience exacte du callback. Configurer les droits Pub/Sub/Token
  Creator conformément à la documentation Google, sans clé privée dans SIRIUS.
- `SIRIUS_GMAIL_PUSH_AUDIENCE` : audience HTTPS exacte, habituellement l'URL
  `/api/integrations/workspace/gmail/webhook`.
- `SIRIUS_GMAIL_PUSH_SERVICE_ACCOUNT` : adresse e-mail du service account attendu.
- `SIRIUS_GMAIL_PUBSUB_TOPIC` : `projects/PROJET/topics/TOPIC`.
- `SIRIUS_GMAIL_PUBSUB_SUBSCRIPTION` : `projects/PROJET/subscriptions/SUBSCRIPTION`.

`POST /api/integrations/workspace/gmail/watch` active Gmail watch INBOX.
Le callback valide le JWT RS256 avec les clés publiques Google à URL fixe :
signature, issuer, audience, expiration, iat, e-mail du service account et
`email_verified=true`. La JWKS est mise en cache par PyJWT ; aucune clé
indiquée par une URL dans le JWT n'est chargée. La subscription du corps est
également comparée à la valeur configurée.

Le couple e-mail/historyId reçu est seulement un **signal de changement** :
il marque les watches enregistrés de cette boîte comme dirty. La lecture réelle
est faite avec le token de chaque compte légitimement connecté à cette boîte.
Un même compte Google connecté volontairement à deux comptes SIRIUS peut donc
rafraîchir les deux snapshots, sans partager leurs identifiants SIRIUS.

### Worker et renouvellement

Boucle toutes les 30 secondes hors durée des traitements, 50 watches maximum
par tour. Toute notification incrémente une révision : une notification arrivée
pendant une lecture ne doit pas être effacée par sa fin. Aucun corps de webhook
ne déclenche un envoi. Trois échecs de lecture consécutifs maximum, puis FAILED
visible ; pas de relance infinie silencieuse. Les callbacks authentiques sont
coalescés et réinitialisent le budget de lecture tant que le watch est ACTIVE.

`GET /api/integrations/workspace/watches` : états, erreurs, expirations, sans secret.
`DELETE .../watches/{id}` désactive **localement** le traitement ; retourne
`remote_stop=false`. Aucun appel distant `channels.stop` ou Gmail `stop` n'est
implémenté ici : Google peut notifier jusqu'à l'expiration, mais SIRIUS ne
traite plus ce watch. Supprimer les permissions dans Google si nécessaire.

Le renouvellement est **explicite**, pas automatique : désactiver l'ancien watch,
puis en créer un nouveau et surveiller son expiration. Gmail impose un
renouvellement au moins tous les sept jours et recommande quotidiennement.
Une création interrompue reste UNCERTAIN ; vérifier côté fournisseur avant de
recréer, aucune nouvelle demande distante en boucle.

## 4. Actions sécurisées par compte

Toutes ces routes exigent la session SIRIUS existante ; les clés Zapier ne sont
pas acceptées. L'identité provient de la session serveur, pas du corps JSON.
Compte désactivé ou licence/essai indisponible : exécution refusée.

### Préparer un e-mail

`POST /api/integrations/workspace/gmail/preview` :

```json
{
  "request_id": "00000000-0000-4000-8000-000000000002",
  "to": "destinataire@example.com",
  "subject": "Point de suivi",
  "body": "Bonjour, voici le point à confirmer."
}
```

Une adresse simple uniquement, pas de CC/BCC/listes ni injection d'en-têtes.
Texte brut et signature personnelle SIRIUS existante incluse dans l'aperçu.
Contrairement au composeur mail historique, ce parcours n'ajoute pas de logo
HTML caché : ce qui est confirmé est le texte effectivement envoyé.

### Préparer un événement

`POST /api/integrations/workspace/calendar/preview` :

```json
{
  "request_id": "00000000-0000-4000-8000-000000000003",
  "title": "Point de suivi",
  "start": "2026-11-02T10:00:00+01:00",
  "end": "2026-11-02T11:00:00+01:00",
  "description": "Ordre du jour à relire."
}
```

Dates avec fuseau obligatoire, durée positive de sept jours maximum. Calendrier
principal uniquement, aucun invité ni invitation e-mail (`sendUpdates=none`).
Pas de suppression, modification ou récurrence dans ce parcours.

### Confirmer et suivre

Chaque préparation retourne contenu, ID, empreinte, échéance et état PREVIEW.
Même UUID + mêmes paramètres : même préparation ; paramètres différents : 409.
Utiliser un UUID différent par nouvelle opération, conserver le même pour
relire une opération existante. Refaire un aperçu expiré exige un nouvel UUID.

Le client doit afficher **tout le payload**, le compte Google utilisé ou le
numéro WhatsApp destinataire et demander une confirmation humaine ; il ne doit
pas appeler automatiquement la route confirm en recevant un webhook.

`POST /api/integrations/actions/{id}/confirm` :

```json
{"confirm": true, "fingerprint": "EMPREINTE_SHA256_RETOURNEE_PAR_L_APERCU"}
```

`GET /api/integrations/actions` liste les 50 dernières préparations du compte.

- Revalidation du propriétaire, de la liaison/connexion courante, du scope,
  de l'empreinte recomputée et de l'expiration avant le claim.
- Changement de compte Google/numéro métier ou nouvelle génération de liaison :
  refaire l'aperçu. Une proposition issue d'un autre compte est 404.
- Une seule tentative HTTP par préparation, sans redirection ni retry externe.
- Un timeout, refus HTTP ou retour illisible après le claim devient UNCERTAIN.
  Vérifier Gmail/Calendar/Meta avant de créer une nouvelle préparation.
- Un arrêt du processus en EXECUTING reste visible et ne se relance pas.
  Ce socle ne réconcilie pas automatiquement les opérations incertaines.
- SUCCEEDED avec ID fournisseur est relisible sans nouvel envoi. Cela ne
  garantit pas la livraison d'un e-mail ou d'un message WhatsApp.
- Calendar reçoit un ID déterministe supplémentaire ; Gmail et WhatsApp n'ont
  pas ici de garantie fournisseur exactly-once. Créer un nouvel UUID après un
  résultat incertain peut réellement créer un doublon.

## 5. Confidentialité et exploitation

Collections personnelles : liaisons/codes WhatsApp, messages, préparations,
watches et snapshots. Export du compte inclut les données métier et états,
pas les codes de liaison, hashes des secrets de canal ni tokens Google.
Effacement du compte couvre ces collections et les credentials Google existants.
Les anciennes sauvegardes, les copies Meta/Google et les messages déjà envoyés
ne sont pas effacés par cette opération.

Déconnecter n'est pas effacer : l'historique WhatsApp, les anciens snapshots et
les préparations restent jusqu'à l'effacement du compte. L'inbox est limitée
à 50 éléments par réponse, pas en rétention. Prévoir quotas, rétention et
suppression granulaire avant généralisation. Les snapshots Gmail contiennent
des données personnelles même sans corps de message.

Ne pas journaliser les corps, signatures, codes, URL OAuth complètes ou tokens.
Sécuriser le reverse proxy : HTTPS, taille et débit des webhooks, pas de logs
de query string contenant le verify token Meta. Les endpoints publics sont
exemptés de la session SIRIUS mais vérifient leur propre preuve fournisseur.
Les corps sont bornés à 256 Kio (Calendar 4 Kio).

L'environnement serveur est la frontière de confiance : isoler les secrets
des différents déploiements et protéger les sauvegardes et `SIRIUS_AUTH_SECRET`.
Ne pas exposer un backend Electron local par un tunnel automatique.

## Tests et recette

```powershell
Set-Location backend
..\.venv\Scripts\python.exe -m pytest tests\test_messaging_integrations.py tests\test_connections_oauth_unit.py -q
```

Tests sans compte ni réseau réels : signature Meta, preuve de numéro, doublons,
isolation, refus des actions implicites, aperçu exact, état incertain sans retry,
PKCE/state OAuth, stockage chiffré, renouvellement, OIDC signé avec clés de test,
watches et synchronisation bornée, export et effacement.

Avant production : tester le numéro Meta de test, les comptes Google test users,
les callbacks HTTPS réels, l'audience/IAM Pub/Sub, les scopes effectivement
accordés, les expirations et l'arrêt des watches. Puis tester les trois actions
avec vos propres destinataires et vérifier dans les fournisseurs. Aucune de
ces opérations externes n'a été exécutée par les tests locaux.

## Références officielles

- [Meta messages webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages)
- [Google Gmail push et renouvellement](https://developers.google.com/workspace/gmail/api/guides/push)
- [Google Calendar push](https://developers.google.com/workspace/calendar/api/guides/push)
- [Cloud Pub/Sub authenticated push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

# SIRIUS : Skill Alexa personnalisée et Smart Life/Tuya

## État du livrable et périmètre

Socle exécutable et tests locaux, **pas une Skill publiée ou certifiée**. Aucun
compte Amazon/Tuya n'est créé, aucune clé réelle n'est fournie et aucun appareil
n'est découvert ou commandé par l'installation des sources. Le connecteur est
désactivé par défaut. La recette réelle reste à faire avec votre projet et une
lampe sans risque. Aucun engagement de gratuité ou de compatibilité universelle Tuya.

Deux Skills **distinctes**, deux liaisons OAuth et deux fonctions Lambda :

| Skill | Exemple | Autorisations |
|---|---|---|
| Personnalisée, `custom.handler` | « Alexa, ouvre sirius assistant », puis « mes dossiers » ou « dernière réunion » | `dossiers:read meetings:read` |
| Smart Home, `smart-home.handler` | « Alexa, allume Bureau », « règle Bureau à cinquante pour cent » | `home:read home:control`, plus sélection de chaque appareil dans SIRIUS |

Une Custom Skill utilise intents/slots et son nom d'invocation. Les commandes
natives Smart Home utilisent les directives v3, **pas** le modèle d'intents.
La liaison en lecture seule n'autorise jamais la domotique, et inversement.

Version initiale : lampes catégorie Tuya `dj` et prises `cz`, un seul
interrupteur booléen (`switch_led`, `switch_1` ou `switch`). Luminosité pour les
lampes compatibles `bright_value`/`bright_value_v2`, plage entière déclarée par Tuya,
échelle 0, min/max et pas validés. Les autres catégories et les prises multicanaux
sont refusées. La commande 0 % utilise le minimum de luminosité Tuya, **pas**
nécessairement l'extinction : « éteins » utilise PowerController.
Pas de couleurs, scènes, serrures, alarmes, chauffage, volets, robots ni scripts.
Ne sélectionner aucune prise reliée à un équipement dangereux ou critique
(chauffage, cuisson, matériel médical, sécurité, etc.).

Smart Life dispose déjà d'une Skill officielle pour des commandes simples sans
SIRIUS. Le présent connecteur est une autre voie, utile pour maîtriser la liste
exposée par SIRIUS ; activer les deux peut créer des doublons de noms dans Alexa.

## Architecture et frontières de confiance

```text
Alexa Custom -> Lambda ASK (vérification Skill ID)
                 -> HTTPS /api/integrations/alexa/{dossiers,meetings}
                      -> jeton opaque de lecture -> compte SIRIUS actif

Alexa Smart Home -> Lambda dédiée (trigger limité à la Skill Smart Home)
                      -> HTTPS /api/integrations/tuya/alexa/*
                           -> jeton opaque home -> compte/licence actifs
                           -> liaison opérateur SIRIUS UID / Tuya UID
                           -> liste d'appareils explicitement autorisés
                           -> HTTPS Tuya HMAC-SHA256 -> état observé

Application SIRIUS même origine -> OAuth authorize -> consentement explicite
  -> code court à usage unique -> token endpoint (client secret Basic)
  -> access token / refresh token dédiés, jamais le JWT de connexion SIRIUS
```

- [OAuth backend](../../backend/alexa_integration.py) : codes de consentement
  10 minutes, codes d'autorisation 2 minutes, état renvoyé à l'identique,
  redirections HTTPS exactes et préenregistrées, PKCE S256 si demandé.
- Access token opaque 10 minutes ; famille de refresh tokens 30 jours fixes,
  puis nouvelle liaison nécessaire. Rotation à chaque refresh, ancien refresh
  réutilisé = révocation de la famille. Deux refresh simultanés peuvent donc
  invalider la liaison : une erreur visible exige de la refaire, pas de réessai aveugle.
- Seules les empreintes SHA-256 des codes et jetons sont persistées. Les secrets
  clients restent dans l'environnement backend ; les Lambdas n'en ont pas besoin.
- Trente requêtes API par minute et par liaison, compte/licence revalidés.
  Gestion et révocation disponibles même après expiration de licence, avec
  session SIRIUS valide. Jusqu'à cinq liaisons actives par client et par compte.
- Les plafonds d'admission de liaisons/demandes simultanées ne constituent pas
  une limite distribuée transactionnelle stricte. Ajouter un rate limit à
  l'entrée HTTPS pour les endpoints OAuth publics avant une ouverture à grande échelle.
- Les jetons ne sont ni des identifiants Alexa `userId`, ni des clés Tuya.
  Une enceinte partagée peut lire les données et commander les appareils consentis.
  Aucun contrôle biométrique, PIN vocal, IA libre ou étape de confirmation
  supplémentaire n'est promis.
- Ni audio ni transcription Alexa ne transitent par SIRIUS. Amazon reçoit
  titres/synthèses demandés et noms/états des appareils ; Tuya reçoit les commandes.

## 1. Créer votre projet Tuya et relier Smart Life

1. Créer un compte sur [Tuya Developer Platform](https://platform.tuya.com/).
   Dans **Cloud > Development**, créer un projet compatible **Smart Home**.
   Vérifier les offres/services réellement disponibles dans votre console : les
   abonnements, essais, quotas et noms de menus peuvent évoluer.
2. Vérifier la région du compte dans Smart Life : **Moi > Réglages > Compte et
   sécurité > Région**. Choisir le centre de données Tuya correspondant, pas
   simplement celui le plus proche du serveur. Voir la
   [configuration de la région](https://developer.tuya.com/en/docs/iot/Platform_Configuration_smarthome?id=Kamcgamwoevrx).
3. Autoriser les services nécessaires pour le jeton projet, la liste des
   appareils par utilisateur, leurs spécifications, leurs états et les commandes.
   Selon l'offre, les catégories de services s'appellent notamment IoT Core et
   Authorization. **Ne pas supposer qu'un essai reste actif indéfiniment.**
4. Dans le projet, **Devices > Link Tuya App Account > Add App Account**.
   Scanner le QR code avec **votre propre application Smart Life**, confirmer
   dans l'application puis sélectionner les appareils à lier. La procédure
   officielle [Link Devices, méthode 3](https://developer.tuya.com/en/docs/iot/link-devices?id=Ka471nu1sfmkl)
   documente ce parcours ; le mot de passe Smart Life n'est jamais remis à SIRIUS.
5. Relever l'Access ID/Client ID, l'Access Secret et l'UID du compte lié, dans
   la console privée. **Ne pas les envoyer dans un chat ni les commiter.**
6. Avant activation, vérifier dans l'API Explorer Tuya la disponibilité effective
   de ces API pour votre projet et votre région :
   - `GET /v1.0/token?grant_type=1`
   - `GET /v1.0/users/{uid}/devices`
   - `GET /v1.0/devices/{device_id}/specifications`
   - `GET /v1.0/devices/{device_id}/status`
   - `POST /v1.0/devices/{device_id}/commands`
   Ce connecteur cible ces API Cloud v1.0 ; il ne remplace pas automatiquement
   une API retirée ou indisponible dans votre abonnement par une API différente.
7. L'opérateur vérifie hors bande que le compte SIRIUS et le compte Smart Life
   appartiennent à la même personne, puis définit le mapping serveur
   `SIRIUS_TUYA_USER_BINDINGS`. Le client ne peut pas s'autoattribuer un UID Tuya.
   Un UID Tuya ne peut être lié à deux comptes SIRIUS. Un projet cloud sert les
   comptes explicitement configurés ; un seul projet/région est actif par serveur.

Configuration backend, depuis [le modèle d'environnement](../../backend/.env.example) :

```dotenv
SIRIUS_TUYA_ENABLED=0
TUYA_CLIENT_ID=
TUYA_CLIENT_SECRET=
TUYA_REGION=eu
SIRIUS_TUYA_USER_BINDINGS={"identifiant-sirius-verifie":"uid-smart-life-verifie"}
```

Régions proposées : `eu` (Europe centrale), `eu-west` (Europe occidentale),
`us` (Amérique occidentale), `us-east` (Amérique orientale), `cn`, `in`, `sg`.
Les hôtes sont fermés dans [le connecteur](../../backend/tuya_integration.py) :
aucune URL utilisateur n'est acceptée. Si votre offre utilise un autre hôte,
ne contournez pas cette validation avec une URL arbitraire.

La signature Tuya porte sur la méthode, le hash du **corps exact**, le chemin et
sa query, le client, l'horodatage et le token pour les requêtes métier.
Référence : [Sign Request](https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g).
Le jeton projet reste en mémoire, caché jusqu'à 60 secondes avant expiration,
jamais envoyé à Amazon ou stocké dans les historiques.

## 2. Autoriser vos appareils, sans donner accès à toute la maison

Ces opérations se font avec la **session SIRIUS du propriétaire**, jamais avec
un token Alexa. Ce boilerplate expose une API et sa documentation OpenAPI ;
il n'ajoute pas encore d'écran de configuration Smart Life dans le HUD.
Utiliser un client API de confiance, authentifié sur le bon service, sans copier
de jetons dans un outil tiers.

| Méthode et chemin sous `/api/integrations/tuya` | Effet |
|---|---|
| `GET /devices` | Lampes/prises du seul UID Tuya lié, pas toutes les ressources du projet |
| `GET /selections` | 100 autorisations les plus récentes, y compris retirées, avec indicateur `truncated` |
| `POST /selections` | Validation capacités/possession et autorisation explicite d'un appareil |
| `DELETE /selections/{endpoint_id}` | Révocation propriétaire, même licence expirée |

Corps de sélection, avec **un ID obtenu dans la liste du compte** :

```json
{
  "device_id": "identifiant-lampe-tuya",
  "name": "Bureau",
  "confirm_noncritical": true
}
```

Cette déclaration signifie que l'utilisateur a vérifié que l'appareil n'est pas
critique ; le connecteur ne peut pas détecter ce qu'une prise alimente réellement.
Un `endpoint_id` opaque et stable est retourné. Cent appareils maximum, pas de
pagination implicite. Une liste fournisseur trop grande ou non conforme est
une erreur visible, pas une découverte partielle silencieuse.

Passer `SIRIUS_TUYA_ENABLED=1` seulement après configuration des comptes et essai
sur un appareil sans danger. Révoquer un appareil dans SIRIUS bloque aussitôt les
futures commandes, même si Alexa le conserve dans sa liste ; retirer également
le périphérique dans Alexa ou relancer sa découverte. Changer le mapping
compte/projet/région exige de sélectionner à nouveau les appareils.

## 3. OAuth 2.0 / Account Linking Amazon

Créer **deux applications Skills** dans Amazon Developer Console. Définir deux
clients et secrets distincts dans l'environnement backend :

```dotenv
SIRIUS_ALEXA_PUBLIC_ORIGIN=https://votre-domaine-sirius
SIRIUS_ALEXA_CLIENT_ID=sirius-alexa-custom
SIRIUS_ALEXA_CLIENT_SECRET=
SIRIUS_ALEXA_REDIRECT_URIS=
SIRIUS_ALEXA_HOME_CLIENT_ID=sirius-alexa-home
SIRIUS_ALEXA_HOME_CLIENT_SECRET=
SIRIUS_ALEXA_HOME_REDIRECT_URIS=
```

Secrets aléatoires indépendants d'au moins 32 caractères, réservés au backend
et à la configuration Account Linking Amazon. Les IDs ne doivent pas être
identiques. Chaque liste de redirect URIs doit contenir **exactement** les
adresses fournies par la console pour cette Skill, séparées par des virgules :
pas de wildcard, de query ni de fragment. Ne pas inventer ces URI.

Configurer pour chacune :

- Authorization Code Grant.
- Authorization URI :
  `https://votre-domaine-sirius/api/integrations/alexa/oauth/authorize`.
- Access Token URI :
  `https://votre-domaine-sirius/api/integrations/alexa/oauth/token`.
- Client ID et secret correspondant à cette Skill.
- Authentification client : **HTTP Basic**, pas credentials dans le corps.
- Scopes Custom : `dossiers:read` et `meetings:read`.
- Scopes Smart Home : `home:read` et `home:control`.
- Domaine/conditions/confidentialité adaptés à votre hébergement et aux règles
  Amazon, URL de politique de confidentialité publique réelle.

La page de consentement utilise les cookies de session SIRIUS : **la SPA et
`/api` doivent partager l'origine HTTPS publique configurée**. Une connexion
Electron sur `127.0.0.1`, ou dans un autre navigateur, ne connecte pas le
navigateur intégré Alexa. Ouvrir SIRIUS dans ce navigateur, se connecter,
revenir sur le consentement, vérifier le compte, puis autoriser les droits
affichés. S'il est impossible d'ouvrir ce parcours dans le navigateur Alexa,
la liaison doit rester bloquée ; pas de collecte de mot de passe de substitution.

Le reverse proxy doit préserver les query OAuth et l'en-tête `Authorization`
du token endpoint, ne pas mettre en cache les réponses et ne pas journaliser
codes, cookies, Bearer tokens ou secrets. Installer un certificat public valide.
Ne pas exposer directement le serveur de développement local à Internet.

API de gestion propriétaire :

- `GET /api/integrations/alexa/connections` : droits/état/expiration, sans hashes.
- `DELETE /api/integrations/alexa/connections/{id}` : révocation locale immédiate.
  Désactiver aussi la Skill dans Alexa. Pas de notification proactive de
  déliaison Amazon dans cette version ; l'appel suivant échoue sur le token.

## 4. Déployer les deux fonctions Lambda

Depuis ce dossier, Node.js 22 ou supérieur :

```powershell
npm ci --ignore-scripts
npm test
```

Créer deux fonctions avec un runtime Node.js AWS actuellement supporté,
mémoire et timeout adaptés (par exemple 256 Mo / 8 secondes), sans VPC privé
qui empêcherait l'accès HTTPS au backend.
Embarquer les sources et `node_modules` à la racine de chaque archive.

Variables Lambda :

```dotenv
SIRIUS_API_ORIGIN=https://votre-domaine-sirius
# Uniquement Lambda Custom :
SIRIUS_ALEXA_SKILL_ID=amzn1.ask.skill.identifiant-exact-custom
```

**Custom**

1. Handler `custom.handler`, trigger **Alexa Skills Kit** limité à l'identifiant
   exact de votre Skill. La vérification par le SDK est une protection additionnelle.
2. Dans la console, modèle **Custom**, locale fr-FR. Importer
   [models/fr-FR.json](./models/fr-FR.json), vérifier le nom d'invocation et
   construire le modèle. Amazon reste juge de son acceptation/certification.
3. Configurer l'ARN Lambda régional dans l'endpoint Custom.

**Smart Home**

1. Handler `smart-home.handler`, trigger **Alexa Smart Home**, avec la
   permission Lambda limitée à **l'identifiant exact de cette Skill**.
   Les directives Smart Home n'ont pas l'`applicationId` de la Custom Skill :
   l'identité de l'appel Amazon repose sur le trigger et sa politique de ressource
   restrictive, pas sur un champ fourni dans un JSON.
2. Modèle Smart Home v3, Account Linking obligatoire, ARN Lambda dans la région
   prise en charge pour vos utilisateurs. Pas d'import d'intents pour cette Skill.
3. Ne pas activer les événements proactifs ou les demandes d'autorisations
   d'envoi d'événements : pas de `AcceptGrant`, `ChangeReport` ou notification
   Discovery Add/Delete implémentés dans cette version.
4. Ne créer **aucune Lambda Function URL publique**, passerelle HTTP anonyme,
   permission d'invocation globale ou mécanisme de signature maison.
   Seul Alexa doit pouvoir invoquer ce handler en production.

Le SDK ASK officiel construit les réponses Custom ; le code échappe le texte
avant SSML, borne le contenu et utilise une carte `LinkAccount` si nécessaire.
Les erreurs réseau ne sont jamais présentées comme une lecture réussie.
Le transport HTTPS fixe l'origine, refuse les redirections, impose 6,5 secondes
et 96 Ko par réponse, et ne fait aucun retry.

### Variante HTTP auto-hébergée

Les endpoints FastAPI ci-dessus sont ceux de l'OAuth et de l'API SIRIUS ;
**ils ne sont pas un récepteur public de requêtes vocales Alexa**.
Pour remplacer Lambda Custom par un endpoint HTTPS, utiliser l'adaptateur
officiel ASK Express et sa vérification de certificat, chaîne de confiance,
signature sur le corps brut et fraîcheur du timestamp, puis conserver la
vérification Skill ID. Ce récepteur n'est pas livré/activé ici.
Une simple comparaison `applicationId`, un token de liaison ou une IP ne
suffit pas à authentifier une requête HTTP Alexa.

## 5. Commandes, validation et résultats incertains

Le handler Smart Home relaie seulement :

- `Alexa.Discovery.Discover` : appareils autorisés et encore possédés.
- `Alexa.PowerController.TurnOn/TurnOff` : booléen explicite, jamais toggle.
- `Alexa.BrightnessController.SetBrightness/AdjustBrightness` : pourcentage
  entier borné ; ajustement converti depuis l'état courant observé.
- `Alexa.ReportState` : état relu chez Tuya, horodaté.

Le backend revérifie UID, projet, catégorie, présence de l'appareil et état en
ligne à chaque commande. Avant l'unique écriture, il revérifie compte/licence et
autorisation. Un verrou durable par appareil évite des ajustements concurrents ;
un échec laisse 15 secondes de garde car une requête peut encore arriver.

Le `messageId` Alexa est une clé d'idempotence persistée par utilisateur :
une même directive n'émet pas une seconde commande, même après un timeout.
Réutiliser cette clé avec une commande différente est une erreur. Après succès,
un doublon renvoie l'observation originale, horodatée, si l'appareil reste
autorisé ; une nouvelle directive doit relire l'état.
Une nouvelle phrase utilisateur génère en revanche une nouvelle directive :
l'idempotence ne peut pas deviner qu'il s'agit d'une répétition humaine.

L'acquittement Tuya n'est **pas** une preuve d'état. Après envoi, l'état est relu :
s'il ne correspond pas, si la réponse est perdue ou si les 5,5 secondes backend
sont dépassées, la commande devient `UNCERTAIN` et Alexa reçoit une erreur.
Aucune boucle de retry d'écriture. L'utilisateur vérifie physiquement l'appareil
avant toute nouvelle commande. Il n'y a pas de garantie de temps réel ni
d'exactly-once sur un réseau ou sur une prise physique.

Ce système n'est pas un dispositif de sécurité. Déconnexion, suppression ou
révocation ne peuvent pas rappeler une requête déjà partie.

## 6. Données, effacement et exploitation

Collections dédiées :

- `sirius_alexa_codes` : demandes/codes hachés, state, scopes, URI, expiration ;
  sans propriétaire avant consentement. Les codes expirés sont purgés à la
  prochaine demande de liaison ; pas d'archive d'audio.
- `sirius_alexa_connections`, `sirius_alexa_refreshes`, `sirius_alexa_limits` :
  liaisons, hashes, anti-rejeu, compteur de débit. Refresh expirés purgés au
  prochain échange ; liaisons et compteurs restent jusqu'à effacement du compte.
- `sirius_tuya_devices`, `sirius_tuya_locks`, `sirius_tuya_commands` :
  sélection, verrou, empreinte de directive et observation/résultat.
  Les commandes âgées de plus de 30 jours sont purgées à la prochaine commande
  (donc fenêtre d'idempotence limitée à cette rétention, pas de purge planifiée
  garantie quand le connecteur n'est pas utilisé).

L'export du compte inclut liaisons sans hashes, appareils sélectionnés et
historique de commandes. Le parcours de suppression serveur couvre toutes ces
collections possédées. Il ne supprime pas les copies Amazon/Tuya ni les secrets
opérateur de l'environnement ; retirer aussi le mapping UID du serveur et,
si nécessaire, délier le compte dans Tuya. Une désactivation globale Tuya ne
bloque pas les routes de retrait d'autorisation.

Ne journaliser que des codes d'erreur techniques, jamais les enveloppes Alexa,
les tokens, le texte privé lu ou les secrets fournisseur.
Sauvegarder la base et les variables hors du dépôt selon votre politique.

## 7. Recette avant usage réel

Tests locaux sans connexion fournisseur :

```powershell
# Depuis la racine du dépôt, environnement Python déjà configuré :
Set-Location backend
& ..\.venv\Scripts\python.exe -m pytest tests\test_alexa_tuya.py -q
# Depuis integrations\alexa :
npm test
```

Ces tests couvrent OAuth, refus/expiry/PKCE, tokens hachés, refresh/rejeu,
séparation des clients et comptes, quotas, export, retrait d'appareils,
signatures/capacités Tuya, commandes incertaines sans répétition,
modèle vocal, directives Smart Home et transport HTTPS simulé.
Ils ne prouvent pas une certification Amazon ni le fonctionnement de vos appareils.

Recette réelle à effectuer vous-même après configuration :

1. Vérifier le compte affiché dans les deux consentements et les scopes distincts.
2. La Skill Custom lit uniquement vos trois derniers titres et votre dernière
   synthèse READY, pas la transcription, les notes complètes ou les tâches.
3. Découvrir une seule lampe non critique ; les autres appareils ne doivent pas
   apparaître. Tester on/off, luminosité min/50/max et état.
4. Tester hors ligne, abonnement Tuya expiré et permissions manquantes : aucune
   fausse annonce de succès.
5. Retirer l'appareil, révoquer la liaison, tester avec un second compte :
   les accès doivent échouer et aucune commande ne doit partir.
6. Vérifier le comportement des délais sur votre hébergement ; si la chaîne
   dépasse souvent le délai Alexa, ne pas publier cette configuration telle quelle.
7. Vérifier politiques IAM, secrets, journaux, coûts, consentements et règles
   Amazon/Tuya avant certification ou ouverture multi-utilisateur.

Références officielles :

- [Alexa Account Linking](https://developer.amazon.com/en-US/docs/alexa/account-linking/configure-authorization-code-grant.html)
- [Alexa Discovery v3](https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-discovery.html)
- [Tuya : liaison Smart Life par QR code](https://developer.tuya.com/en/docs/iot/link-devices?id=Ka471nu1sfmkl)
- [Tuya : contrôle, spécifications et état](https://developer.tuya.com/en/docs/cloud/device-control?id=K95zu01ksols7)
- [Tuya : signature des requêtes](https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g)

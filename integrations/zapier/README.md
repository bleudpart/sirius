# SIRIUS pour Zapier : spécification et exploitation

## Périmètre livré

Application Zapier CLI indépendante, API FastAPI et dispatcher persistant.
**Authentification par clé API dédiée**, choix retenu pour cette version.
Ce code ne constitue pas un serveur OAuth 2.0 et n'utilise pas un JWT de
session utilisateur comme clé d'intégration.

| Type | Opération | Droit nécessaire | Données |
|---|---|---|---|
| Authentification | Tester la connexion | Clé valide | Nom de connexion, droits, expiration |
| REST hook | Nouveau dossier | `hooks:write`, `dossiers:read` | ID, titre et date uniquement |
| REST hook | Synthèse de réunion prête | `hooks:write`, `meetings:read` | ID, titre, résumé et capture complète/incomplète |
| Action | Ajouter une note | `notes:write` | Texte dans les notes du dossier privé existant |
| Search | Rechercher un dossier | `dossiers:read` | Titre exact ou ID ; vingt résultats maximum |

Pas de dépenses IA, validation de tâches, appel téléphonique, virement, script,
navigation ou accès aux fichiers depuis cette intégration. Les propositions de
tâches d'une réunion ne sont ni validées, ni affectées, ni transmises au hook.
Les notes sont automatiquement enregistrées, pas envoyées à des tiers par SIRIUS.

## Architecture

```text
Utilisateur authentifié dans SIRIUS
  └ création clé dédiée → SHA-256 en base, valeur affichée une seule fois
       └ connexion Zapier custom authentication → GET /me

Activation du Zap → performSubscribe(bundle.targetUrl)
  └ POST /hooks → abonnement lié au compte ET à la clé
       └ retour {id, secret} dans subscribeData de Zapier

Nouveaux dossiers / nouvelles synthèses READY
  └ dispatcher FastAPI, toutes les 15 secondes hors durée des traitements
       ├ balayage paginé des sources persistantes, 50 par abonnement/tour
       ├ livraison déterministe persistante par abonnement + événement
       ├ claim CAS avec bail 60 s
       └ POST HTTPS vers hooks.zapier.com, timeout 10 s
            └ secret d'abonnement vérifié par le trigger Zapier
                 └ ID stable pour déduplication Zapier → étapes du Zap

Désactivation du Zap → performUnsubscribe → DELETE /hooks/{id}
Révocation clé → refus API + désactivation des abonnements correspondants
```

Les sources sont relues avant chaque livraison : une réunion supprimée n'est
pas expédiée depuis une ancienne copie de transcription. Les livraisons stockent
des références et états, pas un second exemplaire des résumés.
Le dispatcher ne contacte aucun fournisseur sans abonnement actif.

Les événements antérieurs à la souscription ne sont pas rejoués. Le timestamp
`ready_at` est ajouté au passage READY, y compris pour une capture commencée
avant la souscription et terminée après. Les anciennes synthèses sans ce champ
ne sont pas migrées ni considérées comme nouvelles. Les échantillons de test
sont de vraies données récentes du compte, jusqu'à trois événements, et sont
donc également transmis à Zapier quand l'utilisateur teste son trigger.

## Authentification et sécurité

- Clé aléatoire de 256 bits préfixée `szk_`, hash SHA-256 uniquement en base.
- Une clé appartient à un utilisateur existant, jamais à un `user_id` fourni
  dans un formulaire Zapier. Compte supprimé/désactivé : connexion refusée.
- Droits choisis à la création ; renouveler la clé pour les modifier.
- Expiration par défaut 30 jours, maximum 90 jours. Pas de renouvellement
  automatique : créer une nouvelle clé et reconnecter Zapier avant expiration.
- L'essai/licence SIRIUS est vérifié pour les opérations et les envois,
  même sans JWT de session. Expiration de licence : 402 et suspension visible
  dans `/hooks`, sans détruire l'abonnement. La consultation des connexions,
  leur révocation et le diagnostic restent possibles avec une session valide.
- Dix clés actives et dix abonnements actifs maximum par compte ; ces plafonds
  d'admission ne constituent pas un quota distribué strict en cas de créations
  exactement concurrentes. Révoquer les anciennes clés même expirées.
- API key dans `X-Sirius-Api-Key` uniquement, jamais query string ni URL.
  Les routes normales SIRIUS n'acceptent pas cette clé.
- Les routes de gestion exigent la session utilisateur existante, MFA comprise
  au login si activée ; une clé Zapier ne peut pas créer d'autres clés.
- Soixante requêtes par minute UTC et par clé, 429 avec `Retry-After: 60`.
- URL hook : HTTPS, hôte exact `hooks.zapier.com`, port 443, chemin `/hooks/`,
  sans identifiants, query string ou fragment. Aucune redirection suivie,
  proxy d'environnement désactivé, aucune destination arbitraire.
- Secret distinct par abonnement, transmis en header HTTPS et comparé en temps
  constant dans le trigger. Ce n'est pas une signature HMAC du corps ; TLS
  protège le transport. Ne pas journaliser `target_url`, clés ou secret.
- L'adresse d'API Zapier doit être votre serveur HTTPS de confiance : saisir
  l'adresse d'un tiers lui communiquerait la clé, comme pour tout connecteur.

### Création et révocation d'une clé

La gestion est disponible par API authentifiée, sans nouvel écran de réglages.
Exemple PowerShell ; `$session` est votre access token SIRIUS obtenu par le
login existant, pas votre mot de passe. Ne pas coller de secret dans un dépôt,
un ticket, une capture d'écran ou un journal partagé.

```powershell
$api = 'https://VOTRE-SERVICE/api/integrations/zapier'
$headers = @{ Authorization = "Bearer $session" }
$body = @{
  label = 'Zapier personnel'
  scopes = @('dossiers:read', 'notes:write', 'meetings:read', 'hooks:write')
  expires_in_days = 30
} | ConvertTo-Json
$connection = Invoke-RestMethod "$api/keys" -Method Post -Headers $headers `
  -ContentType 'application/json' -Body $body
# Copier $connection.api_key dans le champ mot de passe de la connexion Zapier.
# Ne pas afficher la réponse complète dans un terminal enregistré.

Invoke-RestMethod "$api/keys" -Headers $headers
# Désactive également les abonnements attachés à cette clé :
Invoke-RestMethod "$api/keys/$($connection.id)" -Method Delete -Headers $headers
```

La révocation ne peut pas rappeler une requête déjà partie. Il en va de même
pour la suppression d'un dossier ou d'un compte pendant un envoi.

## Contrat HTTP

Préfixe : `/api/integrations/zapier`.
Corps JSON, schémas stricts sans champs inconnus.

| Méthode et route | Authentification | Résultat |
|---|---|---|
| `POST /keys` | Session | Métadonnées + `api_key` une seule fois |
| `GET /keys` | Session | Métadonnées sans hash ni clé |
| `DELETE /keys/{id}` | Session | Révocation idempotente d'une clé du compte |
| `GET /deliveries` | Session | Cent dernières livraisons, états et erreurs sans secret |
| `GET /hooks` | Session | Abonnements, état et motif de suspension, sans URL ni secret |
| `GET /me` | Clé | Identité de connexion, scopes et expiration |
| `GET /dossiers?title=...` ou `?id=...` | Clé + lecture dossiers | Tableau minimal, ID prioritaire, pas de sources ni notes |
| `POST /notes` | Clé + écriture notes | Note créée ou résultat identique d'une reprise |
| `POST /hooks` | Clé + hooks + lecture de l'événement | `{id, secret}` |
| `DELETE /hooks/{id}` | Même clé + hooks | Désabonnement ; 404 pour autre compte/clé |
| `GET /samples/{event}` | Clé + lecture de l'événement | Tableau jusqu'à trois événements réels |

Action note :

```json
{
  "request_id": "00000000-0000-4000-8000-000000000001",
  "dossier_id": "identifiant-du-dossier",
  "text": "Texte de la note"
}
```

`request_id` est un UUID **stable par opération et par dossier**, fourni par le
workflow. Le générer une seule fois en amont et le conserver pour les retries
(par exemple dans l'enregistrement source). Ne pas mettre un UUID constant pour
toutes les notes, ni en générer un nouveau dans chaque tentative de l'action.
Même UUID + même texte : même note. Même UUID + texte différent : 409.
Une modification concurrente non réconciliable renvoie 409, jamais un faux succès.
Le texte est limité à 4 000 caractères après validation, les espaces seuls refusés.

Exemple de REST hook :

```json
{
  "id": "meeting.ready:identifiant-reunion",
  "event": "meeting.ready",
  "resource_id": "identifiant-reunion",
  "title": "Point de suivi",
  "created_at": "2026-10-23T09:00:00+00:00",
  "summary": "Le stock sera vérifié avant vendredi.",
  "capture_complete": true
}
```

401 : clé absente/invalide/expirée/révoquée ou compte indisponible ;
402 : essai/licence SIRIUS indisponible ;
403 : droit absent ; 404 : ressource hors compte/inexistante ;
409 : conflit idempotent/plafond ; 422 : corps/URL non conforme ;
429 : débit limité. Les erreurs HTTP sont propagées par le connecteur.

## Livraison, reprises et limites

- Livraisons persistantes : `PENDING → SENDING → SENT | PENDING | FAILED`.
  Source supprimée avant envoi : `CANCELLED`.
- Cinq tentatives maximum, délai 30, 60, 120, 240 secondes après les échecs
  transitoires, augmenté de l'attente du dispatcher. Pas de garantie temps réel.
- Timeout, panne réseau, 408, 429 et 5xx : reprise bornée. 4xx définitifs :
  FAILED. 410 : arrêt de l'abonnement. Une réponse 3xx n'est jamais suivie ;
  elle reste un échec et finit en FAILED après le budget de tentatives.
- Bail de 60 secondes : récupération après arrêt du processus sans renvoyer
  indéfiniment. Les tentatives dont la réponse s'est perdue comptent aussi.
- **Pas de garantie exactly-once**. Si Zapier a reçu le POST avant une panne,
  la reprise porte le même ID et peut être dédupliquée par Zapier. Les étapes
  aval non idempotentes doivent disposer de leur propre protection.
- Les balayages complets recommencent après chaque page finale pour retrouver
  les écritures tardives ; les identifiants de livraison empêchent leur renvoi.
  Les records d'anti-rejeu sont conservés jusqu'à l'effacement du compte.
  Prévoir une politique d'archivage pour les volumes élevés avant généralisation.
- Un seul processus applicatif est conseillé pour cette première version.
  Les claims protègent les livraisons concurrentes ; la découverte n'est pas
  une file distribuée à haut débit, les compteurs d'admission non plus.
- Consulter `/deliveries` en cas de FAILED. Aucune reprise manuelle cachée :
  corriger la cause, vérifier l'historique Zapier avant de recréer un Zap.
  La reconnexion ne rejoue pas automatiquement les événements antérieurs.
  Désactiver puis réactiver un Zap sur la même URL fait tourner le secret et
  recommence à la date de réactivation, sans livrer les anciennes sources.
- Le serveur doit rester démarré et disposer d'une sortie HTTPS. Une installation
  Electron seule, arrêtée ou inaccessible depuis Internet, ne peut pas recevoir
  les appels de Zapier Cloud. Ne pas exposer le backend sans HTTPS et protections
  de déploiement habituelles. Aucun tunnel ni ouverture de port automatique.

## Installation et validation du connecteur

Node 22+, npm ; versions SDK/CLI verrouillées dans le manifeste et le lockfile.

```powershell
Set-Location integrations\zapier
npm ci --ignore-scripts
npm test
npm run validate
npm audit --omit=dev
```

L'audit des dépendances **d'exécution** est sans alerte lors de la validation.
Les correctifs de `form-data`, `tmp`, `diff` et `@simple-git/argv-parser` sont
verrouillés par `overrides`. L'audit **complet** du CLI 19.2.1 reste en alerte :
30 signalements (4 modérés, 24 élevés, 2 critiques), dans l'outillage de
développement, notamment la chaîne Yeoman et les archives. Plusieurs n'ont pas
de correctif compatible annoncé par npm. Ne pas importer de template, dépôt ou
archive non fiable avec ce CLI, ni le faire tourner dans un environnement
contenant des secrets de production. Attendre/vérifier une version upstream
corrigée avant publication générale ; ne pas appliquer `npm audit fix --force`,
qui propose notamment une régression majeure du SDK. Ces alertes ne sont pas
présentées comme corrigées par les tests fonctionnels.

`validate` confirme le schéma et les contrôles structurels ; les libellés
français et l'absence de dropdown sur les identifiants génèrent des avertissements
de publication Zapier. Une distribution catalogue exige encore la revue
linguistique/branding et les contrôles de publication, distincts du schéma.

Les tests sont locaux et simulés : aucun hook réel ni publication Zapier.
Après validation, opérations explicites **à effectuer vous-même** sur votre
compte développeur, jamais automatiquement par SIRIUS :

```powershell
npx zapier-platform login
npx zapier-platform register
npm run push
```

Vérifier les exigences actuelles de Node runtime, de branding, de confidentialité
et de publication Zapier. Le code n'a pas été soumis au catalogue public.
`register` crée l'identité de l'intégration ; `push` téléverse le code à Zapier.
Ne pas confondre avec un push Git ou un déploiement du backend.

### Recette réelle à mener avant activation générale

1. Déployer l'API mise à jour sur un service HTTPS de test.
2. Créer une clé aux seuls droits utiles et connecter l'application privée.
3. Activer un Zap « Nouveau dossier » ; créer un dossier après l'activation.
4. Vérifier un seul ID d'événement dans l'historique et le titre exact.
5. Tester une synthèse après accord des participants : aucun fragment ni
   proposition de tâche ne doit apparaître dans la charge utile.
6. Rechercher un dossier et ajouter une note ; rejouer le même UUID, vérifier
   une seule note. Tester 403 avec une clé en lecture seule.
7. Désactiver le Zap, puis tester expiration/révocation de clé.
8. Vérifier les erreurs et les protections idempotentes des destinations aval.

## Confidentialité et cycle de vie

Collections : `sirius_zapier_keys`, `sirius_zapier_hooks`,
`sirius_zapier_deliveries`, `sirius_zapier_limits`. Le stockage MongoDB ou le
docstore SQLite existant est réutilisé, sans fichiers persistants en source.
L'export du compte inclut les métadonnées, abonnements et livraisons, sans hash
de clé, URL de réception ni secret. Les limites de débit, données opérationnelles
sans contenu métier, sont supprimées avec le compte mais non exportées.
Les notes restent dans les dossiers existants et leur export habituel.

La suppression du compte couvre les quatre collections. Elle n'efface ni
l'historique Zapier ni les données transmises par vos Zaps à d'autres services.
Le résumé peut contenir des données personnelles même sans transcription :
choisir les droits et destinations en conséquence. Révoquer la clé avant une
demande d'effacement si l'on souhaite arrêter immédiatement les prochains envois.

## Extension OAuth 2.0 future, non implémentée

Si une distribution OAuth devient nécessaire, garder les mêmes API à scopes
et remplacer l'authentification custom par `oauth2` dans le manifeste Zapier.
Prérequis côté SIRIUS : client enregistré, URI de redirection exacte, écran de
consentement authentifié, authorization code à usage unique et durée courte,
validation `state` côté Zapier, PKCE si le client le supporte, access tokens courts,
refresh tokens hachés avec rotation/détection de réutilisation, révocation et
audit. Les jetons de session actuels ne doivent pas être recyclés en OAuth.
Cette liste est une trajectoire technique, pas des endpoints disponibles.

## Sources

- [Zapier CLI et schémas](https://docs.zapier.com/integrations/build-cli/overview)
- [Tests et débogage](https://docs.zapier.com/integrations/build-cli/testing-and-debugging)
- [Code du connecteur](./index.js)
- [API et dispatcher](../../backend/zapier_integrations.py)

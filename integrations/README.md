# SIRIUS : Raycast, réunions Discord et publication Slack

L'intégration [Zapier CLI, API keys et REST hooks](./zapier/README.md) dispose
de sa propre spécification, de clés dédiées et de tests indépendants.

Le socle [WhatsApp Cloud API et Google Workspace](./whatsapp-workspace/README.md)
décrit les webhooks vérifiés, la synchronisation bornée et les actions confirmées.

Les [Skills Alexa et le connecteur Smart Life/Tuya](./alexa/README.md) séparent
la lecture des dossiers/synthèses des commandes domotiques sur appareils sélectionnés.

## Périmètre et architecture

Cette intégration est facultative. Installer les sources n'active aucun bot,
enregistrement, appel IA ou partage Slack. Aucun identifiant réel n'est livré.

```text
Raycast (TypeScript/React)
  ├ question explicite ───────────────> POST /api/chat
  ├ liste/détail réunions ────────────> /api/integrations/meetings
  └ choix tâche + responsable + dossier + confirmation
                                       └> entrée meeting confirmée dans Mes dossiers

Discord : commande du propriétaire dans un canal texte fixe
  └ consentements individuels de toutes les personnes du canal vocal fixe
       └ connexion vocale du bot, réception Opus par personne
            └ décodeur PCM stéréo 48 kHz en mémoire
                 └ WAV par tour de parole ou environ 5 s
                      └ POST /api/stt (moteur existant : Groq ou service configuré)
                           └ PUT /api/integrations/meetings/{id}/fragments
                                └ arrêt / fin : POST .../{id}/finish
                                     └ un appel Cerebras, résumé + propositions sourcées

Slack : commande Discord du propriétaire
  └ lecture préalable du texte complet (résumé et tâches validées)
       └ bouton explicite + empreinte du texte exact
            └ claim durable SIRIUS puis chat.postMessage vers un canal Slack fixe
```

La **capture en direct** désigne la réception Discord et l'envoi progressif de
fragments au STT, pas une transcription token par token ni une WebSocket audio
relayée par SIRIUS. Le résumé est automatique **à la fermeture** de la capture
(fin explicite, incident ou limite), pas envoyé toutes les quelques secondes.
Le débit/temps de réponse STT dépend du fournisseur, sans latence garantie.
Les fragments par personne peuvent se chevaucher ; la séquence est l'ordre de
soumission, pas une chronologie certifiée des prises de parole.

Slack n'est **pas** utilisé pour capturer l'audio des Huddles. Ce bot ne fait
ni self-bot utilisateur, ni contournement du client Slack, ni enregistrement
discret de l'écran ou du microphone. Il publie avec l'API officielle Slack.

## Code et API

- [Client HTTP commun](./shared/client.ts) : HTTPS (HTTP permis seulement en
  boucle locale), Bearer, pas de redirection, délais et aucun retry automatique.
- [Extension Raycast](./raycast/src/meetings.tsx) et
  [commande de conversation](./raycast/src/ask.tsx).
- [Bot Discord](./meeting-bot/src/index.ts) :
  cycle consentement → connexion → réception → fermeture → synthèse.
- [Bornes audio, consentements et Slack](./meeting-bot/src/capture.ts).
- [API et stockage](../backend/meeting_integrations.py).

Toutes les routes utilisent l'authentification SIRIUS existante et l'isolation
`user_id` issue de la session, jamais d'un champ fourni par le modèle/bot :

| Route | Effet |
|---|---|
| `POST /api/integrations/meetings` | Admission avec UUID stable, participants et accords déclarés |
| `GET /api/integrations/meetings` | Vingt dernières réunions du compte, sans fragments |
| `GET /api/integrations/meetings/{id}` | Texte, accords, résultat et états de la même référence |
| `PUT /api/integrations/meetings/{id}/fragments` | Fragment texte borné, séquence idempotente |
| `POST /api/integrations/meetings/{id}/finish` | Ferme atomiquement puis tente une seule synthèse |
| `POST /api/integrations/meetings/{id}/approve` | Confirmation exacte et affectations dans un dossier privé |
| `GET /api/integrations/meetings/{id}/publication` | Aperçu complet avec empreinte, aucun envoi |
| `POST /api/integrations/meetings/{id}/publication` | Claim de publication unique, rend le texte confirmé |
| `DELETE /api/integrations/meetings/{id}` | Efface texte et participants, garde un tombstone anti-rejeu |

`/api/stt`, `/api/chat` et `/api/work-dossiers` sont réutilisés sans inventer un
deuxième moteur de transcription, système de comptes ou gestionnaire de tâches.
La synthèse utilise les limites de capacité et quotas Cerebras des sous-agents
existants, y compris les règles de clés personnelles après essai.

États : `CAPTURING → SUMMARIZING → READY | FAILED`, puis `DELETED` si effacement.
Une interruption pendant `SUMMARIZING` reste visible : aucun redémarrage ne
relance implicitement une dépense IA. On peut supprimer une capture expirée
ou une synthèse bloquée depuis plus de deux minutes. Une capture en cours ne
se supprime pas : l'arrêter dans Discord. L'API de suppression ne raccroche
pas un client vocal connecté.

## Raycast

Prérequis : Raycast avec support des extensions sur le système concerné,
Node **22.22.2 ou plus**, accès à l'API SIRIUS. La compilation est vérifiable
sous Windows ; l'ouverture interactive dans Raycast n'est pas simulée par un build.

```powershell
Set-Location integrations\raycast
npm ci
npm run typecheck
npm run build
npm run dev
```

`dev` importe l'extension dans Raycast ; ne le lancer que sur la machine où
Raycast est installé. Le manifeste utilise `bleudpart` comme auteur local ;
vérifier le véritable identifiant Store avant une éventuelle soumission.
L'icône est dérivée du logo SIRIUS du dépôt. Aucune publication Store automatique.

Préférences :

- URL de **votre** API, terminée par `/api`.
- `access_token` personnel SIRIUS, champ de préférence `password`.
- Clé personnelle Cerebras facultative, aussi de type `password`.

Les tokens existants s'obtiennent via votre processus d'authentification SIRIUS
(`/api/auth/login`, avec MFA si activée). Ne pas copier un mot de passe, refresh
token ou cookie de quelqu'un d'autre dans la préférence. Ce premier client
n'implémente pas de Device OAuth ni renouvellement de session en arrière-plan :
renouveler la session après expiration (actuellement 12 h côté SIRIUS).
Ne jamais fournir un token à une API non vérifiée.

Commandes :

- **Demander à SIRIUS** : saisie explicite, 4 000 caractères maximum, appel au
  chat existant. Aucun presse-papiers, écran, sélection ou fichier aspiré.
- **Réunions SIRIUS** : liste, détails et fragments sources ; aucune IA appelée
  par la consultation.
- **Valider les tâches** : relire chaque proposition et son fragment,
  choisir le dossier et, pour chaque tâche retenue, un participant explicitement
  identifié par son ID Discord ; les tâches laissées vides ne sont pas créées.
  Une confirmation finale est requise. Il faut au moins une tâche retenue.

Les affectations sont des **responsables nominatifs dans le dossier privé
du propriétaire**, visibles dans les outils de travail existants. Elles ne
créent ni compte SIRIUS, ni calendrier, ni notification inter-compte, ni mention
Slack/Discord. Un nom n'est jamais résolu automatiquement vers un compte.
L'ID Discord est conservé pour lever les homonymies. Pour livrer réellement
des tâches dans les espaces d'autres personnes, il faudrait un périmètre
de partage entreprise et des autorisations supplémentaires, non implémentés ici.

## Bot de réunion Discord

Prérequis : Node 22.22.2+, une application Discord avec bot officiel, permissions
sur **un seul serveur**, un canal vocal classique et un canal texte accessibles
à toutes les personnes concernées. Choisir des canaux privés adaptés au contenu.
Pas de Stage, appels privés Discord ou invités hors du groupe.

Permissions minimales : View Channels, Connect, Send Messages, Attach Files.
Le bot est muet (`selfMute=true`), mais pas sourd (`selfDeaf=false`).
Les intents sont Guilds et GuildVoiceStates, sans Message Content.
Inviter avec les scopes `bot` et `applications.commands`. Le transport UDP
vocal doit être joignable ; sa compatibilité réelle doit être vérifiée.

```powershell
Set-Location integrations\meeting-bot
npm ci
Copy-Item .env.example .env
# Renseigner localement .env, ne pas le commiter.
npm run build
npm test
# Les deux commandes suivantes contactent réellement Discord :
npm run register
npm start
```

`register` n'est jamais lancé par les tests ou le build. Il installe les trois
commandes de cette application dans le serveur indiqué (remplace sa liste de
commandes de serveur). Exécuter seulement après vérification des identifiants.

Variables expliquées dans [.env.example](./meeting-bot/.env.example) :

- `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`.
- `DISCORD_VOICE_CHANNEL_ID`, `DISCORD_TEXT_CHANNEL_ID` : canaux fixes,
  non sélectionnables par un LLM.
- `DISCORD_OWNER_ID` : seule personne autorisée à démarrer, terminer normalement
  ou demander la publication. Utiliser son **propre compte SIRIUS** ci-dessous.
- `SIRIUS_API_URL`, `SIRIUS_ACCESS_TOKEN` : session personnelle existante.
- `SIRIUS_GROQ_KEY`, `SIRIUS_CEREBRAS_KEY` : facultatives, selon les droits/quotas
  du compte. Le bot a les droits de cette session : le lancer sur une machine
  de confiance, idéalement avec un compte dédié non administrateur.
- `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` : optionnelles, canal cible fixe.

Le bot charge `.env` seulement depuis son répertoire de lancement. Ne jamais
mettre ces variables dans un message Discord/Slack ou un fichier versionné.
Les secrets ne sont pas inclus dans les commandes Slash ni les journaux applicatifs.

### Capture et accord

1. Le propriétaire rejoint le canal vocal configuré puis `/sirius-start`
   dans le canal texte configuré.
2. Le bot décrit explicitement le traitement STT/Cerebras, la conservation et
   le partage possible. **Aucune connexion vocale avant tous les accords.**
3. Chaque personne présente clique elle-même sur le bouton d'accord.
   Le propriétaire ne peut pas cliquer pour les autres. Aucun autre bot admis.
   Si les accords manquent après deux minutes, la demande expire.
4. Après tous les accords, la session est admise par SIRIUS, le bot se connecte,
   annonce la capture puis commence les abonnements audio par personne.
5. Toute arrivée, sortie, déplacement du bot, panne vocale ou retrait d'accord
   arrête la capture ; **aucune reconnexion automatique**. Un nouveau groupe
   nécessite une nouvelle demande d'accord.
6. Chaque participant peut retirer son accord via le bouton d'arrêt ;
   le propriétaire peut utiliser `/sirius-stop` pour terminer normalement.
   Les abonnements audio sont détruits avant d'attendre le réseau.
7. Une fermeture normale vide la file bornée puis synthétise. Un retrait/incident
   annule les fragments encore en attente et ne sauvegarde pas un résultat STT
   revenu ensuite ; un audio **déjà transmis** au fournisseur ne peut être rappelé.
   Les fragments texte déjà reçus peuvent produire un résumé marqué incomplet.

L'API SIRIUS vérifie la cohérence des accords déclarés ; elle n'est pas une
autorité juridique ni une preuve indépendante de l'identité Discord. Le bot,
authentifié avec la session du propriétaire, est la frontière de confiance
pour les clics et la liste des personnes. Vérifier les lois, règles de
l'organisation et conditions des plateformes avant usage réel.

### Bornes et compatibilité

- Une seule capture par processus, 1 à 10 personnes, 20 minutes maximum.
- PCM stéréo 48 kHz / 16 bits, décodage Opus local ; pas de fichier audio.
- Fragments autour de 5 secondes ou fin de parole, six fragments en attente
  maximum. Paroles trop courtes (<200 ms) ignorées ; ce n'est pas une preuve
  d'exhaustivité de transcription.
- Au plus 240 fragments, 2 000 caractères chacun et 24 000 caractères au total
  par session côté API. La saturation arrête, elle ne grossit pas la file.
- Une seule synthèse Cerebras, 12 secondes de délai applicatif, 2 048 tokens,
  au plus 10 propositions citant une séquence existante. Schéma strict,
  JSON dupliqué/non fini refusé. Les citations prouvent la présence du fragment,
  **pas la justesse de l'interprétation IA** : relire avant validation.
- Les requêtes STT réutilisent les quotas/tarifs du moteur SIRIUS existant
  (jusqu'à 240 demandes) ; aucune promesse de coût nul ou de forfait financier.
- Les instants de parole/silence et la réception audio Discord peuvent changer
  avec la plateforme. `@discordjs/voice` inclut la prise en charge DAVE
  disponible dans le SDK ; la réception audio n'est pas une API Discord
  officiellement garantie pour les bots. Aucune désactivation/contournement du
  chiffrement ou capture du client utilisateur n'est effectuée. Une incompatibilité
  doit arrêter la capture, pas être présentée comme un enregistrement réussi.

Après arrêt brutal du processus : aucun fichier de reprise ni reconnexion.
La référence reste éventuellement `CAPTURING` dans SIRIUS. Vérifier le détail,
puis terminer manuellement la même référence avec
`POST .../{id}/finish` et `{"capture_complete":false,"reason":"Bot interrompu"}`,
ou supprimer après expiration. Ne pas démarrer une nouvelle session pour
prétendre compléter automatiquement l'ancienne.

## Publication Slack

Configurer une application Slack avec le scope bot **`chat:write`** et inviter
le bot au canal cible. Ne pas demander d'accès à tous les messages, fichiers,
Huddles ou canaux privés. Aucun serveur webhook Slack entrant n'est nécessaire.

Après revue/affectation dans Raycast :

1. `/sirius-publish meeting:<UUID>` par le propriétaire.
2. Le bot récupère l'aperçu complet du résumé et des tâches réellement validées.
   Il fournit un fichier texte **éphémère au propriétaire dans Discord** pour
   relecture ; cela transmet aussi ce texte à Discord. Si la réunion n'a aucune
   proposition de tâche, le résumé seul peut être publié.
3. Le bouton de confirmation expire après deux minutes.
4. L'API vérifie l'empreinte exacte de ce texte et réserve durablement une
   seule publication. Si les tâches ont changé entre-temps, la demande est refusée.
5. `chat.postMessage` est envoyé une seule fois au canal configuré, sans markdown,
   mentions actives, prévisualisations de liens ou transmission de l'audio/texte brut.
   Seul un `ok:true` Slack est annoncé comme confirmé.

Une coupure après le claim peut signifier « non envoyé » **ou** « envoyé sans
réponse ». Le claim reste conservé : vérifier Slack au lieu de relancer.
Le système privilégie l'absence de doublons à une promesse « exactly once ».
Il ne publie pas automatiquement dans Slack à la fin d'une réunion.

## Données, suppression et limites de sécurité

Audio : mémoire du bot et moteur STT configuré uniquement ; texte : SIRIUS,
Cerebras, puis Discord pour l'aperçu explicite et Slack après confirmation.
Les politiques de rétention fournisseurs restent applicables.

Collections personnelles :

- `sirius_meetings` : titre, identifiants/labels, accords déclarés, fragments,
  états, résumé, propositions et empreinte. Aucun audio en base.
- `sirius_meeting_publications` : claim minimal anti-doublon.
- Tâches dans `sirius_work_entries` et dossiers existants.

Elles sont couvertes par l'export personnel et la suppression serveur revue du
compte. Pas de purge temporelle automatique : les limites de vingt minutes
concernent la capture, pas la durée de conservation.
Supprimer une réunion retire son texte et ses participants de cette session,
mais ne supprime pas ses tâches du dossier, les messages Slack/Discord,
les exports ou les données des fournisseurs. Traiter ces surfaces séparément.

Ne jamais capturer de secret, mot de passe ou réunion sensible sans cadre
approprié. Les tokens sont des sessions SIRIUS existantes non limitées à ces
seules routes : aucune prétention de jeton OAuth à scopes fins dans cette version.
Le multi-serveur, OAuth Slack par utilisateur, le partage inter-comptes,
l'assignation dans un gestionnaire externe et la rétention ZDR ne sont pas fournis.

## Vérification sans réseau fournisseur

Depuis `backend` : `..\.venv\Scripts\python.exe -m pytest tests\test_meeting_integrations.py -q`.
Depuis `integrations\meeting-bot` : `npm test`.
Depuis `integrations\raycast` : `npm run typecheck` puis `npm run build`.

Les tests simulent les fournisseurs et vérifient les accords, l'isolation,
les limites, le décodage local, les doublons, l'annulation des fragments en
attente, les schémas IA, la validation humaine et la publication unique.
Ils ne certifient ni une réception Discord/DAVE en production, ni la latence,
ni une installation Raycast interactive, ni un message réellement livré à Slack.

Références :
[manifeste Raycast](https://developers.raycast.com/information/manifest),
[@discordjs/voice](https://discord.js.org/docs/packages/voice/main),
[Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).
